import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { makeSyntheticPptx } from '../python-inspector-test-fixtures.mjs';
import { inspectPptx } from '../src/presentation/adapters/python-inspector.ts';
import { OpenAICompatibleSemanticInferenceAdapter } from '../src/presentation/adapters/openai-compatible-semantic-inference.ts';
import { planTemplateSemanticProfileBatches, projectTemplateSemanticProfileCache, templateSemanticProfileCacheKey, TemplateSemanticProfiler } from '../src/presentation/application/template-semantic-profiler.ts';
import { createTemplateIR, derivePresentationDesignSystem } from '../src/presentation/application/template-mapper.ts';
import { sha256Json, templateIRHashPayload } from '../src/presentation/domain/template-ir.ts';
import { startFakeSemanticEndpoint, deterministicPlanningResponse } from '../../../scripts/lib/fake-openai-compatible-endpoint.mjs';

const model = 'offline-fake-planner';

async function fixture(root, { slideCount = 3 } = {}) {
  await mkdir(root, { recursive: true });
  const filePath = path.join(root, 'private-template-name.pptx');
  const bytes = await makeSyntheticPptx({ slideCount, layoutCount: 4 });
  await writeFile(filePath, bytes);
  const inspection = await inspectPptx(filePath);
  const templateIR = createTemplateIR(inspection, {
    filePath: 'private-template-name.pptx', originalName: 'private-template-name.pptx',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    compiledAt: '2026-09-25T00:00:00.000Z', compilerVersion: 'lct-template-compiler/1',
  });
  return { templateIR, presentationDesignSystem: derivePresentationDesignSystem(templateIR) };
}

function adapter(baseUrl) {
  return new OpenAICompatibleSemanticInferenceAdapter({ baseUrl, model, requestTimeoutMs: 3000 });
}

function completion(value) {
  return {
    id: 'offline-profile-response', model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }],
  };
}

