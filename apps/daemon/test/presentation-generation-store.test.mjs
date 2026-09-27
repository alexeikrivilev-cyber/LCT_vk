import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openPresentationStore, createPresentationProject } from '../src/presentation-store.ts';
import { getPresentationGeneration, startPresentationGeneration } from '../src/presentation-generation-store.ts';

const fingerprint = 'same-planning-inputs';

async function withStore(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-generation-store-'));
  const db = openPresentationStore(path.join(temp, 'data'));
  t.after(async () => {
    db.close();
    await rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  return db;
}

function seedGeneration(db, projectId, status, idempotencyKey = 'generation-key-old') {
  createPresentationProject(db, { id: projectId, name: projectId });
  return startPresentationGeneration(db, {
    projectId,
    idempotencyKey,
    inputFingerprint: fingerprint,
    state: {
      generationId: `${projectId}-old`,
      revision: 4,
      status,
      slides: [{ status: status === 'failed' ? 'failed' : 'ready' }],
    },
  });
}

function startFresh(db, projectId, idempotencyKey = 'generation-key-new') {
  return startPresentationGeneration(db, {
    projectId,
    idempotencyKey,
    inputFingerprint: fingerprint,
    state: {
      generationId: `${projectId}-new`,
      revision: 1,
      status: 'generating',
      slides: [{ status: 'pending' }],
    },
  });
}

test('failed generation with the same key remains an existing retry', async (t) => {
  const db = await withStore(t);
  seedGeneration(db, 'failed-same-key', 'failed');

  const retry = startFresh(db, 'failed-same-key', 'generation-key-old');

  assert.equal(retry.kind, 'existing');
  assert.equal(retry.generation.generationId, 'failed-same-key-old');
  assert.equal(getPresentationGeneration(db, 'failed-same-key').state.status, 'failed');
});

test('failed generation with a new key creates a fresh pending generation', async (t) => {
  const db = await withStore(t);
  seedGeneration(db, 'failed-new-key', 'failed');

  const retry = startFresh(db, 'failed-new-key');

  assert.equal(retry.kind, 'created');
  assert.equal(retry.generation.generationId, 'failed-new-key-new');
  assert.notEqual(retry.generation.generationId, 'failed-new-key-old');
  assert.deepEqual(retry.generation.state.slides.map((slide) => slide.status), ['pending']);
  assert.equal(getPresentationGeneration(db, 'failed-new-key').idempotencyKey, 'generation-key-new');
});

for (const status of ['cancelled', 'stale']) {
  test(`${status} generation with a new key creates a fresh generation`, async (t) => {
    const db = await withStore(t);
    const projectId = `${status}-new-key`;
    seedGeneration(db, projectId, status);

    const retry = startFresh(db, projectId);

    assert.equal(retry.kind, 'created');
    assert.equal(retry.generation.generationId, `${projectId}-new`);
    assert.deepEqual(retry.generation.state.slides.map((slide) => slide.status), ['pending']);
  });
}

test('active generation with a different key remains a conflict', async (t) => {
  const db = await withStore(t);
  seedGeneration(db, 'active-conflict', 'generating');

  const retry = startFresh(db, 'active-conflict');

  assert.equal(retry.kind, 'active-conflict');
  assert.equal(retry.generation.generationId, 'active-conflict-old');
});

test('completed generation with the same inputs may be reused for a different key', async (t) => {
  const db = await withStore(t);
  seedGeneration(db, 'completed-reuse', 'completed');

  const retry = startFresh(db, 'completed-reuse');

  assert.equal(retry.kind, 'existing');
  assert.equal(retry.generation.generationId, 'completed-reuse-old');
  assert.equal(retry.generation.state.status, 'completed');
});
