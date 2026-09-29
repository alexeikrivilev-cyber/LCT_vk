import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { makeSyntheticPptx } from '../python-inspector-test-fixtures.mjs';
import { inspectPptx } from '../src/presentation/adapters/python-inspector.ts';
import { OpenAICompatibleSemanticInferenceAdapter } from '../src/presentation/adapters/openai-compatible-semantic-inference.ts';
import { createDeterministicTemplateSemanticProfile, planTemplateSemanticProfileBatches, projectTemplateSemanticProfileCache, templateSemanticProfileCacheKey, templateSemanticProfileJsonSchema, TemplateSemanticProfiler, validateTemplateSemanticProfile } from '../src/presentation/application/template-semantic-profiler.ts';
import { createTemplateIR, derivePresentationDesignSystem } from '../src/presentation/application/template-mapper.ts';
import { sha256Json, templateIRHashPayload } from '../src/presentation/domain/template-ir.ts';
import { SemanticInferenceError } from '../src/presentation/application/semantic-inference-port.ts';
import { startFakeSemanticEndpoint, deterministicPlanningResponse } from '../../../scripts/lib/fake-openai-compatible-endpoint.mjs';

const model = 'offline-fake-planner';
const profilerPromptPath = path.join(process.cwd(), 'apps/daemon/prompts/template-profiler.v3.md');

async function profilerPrompt() {
  return (await readFile(profilerPromptPath, 'utf8')).replace(/\s+/gu, ' ').trim();
}

