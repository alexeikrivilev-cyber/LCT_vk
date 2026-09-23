import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { makeSyntheticPptx } from '../python-inspector-test-fixtures.mjs';
import {
  InspectionAdapterError,
  inspectPptx,
  runInspectorProcess,
} from '../src/presentation/adapters/python-inspector.ts';

function errorCode(code) {
  return (error) => error instanceof InspectionAdapterError && error.code === code;
}

test('private Node-to-Python inspector handles synthetic Transitional and Strict PPTX inputs', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'LCT inspection 東京 spaces-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const normalPath = path.join(temp, 'презентация deck.pptx');
  const strictPath = path.join(temp, 'strict deck.pptx');
  const brokenPath = path.join(temp, 'broken relationship.pptx');
  const unsafePath = path.join(temp, 'unsafe relationship.pptx');
  const bzip2Path = path.join(temp, 'bzip2 compressed parts.pptx');
  const lzmaPath = path.join(temp, 'lzma compressed parts.pptx');
  const forgedDeflatePath = path.join(temp, 'forged deflate size.pptx');
  const corruptPath = path.join(temp, 'corrupt.pptx');
  await writeFile(normalPath, await makeSyntheticPptx({ slideCount: 2, layoutCount: 2, unsupported: true }));
  await writeFile(strictPath, await makeSyntheticPptx({ strict: true, layoutCount: 2 }));
  await writeFile(brokenPath, await makeSyntheticPptx({ brokenLayout: true }));
  await writeFile(unsafePath, await makeSyntheticPptx({ unsafeRelationship: true }));
  await writeFile(bzip2Path, await makeSyntheticPptx({ unsupportedCompressionMethod: 12 }));
  await writeFile(lzmaPath, await makeSyntheticPptx({ unsupportedCompressionMethod: 14 }));
  await writeFile(forgedDeflatePath, await makeSyntheticPptx({ forgedDeflateExpansionBytes: 32 * 1024 * 1024 }));
  await writeFile(corruptPath, Buffer.from('not a ZIP package'));

  const beforeHash = createHash('sha256').update(await readFile(normalPath)).digest('hex');
  let normal;
  try {
    normal = await inspectPptx(normalPath);
  } catch (error) {
    if (error instanceof InspectionAdapterError && error.code === 'PYTHON_NOT_AVAILABLE') {
      t.skip('Python 3.12 unavailable: integration is BLOCKED, not passed');
      return;
    }
    throw error;
  }
  const afterHash = createHash('sha256').update(await readFile(normalPath)).digest('hex');
  assert.equal(afterHash, beforeHash, 'inspection must leave the uploaded PPTX bytes unchanged');
  assert.equal(normal.protocolVersion, 1);
  assert.equal(normal.schemaStatus, 'REPLACEABLE/PROVISIONAL');
  assert.equal(normal.inspection.slideSize.width, 11704320);
  assert.equal(normal.inspection.slides.length, 2);
  assert.equal(normal.inspection.slides[0].part, 'ppt/slides/slide1.xml');
  assert.equal(normal.inspection.slides[0].layoutPart, 'ppt/slideLayouts/slideLayout1.xml');
  assert.equal(normal.inspection.slides[0].masterPart, 'ppt/slideMasters/slideMaster1.xml');
  assert.equal(normal.inspection.slides[0].elements[0].text, 'Synthetic takeaway 1');
  assert.equal(normal.inspection.slides[0].elements[0].geometry.x, 914400);
  assert.equal(normal.inspection.slides[0].elements[0].sourcePart, 'ppt/slides/slide1.xml');
  assert.equal(normal.inspection.layouts.length, 2, 'the unused layout remains inventoried');
  assert.deepEqual(normal.inspection.unsupportedParts, ['ppt/customXml/item1.xml']);
  assert.ok(normal.inspectionMs >= 0);

  const strict = await inspectPptx(strictPath);
  assert.equal(strict.inspection.slides.length, 1, 'Strict OOXML namespaces are parsed');
  assert.equal(strict.inspection.slides[0].elements[0].text, 'Synthetic takeaway 1');
  assert.equal(strict.inspection.layouts.length, 2);

  const forgedDeflate = await inspectPptx(forgedDeflatePath);
  assert.equal(forgedDeflate.inspection.slides[0].elements[0].text, 'Synthetic takeaway 1');

  if (process.platform === 'win32') {
    const listing = spawnSync('py', ['-0p'], { encoding: 'utf8', windowsHide: true });
    const candidates = listing.status === 0
      ? listing.stdout.split(/\r?\n/).map((line) => /^\s*-V:\S+(?:\s+\*)?\s+(.+?python(?:w)?\.exe)\s*$/i.exec(line)?.[1]).filter(Boolean)
      : [];
    const workingPython = candidates.find((candidate) => {
      const probe = spawnSync(candidate, ['-c', 'import sys;sys.stdout.write(f"{sys.version_info.major}.{sys.version_info.minor}")'], { encoding: 'utf8', windowsHide: true });
      return probe.status === 0 && probe.stdout === '3.12';
    });
    if (workingPython) {
      const previous = process.env.LCT_PYTHON;
      process.env.LCT_PYTHON = workingPython;
      try {
        assert.equal((await inspectPptx(strictPath)).inspection.slides.length, 1, 'LCT_PYTHON accepts an executable path with Unicode characters');
      } finally {
        if (previous === undefined) delete process.env.LCT_PYTHON;
        else process.env.LCT_PYTHON = previous;
      }
    }
  }

  await assert.rejects(inspectPptx(brokenPath), errorCode('INVALID_PPTX'));
  await assert.rejects(inspectPptx(unsafePath), errorCode('INVALID_PPTX'));
  await assert.rejects(inspectPptx(bzip2Path), errorCode('INVALID_PPTX'));
  await assert.rejects(inspectPptx(lzmaPath), errorCode('INVALID_PPTX'));
  await assert.rejects(inspectPptx(corruptPath), errorCode('INVALID_PPTX'));
  await assert.rejects(inspectPptx('relative/file.pptx'), errorCode('INVALID_INPUT'));
});

