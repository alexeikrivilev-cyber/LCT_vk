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
  validateInspectionEnvelope,
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
  const masterThemePath = path.join(temp, 'master-linked theme.pptx');
  const unlinkedThemePath = path.join(temp, 'unlinked theme.pptx');
  const ambiguousThemePath = path.join(temp, 'ambiguous themes.pptx');
  const rotatedGroupPath = path.join(temp, 'rotated group.pptx');
  const nestedTemplatePath = path.join(temp, 'nested template groups.pptx');
  const slideBackgroundPath = path.join(temp, 'slide background.pptx');
  await writeFile(normalPath, await makeSyntheticPptx({ slideCount: 2, layoutCount: 2, unsupported: true, parserWarning: true }));
  await writeFile(strictPath, await makeSyntheticPptx({ strict: true, layoutCount: 2 }));
  await writeFile(brokenPath, await makeSyntheticPptx({ brokenLayout: true }));
  await writeFile(unsafePath, await makeSyntheticPptx({ unsafeRelationship: true }));
  await writeFile(bzip2Path, await makeSyntheticPptx({ unsupportedCompressionMethod: 12 }));
  await writeFile(lzmaPath, await makeSyntheticPptx({ unsupportedCompressionMethod: 14 }));
  await writeFile(forgedDeflatePath, await makeSyntheticPptx({ forgedDeflateExpansionBytes: 32 * 1024 * 1024 }));
  await writeFile(corruptPath, Buffer.from('not a ZIP package'));
  await writeFile(masterThemePath, await makeSyntheticPptx({ themeLink: 'master' }));
  await writeFile(unlinkedThemePath, await makeSyntheticPptx({ themeLink: 'none' }));
  await writeFile(ambiguousThemePath, await makeSyntheticPptx({ themeLink: 'multiple' }));
  await writeFile(rotatedGroupPath, await makeSyntheticPptx({ groupTransform: { rotation: 60000 } }));
  await writeFile(nestedTemplatePath, await makeSyntheticPptx({ nestedTemplateGroups: true }));
  await writeFile(slideBackgroundPath, await makeSyntheticPptx({ slideBackground: true }));

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
  const takeaway = normal.inspection.slides[0].elements[0];
  assert.equal(takeaway.rawGeometry.x, 914400);
  assert.deepEqual(takeaway.resolvedGeometry, takeaway.rawGeometry);
  assert.equal(takeaway.geometryProvenance, 'direct');
  assert.deepEqual(takeaway.placeholderIdentity, { slideIndex: 1, idx: '7', type: 'title' });
  assert.equal(takeaway.style.font_sizes_pt[0], 24);
  assert.deepEqual(takeaway.style.fonts, ['Aptos']);
  assert.equal(takeaway.style.bold, true);
  assert.equal(takeaway.style.fill_color, '336699');
  assert.deepEqual(normal.inspection.slides[0].background, null);
  assert.equal(normal.inspection.slides[0].elements[0].sourcePart, 'ppt/slides/slide1.xml');
  assert.equal(takeaway.sourceOrder, 0);
  assert.deepEqual(normal.inspection.slides[0].elements[1].relationship, {
    id: 'rIdImage',
    type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
    target: '../media/image1.png',
    targetPart: 'ppt/media/image1.png',
    mode: 'internal',
  });
  assert.deepEqual(normal.inspection.slides[0].elements[2].relationship, {
    id: 'rIdExternal',
    type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
    target: 'https://example.test/image.png',
    targetPart: null,
    mode: 'external',
  });
  assert.equal(normal.inspection.slides[0].relationships[1].target, '../media/image1.png');
  assert.equal(normal.inspection.slides[0].relationships[1].targetPart, 'ppt/media/image1.png');
  assert.equal(normal.inspection.slides[0].relationships[1].type, 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image');
  assert.equal(normal.inspection.slides[0].warnings.includes('content part is detected but not interpreted'), true);
  assert.ok(normal.inspection.parserWarnings.includes('content part is detected but not interpreted'));
  assert.equal(normal.inspection.layouts.length, 2, 'the unused layout remains inventoried');
  assert.ok(normal.inspection.unsupportedDetails.some((detail) => detail.part === 'ppt/customXml/item1.xml' && detail.kind === 'unsupported_part'));
  assert.ok(normal.inspection.unsupportedDetails.some((detail) => detail.kind === 'unsupported_object'));
  assert.deepEqual(normal.inspection.notesParts, ['ppt/notesMasters/notesMaster1.xml', 'ppt/notesSlides/notesSlide1.xml']);
  assert.deepEqual(normal.inspection.mediaParts, ['ppt/media/image1.png']);
  assert.deepEqual(normal.inspection.theme, {
    part: 'ppt/theme/theme1.xml',
    colors: { dk1: '000000', lt1: 'FFFFFF', accent1: '123456' },
    fonts: { major: 'Aptos Display', minor: 'Aptos' },
  });
  assert.deepEqual((await inspectPptx(masterThemePath)).inspection.theme, normal.inspection.theme,
    'a theme linked from the slide master is observed');
  assert.equal((await inspectPptx(unlinkedThemePath)).inspection.theme, null,
    'unlinked theme parts are not guessed');
  assert.equal((await inspectPptx(ambiguousThemePath)).inspection.theme, null,
    'multiple linked themes remain unknown instead of selecting one');
  const rotated = await inspectPptx(rotatedGroupPath);
  const groupedChild = rotated.inspection.slides[0].elements.find((element) => element.name === 'Grouped child');
  assert.ok(groupedChild);
  assert.ok(groupedChild.rawGeometry);
  assert.equal(groupedChild.resolvedGeometry, null, 'unsupported group transforms do not claim direct geometry is resolved');
  assert.equal(groupedChild.geometryProvenance, 'unknown');
  assert.ok(rotated.inspection.slides[0].elements.find((element) => element.name === 'Transformed group')
    ?.warnings.includes('group transform is incomplete or uses rotation/reflection; child resolved geometry is unknown'));
  assert.equal(normal.inspection.masters[0].declaredName, 'Synthetic master');
  assert.equal(normal.inspection.masters[0].designElements.length, 1);
  assert.equal(normal.inspection.masters[0].designElements[0].rawGeometry.x, 1000);
  assert.equal(normal.inspection.masters[0].designElements[0].style.fill_color, 'system:windowText/000000');
  assert.equal(normal.inspection.masters[0].relationships[0].target, '../slideLayouts/slideLayout1.xml');
  assert.equal(normal.inspection.masters[0].relationships[0].targetPart, 'ppt/slideLayouts/slideLayout1.xml');
  assert.deepEqual(normal.inspection.masters[0].background, {
    kind: 'bgRef', idx: '1001', scheme_color: 'bg1', scheme_color_type: 'schemeClr', fill: null,
  });
  assert.deepEqual(normal.inspection.masters[0].colorMapping, { master_mapping: { accent1: 'accent2' } });
  const layout = normal.inspection.layouts[0];
  assert.equal(layout.declaredName, 'Synthetic layout 1');
  assert.equal(layout.declaredType, 'title');
  assert.equal(layout.placeholders.length, 1);
  assert.deepEqual(layout.placeholders[0].placeholderIdentity, { slideIndex: null, idx: '7', type: 'title' });
  assert.equal(layout.placeholders[0].geometryProvenance, 'layout_explicit');
  assert.equal(layout.elements.length, 2);
  assert.equal(layout.designElements.length, 1);
  assert.equal(layout.designElements[0].sourceOrder, 1);
  assert.equal(layout.designElements[0].style.fill_color, 'scheme:accent2');
  assert.deepEqual(layout.background, {
    kind: 'explicit', element: 'solidFill',
    fill: { kind: 'solidFill', attributes: {}, colors: [{ type: 'srgbClr', attributes: { val: 'FFFFFF' }, position: null }], relationship: null },
  });
  assert.deepEqual(layout.colorMapping, { layout_override: [{ element: 'overrideClrMapping', attributes: { accent1: 'accent2' } }] });
  assert.equal(Object.hasOwn(normal, 'source'), false, 'absolute input path must not enter the protocol result');
  assert.equal(JSON.stringify(normal).includes(normalPath), false, 'no field may leak the absolute input path');
  assert.ok(normal.inspectionMs >= 0);

  const slideBackground = await inspectPptx(slideBackgroundPath);
  assert.deepEqual(slideBackground.inspection.slides[0].background, {
    kind: 'explicit', element: 'solidFill',
    fill: { kind: 'solidFill', attributes: {}, colors: [{ type: 'schemeClr', attributes: { val: 'accent1' }, position: null }], relationship: null },
  });
  const nestedTemplate = await inspectPptx(nestedTemplatePath);
  const masterChild = nestedTemplate.inspection.masters[0].elements.find((element) => element.name === 'Master group child');
  assert.ok(masterChild);
  assert.equal(masterChild.parentId, '80');
  assert.equal(masterChild.sourcePart, 'ppt/slideMasters/slideMaster1.xml');
  assert.equal(masterChild.geometryProvenance, 'group_transformed');
  assert.equal(masterChild.style.fill_color, 'system:windowText/000000');
  const layoutChild = nestedTemplate.inspection.layouts[0].elements.find((element) => element.name === 'Layout group 1 child');
  assert.ok(layoutChild);
  assert.equal(layoutChild.parentId, '72');
  assert.equal(layoutChild.geometryProvenance, 'group_transformed');
  assert.equal(layoutChild.style.fill_color, 'scheme:accent2');

  for (const extend of [
    (copy) => { copy.extra = true; },
    (copy) => { copy.inspection.slides[0].extra = true; },
    (copy) => { copy.inspection.slides[0].elements[0].extra = true; },
    (copy) => { copy.inspection.slides[0].relationships[0].extra = true; },
    (copy) => { copy.inspection.theme.extra = true; },
    (copy) => { copy.inspection.unsupportedDetails[0].extra = true; },
  ]) {
    const extended = structuredClone(normal);
    extend(extended);
    assert.throws(() => validateInspectionEnvelope(extended), errorCode('INVALID_ENVELOPE'));
  }

  const strict = await inspectPptx(strictPath);
  assert.equal(strict.inspection.slides.length, 1, 'Strict OOXML namespaces are parsed');
  assert.equal(strict.inspection.slides[0].elements[0].text, 'Synthetic takeaway 1');
  assert.equal(strict.inspection.layouts.length, 2);
  assert.equal(strict.inspection.slides[0].elements[0].placeholderIdentity.slideIndex, 1);

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

test('Windows Python child transports Cyrillic and punctuation through UTF-8 without PYTHONUTF8', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'LCT utf8 child transport-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const filePath = path.join(temp, 'unicode evidence.pptx');
  await writeFile(filePath, await makeSyntheticPptx({ unicodeText: true }));
  const prior = process.env.PYTHONUTF8;
  delete process.env.PYTHONUTF8;
  try {
    const inspection = await inspectPptx(filePath);
    assert.equal(inspection.inspection.slides[0].elements[0].text, 'Сводка — этап → готов');
  } catch (error) {
    if (error instanceof InspectionAdapterError && error.code === 'PYTHON_NOT_AVAILABLE') {
      t.skip('Python 3.12 unavailable: Unicode child-process integration is BLOCKED, not passed');
      return;
    }
    throw error;
  } finally {
    if (prior === undefined) delete process.env.PYTHONUTF8;
    else process.env.PYTHONUTF8 = prior;
  }
});
