import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertSafeProjectId,
  mimeForPresentationFile,
  normalizeMultipartFilename,
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

test('presentation writes reject project and nested directory symlinks that escape storage', async (t) => {
  const projectsRoot = await mkdtemp(path.join(os.tmpdir(), 'lct-presentation-symlink-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'lct-presentation-outside-'));
  t.after(async () => {
    await rm(projectsRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const project = path.join(projectsRoot, 'project-a');
  await mkdir(project);
  try {
    await symlink(outside, path.join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(outside, path.join(projectsRoot, 'project-escape'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      t.skip('directory symlinks are not available in this environment');
      return;
    }
    throw error;
  }

  await assert.rejects(
    resolvePresentationFilePath(projectsRoot, 'project-a', 'linked/out.txt', { createParent: true }),
    /symlink escapes project root/,
  );
  await assert.rejects(
    resolvePresentationFilePath(projectsRoot, 'project-escape', 'out.txt', { createParent: true }),
    /project directory escapes projects root/,
  );
});

test('presentation MIME type lookup is case insensitive', () => {
  assert.equal(
    mimeForPresentationFile('final.PPTX'),
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  );
  assert.equal(mimeForPresentationFile('preview.HTML'), 'text/html; charset=utf-8');
});

test('multipart filename normalization restores browser UTF-8 bytes without corrupting Latin-1 names', () => {
  const cyrillicName = 'Шаблон презентации.pptx';
  const busboyLatin1Value = Buffer.from(cyrillicName, 'utf8').toString('latin1');
  assert.equal(normalizeMultipartFilename(busboyLatin1Value), cyrillicName);
  assert.equal(normalizeMultipartFilename('Café.pptx'), 'Café.pptx');
  assert.equal(normalizeMultipartFilename('template.pptx'), 'template.pptx');
});
