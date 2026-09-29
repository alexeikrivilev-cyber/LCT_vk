import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { register } from 'tsx/esm/api';

import { makeSyntheticPptx } from '../python-inspector-test-fixtures.mjs';
import { createExemplarTemplate, createHybridExemplarTemplate } from './exemplar-template-fixtures.mjs';
import { deterministicPlanningResponse, startFakeSemanticEndpoint } from '../../../scripts/lib/fake-openai-compatible-endpoint.mjs';

register();
const { startServer } = await import('../src/server.ts');
const { SemanticInferenceError } = await import('../src/presentation/application/semantic-inference-port.ts');
const { OpenAICompatibleSemanticInferenceAdapter } = await import('../src/presentation/adapters/openai-compatible-semantic-inference.ts');
const { compileTemplate } = await import('../src/presentation/application/template-compiler.ts');
const { projectTemplateSemanticProfileCache, projectTemplateSemanticProfilePreparationStore, TemplateSemanticProfiler } = await import('../src/presentation/application/template-semantic-profiler.ts');

const repoRoot = path.resolve(import.meta.dirname, '../../..');

async function closeStartedServer(started) {
  await new Promise((resolve, reject) => started.server.close((error) => error ? reject(error) : resolve()));
  await started.shutdown();
}

async function json(response) {
  return response.json();
}

async function waitForProfileState(started, projectId, terminal = ['ready', 'degraded-ready', 'failed'], timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${started.url}/api/projects/${projectId}/template`);
    assert.equal(response.status, 200);
    last = await response.json();
    if (terminal.includes(last.semanticProfile?.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Template semantic profile did not reach a terminal state: ${JSON.stringify(last?.semanticProfile)}`);
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

function validProfileResponse(request) {
  const response = deterministicPlanningResponse({
    model: 'offline-template-profile', messages: request.messages,
    response_format: { json_schema: { name: request.output.name } },
  });
  const value = JSON.parse(response.choices[0].message.content);
  assert.equal(request.output.validate(value), true);
  return { value, telemetry: {} };
}

function objectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) for (const child of value) objectKeys(child, keys);
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      objectKeys(child, keys);
    }
  }
  return keys;
}

