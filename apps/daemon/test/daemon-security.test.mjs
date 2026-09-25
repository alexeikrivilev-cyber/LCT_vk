import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
});

test('server API returns bounded upload errors and hides parser stacks', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-daemon-security-'));
  const started = await startServer({ host: '127.0.0.1', port: 0, dataDir: temp, projectRoot: repoRoot, serveWeb: false, returnServer: true });
  t.after(async () => {
    await closeHttpServer(started.server);
    await started.shutdown();
    await rm(temp, { recursive: true, force: true });
  });

  const malformed = await fetch(`${started.url}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json',
  });
  assert.equal(malformed.status, 400);
  const malformedBody = await malformed.text();
  assert.match(malformed.headers.get('content-type') ?? '', /application\/json/);
  assert.doesNotMatch(malformedBody, /SyntaxError|node_modules|C:\\\\Projects|stack/i);

  const form = new FormData();
  for (let index = 0; index < 3; index += 1) form.append('files', new Blob([`part-${index}`]), `part-${index}.txt`);
  const serverDiagnostics = [];
  const previousConsoleError = console.error;
  console.error = (...values) => serverDiagnostics.push(values);
  let upload;
  try {
    upload = await fetch(`${started.url}/api/projects/no-such-project/upload`, { method: 'POST', body: form });
  } finally {
    console.error = previousConsoleError;
  }
  assert.equal(upload.status, 413);
  const uploadBody = await upload.text();
  assert.match(uploadBody, /UPLOAD_LIMIT_EXCEEDED/);
  assert.doesNotMatch(uploadBody, /SyntaxError|node_modules|C:\\\\Projects|stack/i);
  assert.match(JSON.stringify(serverDiagnostics), /Presentation API request failed/);
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
