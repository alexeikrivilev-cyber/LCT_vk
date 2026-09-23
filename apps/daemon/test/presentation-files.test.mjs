import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertSafeProjectId,
  mimeForPresentationFile,
  resolvePresentationFilePath,
} from '../src/presentation-files.ts';

test('project ids accept safe names and reject path-like or oversized values', () => {
  assert.equal(assertSafeProjectId('project-2026.v1'), 'project-2026.v1');
  for (const value of ['', '../outside', 'a/b', 'a\\b', 'x'.repeat(129)]) {
    assert.throws(() => assertSafeProjectId(value), /invalid project id/);
  }
});

test('presentation file paths stay inside their project directory', async (t) => {
  const projectsRoot = await mkdtemp(path.join(os.tmpdir(), 'lct-presentation-files-'));
  t.after(() => rm(projectsRoot, { recursive: true, force: true }));

  const resolved = await resolvePresentationFilePath(projectsRoot, 'project-a', 'slides/final.pptx');
  assert.equal(resolved.name, 'slides/final.pptx');
  assert.equal(resolved.absolute, path.join(projectsRoot, 'project-a', 'slides', 'final.pptx'));

  for (const value of ['../outside.txt', 'nested/../../outside.txt', '..\\outside.txt']) {
    await assert.rejects(resolvePresentationFilePath(projectsRoot, 'project-a', value), /invalid project file path/);
  }
});

test('presentation MIME type lookup is case insensitive', () => {
  assert.equal(
    mimeForPresentationFile('final.PPTX'),
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  );
  assert.equal(mimeForPresentationFile('preview.HTML'), 'text/html; charset=utf-8');
});