async function fixture(root, { slideCount = 3, groupTransform } = {}) {
  await mkdir(root, { recursive: true });
  const filePath = path.join(root, 'private-template-name.pptx');
  const bytes = await makeSyntheticPptx({ slideCount, layoutCount: 4, groupTransform });
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

function strictFakeProfileResponse(request) {
  const response = deterministicPlanningResponse({
    model,
    messages: request.messages,
    response_format: { json_schema: { name: request.output.name } },
  });
  const value = JSON.parse(response.choices[0].message.content);
  assert.equal(request.output.validate(value), true, 'the same runtime profile contract validates every fake response');
  return { value, telemetry: {} };
}

function profileFailure(code, finishReason) {
  return new SemanticInferenceError(code, 'synthetic profiler failure', {
    telemetry: {
      role: 'worker', operation: 'template-semantic-profile', model, requestId: 'test-request',
      startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(), wallTimeMs: 1,
      ...(finishReason ? { httpStatus: 200, finishReason } : {}), status: 'error', errorCode: code,
    },
  });
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
  assert.equal(endpoint.state.inference.length, 2, 'three source slides are profiled in two bounded batches');
  const requests = endpoint.state.inference.map((record) => record.request);
  for (const request of requests) {
    assert.equal(request.response_format.type, 'json_schema');
    assert.equal(request.response_format.json_schema.strict, true);
    assert.equal(request.response_format.json_schema.name, 'template_semantic_profile_v1');
    const profileSchema = request.response_format.json_schema.schema;
    assert.deepEqual(profileSchema.properties.templateIRHash.enum, [templateIR.hash], 'the schema binds responses to this exact TemplateIR');
    const requestEvidence = JSON.parse(request.messages.at(-1).content);
    assert.equal(profileSchema.properties.slides.minItems, requestEvidence.slides.length);
    assert.equal(profileSchema.properties.slides.maxItems, requestEvidence.slides.length);
    const slideSchemaBranches = profileSchema.properties.slides.items.anyOf;
    assert.equal(slideSchemaBranches.length, requestEvidence.slides.length);
    for (const evidenceSlide of requestEvidence.slides) {
      const sourceSlide = templateIR.slides.find((slide) => slide.index === evidenceSlide.sourceSlideIndex);
    const branch = slideSchemaBranches.find((candidate) => candidate.properties.sourceSlideIndex.enum[0] === sourceSlide.index);
    assert.ok(branch, `schema has a branch for source slide ${sourceSlide.index}`);
    const textIds = sourceSlide.elements.filter((element) => element.text?.trim()).map((element) => element.id);
    const allIds = sourceSlide.elements.map((element) => element.id);
    const replaceableIds = sourceSlide.elements.filter((element) => element.kind.toLowerCase() === 'shape'
      && element.nativeId && element.text?.trim()).map((element) => element.id);
    const definitions = profileSchema.$defs;
    const titleStringRef = branch.properties.titleElementId.anyOf.find((candidate) => candidate.$ref)?.$ref;
    assert.deepEqual(titleStringRef ? definitions[titleStringRef.split('/').at(-1)].enum : [null], textIds.length ? textIds : [null]);
    for (const [field, allowedIds] of [['bodyElementIds', textIds], ['visualElementIds', allIds],
      ['preservedElementIds', allIds], ['replaceableTextElementIds', replaceableIds]]) {
      const arraySchema = branch.properties[field];
      assert.equal(arraySchema.maxItems, allowedIds.length);
      if (allowedIds.length) {
        assert.ok(arraySchema.items.$ref, `${field} uses the bounded ID definition`);
        assert.deepEqual(definitions[arraySchema.items.$ref.split('/').at(-1)].enum, allowedIds, `${field} is limited to IDs valid for this slide and role`);
      }
      else assert.equal('items' in arraySchema, false, `${field} is restricted to an empty list when no IDs qualify`);
    }
    }
  }
  const request = requests[0];
  const configuredPrompt = (await readFile(path.join(process.cwd(), 'apps/daemon/prompts/template-profiler.v3.md'), 'utf8')).replace(/\s+/g, ' ').trim();
  assert.equal(request.messages[0].content, configuredPrompt, 'the runtime sends the versioned Markdown prompt without rewriting its content');
  const evidence = JSON.parse(request.messages.at(-1).content);
  assert.ok(evidence.slides[0].elements.some((element) => element.id));
  assert.equal(evidence.slides.length, 2, 'each request carries only its bounded source-slide batch');
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
  assert.equal(endpoint.state.inference.length, 2, 'same TemplateIR hash uses the cached profile');

  const promptSha256 = createHash('sha256').update(configuredPrompt, 'utf8').digest('hex');
  const cacheKey = templateSemanticProfileCacheKey(templateIR.hash, promptSha256);
  const persistedPath = path.join(root, 'projects', 'project-profile', '.template-compiler', 'semantic-profiles', `${cacheKey}.json`);
  const persisted = JSON.parse(await readFile(persistedPath, 'utf8'));
  assert.equal(persisted.templateIRHash, templateIR.hash);
  const reloadedProfiler = new TemplateSemanticProfiler(adapter(endpoint.baseUrl), projectTemplateSemanticProfileCache(path.join(root, 'projects'), 'project-profile'));
  const afterReload = await reloadedProfiler.profile(templateIR, presentationDesignSystem);
  assert.equal(afterReload.templateIRHash, templateIR.hash);
  assert.equal(endpoint.state.inference.length, 2, 'a new profiler instance uses the project-owned cache after daemon reload');

  const changed = structuredClone(templateIR);
  changed.source.originalName = 'renamed-template.pptx';
  changed.hash = sha256Json(templateIRHashPayload(changed));
  const changedPds = derivePresentationDesignSystem(changed);
  await profiler.profile(changed, changedPds);
  assert.equal(endpoint.state.inference.length, 4, 'a different validated TemplateIR hash gets two requests for its independently profiled batches');
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
            const bodyIdDefinition = observedSchema.$defs[schemaBranch.properties.bodyElementIds.items.$ref.split('/').at(-1)];
            assert.ok(!bodyIdDefinition.enum.includes('invented-element-id'), 'the provider schema excludes an invented ID before runtime validation');
            assert.ok(!bodyIdDefinition.enum.includes(otherSlideTextId), 'the provider schema excludes an ID belonging to another slide');
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

test('profiler resolves same-role and cross-role duplicates before strict validation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-role-normalization-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { templateIR, presentationDesignSystem } = await fixture(root, { groupTransform: {} });
  const firstSlide = templateIR.slides[0];
  const textIds = firstSlide.elements.filter((element) => element.text?.trim()).map((element) => element.id);
  const replaceableId = firstSlide.elements.find((element) => element.kind.toLowerCase() === 'shape'
    && element.nativeId && element.text?.trim() && element.id !== textIds[0])?.id;
  const nonTextId = firstSlide.elements.find((element) => !element.text?.trim())?.id;
  const foreignSlideId = templateIR.slides[1].elements.find((element) => element.text?.trim())?.id;
  assert.ok(textIds[0] && textIds[1] && replaceableId && nonTextId && foreignSlideId,
    'fixture provides multiple text IDs, replaceable text, a non-text element, and a neighboring slide ID');

  async function runScenario(mutate) {
    const endpoint = await startFakeSemanticEndpoint({
      model,
      respond(request) {
        const response = deterministicPlanningResponse(request);
        const value = JSON.parse(response.choices[0].message.content);
        const expectedSlideIndexes = request.response_format.json_schema.schema.properties.slides.items.anyOf
          .map((branch) => branch.properties.sourceSlideIndex.enum[0]);
        if (expectedSlideIndexes.includes(firstSlide.index)) {
          mutate(value.slides.find((slide) => slide.sourceSlideIndex === firstSlide.index));
        }
        return completion(value);
      },
    });
    try {
      let batchTelemetry;
      const logRecords = [];
      const delegate = adapter(endpoint.baseUrl);
      const recordingAdapter = {
        model,
        async infer(request) {
          const previousLog = console.log;
          console.log = (...values) => logRecords.push(...values);
          try { return await delegate.infer(request); }
          finally {
            console.log = previousLog;
            if (request.metadata.templateProfilerBatch.sourceSlideIndexes.includes(firstSlide.index)) {
              batchTelemetry = structuredClone(request.metadata.templateProfilerBatch);
            }
          }
        },
      };
      const profiler = new TemplateSemanticProfiler(recordingAdapter);
      try {
        const profile = await profiler.profile(templateIR, presentationDesignSystem);
        return { profile, batchTelemetry, logRecords };
      } catch (error) {
        return { error, batchTelemetry, logRecords };
      }
    } finally {
      await endpoint.close();
    }
  }

  const bodyAndPreserved = await runScenario((slide) => {
    slide.titleElementId = null;
    slide.bodyElementIds = [textIds[0]];
    slide.visualElementIds = [];
    slide.preservedElementIds = [textIds[0]];
    slide.replaceableTextElementIds = [];
  });
  assert.ok(bodyAndPreserved.profile, `body/preserved conflict passes the existing runtime validator after normalization: ${bodyAndPreserved.error?.message ?? 'no profile returned'}`);
  assert.deepEqual(bodyAndPreserved.profile.slides[0].bodyElementIds, [textIds[0]]);
  assert.deepEqual(bodyAndPreserved.profile.slides[0].preservedElementIds, []);
  assert.equal(bodyAndPreserved.batchTelemetry.roleConflictResolved, true);
  assert.equal(bodyAndPreserved.batchTelemetry.resolvedConflictCount, 1);
  const safeLog = bodyAndPreserved.logRecords.map((record) => JSON.parse(record))
    .find((record) => record.roleConflictResolved === true);
  assert.ok(safeLog, 'safe telemetry includes the batch where normalization occurred');
  assert.equal(safeLog.roleConflictResolved, true);
  assert.equal(safeLog.resolvedConflictCount, 1);
  assert.ok(!JSON.stringify(safeLog).includes(textIds[0]), 'safe telemetry contains no element ID');
  assert.ok(!JSON.stringify(safeLog).includes(firstSlide.elements.find((element) => element.id === textIds[0]).text),
    'safe telemetry contains no slide text');

  await t.test('same-role duplicates are stably deduplicated through the adapter contract', async () => {
    const repeatedBody = await runScenario((slide) => {
      slide.titleElementId = null;
      slide.bodyElementIds = [textIds[1], textIds[0], textIds[1], textIds[0]];
      slide.visualElementIds = [];
      slide.preservedElementIds = [];
      slide.replaceableTextElementIds = [];
    });
    assert.ok(repeatedBody.profile, 'repeated body IDs pass the existing runtime validator after normalization');
    assert.deepEqual(repeatedBody.profile.slides[0].bodyElementIds, [textIds[1], textIds[0]],
      'first occurrence order is stable');
    assert.equal(repeatedBody.batchTelemetry.roleConflictResolved, true);
    assert.equal(repeatedBody.batchTelemetry.resolvedConflictCount, 2,
      'telemetry counts distinct IDs whose repeated assignments were removed');

    const repeatedVisualWithLowerPriorityConflict = await runScenario((slide) => {
      slide.titleElementId = null;
      slide.bodyElementIds = [];
      slide.visualElementIds = [nonTextId, textIds[0], nonTextId];
      slide.preservedElementIds = [nonTextId];
      slide.replaceableTextElementIds = [];
    });
    assert.ok(repeatedVisualWithLowerPriorityConflict.profile,
      'repeated visual IDs and a lower-priority role conflict are normalized before validation');
    assert.deepEqual(repeatedVisualWithLowerPriorityConflict.profile.slides[0].visualElementIds, [nonTextId, textIds[0]],
      'visual IDs retain stable first-occurrence ordering');
    assert.deepEqual(repeatedVisualWithLowerPriorityConflict.profile.slides[0].preservedElementIds, [],
      'the higher-priority visual assignment wins over preserved');
    assert.equal(repeatedVisualWithLowerPriorityConflict.batchTelemetry.roleConflictResolved, true);
    assert.equal(repeatedVisualWithLowerPriorityConflict.batchTelemetry.resolvedConflictCount, 1,
      'the duplicate and cross-role conflict for one ID are counted once');
  });

  const preservedAndReplaceable = await runScenario((slide) => {
    slide.titleElementId = null;
    slide.bodyElementIds = [];
    slide.visualElementIds = [];
    slide.preservedElementIds = [replaceableId];
    slide.replaceableTextElementIds = [replaceableId];
  });
  assert.ok(preservedAndReplaceable.profile, 'preserved/replaceable conflict passes after normalization');
  assert.deepEqual(preservedAndReplaceable.profile.slides[0].preservedElementIds, [replaceableId]);
  assert.deepEqual(preservedAndReplaceable.profile.slides[0].replaceableTextElementIds, []);
  assert.equal(preservedAndReplaceable.batchTelemetry.resolvedConflictCount, 1);

  const titleAndBody = await runScenario((slide) => {
    slide.titleElementId = textIds[0];
    slide.bodyElementIds = [textIds[0]];
    slide.visualElementIds = [];
    slide.preservedElementIds = [];
    slide.replaceableTextElementIds = [];
  });
  assert.ok(titleAndBody.profile, 'title/body conflict passes after normalization');
  assert.equal(titleAndBody.profile.slides[0].titleElementId, textIds[0]);
  assert.deepEqual(titleAndBody.profile.slides[0].bodyElementIds, []);
  assert.equal(titleAndBody.batchTelemetry.roleConflictResolved, true);
  assert.equal(titleAndBody.batchTelemetry.resolvedConflictCount, 1);

  const multipleConflicts = await runScenario((slide) => {
    slide.titleElementId = textIds[0];
    slide.bodyElementIds = [textIds[0], textIds[1]];
    slide.visualElementIds = [textIds[1]];
    slide.preservedElementIds = [replaceableId];
    slide.replaceableTextElementIds = [replaceableId];
  });
  assert.ok(multipleConflicts.profile, 'multiple conflicts are normalized before the strict validator');
  assert.deepEqual(multipleConflicts.profile.slides[0].bodyElementIds, [textIds[1]]);
  assert.deepEqual(multipleConflicts.profile.slides[0].visualElementIds, []);
  assert.deepEqual(multipleConflicts.profile.slides[0].preservedElementIds, [replaceableId]);
  assert.deepEqual(multipleConflicts.profile.slides[0].replaceableTextElementIds, []);
  assert.equal(multipleConflicts.batchTelemetry.roleConflictResolved, true);
  assert.equal(multipleConflicts.batchTelemetry.resolvedConflictCount, 3);

  for (const [name, invalidId, expectedCode, mutateInvalid] of [
    ['unknown ID', 'invented-after-normalization', 'UNKNOWN_ELEMENT_ID', (slide) => { slide.visualElementIds.push('invented-after-normalization'); }],
    ['wrong slide', foreignSlideId, 'ELEMENT_FROM_DIFFERENT_SLIDE', (slide) => { slide.visualElementIds.push(foreignSlideId); }],
    ['invalid replaceable', nonTextId, 'INVALID_REPLACEABLE_ELEMENT', (slide) => { slide.replaceableTextElementIds = [nonTextId]; }],
  ]) {
    const invalidAfterNormalization = await runScenario((slide) => {
      slide.titleElementId = textIds[0];
      slide.bodyElementIds = [textIds[0]];
      slide.visualElementIds = [];
      slide.preservedElementIds = [];
      slide.replaceableTextElementIds = [];
      mutateInvalid(slide);
    });
    assert.ok(!invalidAfterNormalization.profile, `${name} must remain rejected after duplicate resolution`);
    assert.equal(invalidAfterNormalization.error.telemetry.validationFailureCode, expectedCode, name);
    assert.equal(invalidAfterNormalization.batchTelemetry.roleConflictResolved, true);
    assert.equal(invalidAfterNormalization.batchTelemetry.resolvedConflictCount, 1);
    assert.ok(!JSON.stringify(invalidAfterNormalization.batchTelemetry).includes(invalidId), 'safe telemetry contains no element IDs');
  }
});

test('large templates use deterministic slide- and byte-bounded batches and merge in canonical order', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-batches-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { templateIR, presentationDesignSystem } = await fixture(root, { slideCount: 17 });
  const plan = planTemplateSemanticProfileBatches(templateIR, await profilerPrompt());
  assert.ok(plan.batches.length > 1);
  assert.ok(plan.batches.length <= 32);
  assert.ok(plan.batches.every((batch) => batch.sourceSlideIndexes.length <= 2));
  assert.ok(plan.batches.every((batch) => batch.evidenceBytes <= 24 * 1024));
  assert.ok(plan.batches.every((batch) => batch.estimatedTotalRequestBytes <= 48 * 1024));
  assert.ok(plan.batches.every((batch) => batch.estimatedTotalRequestBytes === batch.systemPromptBytes + batch.evidenceBytes
    + batch.schemaBytes + batch.envelopeOverheadBytes + batch.outputTokenReserveBytes));
  assert.ok(plan.batches.every((batch) => batch.outputTokenReserveBytes === batch.maxOutputTokens * 4));
  assert.ok(plan.batches.every((batch) => batch.maxOutputTokens === Math.max(2048, batch.sourceSlideIndexes.length * 1024)));
  assert.ok(plan.batches.every((batch) => batch.maxOutputTokens >= 2048 && batch.maxOutputTokens <= 4096));
  assert.ok(plan.batches.some((batch) => batch.sourceSlideIndexes.length === 2 && batch.maxOutputTokens === 2048));
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
      systemPromptBytes: batch.systemPromptBytes,
      evidenceBytes: batch.evidenceBytes,
      schemaBytes: batch.schemaBytes,
      envelopeOverheadBytes: batch.envelopeOverheadBytes,
      outputTokenReserveBytes: batch.outputTokenReserveBytes,
      estimatedTotalRequestBytes: batch.estimatedTotalRequestBytes,
      roleConflictResolved: false,
      resolvedConflictCount: 0,
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

test('two-slide batching covers qualification-sized templates within their batch and byte budgets', async (t) => {
  for (const { slideCount, maximumBatches } of [
    { slideCount: 10, maximumBatches: 5 },
    { slideCount: 29, maximumBatches: 15 },
    { slideCount: 55, maximumBatches: 28 },
  ]) {
    await t.test(`${slideCount} slides`, async (subtest) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `lct-template-profile-${slideCount}-slides-`));
      subtest.after(() => rm(root, { recursive: true, force: true }));
      const { templateIR } = await fixture(root, { slideCount });
      const plan = planTemplateSemanticProfileBatches(templateIR, await profilerPrompt());
      const indexes = plan.batches.flatMap((batch) => batch.sourceSlideIndexes);

      assert.ok(plan.batches.length <= maximumBatches, `at most ${maximumBatches} batches`);
      assert.ok(plan.batches.length < 32, 'the template does not approach the configured 32-batch ceiling');
      assert.deepEqual(indexes, templateIR.slides.map((slide) => slide.index), 'all indexes are covered once in source order');
      assert.equal(new Set(indexes).size, slideCount, 'no source slide index is duplicated');
      assert.ok(plan.batches.every((batch) => batch.sourceSlideIndexes.length <= 2));
      assert.ok(plan.batches.every((batch) => batch.evidenceBytes <= 24 * 1024));
      assert.ok(plan.batches.every((batch) => batch.estimatedTotalRequestBytes <= 48 * 1024));
      assert.ok(plan.batches.every((batch) => batch.maxOutputTokens >= 2048 && batch.maxOutputTokens <= 4096));
      assert.ok(plan.batches.every((batch) => batch.maxOutputTokens === 2048), 'one- and two-slide batches retain the 2048-token floor');
    });
  }
});

