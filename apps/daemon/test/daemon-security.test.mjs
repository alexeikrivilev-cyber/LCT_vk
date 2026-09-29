import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeHttpServer, parseDaemonCliStartupArgs } from '../src/daemon-startup.ts';
import { startServer } from '../src/server.ts';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

test('daemon CLI rejects non-loopback binding until an authentication boundary exists', () => {
  for (const host of ['localhost', '127.0.0.1', '127.12.4.1', '::1']) {
    const result = parseDaemonCliStartupArgs(['--host', host, '--no-open']);
    assert.equal(result.ok, true, `${host} should remain available for local use`);
  }
  for (const host of ['0.0.0.0', '192.168.1.7', '::', 'lct.example.com']) {
    const result = parseDaemonCliStartupArgs(['--host', host]);
    assert.equal(result.ok, false, `${host} should be rejected`);
    assert.match(result.message ?? '', /no authentication/i);
  }
  assert.equal(parseDaemonCliStartupArgs(['--port', 'not-a-port']).ok, false);
  assert.equal(parseDaemonCliStartupArgs(['--port']).ok, false);
});

test('health is process-only and readiness checks local dependencies without model completion', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-daemon-ready-'));
  const previousBackend = process.env.LCT_PPTX_BACKEND;
  delete process.env.LCT_PPTX_BACKEND;
  const started = await startServer({ host: '127.0.0.1', port: 0, dataDir: temp, projectRoot: repoRoot, serveWeb: false, returnServer: true });
  t.after(async () => {
    await closeHttpServer(started.server);
    await started.shutdown();
    await rm(temp, { recursive: true, force: true });
    if (previousBackend === undefined) delete process.env.LCT_PPTX_BACKEND; else process.env.LCT_PPTX_BACKEND = previousBackend;
  });

  for (const pathName of ['/health', '/api/health']) {
    const response = await fetch(`${started.url}${pathName}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  }
  for (const pathName of ['/readiness', '/api/readiness']) {
    const response = await fetch(`${started.url}${pathName}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.checks.store, 'available');
    assert.equal(body.checks.writableDirectories, 'writable');
    assert.equal(body.checks.renderer, 'initialized');
    assert.equal(body.checks.pptxBackend, 'office-kit');
    assert.deepEqual(body.checks.semantic, { required: false, status: 'not-required' });
  }
});

test('configured semantic readiness probes only the local models endpoint and validates startup config', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-daemon-ready-semantic-'));
  const { createServer } = await import('node:http');
  const endpoint = createServer((req, res) => {
    assert.equal(req.url, '/v1/models');
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.authorization, 'Bearer local-test-secret');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'local-test-model' }] }));
  });
  await new Promise((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  const address = endpoint.address();
  const oldBase = process.env.LCT_SEMANTIC_BASE_URL;
  const oldModel = process.env.LCT_SEMANTIC_MODEL;
  const oldKey = process.env.LCT_SEMANTIC_API_KEY;
  process.env.LCT_SEMANTIC_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.LCT_SEMANTIC_MODEL = 'local-test-model';
  process.env.LCT_SEMANTIC_API_KEY = 'local-test-secret';
  let started;
  let remoteRequests = 0;
  try {
    const previousHandler = endpoint.listeners('request')[0];
    endpoint.removeListener('request', previousHandler);
    endpoint.on('request', (req, res) => {
      remoteRequests += 1;
      previousHandler(req, res);
    });
    started = await startServer({ host: '127.0.0.1', port: 0, dataDir: temp, projectRoot: repoRoot, serveWeb: false, returnServer: true });
  } finally {
    if (oldBase === undefined) delete process.env.LCT_SEMANTIC_BASE_URL; else process.env.LCT_SEMANTIC_BASE_URL = oldBase;
    if (oldModel === undefined) delete process.env.LCT_SEMANTIC_MODEL; else process.env.LCT_SEMANTIC_MODEL = oldModel;
    if (oldKey === undefined) delete process.env.LCT_SEMANTIC_API_KEY; else process.env.LCT_SEMANTIC_API_KEY = oldKey;
  }
  t.after(async () => {
    await closeHttpServer(started.server);
    await started.shutdown();
    await new Promise((resolve, reject) => endpoint.close((error) => error ? reject(error) : resolve()));
    await rm(temp, { recursive: true, force: true });
  });
  const response = await fetch(`${started.url}/readiness`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.checks.pptxBackend, 'office-kit');
  assert.deepEqual(body.checks.semantic, { required: true, status: 'reachable' });
  assert.equal(remoteRequests, 1, 'readiness performs one bounded models probe, never a completion request');
  assert.equal(endpoint.listening, true);

  const invalidTemp = await mkdtemp(path.join(os.tmpdir(), 'lct-daemon-invalid-config-'));
  const previousPort = process.env.LCT_PORT;
  process.env.LCT_PORT = 'invalid';
  try {
    await assert.rejects(startServer({ dataDir: invalidTemp, projectRoot: repoRoot, serveWeb: false }), /LCT_PORT must be an integer/);
  } finally {
    if (previousPort === undefined) delete process.env.LCT_PORT; else process.env.LCT_PORT = previousPort;
    await rm(invalidTemp, { recursive: true, force: true });
  }
});

