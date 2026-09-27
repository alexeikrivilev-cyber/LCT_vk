import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { register } from 'tsx/esm/api';

import { makeSyntheticPptx } from '../python-inspector-test-fixtures.mjs';
import { createHybridExemplarTemplate } from './exemplar-template-fixtures.mjs';
import { startFakeSemanticEndpoint } from '../../../scripts/lib/fake-openai-compatible-endpoint.mjs';

register();
const { startServer } = await import('../src/server.ts');
const { SemanticInferenceError } = await import('../src/presentation/application/semantic-inference-port.ts');
const { OpenAICompatibleSemanticInferenceAdapter } = await import('../src/presentation/adapters/openai-compatible-semantic-inference.ts');
const { compileTemplate } = await import('../src/presentation/application/template-compiler.ts');

const repoRoot = path.resolve(import.meta.dirname, '../../..');

async function closeStartedServer(started) {
  await new Promise((resolve, reject) => started.server.close((error) => error ? reject(error) : resolve()));
  await started.shutdown();
}

async function json(response) {
  return response.json();
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
    assert.equal(compiled.status, 200, await compiled.clone().text());
    const compiledBody = await json(compiled);
    assert.equal(compiledBody.status, 'ready');
    assert.equal(compiledBody.source.filePath, templateName);
    assert.equal(compiledBody.source.sha256, originalHash);
    assert.equal(compiledBody.templateIR.slides.length, 2);
    assert.equal(compiledBody.presentationDesignSystem.templateIRId, compiledBody.templateIR.id);
    assert.equal(compiledBody.semanticProfile.status, 'ready');
    assert.equal(compiledBody.semanticProfile.cached, false);
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
    const inferred = await json(await fetch(`${started.url}/api/projects/${inheritedProjectId}/template/compile`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: 'inherited-placeholder.pptx' }),
    }));
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

test('failed semantic preparation blocks Generate with 409 without a profile retry', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profiler-error-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  let inferenceCalls = 0;
  const started = await startServer({
    host: '127.0.0.1', port: 0, dataDir: path.join(temp, 'data'), projectRoot: repoRoot,
    serveWeb: false, returnServer: true,
    enableSemanticProfiling: true,
    semanticInferenceAdapter: {
      async infer() { inferenceCalls += 1; throw new SemanticInferenceError('PROVIDER_ERROR', 'unsafe raw provider message'); },
    },
  });
  const projectId = 'semantic-profile-boundary';
  try {
    const created = await fetch(`${started.url}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'Semantic profile boundary test' }),
    });
    assert.equal(created.status, 201);
    const pptx = await makeSyntheticPptx({ slideCount: 1, layoutCount: 2 });
    const upload = new FormData();
    upload.append('files', new Blob([pptx]), 'Шаблон.pptx');
    assert.equal((await fetch(`${started.url}/api/projects/${projectId}/upload`, { method: 'POST', body: upload })).status, 200);

    const response = await fetch(`${started.url}/api/projects/${projectId}/template/compile`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: 'Шаблон.pptx' }),
    });
    assert.equal(response.status, 200);
    const failure = await response.json();
    assert.equal(failure.status, 'ready');
    assert.equal(failure.semanticProfile.status, 'failed');
    assert.equal(failure.semanticProfile.failureCode, 'PROVIDER_ERROR');
    assert.doesNotMatch(failure.semanticProfileNotice.message, /можно продолжить/u);
    assert.doesNotMatch(JSON.stringify(failure), /unsafe raw provider message|C:\\\\|node_modules/u);

    const saved = await fetch(`${started.url}/api/projects/${projectId}/template`);
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.equal(savedBody.status, 'ready', 'structural readiness remains separately observable after profile failure');
    assert.equal(savedBody.semanticProfile.status, 'failed');

    const callsBeforeGenerate = inferenceCalls;
    assert.ok(callsBeforeGenerate > 0, 'template preparation attempted semantic profiling');
    const blocked = await fetch(`${started.url}/api/projects/${projectId}/workflow/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateFilePath: 'Шаблон.pptx', contentFiles: [], brief: {
        audience: 'Продуктовая команда', purpose: 'Подготовить краткий обзор.',
        expectedOutcome: 'Согласовать следующий шаг.', preferences: [], requestedSlideCount: 1,
      } }),
    });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).error.code, 'TEMPLATE_PROFILE_NOT_READY');
    assert.equal(inferenceCalls, callsBeforeGenerate, 'Generate must not retry profile inference on a cache miss');
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
    assert.equal(response.status, 200, await response.clone().text());
    const compiled = await response.json();
    assert.equal(compiled.status, 'ready');
    assert.equal(compiled.semanticProfile.status, 'ready');
    assert.equal(compiled.semanticProfile.cached, false);
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
