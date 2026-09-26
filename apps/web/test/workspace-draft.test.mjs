import assert from 'node:assert/strict';
import test from 'node:test';

import { clearWorkspaceDraft, readWorkspaceDraft, workspaceDraftKey, writeWorkspaceDraft } from '../src/workspace-draft.ts';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

const brief = {
  selectedContentFiles: ['case.md', 'gone.csv'],
  briefAudience: 'Руководители',
  briefPurpose: 'Показать динамику',
  briefExpectedOutcome: 'Согласовать решение',
  briefPreferences: 'Коротко',
  requestedSlideCount: '8',
};

test('workspace draft survives refresh, only keeps available source paths, and restores newer edits than server state', () => {
  const storage = memoryStorage();
  assert.equal(writeWorkspaceDraft(storage, 'project-1', brief, 2000), true);
  const restored = readWorkspaceDraft(storage, 'project-1', '1970-01-01T00:00:01.000Z', new Set(['case.md']));
  assert.deepEqual(restored, { ...brief, selectedContentFiles: ['case.md'], updatedAt: 2000 });
  assert.equal(JSON.stringify(restored).includes('uploaded source text'), false);
});

test('newer server planning state takes precedence over an old browser draft', () => {
  const storage = memoryStorage();
  writeWorkspaceDraft(storage, 'project-1', brief, 2000);
  assert.equal(readWorkspaceDraft(storage, 'project-1', '1970-01-01T00:00:03.000Z', new Set(['case.md', 'gone.csv'])), null);
});

test('invalid, oversized, and inaccessible browser draft states fail closed', () => {
  const storage = memoryStorage();
  storage.setItem(workspaceDraftKey('project-1'), '{bad json');
  assert.equal(readWorkspaceDraft(storage, 'project-1', null, new Set()), null);
  storage.setItem(workspaceDraftKey('project-1'), JSON.stringify({ ...brief, updatedAt: 'now' }));
  assert.equal(readWorkspaceDraft(storage, 'project-1', null, new Set()), null);
  assert.equal(readWorkspaceDraft({ getItem: () => { throw new Error('storage disabled'); } }, 'project-1', null, new Set()), null);
  clearWorkspaceDraft({ removeItem: () => { throw new Error('storage disabled'); } }, 'project-1');
});
