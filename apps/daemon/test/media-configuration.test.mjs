import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { register } from 'tsx/esm/api';

register();
const { presentationImageConfig, presentationImageModels } = await import('../src/media/models.ts');
const { generatePresentationImage } = await import('../src/media/index.ts');
const { startServer } = await import('../src/server.ts');

test('image model discovery and generation stay disabled when only legacy OpenAI env is present', async (t) => {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { calls.push(args); throw new Error('unexpected network request'); };
  t.after(() => { globalThis.fetch = previousFetch; });
  const env = {
    OPENAI_API_KEY: 'not-a-real-secret',
    OPENAI_BASE_URL: 'https://images.example.invalid/v1',
  };
  assert.deepEqual(presentationImageModels(env), []);
  assert.equal(presentationImageConfig(env).configured, false);
  await assert.rejects(generatePresentationImage({
    projectsRoot: path.join(os.tmpdir(), 'unused-projects'),
    projectId: 'unused-project',
    prompt: 'A quiet abstract landscape',
    model: 'gpt-image-1',
    env,
  }), (error) => error.status === 503);
  assert.equal(calls.length, 0);
});

test('image discovery requires explicit LCT endpoint and model and never advertises an implicit default', () => {
  assert.deepEqual(presentationImageModels({ LCT_IMAGE_BASE_URL: 'https://images.example.test/v1' }), []);
  assert.deepEqual(presentationImageModels({ LCT_IMAGE_MODEL: 'open-weight-image-model' }), []);
  assert.deepEqual(presentationImageModels({
    LCT_IMAGE_BASE_URL: 'https://images.example.test/v1/',
    LCT_IMAGE_MODEL: 'open-weight-image-model',
  }), [{ id: 'open-weight-image-model', label: 'open-weight-image-model', provider: 'openai-compatible', supportsReferences: false }]);
});

test('media API reports Russian unconfigured state and blocks an OpenAI-only request', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-image-api-'));
  const keys = ['LCT_IMAGE_BASE_URL', 'LCT_IMAGE_MODEL', 'LCT_IMAGE_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.OPENAI_BASE_URL = 'https://legacy.example.invalid/v1';
  process.env.OPENAI_API_KEY = 'not-a-real-secret';
  const started = await startServer({
    host: '127.0.0.1', port: 0, dataDir: path.join(temp, 'data'), projectRoot: path.resolve(import.meta.dirname, '../../..'),
    serveWeb: false, returnServer: true, semanticInferenceAdapter: { async infer() { throw new Error('not used'); } },
  });
  t.after(async () => {
    try {
      started.server.closeAllConnections?.();
      await new Promise((resolve, reject) => started.server.close((error) => error ? reject(error) : resolve()));
      await started.shutdown();
    } finally {
      for (const key of keys) {
        if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
      }
      await rm(temp, { recursive: true, force: true });
    }
  });
  const models = await fetch(`${started.url}/api/media/models`).then((response) => response.json());
  assert.deepEqual(models.image, []);
  assert.equal(models.configured, false);
  assert.equal(models.message, 'Генерация изображений не настроена.');
  const rejected = await fetch(`${started.url}/api/media/generate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'any-project', prompt: 'Do not send this externally', model: 'gpt-image-1' }),
  });
  assert.equal(rejected.status, 503);
  assert.equal((await rejected.json()).error.code, 'IMAGE_GENERATION_NOT_CONFIGURED');
});

test('configured image adapter is allowlisted to the explicit model and uses only LCT credentials', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-image-adapter-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ data: [{ b64_json: Buffer.from('synthetic-image-bytes').toString('base64') }] });
  };
  t.after(() => { globalThis.fetch = previousFetch; });
  const env = {
    LCT_IMAGE_BASE_URL: 'https://image-gateway.example.test/v1/',
    LCT_IMAGE_MODEL: 'open-weight-image-model',
    LCT_IMAGE_API_KEY: 'lct-test-secret',
    OPENAI_BASE_URL: 'https://legacy.example.invalid/v1',
    OPENAI_API_KEY: 'legacy-test-secret',
  };
  await assert.rejects(generatePresentationImage({
    projectsRoot: path.join(temp, 'projects'), projectId: 'configured-image', prompt: 'A blue landscape',
    model: 'gpt-image-1', env,
  }), (error) => error.status === 400);
  assert.equal(calls.length, 0);
  const generated = await generatePresentationImage({
    projectsRoot: path.join(temp, 'projects'), projectId: 'configured-image', prompt: 'A blue landscape',
    output: 'media/test.png', env,
  });
  assert.equal(generated.model, 'open-weight-image-model');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://image-gateway.example.test/v1/images/generations');
  assert.equal(calls[0].init.headers.authorization, 'Bearer lct-test-secret');
  const bytes = await readFile(path.join(temp, 'projects', 'configured-image', 'media', 'test.png'));
  assert.equal(bytes.toString(), 'synthetic-image-bytes');
});