test('semantic template profile loads its versioned prompt, validates references, and caches by TemplateIR plus prompt fingerprint', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { templateIR, presentationDesignSystem } = await fixture(root);
  const endpoint = await startFakeSemanticEndpoint({ model });
  t.after(() => endpoint.close());
  const cache = projectTemplateSemanticProfileCache(path.join(root, 'projects'), 'project-profile');
  const profiler = new TemplateSemanticProfiler(adapter(endpoint.baseUrl), cache);

  const first = await profiler.profile(templateIR, presentationDesignSystem);
  assert.equal(first.templateIRHash, templateIR.hash);
  assert.equal(first.slides.length, templateIR.slides.length);
  assert.ok(first.slides.every((slide) => templateIR.slides.some((source) => source.index === slide.sourceSlideIndex)));
  assert.ok(first.slides.every((profileSlide) => Array.isArray(profileSlide.preservedElementIds)
    && Array.isArray(profileSlide.replaceableTextElementIds)));
  for (const profileSlide of first.slides) {
    const sourceSlide = templateIR.slides.find((slide) => slide.index === profileSlide.sourceSlideIndex);
    const classified = [...profileSlide.preservedElementIds, ...profileSlide.replaceableTextElementIds];
    assert.equal(new Set(classified).size, classified.length, 'a text element cannot be simultaneously preserved and cleared');
    assert.ok(classified.every((id) => sourceSlide.elements.some((element) => element.id === id)));
  }
  assert.equal(endpoint.state.inference.length, 1);
  const request = endpoint.state.inference[0].request;
  assert.equal(request.response_format.type, 'json_schema');
  assert.equal(request.response_format.json_schema.strict, true);
  assert.equal(request.response_format.json_schema.name, 'template_semantic_profile_v1');
  const configuredPrompt = (await readFile(path.join(process.cwd(), 'apps/daemon/prompts/template-profiler.v2.md'), 'utf8')).replace(/\s+/g, ' ').trim();
  assert.equal(request.messages[0].content, configuredPrompt, 'the runtime sends the versioned Markdown prompt without rewriting its content');
  const evidence = JSON.parse(request.messages.at(-1).content);
  assert.ok(evidence.slides[0].elements.some((element) => element.id));
  assert.equal(evidence.slides.length, templateIR.slides.length);
  assert.equal(evidence.canvas.width, templateIR.slideSize.width);
  assert.equal(evidence.canvas.height, templateIR.slideSize.height);
  const serializedEvidence = request.messages.at(-1).content;
  assert.ok(Buffer.byteLength(serializedEvidence, 'utf8') < 24 * 1024, 'representative synthetic profile evidence stays bounded');
  assert.ok(!('presentationDesignSystem' in evidence));
  assert.ok(!serializedEvidence.includes('relationshipCount'));
  assert.ok(!serializedEvidence.includes('relationshipIds'));
  assert.ok(!serializedEvidence.includes('layoutSummaries'));
  assert.ok(!serializedEvidence.includes('observedFonts'));
  assert.ok(!serializedEvidence.includes('fillColor'));
  const sourceSlide = templateIR.slides[0];
  const profiledSlide = evidence.slides.find((slide) => slide.sourceSlideIndex === sourceSlide.index);
  for (const sourceElement of sourceSlide.elements) {
    const profiledElement = profiledSlide.elements.find((element) => element.id === sourceElement.id);
    assert.ok(profiledElement, `all source element IDs needed by the profile remain available: ${sourceElement.id}`);
    assert.equal(profiledElement.kind, sourceElement.kind);
    if (sourceElement.geometry.resolved ?? sourceElement.geometry.direct) {
      const geometry = sourceElement.geometry.resolved ?? sourceElement.geometry.direct;
      assert.deepEqual(profiledElement.geometry, { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height });
    }
    if (sourceElement.text?.trim()) assert.equal(profiledElement.text, sourceElement.text.trim().slice(0, 320));
    if (sourceElement.placeholder?.role) assert.equal(profiledElement.placeholderRole, sourceElement.placeholder.role);
    if (sourceElement.placeholder?.type) assert.equal(profiledElement.placeholderType, sourceElement.placeholder.type);
    if (sourceElement.parentId) assert.equal(profiledElement.parentId, sourceElement.parentId);
    if (sourceElement.directStyles.fontSizesPt?.length) {
      assert.deepEqual(profiledElement.styles.fontSizesPt, [...new Set(sourceElement.directStyles.fontSizesPt)].slice(0, 4));
    }
    if (sourceElement.directStyles.bold !== null) assert.equal(profiledElement.styles.bold, sourceElement.directStyles.bold);
  }
  assert.ok(!JSON.stringify(evidence).includes('private-template-name'));
  assert.ok(!JSON.stringify(evidence).includes('layoutName'));

  first.slides[0].reasonCodes.push('caller_mutation');
  const cached = await profiler.profile(templateIR, presentationDesignSystem);
  assert.ok(!cached.slides[0].reasonCodes.includes('caller_mutation'));
  assert.equal(endpoint.state.inference.length, 1, 'same TemplateIR hash uses the cached profile');

  const promptSha256 = createHash('sha256').update(configuredPrompt, 'utf8').digest('hex');
  const cacheKey = templateSemanticProfileCacheKey(templateIR.hash, promptSha256);
  const persistedPath = path.join(root, 'projects', 'project-profile', '.template-compiler', 'semantic-profiles', `${cacheKey}.json`);
  const persisted = JSON.parse(await readFile(persistedPath, 'utf8'));
  assert.equal(persisted.templateIRHash, templateIR.hash);
  const reloadedProfiler = new TemplateSemanticProfiler(adapter(endpoint.baseUrl), projectTemplateSemanticProfileCache(path.join(root, 'projects'), 'project-profile'));
  const afterReload = await reloadedProfiler.profile(templateIR, presentationDesignSystem);
  assert.equal(afterReload.templateIRHash, templateIR.hash);
  assert.equal(endpoint.state.inference.length, 1, 'a new profiler instance uses the project-owned cache after daemon reload');

  const changed = structuredClone(templateIR);
  changed.source.originalName = 'renamed-template.pptx';
  changed.hash = sha256Json(templateIRHashPayload(changed));
  const changedPds = derivePresentationDesignSystem(changed);
  await profiler.profile(changed, changedPds);
  assert.equal(endpoint.state.inference.length, 2, 'a different validated TemplateIR hash gets a different cached profile');
});

