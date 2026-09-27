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
    usage: { prompt_tokens: 17, completion_tokens: 23 },
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
  const profileSchema = request.response_format.json_schema.schema;
  assert.deepEqual(profileSchema.properties.templateIRHash.enum, [templateIR.hash], 'the schema binds responses to this exact TemplateIR');
  assert.equal(profileSchema.properties.slides.minItems, templateIR.slides.length);
  assert.equal(profileSchema.properties.slides.maxItems, templateIR.slides.length);
  const slideSchemaBranches = profileSchema.properties.slides.items.anyOf;
  assert.equal(slideSchemaBranches.length, templateIR.slides.length);
  for (const sourceSlide of templateIR.slides) {
    const branch = slideSchemaBranches.find((candidate) => candidate.properties.sourceSlideIndex.enum[0] === sourceSlide.index);
    assert.ok(branch, `schema has a branch for source slide ${sourceSlide.index}`);
    const textIds = sourceSlide.elements.filter((element) => element.text?.trim()).map((element) => element.id);
    const allIds = sourceSlide.elements.map((element) => element.id);
    const replaceableIds = sourceSlide.elements.filter((element) => element.kind.toLowerCase() === 'shape'
      && element.nativeId && element.text?.trim()).map((element) => element.id);
    assert.deepEqual(branch.properties.titleElementId.enum, [null, ...textIds]);
    for (const [field, allowedIds] of [['bodyElementIds', textIds], ['visualElementIds', allIds],
      ['preservedElementIds', allIds], ['replaceableTextElementIds', replaceableIds]]) {
      const arraySchema = branch.properties[field];
      assert.equal(arraySchema.maxItems, allowedIds.length);
      if (allowedIds.length) assert.deepEqual(arraySchema.items.enum, allowedIds, `${field} is limited to IDs valid for this slide and role`);
      else assert.equal('items' in arraySchema, false, `${field} is restricted to an empty list when no IDs qualify`);
    }
  }
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

