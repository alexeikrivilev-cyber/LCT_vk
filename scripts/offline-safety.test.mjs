import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { installLoopbackFetchGuard, isPathInside } from './lib/offline-safety.mjs';

test('offline path guard accepts descendants but not siblings', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-offline-safety-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const immutable = path.join(root, '.lct', 'golden-live-workspace');
  assert.equal(isPathInside(path.join(immutable, 'bundle'), immutable), true);
  assert.equal(isPathInside(path.join(root, '.lct', 'golden-live-workspace-copy'), immutable), false);
  assert.equal(isPathInside(immutable, immutable), true);
});

test('loopback fetch guard allows local fake requests and blocks external attempts before network', async (t) => {
  const server = createServer((_request, response) => { response.writeHead(200); response.end('local'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  const guard = installLoopbackFetchGuard();
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'local');
    await assert.rejects(fetch('https://outside.invalid/v1/models'), /blocked a non-loopback/u);
    assert.equal(guard.blockedRequestCount, 1);
  } finally { guard.restore(); }
});