test('semantic template profile rejects unknown slide indexes and element IDs through adapter validation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { templateIR, presentationDesignSystem } = await fixture(root);
  for (const invalid of ['slide-index', 'element-id']) {
    await t.test(invalid, async (subtest) => {
      const endpoint = await startFakeSemanticEndpoint({
        model,
        respond(request) {
          const normal = deterministicPlanningResponse(request);
          const content = JSON.parse(normal.choices[0].message.content);
          if (invalid === 'slide-index') content.slides[0].sourceSlideIndex = 999999;
          else content.slides[0].bodyElementIds = ['invented-element-id'];
          return completion(content);
        },
      });
      subtest.after(() => endpoint.close());
      const profiler = new TemplateSemanticProfiler(adapter(endpoint.baseUrl));
      await assert.rejects(profiler.profile(templateIR, presentationDesignSystem), (error) => error.code === 'INVALID_STRUCTURED_OUTPUT');
      assert.equal(endpoint.state.inference.length, 1);
    });
  }
});

test('large templates use deterministic slide- and byte-bounded batches and merge in canonical order', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-batches-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { templateIR, presentationDesignSystem } = await fixture(root, { slideCount: 17 });
  const plan = planTemplateSemanticProfileBatches(templateIR);
  assert.ok(plan.batches.length > 1);
  assert.ok(plan.batches.every((batch) => batch.sourceSlideIndexes.length <= 6));
  assert.ok(plan.batches.every((batch) => batch.evidenceBytes <= 24 * 1024));
  assert.deepEqual(plan.batches.flatMap((batch) => batch.sourceSlideIndexes), templateIR.slides.map((slide) => slide.index));

  const endpoint = await startFakeSemanticEndpoint({
    model,
    respond(request) {
      const response = deterministicPlanningResponse(request);
      const body = JSON.parse(response.choices[0].message.content);
      body.slides.reverse();
      return completion(body);
    },
  });
  t.after(() => endpoint.close());
  const observedRequests = [];
  const delegate = adapter(endpoint.baseUrl);
  const recordingAdapter = {
    model,
    async infer(request) {
      observedRequests.push(request);
      return delegate.infer(request);
    },
  };
  const profiler = new TemplateSemanticProfiler(recordingAdapter);
  const profile = await profiler.profile(templateIR, presentationDesignSystem);

  assert.equal(observedRequests.length, plan.batches.length);
  assert.deepEqual(profile.slides.map((slide) => slide.sourceSlideIndex), templateIR.slides.map((slide) => slide.index));
  assert.equal(profile.slides.length, templateIR.slides.length);
  observedRequests.forEach((request, index) => {
    const batch = plan.batches[index];
    const evidence = JSON.parse(request.messages.at(-1).content);
    assert.deepEqual(evidence.slides.map((slide) => slide.sourceSlideIndex), batch.sourceSlideIndexes);
    assert.deepEqual(request.metadata.templateProfilerBatch, {
      batchNumber: batch.batchNumber,
      totalBatches: batch.totalBatches,
      sourceSlideIndexes: batch.sourceSlideIndexes,
    });
    assert.equal(request.maxOutputTokens, batch.maxOutputTokens);
    assert.equal(request.output.schema.properties.slides.minItems, batch.sourceSlideIndexes.length);
    assert.equal(request.output.schema.properties.slides.maxItems, batch.sourceSlideIndexes.length);
    assert.deepEqual(request.output.schema.properties.slides.items.properties.sourceSlideIndex.enum, batch.sourceSlideIndexes);
  });
  assert.ok(observedRequests.every((request) => request.output.name === 'template_semantic_profile_v1'));
  assert.ok(endpoint.state.inference.every((entry) => entry.request.response_format.type === 'json_schema'
    && entry.request.response_format.json_schema.strict === true));

  await profiler.profile(templateIR, presentationDesignSystem);
  assert.equal(endpoint.state.inference.length, plan.batches.length, 'the complete in-memory profile cache avoids later provider requests');
});

