import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import {
  addSlide,
  addSlideChart,
  addSlideImage,
  addSlideLine,
  addSlideTable,
  findSlidePlaceholder,
  getAllCharts,
  getAllImages,
  getAllTables,
  getPresentationTheme,
  getShapeBoundsResolved,
  getShapeImageCrop,
  getShapeKind,
  getShapePosition,
  getShapeSize,
  getShapeText,
  getSlideLayouts,
  getSlideMasterCount,
  getSlideMasterPartNames,
  getSlideNotes,
  getSlideShapes,
  getSlides,
  getSlideLayoutName,
  getSlideLayoutPlaceholders,
  loadPresentation,
  savePresentation,
  setShapeImageCrop,
  setShapeText,
  setSlideNotes,
  validatePresentation,
} from '@office-kit/pptx/node';
import { auditTextLayout, renderSlideToSvg } from '@office-kit/pptx-preview';
import { renderSlideToImage } from '@office-kit/pptx-preview/node';
import { OfficeKitPptxDocumentAdapter } from '../src/presentation/adapters/office-kit-pptx-document-adapter.ts';

const require = createRequire(import.meta.url);
const pptxgen = require('pptxgenjs');

const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Y6sAAAAASUVORK5CYII=',
  'base64',
);

async function makeSyntheticTemplate(directory) {
  const generator = new pptxgen();
  generator.layout = 'LAYOUT_WIDE';
  generator.author = 'LCT isolated renderer spike';
  generator.theme = {
    headFontFace: 'Aptos Display',
    bodyFontFace: 'Aptos',
    lang: 'en-US',
  };
  generator.defineSlideMaster({
    title: 'LCT Master',
    background: { color: 'F7F7F7' },
    objects: [
      {
        rect: {
          x: 0,
          y: 0,
          w: 13.333,
          h: 0.18,
          fill: { color: '003366' },
          line: { color: '003366' },
        },
      },
      {
        placeholder: {
          options: {
            name: 'Title',
            type: 'title',
            x: 0.6,
            y: 0.4,
            w: 12,
            h: 0.8,
            fontFace: 'Aptos Display',
            fontSize: 28,
            bold: true,
            color: '003366',
          },
        },
      },
      {
        placeholder: {
          options: {
            name: 'Body',
            type: 'body',
            x: 0.7,
            y: 1.5,
            w: 11.9,
            h: 4.8,
            fontFace: 'Aptos',
            fontSize: 18,
            color: '333333',
          },
        },
      },
    ],
  });

  const sourceSlide = generator.addSlide({ masterName: 'LCT Master' });
  sourceSlide.addText('Original title', { placeholder: 'title' });
  sourceSlide.addText('Original content', { placeholder: 'body' });
  sourceSlide.addNotes('Original speaker notes');

  const filePath = path.join(directory, 'synthetic-template.pptx');
  await generator.writeFile({ fileName: filePath });
  return new Uint8Array(await readFile(filePath));
}

async function addUnknownXmlPart(source) {
  const zip = await JSZip.loadAsync(source);
  const contentTypes = await zip.file('[Content_Types].xml').async('string');
  const unknownXml = '<lct-spike xmlns="urn:lct:spike"><keep>opaque</keep></lct-spike>';
  zip.file('ppt/lctSpike/unknownPart.xml', unknownXml);
  zip.file(
    '[Content_Types].xml',
    contentTypes.replace(
      '</Types>',
      '<Override PartName="/ppt/lctSpike/unknownPart.xml" ContentType="application/xml"/></Types>',
    ),
  );
  return { bytes: await zip.generateAsync({ type: 'nodebuffer' }), unknownXml };
}