test('Template Compiler API persists understanding, detects source changes, and preserves the last success', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-template-compiler-api-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const dataDir = path.join(temp, 'data');
  const endpoint = await startFakeSemanticEndpoint({ model: 'offline-template-profile' });
  t.after(() => endpoint.close());
  const options = { host: '127.0.0.1', port: 0, dataDir, projectRoot: repoRoot, serveWeb: false, returnServer: true,
    enableSemanticProfiling: true,
    semanticInferenceAdapter: new OpenAICompatibleSemanticInferenceAdapter({ baseUrl: endpoint.baseUrl, model: 'offline-template-profile', enableThinking: false }) };
  let started = await startServer(options);
  assert.equal(typeof started, 'object');
  const projectId = 'template-understanding';
  try {
    const created = await fetch(`${started.url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'Template understanding test' }),
    });
    assert.equal(created.status, 201);

    const pptx = await makeSyntheticPptx({ slideCount: 2, layoutCount: 2, unsupported: true, slideBackground: true, nestedTemplateGroups: true });
    const originalHash = createHash('sha256').update(pptx).digest('hex');
    const templateName = 'Шаблон презентации.pptx';
    const upload = new FormData();
    upload.append('files', new Blob([pptx]), templateName);
    const uploaded = await fetch(`${started.url}/api/projects/${projectId}/upload`, { method: 'POST', body: upload });
    assert.equal(uploaded.status, 200);
    const uploadBody = await json(uploaded);
    assert.equal(uploadBody.files[0].path, templateName);
    assert.equal(uploadBody.files[0].originalName, templateName);

    const compiled = await fetch(`${started.url}/api/projects/${projectId}/template/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: templateName }),
    });
    if (compiled.status === 503) {
      const response = await json(compiled);
      if (response.failure?.code === 'INSPECTOR_UNAVAILABLE') {
        t.skip('Python 3.12 unavailable: compile API integration is BLOCKED, not passed');
        return;
      }
    }
    assert.equal(compiled.status, 202, await compiled.clone().text());
    const acceptedBody = await json(compiled);
    assert.equal(acceptedBody.semanticProfile.status, 'processing');
    assert.equal(acceptedBody.semanticProfile.cached, false);
    const compiledBody = { ...acceptedBody, semanticProfile: (await waitForProfileState(started, projectId)).semanticProfile };
    assert.equal(compiledBody.status, 'ready');
    assert.equal(compiledBody.source.filePath, templateName);
    assert.equal(compiledBody.source.sha256, originalHash);
    assert.equal(compiledBody.templateIR.slides.length, 2);
    assert.equal(compiledBody.presentationDesignSystem.templateIRId, compiledBody.templateIR.id);
    assert.equal(compiledBody.semanticProfile.status, 'ready');
    assert.equal(compiledBody.semanticProfile.cached, true, 'the later state read reports the persisted profile cache');
    assert.ok(!Object.hasOwn(compiledBody, 'inspection'), 'the private inspection DTO must not be exposed');
    const irKeys = objectKeys(compiledBody.templateIR);
    assert.equal(irKeys.has('protocolVersion'), false);
    assert.equal(irKeys.has('schemaStatus'), false);
    assert.equal(irKeys.has('raw'), false, 'private inspector DTO copies must not be persisted as canonical IR');
    assert.equal(irKeys.has('geometryResolutionUnknown'), false, 'private geometry protocol flags do not leak into canonical IR');
    const firstElement = compiledBody.templateIR.slides[0].elements.find((element) => element.text === 'Synthetic takeaway 1');
    assert.ok(firstElement, 'the exact synthetic source text is retained');
    assert.equal(firstElement.placeholder.index, '7');
    assert.equal(firstElement.placeholder.type, 'title');
    assert.equal(firstElement.geometry.direct.x, 914400);
    assert.equal(firstElement.geometry.resolved.x, 914400);
    assert.equal(firstElement.directStyles.fonts[0], 'Aptos');
    assert.equal(firstElement.directStyles.fontSizesPt[0], 24);
    assert.equal(compiledBody.templateIR.theme.colors.accent1, '123456');
    assert.equal(compiledBody.templateIR.theme.fonts.major, 'Aptos Display');
    assert.deepEqual(compiledBody.templateIR.notesParts, ['ppt/notesMasters/notesMaster1.xml', 'ppt/notesSlides/notesSlide1.xml']);
    assert.deepEqual(compiledBody.templateIR.masters[0].background, {
      kind: 'scheme_reference', index: '1001', schemeColor: 'bg1', schemeColorType: 'schemeClr',
    });
    assert.deepEqual(compiledBody.templateIR.masters[0].colorMapping, { masterMapping: { accent1: 'accent2' }, layoutOverrides: null });
    assert.deepEqual(compiledBody.templateIR.layouts[0].background, {
      kind: 'explicit', element: 'solidFill',
      fill: { kind: 'solidFill', attributes: {}, colors: [{ type: 'srgbClr', attributes: { val: 'FFFFFF' }, position: null }], relationshipNativeId: null },
    });
    assert.deepEqual(compiledBody.templateIR.slides[0].background, {
      kind: 'explicit', element: 'solidFill',
      fill: { kind: 'solidFill', attributes: {}, colors: [{ type: 'schemeClr', attributes: { val: 'accent1' }, position: null }], relationshipNativeId: null },
    });
    assert.ok(compiledBody.templateIR.masters[0].elements.some((element) => element.name === 'Master group child'));
    assert.ok(compiledBody.templateIR.layouts[0].elements.some((element) => element.name === 'Layout group 1 child'));
    assert.deepEqual(compiledBody.templateIR.layouts[0].colorMapping, {
      masterMapping: null,
      layoutOverrides: [{ element: 'overrideClrMapping', attributes: { accent1: 'accent2' } }],
    });
    assert.ok(compiledBody.templateIR.assets.some((asset) => asset.part === 'ppt/media/image1.png'));
    assert.ok(compiledBody.templateIR.unsupported.some((item) => item.part === 'ppt/customXml/item1.xml'));
    const slideRelations = compiledBody.templateIR.slides[0].relationships;
    assert.ok(slideRelations.some((relationship) => relationship.mode === 'external'
      && relationship.target === 'https://example.test/image.png' && relationship.targetPart === null));
    assert.ok(slideRelations.some((relationship) => relationship.mode === 'internal'
      && relationship.target === '../media/image1.png' && relationship.targetPart === 'ppt/media/image1.png'));
    assert.ok(compiledBody.presentationDesignSystem.typography.observedFonts.includes('Aptos'));
    assert.ok(compiledBody.presentationDesignSystem.typography.observedSizesPt.includes(24));
    assert.ok(compiledBody.presentationDesignSystem.colors.direct.some((color) => color.role === 'fill'
      && color.value === '336699' && color.uses > 0));
    assert.equal(compiledBody.presentationDesignSystem.layouts.length, 2);
    assert.equal(compiledBody.presentationDesignSystem.layouts[0].usageCount, 2);
    assert.equal(createHash('sha256').update(await readFile(path.join(dataDir, 'projects', projectId, templateName))).digest('hex'), originalHash,
      'compilation must preserve the uploaded source bytes');

    await closeStartedServer(started);
    started = await startServer(options);
    const reloaded = await fetch(`${started.url}/api/projects/${projectId}/template`);
    assert.equal(reloaded.status, 200);
    const reloadedBody = await json(reloaded);
    assert.equal(reloadedBody.status, 'ready', 'compiled state survives daemon restart');
    assert.equal(reloadedBody.templateIR.hash, compiledBody.templateIR.hash);
    assert.equal(reloadedBody.semanticProfile.status, 'ready', 'profile readiness survives daemon restart');
    assert.equal(reloadedBody.semanticProfile.cached, true);
    assert.equal(Object.hasOwn(reloadedBody, 'semanticProfileData'), false, 'GET exposes status, not profile contents');

    const inheritedProjectId = 'inherited-placeholder-typography';
    assert.equal((await fetch(`${started.url}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: inheritedProjectId, name: 'Inherited placeholder typography' }),
    })).status, 201);
    const inheritedPath = path.join(temp, 'inherited-placeholder.pptx');
    await createHybridExemplarTemplate(inheritedPath, { masterName: 'Inherited typography test' });
    const inheritedBytes = await readFile(inheritedPath);
    const inheritedUpload = new FormData();
    inheritedUpload.append('files', new Blob([inheritedBytes]), 'inherited-placeholder.pptx');
    assert.equal((await fetch(`${started.url}/api/projects/${inheritedProjectId}/upload`, { method: 'POST', body: inheritedUpload })).status, 200);
    const inferredResponse = await fetch(`${started.url}/api/projects/${inheritedProjectId}/template/compile`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: 'inherited-placeholder.pptx' }),
    });
    assert.equal(inferredResponse.status, 202);
    const inferredAccepted = await inferredResponse.json();
    const inferred = { ...inferredAccepted, semanticProfile: (await waitForProfileState(started, inheritedProjectId)).semanticProfile };
    assert.equal(inferred.status, 'ready');
    const inheritedTitle = inferred.templateIR.slides.flatMap((slide) => slide.elements)
      .find((element) => element.text === 'Native source title sample');
    assert.ok(inheritedTitle, 'the test title placeholder is inspected');
    assert.ok(inheritedTitle.effectiveFontSizesPt?.includes(30),
      'the pinned Office Kit style cascade resolves the master-inherited 30pt title font');
    const profilerCalls = endpoint.state.inference.filter((item) => item.operation === 'template-semantic-profile').length;
    const inheritedAgain = await json(await fetch(`${started.url}/api/projects/${inheritedProjectId}/template/compile`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: 'inherited-placeholder.pptx' }),
    }));
    assert.equal(inheritedAgain.templateIR.hash, inferred.templateIR.hash, 'derived typography does not perturb structural template identity');
    assert.equal(inheritedAgain.semanticProfile.cached, true, 'the derived style observation does not invalidate the profile cache');
    assert.equal(endpoint.state.inference.filter((item) => item.operation === 'template-semantic-profile').length, profilerCalls,
      'recompilation reuses the READY profile without another semantic request');

    const missingProject = await fetch(`${started.url}/api/projects/does-not-exist/template`);
    assert.equal(missingProject.status, 404);
    const invalidPath = await fetch(`${started.url}/api/projects/${projectId}/template/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: '../outside.pptx' }),
    });
    assert.equal(invalidPath.status, 400);
    const failedPathState = await json(await fetch(`${started.url}/api/projects/${projectId}/template`));
    assert.equal(failedPathState.status, 'failed');
    assert.equal(failedPathState.source.filePath, 'outside.pptx');
    assert.equal(failedPathState.source.originalName, 'outside.pptx');
    assert.ok(!JSON.stringify(failedPathState).includes('../outside.pptx'));
    const absolutePath = path.join(os.tmpdir(), 'outside-absolute.pptx');
    const invalidAbsolutePath = await fetch(`${started.url}/api/projects/${projectId}/template/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: absolutePath }),
    });
    assert.equal(invalidAbsolutePath.status, 400);
    const failedAbsolutePathState = await json(await fetch(`${started.url}/api/projects/${projectId}/template`));
    assert.equal(failedAbsolutePathState.status, 'failed');
    assert.equal(failedAbsolutePathState.source.filePath, 'outside-absolute.pptx');
    assert.ok(!JSON.stringify(failedAbsolutePathState).includes(absolutePath));
    const noTemplate = await fetch(`${started.url}/api/projects/${projectId}/template/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: 'missing.pptx' }),
    });
    assert.equal(noTemplate.status, 404);

    const recompilation = await fetch(`${started.url}/api/projects/${projectId}/template/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: templateName }),
    });
    assert.equal(recompilation.status, 200);
    assert.equal((await json(recompilation)).templateIR.hash, compiledBody.templateIR.hash,
      'identical PPTX bytes map to the same TemplateIR hash across compilations');
    const modified = Buffer.concat([pptx, Buffer.from([0])]);
    await writeFile(path.join(dataDir, 'projects', projectId, templateName), modified);
    const stale = await json(await fetch(`${started.url}/api/projects/${projectId}/template`));
    assert.equal(stale.status, 'stale');
    assert.equal(stale.currentSourceSha256, createHash('sha256').update(modified).digest('hex'));

    const corruptUpload = new FormData();
    corruptUpload.append('files', new Blob([Buffer.from('not a pptx')]), 'broken.pptx');
    assert.equal((await fetch(`${started.url}/api/projects/${projectId}/upload`, { method: 'POST', body: corruptUpload })).status, 200);
    const invalidPptx = await fetch(`${started.url}/api/projects/${projectId}/template/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: 'broken.pptx' }),
    });
    assert.equal(invalidPptx.status, 422);
    assert.equal((await json(invalidPptx)).failure.code, 'INVALID_PPTX');
    const failedState = await json(await fetch(`${started.url}/api/projects/${projectId}/template`));
    assert.equal(failedState.status, 'failed');
    const persistedState = JSON.parse(await readFile(path.join(dataDir, 'projects', projectId, '.template-compiler', 'state.json'), 'utf8'));
    assert.equal(persistedState.lastSuccessful.templateIR.hash, compiledBody.templateIR.hash,
      'a failed attempt must not overwrite the last successful canonical result');
  } finally {
    await closeStartedServer(started);
  }
});

