import assert from 'node:assert/strict';
import test from 'node:test';

import { refreshPersistedWorkflowSnapshots } from '../src/workflow-terminal-refresh.ts';

test('terminal workflow outcomes refresh persisted template and planning state exactly once', async () => {
  for (const status of ['ready', 'failed']) {
    const calls = [];
    const refreshed = await refreshPersistedWorkflowSnapshots(status, {
      template: async () => { calls.push('template'); },
      planning: async () => { calls.push('planning'); },
    });
    assert.equal(refreshed, true);
    assert.deepEqual(calls.sort(), ['planning', 'template']);
  }
});

test('running or missing workflow status does not trigger inference or snapshot reloads', async () => {
  let refreshCount = 0;
  const refreshers = {
    template: async () => { refreshCount += 1; },
    planning: async () => { refreshCount += 1; },
  };
  assert.equal(await refreshPersistedWorkflowSnapshots('running', refreshers), false);
  assert.equal(await refreshPersistedWorkflowSnapshots(null, refreshers), false);
  assert.equal(refreshCount, 0);
});