test('Office Kit round-trips a synthetic template and authors native objects', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lct-office-kit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const template = await makeSyntheticTemplate(directory);
  const { bytes: source, unknownXml } = await addUnknownXmlPart(template);
  const sourceZip = await JSZip.loadAsync(source);
  const originalPartNames = Object.keys(sourceZip.files).filter((name) => !name.endsWith('/'));
  const originalPresentation = await loadPresentation(source);
  const sourceLayoutNames = getSlideLayouts(originalPresentation).map(getSlideLayoutName);
  const sourceMasterParts = getSlideMasterPartNames(originalPresentation);
  const sourceTheme = getPresentationTheme(originalPresentation);
  assert.ok(getSlideMasterCount(originalPresentation) > 0);
  assert.ok(sourceTheme);

  const adapter = new OfficeKitPptxDocumentAdapter();
  const sourceBytesBeforeRoundTrip = Uint8Array.from(source);
  const result = await adapter.roundTrip(source);

  assert.deepEqual(result.validationIssues, []);
  assert.notEqual(Buffer.compare(Buffer.from(result.pptx), Buffer.from(source)), 0);
  assert.equal(Buffer.compare(Buffer.from(source), Buffer.from(sourceBytesBeforeRoundTrip)), 0);

  const savedZip = await JSZip.loadAsync(result.pptx);
  const savedPartNames = new Set(Object.keys(savedZip.files).filter((name) => !name.endsWith('/')));
  assert.deepEqual(originalPartNames.filter((name) => !savedPartNames.has(name)), []);
  assert.equal(await savedZip.file('ppt/lctSpike/unknownPart.xml').async('string'), unknownXml);

  const presentation = await loadPresentation(result.pptx);
  const sourceLayouts = getSlideLayouts(presentation);

  const layout = sourceLayouts.find((candidate) =>
    getSlideLayoutPlaceholders(candidate).some((placeholder) => placeholder.type === 'title'),
  );
  assert.ok(layout, 'synthetic template exposes a layout with a title placeholder');
  const slide = addSlide(presentation, { layout });
  const title = findSlidePlaceholder(slide, 'title');
  assert.ok(title);
  const layoutTitle = getSlideLayoutPlaceholders(layout).find((placeholder) => placeholder.type === 'title');
  assert.ok(layoutTitle?.bounds);
  assert.deepEqual(getShapeBoundsResolved(presentation, title), layoutTitle.bounds);
  setShapeText(title, 'Editable spike title');

  addSlideTable(slide, {
    x: 457200,
    y: 1828800,
    w: 3657600,
    h: 914400,
    rows: [['Metric', 'Value'], ['Revenue', '12']],
  });
  const contained = addSlideImage(slide, onePixelPng, {
    x: 4572000,
    y: 1828800,
    w: 1828800,
    h: 914400,
    fit: 'contain',
  });
  assert.deepEqual(getShapeSize(contained), { w: 914400, h: 914400 });
  assert.deepEqual(getShapePosition(contained), { x: 5029200, y: 1828800 });
  const cropped = addSlideImage(slide, onePixelPng, {
    x: 7315200,
    y: 1828800,
    w: 1828800,
    h: 1828800,
  });
  setShapeImageCrop(cropped, { left: 0.15, top: 0.1 });
  addSlideChart(slide, {
    x: 457200,
    y: 4114800,
    w: 2743200,
    h: 1371600,
    spec: {
      kind: 'column',
      categories: ['Q1', 'Q2'],
      series: [{ name: 'Revenue', values: [10, 12] }],
    },
  });
  addSlideLine(slide, {
    from: { x: 4114800, y: 4114800 },
    to: { x: 5943600, y: 4114800 },
  });
  setSlideNotes(slide, 'Generated slide notes');

  const svg = renderSlideToSvg(presentation, slide);
  assert.match(svg, /^<svg/);
  assert.ok(renderSlideToImage(presentation, slide, { width: 960 }).length > 0);
  assert.deepEqual(auditTextLayout(presentation), []);

  const saved = await savePresentation(presentation);
  const reopened = await loadPresentation(saved);
  const finalZip = await JSZip.loadAsync(saved);
  const finalPartNames = new Set(Object.keys(finalZip.files).filter((name) => !name.endsWith('/')));
  assert.deepEqual(originalPartNames.filter((name) => !finalPartNames.has(name)), []);
  assert.equal(await finalZip.file('ppt/lctSpike/unknownPart.xml').async('string'), unknownXml);
  const slides = getSlides(reopened);
  const reopenedSlide = slides.at(-1);
  assert.ok(reopenedSlide);
  assert.equal(getSlides(reopened).length, 2);
  assert.deepEqual(getSlideMasterPartNames(reopened), sourceMasterParts);
  assert.deepEqual(getSlideLayouts(reopened).map(getSlideLayoutName), sourceLayoutNames);
  assert.deepEqual(getPresentationTheme(reopened), sourceTheme);
  assert.equal(getShapeText(findSlidePlaceholder(reopenedSlide, 'title')), 'Editable spike title');
  assert.equal(getSlideNotes(getSlides(reopened)[0]), 'Original speaker notes');
  assert.equal(getSlideNotes(reopenedSlide), 'Generated slide notes');
  assert.equal(getAllTables(reopened).length, 1);
  assert.equal(getAllImages(reopened).length, 2);
  assert.equal(getAllCharts(reopened).length, 1);
  assert.ok(getSlideShapes(reopenedSlide).some((shape) => getShapeKind(shape) === 'connector'));
  assert.ok(getSlideShapes(reopenedSlide).some((shape) => {
    const crop = getShapeImageCrop(shape);
    return crop?.left === 0.15 && crop.top === 0.1;
  }));
  assert.deepEqual(validatePresentation(reopened), []);
});
