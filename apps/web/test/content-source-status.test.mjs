import assert from 'node:assert/strict';
import test from 'node:test';

import { contentSourceStatus, contentSourceStatusLabel } from '../src/content-source-status.ts';

test('content source status distinguishes parsed text, visual assets, parser failures, and not-yet-parsed files', () => {
  assert.equal(contentSourceStatus({ kind: 'text' }), 'parsed');
  assert.equal(contentSourceStatus({ kind: 'image' }), 'asset-only');
  assert.equal(contentSourceStatus({ kind: 'unsupported' }), 'unsupported');
  assert.equal(contentSourceStatus({ kind: 'text', warnings: [{ code: 'INVALID_JSON_NOT_PARSED' }] }), 'unsupported');
  assert.equal(contentSourceStatus(null), 'not-parsed');
  assert.deepEqual(['parsed', 'asset-only', 'unsupported', 'not-parsed'].map(contentSourceStatusLabel),
    ['Распознано', 'Только вложение', 'Не поддерживается', 'Ещё не проверено']);
});