test('profile preparation bounds concurrent batches, merges deterministically, and read-only cache misses make no requests', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-concurrency-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { templateIR, presentationDesignSystem } = await fixture(root, { slideCount: 17 });
  const plan = planTemplateSemanticProfileBatches(templateIR, await profilerPrompt());
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

test('two-slide finish_reason=length recovers as ordered, strictly validated single-slide requests', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-length-split-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { templateIR, presentationDesignSystem } = await fixture(root, { slideCount: 2 });
  const requests = [];
  let writes = 0;
  const profiler = new TemplateSemanticProfiler({
    async infer(request) {
      const indexes = request.metadata.templateProfilerBatch.sourceSlideIndexes;
      requests.push({ indexes: [...indexes], maxOutputTokens: request.maxOutputTokens, schema: request.output.schema });
      if (requests.length === 1) throw profileFailure('INVALID_STRUCTURED_OUTPUT', 'length');
      return strictFakeProfileResponse(request);
    },
  }, { async read() { return null; }, async write() { writes += 1; } });

  const profile = await profiler.prepareTemplateProfile(templateIR, presentationDesignSystem);
  assert.deepEqual(requests.map((request) => request.indexes), [[1, 2], [1], [2]]);
  assert.ok(requests.slice(1).every((request) => request.maxOutputTokens === 2048));
  assert.equal(profile.slides.length, 2);
  assert.deepEqual(profile.slides.map((slide) => slide.sourceSlideIndex), [1, 2]);
  assert.equal(writes, 1, 'only the complete profile is cached after both recovered slides validate');
});