test('batch response index coverage is exact and partial results are never cached', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-batch-abort-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { templateIR, presentationDesignSystem } = await fixture(root, { slideCount: 15 });
  let writes = 0;
  const cache = { async read() { return null; }, async write() { writes += 1; } };
  for (const invalid of ['foreign-index', 'duplicate-index', 'missing-index']) {
    const endpoint = await startFakeSemanticEndpoint({
      model,
      respond(request) {
        const response = deterministicPlanningResponse(request);
        const value = JSON.parse(response.choices[0].message.content);
        if (invalid === 'foreign-index') value.slides[0].sourceSlideIndex = templateIR.slides[6].index;
        if (invalid === 'duplicate-index') value.slides[0].sourceSlideIndex = value.slides[1].sourceSlideIndex;
        if (invalid === 'missing-index') value.slides.pop();
        return completion(value);
      },
    });
    t.after(() => endpoint.close());
    const profiler = new TemplateSemanticProfiler(adapter(endpoint.baseUrl), cache);
    await assert.rejects(profiler.profile(templateIR, presentationDesignSystem), (error) => error.code === 'INVALID_STRUCTURED_OUTPUT', invalid);
    assert.equal(endpoint.state.inference.length, 1, `${invalid} aborts the first batch without retry`);
  }
  assert.equal(writes, 0, 'no partial profile reaches persistent cache');
});

test('a single dense slide keeps every exposed element ID while shortening text to fit the batch byte cap', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-dense-slide-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { templateIR } = await fixture(root, { slideCount: 1 });
  const slide = templateIR.slides[0];
  const sourceElement = slide.elements.find((element) => typeof element.text === 'string' && element.text.trim());
  assert.ok(sourceElement, 'synthetic fixture has a readable source element');
  const elementTemplate = structuredClone(sourceElement);
  slide.elements = Array.from({ length: 120 }, (_, index) => ({
    ...structuredClone(elementTemplate),
    id: `dense_element_${index + 1}`,
    nativeId: String(index + 1),
    order: index + 1,
    text: `Dense evidence ${index + 1}: ${'claim '.repeat(90)}`,
  }));
  slide.designElementIds = [];
  templateIR.hash = sha256Json(templateIRHashPayload(templateIR));

  const plan = planTemplateSemanticProfileBatches(templateIR);
  assert.equal(plan.batches.length, 1);
  assert.ok(plan.batches[0].evidenceBytes <= 24 * 1024);
  const evidence = JSON.parse(plan.batches[0].evidence);
  assert.equal(evidence.slides[0].elements.length, 120);
  assert.deepEqual(evidence.slides[0].elements.map((element) => element.id), slide.elements.map((element) => element.id));
  assert.equal(evidence.slides[0].textEvidenceTruncated, true);
  assert.ok(evidence.slides[0].elements.every((element) => !element.text || element.text.length <= 320));
});

test('a slide that still exceeds the byte cap after compact fallback fails locally', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-unrepresentable-slide-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { templateIR } = await fixture(root, { slideCount: 1 });
  const slide = templateIR.slides[0];
  const sourceElement = structuredClone(slide.elements[0]);
  slide.elements = Array.from({ length: 120 }, (_, index) => ({
    ...structuredClone(sourceElement),
    id: `dense_element_${index + 1}_${'x'.repeat(300)}`,
    nativeId: String(index + 1),
    order: index + 1,
  }));
  slide.designElementIds = [];
  templateIR.hash = sha256Json(templateIRHashPayload(templateIR));

  assert.throws(
    () => planTemplateSemanticProfileBatches(templateIR),
    (error) => error.code === 'REQUEST_TOO_LARGE' && /source slide 1/u.test(error.message),
  );
});

test('corrupt or invalid persisted semantic profiles are discarded and reprofiled through the strict adapter', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-corrupt-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { templateIR, presentationDesignSystem } = await fixture(root);
  const endpoint = await startFakeSemanticEndpoint({ model });
  t.after(() => endpoint.close());
  const cache = projectTemplateSemanticProfileCache(path.join(root, 'projects'), 'project-profile');
  const profiler = new TemplateSemanticProfiler(adapter(endpoint.baseUrl), cache);
  const promptText = (await readFile(path.join(process.cwd(), 'apps/daemon/prompts/template-profiler.v2.md'), 'utf8')).replace(/\s+/g, ' ').trim();
  const promptSha256 = createHash('sha256').update(promptText, 'utf8').digest('hex');
  const cacheKey = templateSemanticProfileCacheKey(templateIR.hash, promptSha256);
  const profilePath = path.join(root, 'projects', 'project-profile', '.template-compiler', 'semantic-profiles', `${cacheKey}.json`);
  await mkdir(path.dirname(profilePath), { recursive: true });

  await writeFile(profilePath, '{broken-json', 'utf8');
  await profiler.profile(templateIR, presentationDesignSystem);
  assert.equal(endpoint.state.inference.length, 1, 'malformed JSON is removed and replaced by a validated strict response');
  assert.equal(JSON.parse(await readFile(profilePath, 'utf8')).templateIRHash, templateIR.hash);

  profiler.clear();
  await writeFile(profilePath, JSON.stringify({ templateIRHash: templateIR.hash, slides: [] }), 'utf8');
  await profiler.profile(templateIR, presentationDesignSystem);
  assert.equal(endpoint.state.inference.length, 2, 'a parsed cache with invalid slide coverage is also discarded');
  assert.equal(JSON.parse(await readFile(profilePath, 'utf8')).slides.length, templateIR.slides.length);
});

