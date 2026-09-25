import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { makeSyntheticPptx } from '../python-inspector-test-fixtures.mjs';
import { inspectPptx } from '../src/presentation/adapters/python-inspector.ts';
import { OpenAICompatibleSemanticInferenceAdapter } from '../src/presentation/adapters/openai-compatible-semantic-inference.ts';
import { projectTemplateSemanticProfileCache, TemplateSemanticProfiler } from '../src/presentation/application/template-semantic-profiler.ts';
import { createTemplateIR, derivePresentationDesignSystem } from '../src/presentation/application/template-mapper.ts';
import { sha256Json, templateIRHashPayload } from '../src/presentation/domain/template-ir.ts';
import { startFakeSemanticEndpoint, deterministicPlanningResponse } from '../../../scripts/lib/fake-openai-compatible-endpoint.mjs';

const model = 'offline-fake-planner';

async function fixture(root) {
  await mkdir(root, { recursive: true });
  const filePath = path.join(root, 'private-template-name.pptx');
  const bytes = await makeSyntheticPptx({ slideCount: 3, layoutCount: 4 });
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

test('semantic template profile uses strict HTTP adapter output, validates all references, and caches by TemplateIR hash', async (t) => {
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
  assert.equal(endpoint.state.inference.length, 1);
  const request = endpoint.state.inference[0].request;
  assert.equal(request.response_format.type, 'json_schema');
  assert.equal(request.response_format.json_schema.strict, true);
  assert.equal(request.response_format.json_schema.name, 'template_semantic_profile_v1');
  const evidence = JSON.parse(request.messages.at(-1).content);
  assert.ok(evidence.slides[0].elements.some((element) => element.id));
  assert.ok(!JSON.stringify(evidence).includes('private-template-name'));
  assert.ok(!JSON.stringify(evidence).includes('layoutName'));

  first.slides[0].reasonCodes.push('caller_mutation');
  const cached = await profiler.profile(templateIR, presentationDesignSystem);
  assert.ok(!cached.slides[0].reasonCodes.includes('caller_mutation'));
  assert.equal(endpoint.state.inference.length, 1, 'same TemplateIR hash uses the cached profile');

  const persistedPath = path.join(root, 'projects', 'project-profile', '.template-compiler', 'semantic-profiles', `${templateIR.hash}.json`);
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

test('corrupt or invalid persisted semantic profiles are discarded and reprofiled through the strict adapter', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-corrupt-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { templateIR, presentationDesignSystem } = await fixture(root);
  const endpoint = await startFakeSemanticEndpoint({ model });
  t.after(() => endpoint.close());
  const cache = projectTemplateSemanticProfileCache(path.join(root, 'projects'), 'project-profile');
  const profiler = new TemplateSemanticProfiler(adapter(endpoint.baseUrl), cache);
  const profilePath = path.join(root, 'projects', 'project-profile', '.template-compiler', 'semantic-profiles', `${templateIR.hash}.json`);
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