test('two-slide transport failure splits once into strict single-slide requests', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-transport-split-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { templateIR, presentationDesignSystem } = await fixture(root, { slideCount: 2 });
  const requests = [];
  const profiler = new TemplateSemanticProfiler({
    async infer(request) {
      const indexes = request.metadata.templateProfilerBatch.sourceSlideIndexes;
      requests.push([...indexes]);
      if (requests.length === 1) throw profileFailure('SERVICE_UNAVAILABLE');
      return strictFakeProfileResponse(request);
    },
  });

  const profile = await profiler.prepareTemplateProfile(templateIR, presentationDesignSystem);
  assert.deepEqual(requests, [[1, 2], [1], [2]]);
  assert.deepEqual(profile.slides.map((slide) => slide.sourceSlideIndex), [1, 2]);
});

test('single-slide finish_reason=length gets at most one larger retry within the request budget', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-single-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { templateIR, presentationDesignSystem } = await fixture(root, { slideCount: 1 });
  const requests = [];
  const profiler = new TemplateSemanticProfiler({
    async infer(request) {
      requests.push(request);
      if (requests.length === 1) throw profileFailure('INVALID_STRUCTURED_OUTPUT', 'length');
      return strictFakeProfileResponse(request);
    },
  });

  const profile = await profiler.prepareTemplateProfile(templateIR, presentationDesignSystem);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].maxOutputTokens, 2048);
  assert.equal(requests[1].maxOutputTokens, 4096);
  assert.ok(requests[1].metadata.templateProfilerBatch.estimatedTotalRequestBytes <= 48 * 1024);
  assert.ok(requests[1].metadata.templateProfilerBatch.outputTokenReserveBytes
    > requests[0].metadata.templateProfilerBatch.outputTokenReserveBytes);
  assert.equal(validateTemplateSemanticProfile(profile, templateIR).slides.length, 1);
});