test('batch schema narrows profile references and runtime validation reports safe invariant codes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { templateIR, presentationDesignSystem } = await fixture(root);
  const firstSlide = templateIR.slides[0];
  const firstTextId = firstSlide.elements.find((element) => element.text?.trim())?.id;
  const otherSlideTextId = templateIR.slides[1].elements.find((element) => element.text?.trim())?.id;
  const nonTextId = firstSlide.elements.find((element) => !element.text?.trim())?.id;
  assert.ok(firstTextId && otherSlideTextId && nonTextId, 'synthetic fixture provides text and non-text references across slides');
  const cases = [
    ['invented-element-id', 'UNKNOWN_ELEMENT_ID', (value) => { value.slides[0].bodyElementIds = ['invented-element-id']; }],
    ['element-from-another-slide', 'ELEMENT_FROM_DIFFERENT_SLIDE', (value) => { value.slides[0].bodyElementIds = [otherSlideTextId]; }],
    ['wrong-hash', 'HASH_MISMATCH', (value) => { value.templateIRHash = '0'.repeat(64); }],
    ['duplicate-slide-index', 'DUPLICATE_SLIDE_INDEX', (value) => { value.slides[1].sourceSlideIndex = value.slides[0].sourceSlideIndex; }],
    ['unexpected-slide-index', 'UNEXPECTED_SLIDE_INDEX', (value) => { value.slides[0].sourceSlideIndex = 999999; }],
    ['non-text-title', 'TITLE_NOT_TEXT', (value) => {
      const slide = value.slides[0];
      slide.bodyElementIds = slide.bodyElementIds.filter((id) => id !== nonTextId);
      slide.visualElementIds = slide.visualElementIds.filter((id) => id !== nonTextId);
      slide.preservedElementIds = slide.preservedElementIds.filter((id) => id !== nonTextId);
      slide.replaceableTextElementIds = slide.replaceableTextElementIds.filter((id) => id !== nonTextId);
      slide.titleElementId = nonTextId;
    }],
    ['non-text-body', 'BODY_NOT_TEXT', (value) => {
      const slide = value.slides[0];
      slide.titleElementId = null;
      slide.visualElementIds = slide.visualElementIds.filter((id) => id !== nonTextId);
      slide.preservedElementIds = slide.preservedElementIds.filter((id) => id !== nonTextId);
      slide.replaceableTextElementIds = slide.replaceableTextElementIds.filter((id) => id !== nonTextId);
      slide.bodyElementIds = [nonTextId];
    }],
    ['invalid-replaceable-element', 'INVALID_REPLACEABLE_ELEMENT', (value) => {
      const slide = value.slides[0];
      slide.titleElementId = null;
      slide.bodyElementIds = slide.bodyElementIds.filter((id) => id !== nonTextId);
      slide.visualElementIds = slide.visualElementIds.filter((id) => id !== nonTextId);
      slide.preservedElementIds = slide.preservedElementIds.filter((id) => id !== nonTextId);
      slide.replaceableTextElementIds = [nonTextId];
    }],
    ['duplicate-element-role', 'DUPLICATE_ELEMENT_ROLE', (value) => {
      const slide = value.slides[0];
      slide.titleElementId = firstTextId;
      slide.bodyElementIds = [firstTextId];
      slide.visualElementIds = slide.visualElementIds.filter((id) => id !== firstTextId);
      slide.preservedElementIds = slide.preservedElementIds.filter((id) => id !== firstTextId);
      slide.replaceableTextElementIds = slide.replaceableTextElementIds.filter((id) => id !== firstTextId);
    }],
  ];
  for (const [invalid, validationFailureCode, mutate] of cases) {
    await t.test(invalid, async (subtest) => {
      let observedSchema;
      const endpoint = await startFakeSemanticEndpoint({
        model,
        respond(request) {
          observedSchema = request.response_format.json_schema.schema;
          const normal = deterministicPlanningResponse(request);
          const content = JSON.parse(normal.choices[0].message.content);
          if (invalid === 'invented-element-id') {
            const textIds = firstSlide.elements.filter((element) => element.text?.trim()).map((element) => element.id);
            const schemaBranch = observedSchema.properties.slides.items.anyOf.find((branch) => branch.properties.sourceSlideIndex.enum[0] === firstSlide.index);
            assert.ok(!schemaBranch.properties.bodyElementIds.items.enum.includes('invented-element-id'), 'the provider schema excludes an invented ID before runtime validation');
            assert.ok(!schemaBranch.properties.bodyElementIds.items.enum.includes(otherSlideTextId), 'the provider schema excludes an ID belonging to another slide');
            assert.ok(textIds.includes(firstTextId));
          }
          mutate(content);
          return completion(content);
        },
      });
      subtest.after(() => endpoint.close());
      const profiler = new TemplateSemanticProfiler(adapter(endpoint.baseUrl));
      await assert.rejects(profiler.profile(templateIR, presentationDesignSystem), (error) => {
        assert.equal(error.code, 'INVALID_STRUCTURED_OUTPUT');
        assert.equal(error.telemetry.runtimeSchemaValidation, 'failed');
        assert.equal(error.telemetry.validationFailureCode, validationFailureCode);
        assert.equal(error.telemetry.promptTokens, 17);
        assert.equal(error.telemetry.completionTokens, 23);
        assert.ok(!JSON.stringify(error.telemetry).includes('invented-element-id'), 'diagnostics contain no raw model output');
        return true;
      });
      assert.ok(observedSchema, 'batch-specific schema was sent to the provider');
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
  assert.ok(plan.batches.every((batch) => batch.sourceSlideIndexes.length <= 4));
  assert.ok(plan.batches.every((batch) => batch.evidenceBytes <= 24 * 1024));
  assert.ok(plan.batches.every((batch) => batch.maxOutputTokens >= 2048 && batch.maxOutputTokens <= 4096));
  assert.ok(plan.batches.some((batch) => batch.sourceSlideIndexes.length === 4 && batch.maxOutputTokens === 4096));
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
    assert.equal(request.timeoutMs, 180000);
    assert.equal(request.output.schema.properties.slides.minItems, batch.sourceSlideIndexes.length);
    assert.equal(request.output.schema.properties.slides.maxItems, batch.sourceSlideIndexes.length);
    assert.deepEqual(request.output.schema.properties.slides.items.anyOf.map((branch) => branch.properties.sourceSlideIndex.enum[0]), batch.sourceSlideIndexes);
  });
  assert.ok(observedRequests.every((request) => request.output.name === 'template_semantic_profile_v1'));
  assert.ok(endpoint.state.inference.every((entry) => entry.request.response_format.type === 'json_schema'
    && entry.request.response_format.json_schema.strict === true));

  await profiler.profile(templateIR, presentationDesignSystem);
  assert.equal(endpoint.state.inference.length, plan.batches.length, 'the complete in-memory profile cache avoids later provider requests');
});