test('changing the versioned template-profiler prompt invalidates its project profile cache', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-prompt-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { templateIR, presentationDesignSystem } = await fixture(root);
  const promptDirectory = path.join(root, 'prompts');
  await mkdir(promptDirectory, { recursive: true });
  const sourcePrompt = await readFile(path.join(process.cwd(), 'apps/daemon/prompts/template-profiler.v2.md'), 'utf8');
  const promptPath = path.join(promptDirectory, 'template-profiler.v2.md');
  await writeFile(promptPath, sourcePrompt, 'utf8');
  const endpoint = await startFakeSemanticEndpoint({ model });
  t.after(() => endpoint.close());
  const cache = projectTemplateSemanticProfileCache(path.join(root, 'projects'), 'project-profile');

  const first = new TemplateSemanticProfiler(adapter(endpoint.baseUrl), cache, { promptDirectory });
  await first.profile(templateIR, presentationDesignSystem);
  assert.equal(endpoint.state.inference.length, 1);
  await writeFile(promptPath, `${sourcePrompt}\nUse no inferred template identity.\n`, 'utf8');

  const changedPrompt = new TemplateSemanticProfiler(adapter(endpoint.baseUrl), cache, { promptDirectory });
  await changedPrompt.profile(templateIR, presentationDesignSystem);
  assert.equal(endpoint.state.inference.length, 2, 'prompt contents contribute to the persistent cache key');
});

test('profiler config version invalidates profiles produced from the previous evidence shape', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-config-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { templateIR, presentationDesignSystem } = await fixture(root);
  const contract = JSON.parse(await readFile(path.join(process.cwd(), 'apps/daemon/src/presentation/contracts/template-profiler.v1.json'), 'utf8'));
  assert.equal(contract.configVersion, 'template-profiler-config.v3');
  const prompt = (await readFile(path.join(process.cwd(), 'apps/daemon/prompts/template-profiler.v2.md'), 'utf8')).replace(/\s+/g, ' ').trim();
  const promptSha256 = createHash('sha256').update(prompt, 'utf8').digest('hex');
  const oldCacheKey = createHash('sha256').update(JSON.stringify({
    templateIRHash: templateIR.hash,
    promptVersion: 'template-profiler.v2',
    promptSha256,
    schemaCompatibility: 'template_semantic_profile_v1',
    configVersion: 'template-profiler-config.v2',
  })).digest('hex');
  const cache = projectTemplateSemanticProfileCache(path.join(root, 'projects'), 'project-profile');
  const legacyProfile = {
    templateIRHash: templateIR.hash,
    slides: templateIR.slides.map((slide) => ({
      sourceSlideIndex: slide.index,
      archetype: 'content',
      supportedContentModes: ['text'],
      titleElementId: null,
      bodyElementIds: [],
      visualElementIds: [],
      preservedElementIds: [],
      replaceableTextElementIds: [],
      confidence: 0.1,
      reasonCodes: ['legacy_cache_entry'],
    })),
  };
  await cache.write(legacyProfile, oldCacheKey);
  const endpoint = await startFakeSemanticEndpoint({ model });
  t.after(() => endpoint.close());
  const profiler = new TemplateSemanticProfiler(adapter(endpoint.baseUrl), cache);

  const currentProfile = await profiler.profile(templateIR, presentationDesignSystem);
  assert.equal(endpoint.state.inference.length, 1, 'a profile cache entry with the previous configVersion is ignored');
  assert.ok(!currentProfile.slides[0].reasonCodes.includes('legacy_cache_entry'));
});