test('a still-truncated single slide is attempted only twice and never writes a partial profile', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-single-exhausted-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { templateIR, presentationDesignSystem } = await fixture(root, { slideCount: 1 });
  let calls = 0;
  let writes = 0;
  const profiler = new TemplateSemanticProfiler({
    async infer() { calls += 1; throw profileFailure('INVALID_STRUCTURED_OUTPUT', 'length'); },
  }, { async read() { return null; }, async write() { writes += 1; } });

  await assert.rejects(profiler.prepareTemplateProfile(templateIR, presentationDesignSystem), (error) => error.code === 'INVALID_STRUCTURED_OUTPUT');
  assert.equal(calls, 2);
  assert.equal(writes, 0);
});

test('deterministic fallback profiles remain low-confidence, same-slide, role-exclusive, and strictly valid', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { templateIR, presentationDesignSystem } = await fixture(root, { slideCount: 3 });
  const profile = createDeterministicTemplateSemanticProfile(templateIR, presentationDesignSystem, 'semantic_unavailable');
  assert.equal(validateTemplateSemanticProfile(profile, templateIR).slides.length, templateIR.slides.length);
  assert.ok(profile.slides.every((slide) => slide.confidence < 0.6));
  for (const slideProfile of profile.slides) {
    const source = templateIR.slides.find((slide) => slide.index === slideProfile.sourceSlideIndex);
    const roles = [
      ...(slideProfile.titleElementId ? [slideProfile.titleElementId] : []),
      ...slideProfile.bodyElementIds, ...slideProfile.visualElementIds,
      ...(slideProfile.preservedElementIds ?? []), ...(slideProfile.replaceableTextElementIds ?? []),
    ];
    assert.equal(new Set(roles).size, roles.length);
    assert.ok(roles.every((id) => source.elements.some((element) => element.id === id)));
    assert.deepEqual(slideProfile.replaceableTextElementIds, [], 'unknown sample copy is never silently cleared');
    assert.ok(slideProfile.reasonCodes.includes('deterministic_fallback'));
  }
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

  const plan = planTemplateSemanticProfileBatches(templateIR, await profilerPrompt());
  assert.equal(plan.batches.length, 1);
  assert.ok(plan.batches[0].evidenceBytes <= 24 * 1024);
  const evidence = JSON.parse(plan.batches[0].evidence);
  assert.equal(evidence.slides[0].elements.length, 120);
  assert.deepEqual(evidence.slides[0].elements.map((element) => element.id), slide.elements.map((element) => element.id));
  assert.equal(evidence.slides[0].textEvidenceTruncated, true);
  assert.ok(evidence.slides[0].elements.every((element) => !element.text || element.text.length <= 320));
});