test('semantic provider failure persists a validated degraded profile and allows the planning path to start', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profiler-error-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  let inferenceCalls = 0;
  let profileCalls = 0;
  const started = await startServer({
    host: '127.0.0.1', port: 0, dataDir: path.join(temp, 'data'), projectRoot: repoRoot,
    serveWeb: false, returnServer: true,
    enableSemanticProfiling: true,
    semanticInferenceAdapter: { async infer(request) {
      inferenceCalls += 1;
      if (request.operation === 'template-semantic-profile') {
        profileCalls += 1;
        throw new SemanticInferenceError('PROVIDER_ERROR', 'unsafe raw provider message');
      }
      throw new SemanticInferenceError('SERVICE_UNAVAILABLE', 'offline after preparation');
    } },
  });
  const projectId = 'semantic-profile-boundary';
  try {
    const created = await fetch(`${started.url}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'Semantic profile boundary test' }),
    });
    assert.equal(created.status, 201);
    const fallbackTemplatePath = path.join(temp, 'fallback-template.pptx');
    await createExemplarTemplate(fallbackTemplatePath, { includePicture: false });
    const pptx = await readFile(fallbackTemplatePath);
    const upload = new FormData();
    upload.append('files', new Blob([pptx]), 'Шаблон.pptx');
    assert.equal((await fetch(`${started.url}/api/projects/${projectId}/upload`, { method: 'POST', body: upload })).status, 200);

    const response = await fetch(`${started.url}/api/projects/${projectId}/template/compile`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: 'Шаблон.pptx' }),
    });
    assert.equal(response.status, 202);
    const accepted = await response.json();
    assert.equal(accepted.semanticProfile.status, 'processing');
    assert.equal(accepted.semanticProfile.cached, false);
    assert.doesNotMatch(JSON.stringify(accepted), /unsafe raw provider message|C:\\\\|node_modules/u);

    const savedBody = await waitForProfileState(started, projectId, ['degraded-ready']);
    assert.equal(savedBody.status, 'ready', 'structural readiness remains separately observable after profile failure');
    assert.equal(savedBody.semanticProfile.status, 'degraded-ready');
    assert.equal(savedBody.semanticProfile.degradationCode, 'PROVIDER_ERROR', JSON.stringify(savedBody.semanticProfile));
    assert.equal(profileCalls, 1, 'the exhausted semantic preparation is not retried by polling');

    const cached = await json(await fetch(`${started.url}/api/projects/${projectId}/template`));
    assert.equal(cached.semanticProfile.status, 'degraded-ready');
    assert.equal(cached.semanticProfile.cached, true);
    assert.equal(profileCalls, 1, 'the deterministic fallback is persisted in the normal validated profile cache');
    const blocked = await fetch(`${started.url}/api/projects/${projectId}/workflow/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateFilePath: 'Шаблон.pptx', contentFiles: [], brief: {
        audience: 'Продуктовая команда', purpose: 'Подготовить краткий обзор.',
        expectedOutcome: 'Согласовать следующий шаг.', preferences: [], requestedSlideCount: 1,
      } }),
    });
    assert.equal(blocked.status, 202, 'the prepared degraded profile lets the ordinary planning path start');
    await waitForProfileState(started, projectId, ['degraded-ready']);
    const planningStarted = await waitFor(() => inferenceCalls > profileCalls);
    const workflowState = await json(await fetch(`${started.url}/api/projects/${projectId}/workflow`));
    assert.equal(planningStarted, true, `the detached planning workflow reaches its separate inference request; state=${JSON.stringify(workflowState.operation && {
      status: workflowState.operation.status, stage: workflowState.operation.stage, failure: workflowState.operation.failure,
    })}`);
    assert.equal(profileCalls, 1, 'planning never starts template profiling again');
    assert.ok(inferenceCalls > profileCalls, 'the workflow can make its normal, separate planning request');
  } finally {
    await new Promise((resolve, reject) => started.server.close((error) => error ? reject(error) : resolve()));
    await started.shutdown();
  }
});

