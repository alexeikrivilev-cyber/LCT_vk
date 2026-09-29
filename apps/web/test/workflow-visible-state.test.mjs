import test from 'node:test';
import assert from 'node:assert/strict';
import {
  persistedWorkspaceView,
  visibleGenerationOperationError,
  visiblePersistedFailure,
  visibleRequestFailure,
} from '../src/workflow-visible-state.ts';

test('a matching ready template or plan suppresses an older request failure', () => {
  const oldFailure = { message: 'request failed' };
  assert.equal(visibleRequestFailure(oldFailure, 'ready', ['ready']), null);
});

test('completed generation suppresses an older generation-start error', () => {
  assert.equal(visibleGenerationOperationError('older error', 'start', 'completed'), null);
});

test('a failed retry preserves its new request error until a completed snapshot arrives', () => {
  const failure = { message: 'retry failed' };
  assert.deepEqual(visibleGenerationOperationError(failure, 'start', 'failed'), failure);
});

test('generation action errors remain visible after successful generation', () => {
  const failure = { message: 'export failed' };
  assert.deepEqual(visibleGenerationOperationError(failure, 'action', 'completed'), failure);
});

test('reopening a completed project restores its persisted editor before its saved plan', () => {
  assert.equal(persistedWorkspaceView({
    operationStatus: 'ready', operationGenerationId: 'generation-1',
    savedPlanReady: true, templateReady: true,
  }), 'editor');
});

test('workspace initialization preserves running, audit-failure, plan, and template destinations', () => {
  assert.equal(persistedWorkspaceView({ operationStatus: 'running', savedPlanReady: true, templateReady: true }), 'progress');
  assert.equal(persistedWorkspaceView({
    operationStatus: 'failed', operationFailureStage: 'contextual_audit', operationGenerationId: 'generation-1',
    savedPlanReady: true, templateReady: true,
  }), 'audit');
  assert.equal(persistedWorkspaceView({ operationStatus: 'failed', savedPlanReady: true, templateReady: true }), 'progress');
  assert.equal(persistedWorkspaceView({ savedPlanReady: true, templateReady: true }), 'outline');
  assert.equal(persistedWorkspaceView({ savedPlanReady: false, templateReady: true }), 'template');
});

test('a failed operation stays visible, while stale persisted failures disappear after recovery', () => {
  const failure = { code: 'SERVICE_UNAVAILABLE' };
  assert.deepEqual(visiblePersistedFailure(failure, 'failed'), failure);
  assert.equal(visiblePersistedFailure(failure, 'ready'), null);
  assert.equal(visiblePersistedFailure(failure, 'completed'), null);
});

test('request errors remain visible until a successful persisted state arrives', () => {
  const failure = { message: 'try again' };
  assert.deepEqual(visibleRequestFailure(failure, 'running', ['ready']), failure);
  assert.deepEqual(visibleRequestFailure(failure, undefined, ['ready']), failure);
});