test('strict profiler schema exposes only element IDs present in bounded slide evidence', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-evidence-schema-alignment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { templateIR } = await fixture(root, { slideCount: 1 });
  const slide = templateIR.slides[0];
  const sourceElement = structuredClone(slide.elements.find((element) => element.text?.trim()));
  assert.ok(sourceElement, 'fixture provides a text element');
  slide.elements = Array.from({ length: 132 }, (_, index) => ({
    ...structuredClone(sourceElement),
    id: `bounded_evidence_${index + 1}`,
    nativeId: String(index + 1),
    order: index + 1,
    text: `Bounded evidence sample ${index + 1}`,
  }));
  templateIR.hash = sha256Json(templateIRHashPayload(templateIR));

  const schema = templateSemanticProfileJsonSchema(templateIR, [slide]);
  const branch = schema.properties.slides.items.anyOf[0];
  const evidenceIds = slide.elements.slice(0, 120).map((element) => element.id);
  const definitions = schema.$defs;
  const allowed = (field) => {
    const item = branch.properties[field].items;
    return item.$ref ? definitions[item.$ref.split('/').at(-1)].enum : [];
  };
  for (const field of ['bodyElementIds', 'visualElementIds', 'preservedElementIds', 'replaceableTextElementIds']) {
    assert.deepEqual(allowed(field), field === 'bodyElementIds'
      ? evidenceIds
      : evidenceIds, `${field} cannot reference elements omitted from bounded evidence`);
    assert.ok(!allowed(field).includes('bounded_evidence_121'));
  }
});

test('bounded profile evidence keeps readable text and the strongest non-text candidates before smaller decoration', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-priority-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { templateIR } = await fixture(root, { slideCount: 1 });
  const slide = templateIR.slides[0];
  const textTemplate = structuredClone(slide.elements.find((element) => element.text?.trim()));
  const visualTemplate = structuredClone(slide.elements.find((element) => !element.text?.trim()));
  assert.ok(textTemplate && visualTemplate, 'fixture provides text and non-text elements');
  const textElements = Array.from({ length: 25 }, (_, index) => ({
    ...structuredClone(textTemplate), id: `priority_text_${index + 1}`, nativeId: String(index + 1), order: index + 1,
    text: `Readable template claim ${index + 1}`,
  }));
  const visualElements = Array.from({ length: 100 }, (_, index) => ({
    ...structuredClone(visualTemplate), id: `priority_visual_${index + 1}`, nativeId: String(index + 101),
    order: index + 26, kind: index < 3 ? 'picture' : 'shape', text: null, placeholder: null,
    geometry: {
      ...structuredClone(visualTemplate.geometry),
      direct: { x: 100, y: 200, width: (100 - index) * 1000, height: (100 - index) * 1000, rotation: 0, unit: 'EMU' },
      resolved: { x: 100, y: 200, width: (100 - index) * 1000, height: (100 - index) * 1000, rotation: 0, unit: 'EMU' },
    },
  }));
  slide.elements = [...textElements, ...visualElements];
  slide.designElementIds = [];
  templateIR.hash = sha256Json(templateIRHashPayload(templateIR));

  const plan = planTemplateSemanticProfileBatches(templateIR, await profilerPrompt());
  const evidence = plan.batches.flatMap((batch) => JSON.parse(batch.evidence).slides)
    .find((item) => item.sourceSlideIndex === slide.index);
  assert.ok(evidence, 'bounded profile plan includes the source slide');
  const ids = new Set(evidence.elements.map((element) => element.id));
  assert.equal(evidence.elements.length, 45, 'all readable text plus the configured top 20 non-text elements fit');
  assert.ok(textElements.every((element) => ids.has(element.id)), 'source text is not displaced by decoration');
  assert.ok(visualElements.slice(0, 20).every((element) => ids.has(element.id)), 'media and largest visual objects are retained first');
  assert.ok(visualElements.slice(20).every((element) => !ids.has(element.id)), 'low-priority remainder is omitted deterministically');
  assert.equal(evidence.evidenceTruncated, true);
  assert.equal(evidence.textEvidenceTruncated, undefined, 'all readable text survived evidence prioritization');
});