test('explicit structural-only diagnostic mode does not profile during template compilation', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-required-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const dataDir = path.join(temp, 'data');
  let inferenceCalls = 0;
  const started = await startServer({
    host: '127.0.0.1', port: 0, dataDir, projectRoot: repoRoot,
    serveWeb: false, returnServer: true,
    enableSemanticProfiling: false,
    semanticInferenceAdapter: { async infer() { inferenceCalls += 1; throw new Error('unexpected semantic inference'); } },
  });
  const projectId = 'missing-semantic-profile';
  try {
    assert.equal((await fetch(`${started.url}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: projectId, name: 'Profile gate test' }),
    })).status, 201);
    const upload = new FormData();
    upload.append('files', new Blob([await makeSyntheticPptx({ slideCount: 2, layoutCount: 2 })]), 'template.pptx');
    assert.equal((await fetch(`${started.url}/api/projects/${projectId}/upload`, { method: 'POST', body: upload })).status, 200);
    const structural = await compileTemplate(path.join(dataDir, 'projects'), projectId, 'template.pptx');
    assert.equal(structural.status, 'ready');
    const state = await json(await fetch(`${started.url}/api/projects/${projectId}/template`));
    assert.equal(state.status, 'ready');
    assert.equal(state.semanticProfile.status, 'disabled');
    assert.equal(inferenceCalls, 0, 'endpoint configuration does not cause a template-profiler call');
  } finally {
    await closeStartedServer(started);
  }
});

test('template preparation profiles before Generate and exposes read-only cache status', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profiler-preparation-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const endpoint = await startFakeSemanticEndpoint({ model: 'offline-configured-endpoint' });
  t.after(() => endpoint.close());
  const envKeys = ['LCT_SEMANTIC_BASE_URL', 'LCT_SEMANTIC_MODEL', 'LCT_SEMANTIC_API_KEY', 'LCT_SEMANTIC_ENABLE_THINKING'];
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.LCT_SEMANTIC_BASE_URL = endpoint.baseUrl;
  process.env.LCT_SEMANTIC_MODEL = 'offline-configured-endpoint';
  process.env.LCT_SEMANTIC_ENABLE_THINKING = 'false';
  delete process.env.LCT_SEMANTIC_API_KEY;
  t.after(() => {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  const started = await startServer({
    host: '127.0.0.1', port: 0, dataDir: path.join(temp, 'data'), projectRoot: repoRoot,
    serveWeb: false, returnServer: true,
    enableSemanticProfiling: true,
  });
  const projectId = 'structural-template-only';
  try {
    const created = await fetch(`${started.url}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'Structural template understanding' }),
    });
    assert.equal(created.status, 201);
    const template = await makeSyntheticPptx({ slideCount: 2, layoutCount: 2, nestedTemplateGroups: true });
    const upload = new FormData();
    upload.append('files', new Blob([template]), 'structural-template.pptx');
    assert.equal((await fetch(`${started.url}/api/projects/${projectId}/upload`, { method: 'POST', body: upload })).status, 200);
    const response = await fetch(`${started.url}/api/projects/${projectId}/template/compile`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: 'structural-template.pptx' }),
    });
    assert.equal(response.status, 202, await response.clone().text());
    const accepted = await response.json();
    assert.equal(accepted.semanticProfile.status, 'processing');
    const compiled = { ...accepted, semanticProfile: (await waitForProfileState(started, projectId)).semanticProfile };
    assert.equal(compiled.status, 'ready');
    assert.equal(compiled.semanticProfile.status, 'ready');
    assert.equal(compiled.semanticProfile.cached, true, 'the terminal state reports the persisted profile cache');
    assert.ok(compiled.templateIR?.hash);
    assert.ok(compiled.presentationDesignSystem);
    assert.equal(endpoint.state.inference.filter((entry) => entry.operation === 'template-semantic-profile').length, 1);
    const callsAfterPrepare = endpoint.state.inference.length;
    const persistedState = await json(await fetch(`${started.url}/api/projects/${projectId}/template`));
    assert.equal(persistedState.semanticProfile.status, 'ready');
    assert.equal(persistedState.semanticProfile.cached, true);
    assert.equal(endpoint.state.inference.length, callsAfterPrepare, 'GET validates the profile cache without inference');
  } finally {
    await closeStartedServer(started);
  }
});