test('profile preparation bounds concurrent batches, merges deterministically, and read-only cache misses make no requests', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-concurrency-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { templateIR, presentationDesignSystem } = await fixture(root, { slideCount: 17 });
  const plan = planTemplateSemanticProfileBatches(templateIR);
  let active = 0;
  let maximumActive = 0;
  const requestBatchNumbers = [];
  let writes = 0;
  const cache = { async read() { return null; }, async write() { writes += 1; } };
  const fake = {
    async infer(request) {
      const batchNumber = request.metadata.templateProfilerBatch.batchNumber;
      requestBatchNumbers.push(batchNumber);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, (plan.batches.length - batchNumber + 1) * 8));
        const response = deterministicPlanningResponse({
          model,
          messages: request.messages,
          response_format: { json_schema: { name: request.output.name } },
        });
        return { value: JSON.parse(response.choices[0].message.content), telemetry: {} };
      } finally { active -= 1; }
    },
  };
  const profiler = new TemplateSemanticProfiler(fake, cache, { concurrency: 2 });
  const profile = await profiler.prepareTemplateProfile(templateIR, presentationDesignSystem);
  assert.equal(maximumActive, 2);
  assert.equal(writes, 1, 'only the fully merged, validated profile is persisted');
  assert.deepEqual(requestBatchNumbers, plan.batches.map((batch) => batch.batchNumber));
  assert.deepEqual(profile.slides.map((slide) => slide.sourceSlideIndex), templateIR.slides.map((slide) => slide.index));

  const failedRequests = [];
  let failedWrites = 0;
  const failingProfiler = new TemplateSemanticProfiler({
    async infer(request) {
      const batchNumber = request.metadata.templateProfilerBatch.batchNumber;
      failedRequests.push(batchNumber);
      if (batchNumber === 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('first batch failed');
      }
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('sibling batch aborted')), { once: true });
      });
    },
  }, { async read() { return null; }, async write() { failedWrites += 1; } }, { concurrency: 2 });
  await assert.rejects(failingProfiler.prepareTemplateProfile(templateIR, presentationDesignSystem));
  assert.deepEqual(failedRequests.sort(), [1, 2], 'no later batch starts after the first provider failure');
  assert.equal(failedWrites, 0, 'failed concurrent preparation never stores a partial profile');

  const emptyCacheProfiler = new TemplateSemanticProfiler({ async infer() { throw new Error('read-only lookup must not infer'); } }, {
    async read() { return null; }, async write() { throw new Error('read-only lookup must not write'); },
  });
  assert.equal(await emptyCacheProfiler.getPreparedTemplateProfile(templateIR, presentationDesignSystem), null);
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
  assert.equal(contract.configVersion, 'template-profiler-config.v6');
  assert.equal(contract.maxSlidesPerBatch, 4);
  assert.equal(contract.maxBatchEvidenceBytes, 24 * 1024);
  assert.equal(contract.maxBatches, 14);
  assert.equal(contract.maxOutputTokens, 4096);
  assert.equal(contract.timeoutMs, 180000);
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
