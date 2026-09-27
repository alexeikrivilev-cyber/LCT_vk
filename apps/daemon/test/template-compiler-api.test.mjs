import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { register } from 'tsx/esm/api';

import { makeSyntheticPptx } from '../python-inspector-test-fixtures.mjs';
import { startFakeSemanticEndpoint } from '../../../scripts/lib/fake-openai-compatible-endpoint.mjs';

register();
const { startServer } = await import('../src/server.ts');
const { SemanticInferenceError } = await import('../src/presentation/application/semantic-inference-port.ts');

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
  const options = { host: '127.0.0.1', port: 0, dataDir, projectRoot: repoRoot, serveWeb: false, returnServer: true };
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

test('semantic profiler failure is not reported or persisted as structural PPTX corruption', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profiler-error-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const started = await startServer({
    host: '127.0.0.1', port: 0, dataDir: path.join(temp, 'data'), projectRoot: repoRoot,
    serveWeb: false, returnServer: true, enableSemanticProfiling: true,
    semanticInferenceAdapter: {
      async infer() { throw new SemanticInferenceError('PROVIDER_ERROR', 'unsafe raw provider message'); },
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
    assert.equal(response.status, 502);
    const failure = await response.json();
    assert.equal(failure.status, 'failed');
    assert.equal(failure.failure.code, 'PROVIDER_ERROR');
    assert.match(failure.failure.message, /Сервис анализа/u);
    assert.doesNotMatch(JSON.stringify(failure), /unsafe raw provider message|C:\\\\|node_modules/u);

    const saved = await fetch(`${started.url}/api/projects/${projectId}/template`);
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).status, 'ready', 'successful structural compilation stays available for retrying semantic profiling');
  } finally {
    await new Promise((resolve, reject) => started.server.close((error) => error ? reject(error) : resolve()));
    await started.shutdown();
  }
});

test('configured semantic endpoint does not opt structural template compilation into optional profiling', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-template-profiler-default-off-'));
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
    assert.ok(compiled.templateIR?.hash);
    assert.ok(compiled.presentationDesignSystem);
    assert.equal(endpoint.state.inference.length, 0, 'a configured model endpoint does not trigger optional Template Semantic Profiler calls');
  } finally {
    await closeStartedServer(started);
  }
});