test('semantic readiness reports warming as non-fatal while hard failures remain unready', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-daemon-warming-ready-'));
  const oldBase = process.env.LCT_SEMANTIC_BASE_URL;
  const oldModel = process.env.LCT_SEMANTIC_MODEL;
  const oldTimeout = process.env.LCT_SEMANTIC_READINESS_TIMEOUT_MS;
  process.env.LCT_SEMANTIC_BASE_URL = 'https://provider.example.test/v1';
  process.env.LCT_SEMANTIC_MODEL = 'local-test-model';
  process.env.LCT_SEMANTIC_READINESS_TIMEOUT_MS = '35000';
  let probeStatus = 'warming';
  let observedTimeout;
  const started = await startServer({
    host: '127.0.0.1', port: 0, dataDir: temp, projectRoot: repoRoot, serveWeb: false, returnServer: true,
    semanticReadinessProbe: async (timeoutMs) => {
      observedTimeout = timeoutMs;
      return probeStatus;
    },
  });
  t.after(async () => {
    await closeHttpServer(started.server);
    await started.shutdown();
    await rm(temp, { recursive: true, force: true });
    if (oldBase === undefined) delete process.env.LCT_SEMANTIC_BASE_URL; else process.env.LCT_SEMANTIC_BASE_URL = oldBase;
    if (oldModel === undefined) delete process.env.LCT_SEMANTIC_MODEL; else process.env.LCT_SEMANTIC_MODEL = oldModel;
    if (oldTimeout === undefined) delete process.env.LCT_SEMANTIC_READINESS_TIMEOUT_MS;
    else process.env.LCT_SEMANTIC_READINESS_TIMEOUT_MS = oldTimeout;
  });

  const warming = await fetch(`${started.url}/readiness`);
  assert.equal(warming.status, 200);
  assert.deepEqual((await warming.json()).checks.semantic, { required: true, status: 'warming' });
  assert.equal(observedTimeout, 35_000);

  probeStatus = 'unreachable';
  const unreachable = await fetch(`${started.url}/readiness`);
  assert.equal(unreachable.status, 503);
  assert.deepEqual((await unreachable.json()).checks.semantic, { required: true, status: 'unreachable' });
});

