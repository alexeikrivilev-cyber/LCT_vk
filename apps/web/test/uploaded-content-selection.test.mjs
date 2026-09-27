import assert from 'node:assert/strict';
import test from 'node:test';

import { includeUploadedContentFiles } from '../src/uploaded-content-selection.ts';

test('new uploaded source files are included by default within the existing 12-file limit', () => {
  assert.deepEqual(includeUploadedContentFiles(['existing.txt'], ['new.md', 'existing.txt', 'new.csv']), [
    'existing.txt', 'new.md', 'new.csv',
  ]);
  assert.equal(includeUploadedContentFiles(Array.from({ length: 12 }, (_, index) => `old-${index}.txt`), ['new.txt']).length, 12);
  assert.deepEqual(includeUploadedContentFiles([], ['a.txt', 'a.txt', '', 'b.txt']), ['a.txt', 'b.txt']);
});