test('private process boundary reports malformed JSON, invalid envelopes, nonzero exits, limits, and timeouts', async () => {
  const node = process.execPath;
  await assert.rejects(
    runInspectorProcess(path.join(os.tmpdir(), 'missing-lct-python-executable.exe'), []),
    errorCode('PYTHON_NOT_AVAILABLE'),
  );
  await assert.rejects(
    runInspectorProcess(node, ['-e', "process.stderr.write('LCT_IO_ERROR:unavailable');process.exit(4)"]),
    errorCode('INPUT_UNAVAILABLE'),
  );
  await assert.rejects(
    runInspectorProcess(node, ['-e', "process.stdout.write('not-json')"]),
    errorCode('INVALID_JSON'),
  );
  await assert.rejects(
    runInspectorProcess(node, ['-e', "process.stdout.write('{}')"]),
    errorCode('INVALID_ENVELOPE'),
  );
  await assert.rejects(
    runInspectorProcess(node, ['-e', "process.stderr.write('x'.repeat(100000));process.exit(7)"]),
    (error) => error instanceof InspectionAdapterError
      && error.code === 'NON_ZERO_EXIT'
      && Buffer.byteLength(error.details?.stderr ?? '') <= 32 * 1024,
  );
  await assert.rejects(
    runInspectorProcess(node, ['-e', "process.stdout.write('x'.repeat(4096))"], { limits: { maxStdoutBytes: 1024 } }),
    errorCode('OUTPUT_TOO_LARGE'),
  );
  await assert.rejects(
    runInspectorProcess(node, ['-e', 'setInterval(() => {}, 1000)'], { limits: { timeoutMs: 50 } }),
    errorCode('TIMEOUT'),
  );
});
