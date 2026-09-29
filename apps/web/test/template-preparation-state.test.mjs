import assert from 'node:assert/strict';
import test from 'node:test';

import { isPersistedTemplatePreparationState, isUsableTemplateProfileState } from '../src/template-preparation-state.ts';

test('semantic and deterministic degraded profiles are usable after persisted preparation', () => {
  assert.equal(isUsableTemplateProfileState('ready'), true);
  assert.equal(isUsableTemplateProfileState('degraded-ready'), true);
  for (const status of ['processing', 'failed', 'missing', 'disabled', null]) {
    assert.equal(isUsableTemplateProfileState(status), false, `${status} is not usable yet`);
  }
});

test('a disconnected compile request is suppressed only when GET confirms the same persisted template state', () => {
  const filePath = 'unknown presentation.pptx';
  for (const status of ['processing', 'ready', 'degraded-ready']) {
    assert.equal(isPersistedTemplatePreparationState('ready', status, filePath, filePath), true);
  }
  assert.equal(isPersistedTemplatePreparationState('ready', 'failed', filePath, filePath), false);
  assert.equal(isPersistedTemplatePreparationState('failed', 'processing', filePath, filePath), false);
  assert.equal(isPersistedTemplatePreparationState('ready', 'processing', 'different.pptx', filePath), false);
});