test('dense schema makes the planner split a batch even when the evidence alone fits', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-schema-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { templateIR } = await fixture(root, { slideCount: 4 });
  for (const slide of templateIR.slides) {
    const sourceElement = structuredClone(slide.elements[0]);
    assert.ok(sourceElement, 'synthetic slide has a source element to clone');
    slide.elements = Array.from({ length: 30 }, (_, index) => ({
      ...structuredClone(sourceElement),
      id: `schema_dense_slide_${slide.index}_element_${index}_${'x'.repeat(220)}`,
      nativeId: String(index + 1), name: `Dense text ${index + 1}`, order: index + 1,
      kind: 'shape', text: `Dense synthetic sample copy ${index + 1}`, placeholder: null,
    }));
    slide.designElementIds = [];
  }
  templateIR.hash = sha256Json(templateIRHashPayload(templateIR));
  const prompt = await profilerPrompt();
  const plan = planTemplateSemanticProfileBatches(templateIR, prompt);
  const candidateSlides = templateIR.slides.slice(0, 2);
  const candidateEvidence = {
    templateIRHash: templateIR.hash,
    canvas: { width: templateIR.slideSize.width, height: templateIR.slideSize.height },
    slides: plan.batches.flatMap((batch) => JSON.parse(batch.evidence).slides)
      .filter((slide) => candidateSlides.some((candidate) => candidate.index === slide.sourceSlideIndex)),
  };
  const evidenceBytes = Buffer.byteLength(JSON.stringify(candidateEvidence), 'utf8');
  const generatedSchema = templateSemanticProfileJsonSchema(templateIR, candidateSlides);
  const schemaBytes = Buffer.byteLength(JSON.stringify(generatedSchema), 'utf8');
  const maxOutputTokens = Math.min(4096, Math.max(2048, candidateSlides.length * 1024));
  const oversizedRequestBytes = Buffer.byteLength(prompt, 'utf8') + evidenceBytes + schemaBytes + 2048 + maxOutputTokens * 4;

  assert.ok(evidenceBytes <= 24 * 1024, `the combined evidence alone fits the evidence ceiling (${evidenceBytes} bytes)`);
  assert.ok(oversizedRequestBytes > 48 * 1024, `the generated strict schema pushes the full request beyond budget (evidence=${evidenceBytes}, schema=${schemaBytes}, total=${oversizedRequestBytes})`);
  assert.ok(plan.batches.length > 1, 'planner splits rather than emitting the oversized request');
  assert.ok(plan.batches.length <= 32);
  assert.deepEqual(plan.batches.flatMap((batch) => batch.sourceSlideIndexes), templateIR.slides.map((slide) => slide.index),
    'all source slides are covered exactly once and in source order');
  assert.equal(new Set(plan.batches.flatMap((batch) => batch.sourceSlideIndexes)).size, templateIR.slides.length);
  assert.ok(plan.batches.every((batch) => batch.sourceSlideIndexes.length <= 2));
  assert.ok(plan.batches.every((batch) => batch.evidenceBytes <= 24 * 1024));
  assert.ok(plan.batches.every((batch) => batch.estimatedTotalRequestBytes <= 48 * 1024));
  assert.ok(plan.batches.every((batch) => batch.schemaBytes === Buffer.byteLength(JSON.stringify(batch.schema), 'utf8')));
  assert.ok(!plan.batches.some((batch) => batch.sourceSlideIndexes.join(',') === candidateSlides.map((slide) => slide.index).join(',')),
    'the otherwise evidence-valid 3-slide candidate is split by the full-request ceiling');
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
    () => planTemplateSemanticProfileBatches(templateIR, 'bounded synthetic profiler prompt'),
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
  const promptText = (await readFile(path.join(process.cwd(), 'apps/daemon/prompts/template-profiler.v3.md'), 'utf8')).replace(/\s+/g, ' ').trim();
  const promptSha256 = createHash('sha256').update(promptText, 'utf8').digest('hex');
  const cacheKey = templateSemanticProfileCacheKey(templateIR.hash, promptSha256);
  const profilePath = path.join(root, 'projects', 'project-profile', '.template-compiler', 'semantic-profiles', `${cacheKey}.json`);
  await mkdir(path.dirname(profilePath), { recursive: true });

  await writeFile(profilePath, '{broken-json', 'utf8');
  await profiler.profile(templateIR, presentationDesignSystem);
  assert.equal(endpoint.state.inference.length, 2, 'malformed JSON is removed and replaced by a validated strict response across two batches');
  assert.equal(JSON.parse(await readFile(profilePath, 'utf8')).templateIRHash, templateIR.hash);

  profiler.clear();
  await writeFile(profilePath, JSON.stringify({ templateIRHash: templateIR.hash, slides: [] }), 'utf8');
  await profiler.profile(templateIR, presentationDesignSystem);
  assert.equal(endpoint.state.inference.length, 4, 'a parsed cache with invalid slide coverage is also discarded and both batches are regenerated');
  assert.equal(JSON.parse(await readFile(profilePath, 'utf8')).slides.length, templateIR.slides.length);
});