test('template preparation returns PROCESSING before inference, survives client abort, and deduplicates concurrent compile requests', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-async-api-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  let inferenceCalls = 0;
  const started = await startServer({
    host: '127.0.0.1', port: 0, dataDir: path.join(temp, 'data'), projectRoot: repoRoot,
    serveWeb: false, returnServer: true, enableSemanticProfiling: true,
    semanticInferenceAdapter: { async infer(request) {
      inferenceCalls += 1;
      enteredResolve();
      await gate;
      return validProfileResponse(request);
    } },
  });
  const projectId = 'async-template-preparation';
  try {
    assert.equal((await fetch(`${started.url}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'Async template preparation' }),
    })).status, 201);
    const upload = new FormData();
    upload.append('files', new Blob([await makeSyntheticPptx({ slideCount: 1, layoutCount: 2 })]), 'unknown template.pptx');
    assert.equal((await fetch(`${started.url}/api/projects/${projectId}/upload`, { method: 'POST', body: upload })).status, 200);

    const controller = new AbortController();
    const startedAt = Date.now();
    const acceptedResponse = await fetch(`${started.url}/api/projects/${projectId}/template/compile`, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filePath: 'unknown template.pptx' }),
    });
    assert.equal(acceptedResponse.status, 202);
    const accepted = await acceptedResponse.json();
    controller.abort();
    assert.equal(accepted.semanticProfile.status, 'processing');
    assert.ok(Date.now() - startedAt < 10000, 'the accepted response does not await the delayed semantic provider');
    await entered;

    const processing = await json(await fetch(`${started.url}/api/projects/${projectId}/template`));
    assert.equal(processing.semanticProfile.status, 'processing');
    const duplicate = await fetch(`${started.url}/api/projects/${projectId}/template/compile`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: 'unknown template.pptx' }),
    });
    assert.equal(duplicate.status, 202);
    assert.equal((await duplicate.json()).semanticProfile.status, 'processing');
    assert.equal(inferenceCalls, 1, 'same project and profile key has exactly one active job');

    release();
    const ready = await waitForProfileState(started, projectId);
    assert.equal(ready.semanticProfile.status, 'ready');
    assert.equal(inferenceCalls, 1);
    const reloaded = await json(await fetch(`${started.url}/api/projects/${projectId}/template`));
    assert.equal(reloaded.semanticProfile.status, 'ready');
    assert.equal(reloaded.semanticProfile.cached, true);
  } finally {
    release();
    await closeStartedServer(started);
  }
});

test('a project waiting on shared preparation retries after the owner stores only a deterministic fallback', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-shared-fallback-waiter-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  let releaseOwner;
  const ownerGate = new Promise((resolve) => { releaseOwner = resolve; });
  let ownerEnteredResolve;
  const ownerEntered = new Promise((resolve) => { ownerEnteredResolve = resolve; });
  let inferenceCalls = 0;
  const started = await startServer({
    host: '127.0.0.1', port: 0, dataDir: path.join(temp, 'data'), projectRoot: repoRoot,
    serveWeb: false, returnServer: true, enableSemanticProfiling: true,
    semanticInferenceCacheIdentity: 'offline-shared-fallback-waiter-v1',
    semanticInferenceAdapter: { async infer(request) {
      inferenceCalls += 1;
      if (inferenceCalls === 1) {
        ownerEnteredResolve();
        await ownerGate;
        throw new SemanticInferenceError('SERVICE_UNAVAILABLE', 'temporary fake outage');
      }
      return validProfileResponse(request);
    } },
  });
  const ownerProject = 'shared-profile-owner';
  const waiterProject = 'shared-profile-waiter';
  try {
    const template = await makeSyntheticPptx({ slideCount: 1, layoutCount: 2 });
    for (const projectId of [ownerProject, waiterProject]) {
      assert.equal((await fetch(`${started.url}/api/projects`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: projectId, name: projectId }),
      })).status, 201);
      const upload = new FormData();
      upload.append('files', new Blob([template]), 'same-template.pptx');
      assert.equal((await fetch(`${started.url}/api/projects/${projectId}/upload`, { method: 'POST', body: upload })).status, 200);
    }

    const ownerCompile = await fetch(`${started.url}/api/projects/${ownerProject}/template/compile`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: 'same-template.pptx' }),
    });
    assert.equal(ownerCompile.status, 202);
    const ownerAccepted = await ownerCompile.json();
    await ownerEntered;

    const waiterCompile = await fetch(`${started.url}/api/projects/${waiterProject}/template/compile`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: 'same-template.pptx' }),
    });
    assert.equal(waiterCompile.status, 202);
    const waiterAccepted = await waiterCompile.json();
    assert.equal(waiterAccepted.semanticProfile.status, 'processing');
    assert.equal(waiterAccepted.templateIR.hash, ownerAccepted.templateIR.hash, 'both projects coordinate on the same content-addressed profile');
    assert.equal(inferenceCalls, 1, 'the waiter does not duplicate successful in-flight work');

    releaseOwner();
    const ownerFinal = await waitForProfileState(started, ownerProject, ['degraded-ready']);
    assert.equal(ownerFinal.semanticProfile.status, 'degraded-ready');
    const waiterFinal = await waitForProfileState(started, waiterProject, ['ready', 'degraded-ready']);
    assert.equal(waiterFinal.semanticProfile.status, 'ready', 'the waiter owns a retry after the owner fallback remains local');
    assert.equal(inferenceCalls, 2);
  } finally {
    releaseOwner();
    await closeStartedServer(started);
  }
});

test('daemon restart resumes persisted processing and bounds repeated restart recovery with deterministic fallback', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profile-restart-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const dataDir = path.join(temp, 'data');
  const projectsRoot = path.join(dataDir, 'projects');
  const projectId = 'interrupted-template-preparation';
  const secondProjectId = 'repeatedly-interrupted-template-preparation';
  const startStructuralServer = () => startServer({
    host: '127.0.0.1', port: 0, dataDir, projectRoot: repoRoot,
    serveWeb: false, returnServer: true, enableSemanticProfiling: false,
  });
  let activeServer = await startStructuralServer();
  try {
    assert.equal((await fetch(`${activeServer.url}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'Interrupted preparation' }),
    })).status, 201);
    const upload = new FormData();
    upload.append('files', new Blob([await makeSyntheticPptx({ slideCount: 2, layoutCount: 2 })]), 'restart template.pptx');
    assert.equal((await fetch(`${activeServer.url}/api/projects/${projectId}/upload`, { method: 'POST', body: upload })).status, 200);
    const compiled = await fetch(`${activeServer.url}/api/projects/${projectId}/template/compile`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: 'restart template.pptx' }),
    });
    assert.equal(compiled.status, 200);
    const structural = await compiled.json();
    const profiler = new TemplateSemanticProfiler({ async infer() { throw new Error('cache key lookup must not infer'); } });
    const profileCacheKey = await profiler.profileCacheKey(structural.templateIR);
    const preparationStore = projectTemplateSemanticProfilePreparationStore(projectsRoot, projectId);
    const processingRecord = {
      schemaVersion: 1, templateIRHash: structural.templateIR.hash, profileCacheKey,
      status: 'processing', updatedAt: new Date().toISOString(), templateStructuralMs: 12, recoveryCount: 0,
    };
    await preparationStore.write(processingRecord);

    assert.equal((await fetch(`${activeServer.url}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: secondProjectId, name: 'Repeatedly interrupted preparation' }),
    })).status, 201);
    const secondUpload = new FormData();
    secondUpload.append('files', new Blob([await makeSyntheticPptx({ slideCount: 1, layoutCount: 2 })]), 'second restart template.pptx');
    assert.equal((await fetch(`${activeServer.url}/api/projects/${secondProjectId}/upload`, { method: 'POST', body: secondUpload })).status, 200);
    const secondCompile = await fetch(`${activeServer.url}/api/projects/${secondProjectId}/template/compile`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: 'second restart template.pptx' }),
    });
    assert.equal(secondCompile.status, 200, 'structural-only mode compiles without semantic work');
    const secondStructural = await secondCompile.json();
    const secondKey = await profiler.profileCacheKey(secondStructural.templateIR);
    await projectTemplateSemanticProfilePreparationStore(projectsRoot, secondProjectId).write({
      schemaVersion: 1, templateIRHash: secondStructural.templateIR.hash, profileCacheKey: secondKey,
      status: 'processing', updatedAt: new Date().toISOString(), templateStructuralMs: 8, recoveryCount: 1,
    });

    await closeStartedServer(activeServer);
    activeServer = null;

    let inferenceCalls = 0;
    const resumed = await startServer({
      host: '127.0.0.1', port: 0, dataDir, projectRoot: repoRoot,
      serveWeb: false, returnServer: true, enableSemanticProfiling: true,
      semanticInferenceAdapter: { async infer(request) { inferenceCalls += 1; return validProfileResponse(request); } },
    });
    activeServer = resumed;
    const ready = await waitForProfileState(resumed, projectId);
    assert.equal(ready.semanticProfile.status, 'ready');
    assert.ok(inferenceCalls > 0, 'a valid persisted PROCESSING record is resumed once after restart');
    const recoveredRecord = await preparationStore.read(profileCacheKey);
    assert.equal(recoveredRecord.status, 'ready');
    assert.equal(recoveredRecord.recoveryCount, 1);

    const callsAfterFirstResume = inferenceCalls;
    const degraded = await waitForProfileState(resumed, secondProjectId);
    assert.equal(degraded.semanticProfile.status, 'degraded-ready');
    assert.equal(inferenceCalls, callsAfterFirstResume, 'a repeated interrupted preparation falls back without another model run');
    const fallbackRecord = await projectTemplateSemanticProfilePreparationStore(projectsRoot, secondProjectId).read(secondKey);
    assert.equal(fallbackRecord.status, 'degraded-ready');
    assert.equal(fallbackRecord.recoveryCount, 1);
  } finally {
    if (activeServer) await closeStartedServer(activeServer);
  }
});