test('server API bounds uploads, hides parser stacks, and logs only safe structured diagnostics', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-daemon-security-'));
  const started = await startServer({ host: '127.0.0.1', port: 0, dataDir: temp, projectRoot: repoRoot, serveWeb: false, returnServer: true });
  t.after(async () => {
    await closeHttpServer(started.server);
    await started.shutdown();
    await rm(temp, { recursive: true, force: true });
  });

  const serverLogs = [];
  const previousConsoleError = console.error;
  const previousConsoleLog = console.log;
  console.error = (...values) => serverLogs.push(values);
  console.log = (...values) => serverLogs.push(values);
  let malformed;
  let upload;
  try {
    malformed = await fetch(`${started.url}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json',
    });
  } finally {
    console.error = previousConsoleError;
    console.log = previousConsoleLog;
  }
  assert.equal(malformed.status, 400);
  const malformedBody = await malformed.text();
  assert.match(malformed.headers.get('content-type') ?? '', /application\/json/);
  assert.match(malformed.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/i);
  assert.doesNotMatch(malformedBody, /SyntaxError|node_modules|C:\\\\Projects|stack/i);

  const form = new FormData();
  for (let index = 0; index < 3; index += 1) form.append('files', new Blob([`part-${index}`]), `part-${index}.txt`);
  const serverDiagnostics = [];
  const previousConsoleErrorForUpload = console.error;
  console.error = (...values) => serverDiagnostics.push(values);
  try {
    upload = await fetch(`${started.url}/api/projects/no-such-project/upload`, { method: 'POST', body: form });
  } finally {
    console.error = previousConsoleErrorForUpload;
  }
  assert.equal(upload.status, 413);
  const uploadBody = await upload.text();
  assert.match(uploadBody, /UPLOAD_LIMIT_EXCEEDED/);
  assert.doesNotMatch(uploadBody, /SyntaxError|node_modules|C:\\\\Projects|stack/i);
  const logLines = [...serverLogs.flat(), ...serverDiagnostics.flat()].filter((item) => typeof item === 'string');
  const structured = logLines.map((line) => JSON.parse(line));
  assert.ok(structured.some((entry) => entry.event === 'http.request' && entry.requestId && entry.operation && Number.isInteger(entry.durationMs)));
  assert.ok(structured.some((entry) => entry.event === 'http.error' && entry.errorCode === 'INVALID_REQUEST'));
  assert.ok(serverDiagnostics.flat().some((line) => JSON.parse(line).errorCode === 'UPLOAD_LIMIT_EXCEEDED'));
  assert.doesNotMatch(JSON.stringify([...serverLogs, ...serverDiagnostics]), /bad json|C:\\Projects|node_modules|stack|Bearer|https?:\/\//i);
});

test('uploaded active-content files are not served inline from the application origin', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-daemon-active-content-'));
  const started = await startServer({ host: '127.0.0.1', port: 0, dataDir: temp, projectRoot: repoRoot, serveWeb: false, returnServer: true });
  t.after(async () => {
    await closeHttpServer(started.server);
    await started.shutdown();
    await rm(temp, { recursive: true, force: true });
  });
  const created = await fetch(`${started.url}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'active-content', name: 'Active content test' }),
  });
  assert.equal(created.status, 201);
  const form = new FormData();
  form.append('files', new Blob(['<script>document.body.textContent="executed"</script>'], { type: 'text/html' }), 'untrusted.html');
  const upload = await fetch(`${started.url}/api/projects/active-content/upload`, { method: 'POST', body: form });
  assert.equal(upload.status, 200);
  const response = await fetch(`${started.url}/api/projects/active-content/raw/untrusted.html`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(response.headers.get('content-disposition'), 'attachment');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await response.text(), /<script>/);
});

test('startServer also rejects direct non-loopback host configuration', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-daemon-bind-'));
  try {
    await assert.rejects(
      startServer({ host: '0.0.0.0', port: 0, dataDir: temp, projectRoot: repoRoot, serveWeb: false }),
      /no authentication/i,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('startup validates semantic and renderer configuration before creating the data store', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lct-daemon-config-order-'));
  const dataDir = path.join(tempRoot, 'not-created');
  const previous = {
    baseUrl: process.env.LCT_SEMANTIC_BASE_URL,
    backend: process.env.LCT_PPTX_BACKEND,
  };
  try {
    process.env.LCT_SEMANTIC_BASE_URL = 'ftp://invalid.local/v1';
    process.env.LCT_PPTX_BACKEND = 'custom';
    await assert.rejects(
      startServer({ host: '127.0.0.1', port: 0, dataDir, projectRoot: repoRoot, serveWeb: false }),
      /LCT_SEMANTIC_BASE_URL must be an HTTP\(S\) URL/,
    );
    await assert.rejects(access(dataDir), { code: 'ENOENT' });

    delete process.env.LCT_SEMANTIC_BASE_URL;
    process.env.LCT_PPTX_BACKEND = 'unknown-backend';
    await assert.rejects(
      startServer({ host: '127.0.0.1', port: 0, dataDir, projectRoot: repoRoot, serveWeb: false }),
      /LCT_PPTX_BACKEND must be custom or office-kit/,
    );
    await assert.rejects(access(dataDir), { code: 'ENOENT' });
  } finally {
    if (previous.baseUrl === undefined) delete process.env.LCT_SEMANTIC_BASE_URL; else process.env.LCT_SEMANTIC_BASE_URL = previous.baseUrl;
    if (previous.backend === undefined) delete process.env.LCT_PPTX_BACKEND; else process.env.LCT_PPTX_BACKEND = previous.backend;
    await rm(tempRoot, { recursive: true, force: true });
  }
});