test('changing the versioned template-profiler prompt invalidates its project profile cache', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-prompt-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { templateIR, presentationDesignSystem } = await fixture(root);
  const promptDirectory = path.join(root, 'prompts');
  await mkdir(promptDirectory, { recursive: true });
  const sourcePrompt = await readFile(path.join(process.cwd(), 'apps/daemon/prompts/template-profiler.v3.md'), 'utf8');
  const normalizedPrompt = sourcePrompt.replace(/\s+/g, ' ');
  assert.match(normalizedPrompt, /AT MOST ONE(?: of)?/u);
  for (const role of ['titleElementId', 'bodyElementIds', 'visualElementIds', 'preservedElementIds', 'replaceableTextElementIds']) {
    assert.ok(normalizedPrompt.includes(role), `the role-exclusivity rule must name ${role}`);
  }
  assert.match(normalizedPrompt, /Never (?:duplicate an ID across fields|use the same ID in two fields)/u);
  assert.match(normalizedPrompt, /(?:single|one) best-supported role/u);
  const promptPath = path.join(promptDirectory, 'template-profiler.v3.md');
  await writeFile(promptPath, sourcePrompt, 'utf8');
  const endpoint = await startFakeSemanticEndpoint({ model });
  t.after(() => endpoint.close());
  const cache = projectTemplateSemanticProfileCache(path.join(root, 'projects'), 'project-profile');

  const first = new TemplateSemanticProfiler(adapter(endpoint.baseUrl), cache, { promptDirectory });
  const initialCacheKey = await first.profileCacheKey(templateIR);
  await first.profile(templateIR, presentationDesignSystem);
  assert.equal(endpoint.state.inference.length, 2, 'the three-slide fixture is split into two profile requests');
  await writeFile(promptPath, `${sourcePrompt}\nUse no inferred template identity.\n`, 'utf8');

  const changedPrompt = new TemplateSemanticProfiler(adapter(endpoint.baseUrl), cache, { promptDirectory });
  assert.notEqual(await changedPrompt.profileCacheKey(templateIR), initialCacheKey,
    'changed prompt content must change the semantic-profile cache fingerprint');
  await changedPrompt.profile(templateIR, presentationDesignSystem);
  assert.equal(endpoint.state.inference.length, 4, 'prompt contents contribute to the persistent cache key for both bounded batches');
});

test('profiler config version invalidates profiles produced from the previous evidence shape', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-config-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { templateIR, presentationDesignSystem } = await fixture(root);
  const contract = JSON.parse(await readFile(path.join(process.cwd(), 'apps/daemon/src/presentation/contracts/template-profiler.v1.json'), 'utf8'));
  assert.equal(contract.configVersion, 'template-profiler-config.v8');
  assert.equal(contract.maxSlidesPerBatch, 2);
  assert.equal(contract.maxBatchEvidenceBytes, 24 * 1024);
  assert.equal(contract.maxNonTextEvidenceElementsPerSlide, 20);
  assert.equal(contract.maxBatches, 32);
  assert.equal(contract.maxEstimatedRequestBytes, 48 * 1024);
  assert.equal(contract.requestEnvelopeOverheadBytes, 2048);
  assert.equal(contract.outputTokenByteReserve, 4);
  assert.equal(contract.maxOutputTokens, 4096);
  assert.equal(contract.timeoutMs, 180000);
  const prompt = (await readFile(path.join(process.cwd(), 'apps/daemon/prompts/template-profiler.v3.md'), 'utf8')).replace(/\s+/g, ' ').trim();
  const promptSha256 = createHash('sha256').update(prompt, 'utf8').digest('hex');
  const oldCacheKey = createHash('sha256').update(JSON.stringify({
    templateIRHash: templateIR.hash,
    promptVersion: 'template-profiler.v3',
    promptSha256,
    schemaCompatibility: 'template_semantic_profile_v1',
    configVersion: 'template-profiler-config.v6',
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
  assert.equal(endpoint.state.inference.length, 2, 'a profile cache entry with the previous configVersion is ignored and both batches are profiled');
  assert.ok(!currentProfile.slides[0].reasonCodes.includes('legacy_cache_entry'));
});
