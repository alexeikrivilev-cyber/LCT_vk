import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { getShapeKind, getSlideShapes, getSlides, loadPresentation, savePresentation, setShapeImageCrop } from '@office-kit/pptx/node';

const require = createRequire(import.meta.url);
const pptxgen = require('pptxgenjs');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Y6sAAAAASUVORK5CYII=';

const profiles = [
  { id: 'T1_CORPORATE', title: { x: 0.6, y: 0.35, w: 12.0, h: 0.75 }, body: { x: 0.7, y: 1.4, w: 11.8, h: 5.2 }, color: '15324B' },
  { id: 'T2_SPLIT_VISUAL', title: { x: 0.5, y: 0.3, w: 12.2, h: 0.7 }, body: { x: 0.6, y: 1.3, w: 4.7, h: 5.3 }, visual: { x: 5.55, y: 1.25, w: 7.0, h: 5.35 }, color: '176B68' },
  { id: 'T3_DATA_DASHBOARD', title: { x: 0.35, y: 0.25, w: 12.4, h: 0.65 }, body: { x: 0.4, y: 1.2, w: 3.3, h: 5.6 }, visual: { x: 3.9, y: 1.2, w: 8.8, h: 5.6 }, color: '563D82' },
  { id: 'T4_EDITORIAL', title: { x: 1.4, y: 1.1, w: 10.3, h: 1.4 }, body: { x: 1.45, y: 2.9, w: 9.9, h: 3.3 }, color: '8A4A2F' },
  { id: 'T5_STRESS', title: { x: 0.3, y: 0.45, w: 12.4, h: 0.9 }, body: { x: 0.5, y: 1.6, w: 6.2, h: 4.9 }, visual: { x: 7.0, y: 1.5, w: 5.8, h: 4.9 }, color: '3E5368' },
];

function addMaster(deck, profile, index, suffix = '') {
  const name = `${profile.id}_MASTER${suffix}`;
  const objects = [
    { rect: { x: 0.15, y: 0.16, w: 0.5, h: 0.24, fill: { color: profile.color }, line: { color: profile.color } } },
    { rect: { x: 0, y: 7.28, w: 13.333, h: 0.08, fill: { color: profile.color }, line: { color: profile.color } } },
    { placeholder: { options: { name: `Heading_${index}`, type: 'title', ...profile.title, fontFace: index === 4 ? 'Georgia' : 'Aptos Display', fontSize: index === 4 ? 34 : 28, bold: true, color: profile.color } } },
    { placeholder: { options: { name: `Copy_${index}`, type: 'body', ...profile.body, fontFace: 'Aptos', fontSize: 18, color: '30343B' } } },
  ];
  if (profile.visual) objects.splice(2, 0, { placeholder: { options: { name: `Visual_${index}`, type: index === 1 || index === 4 ? 'pic' : 'chart', ...profile.visual } } });
  if (index === 2) objects.push({ placeholder: { options: { name: 'TableArea_Dashboard', type: 'tbl', x: 8.0, y: 4.0, w: 4.6, h: 2.4 } } });
  deck.defineSlideMaster({ title: name, background: { color: index === 3 ? 'FBF7EF' : 'FFFFFF' }, objects });
  return name;
}

async function injectOpaquePart(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const types = await zip.file('[Content_Types].xml').async('string');
  zip.file('ppt/lctCorpus/opaque.xml', '<lct:opaque xmlns:lct="urn:lct:synthetic">preserve-me</lct:opaque>');
  zip.file('[Content_Types].xml', types.replace('</Types>', '<Override PartName="/ppt/lctCorpus/opaque.xml" ContentType="application/xml"/></Types>'));
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function specializeVisualPlaceholders(bytes, index) {
  const zip = await JSZip.loadAsync(bytes);
  for (const name of Object.keys(zip.files).filter((part) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(part))) {
    let xml = await zip.file(name).async('string');
    const types = index === 1 || index === 4 ? new Map([['102', 'pic']]) : index === 2 ? new Map([['105', 'tbl']]) : new Map();
    xml = xml.replace(/<p:ph([^>]*)>/g, (tag, attributes) => {
      const indexMatch = /\bidx="(\d+)"/.exec(attributes);
      const type = indexMatch ? types.get(indexMatch[1]) : undefined;
      if (!type) return tag;
      const selfClosing = /\/\s*$/.test(attributes);
      const withoutType = attributes.replace(/\s+type="[^"]*"/, '').replace(/\/\s*$/, '');
      return `<p:ph${withoutType} type="${type}"${selfClosing ? '/' : ''}>`;
    });
    zip.file(name, xml);
  }
  return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }));
}

async function normalizeSyntheticShapeIds(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const part = zip.file('ppt/slides/slide1.xml');
  if (!part) throw new Error('Synthetic template has no source slide for shape-id validation');
  const xml = await part.async('string');
  const used = new Set();
  let nextId = 2;
  const normalized = xml.replace(/(<p:cNvPr\b[^>]*\bid=")(\d+)(")/g, (_match, prefix, rawId, suffix) => {
    let id = Number(rawId);
    if (used.has(id)) {
      while (used.has(nextId)) nextId += 1;
      id = nextId++;
    }
    used.add(id);
    return `${prefix}${id}${suffix}`;
  });
  zip.file('ppt/slides/slide1.xml', normalized);
  return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }));
}

/** Five valid, generated templates; only T5 receives one valid opaque XML package part. */
export async function createHardTemplateCorpus(directory) {
  await mkdir(directory, { recursive: true });
  const result = [];
  for (const [index, profile] of profiles.entries()) {
    const deck = new pptxgen();
    deck.layout = 'LAYOUT_WIDE';
    deck.author = 'LCT synthetic compatibility corpus';
    deck.subject = profile.id;
    deck.theme = { headFontFace: index === 3 ? 'Georgia' : 'Aptos Display', bodyFontFace: 'Aptos', lang: 'en-US' };
    const master = addMaster(deck, profile, index);
    if (index === 1 || index === 4) addMaster(deck, profile, index, '_ALTERNATE');
    const slide = deck.addSlide({ masterName: index === 4 ? `${master.replace('_MASTER', '_MASTER')}_ALTERNATE` : master });
    slide.addText(profile.id.replaceAll('_', ' '), { placeholder: `Heading_${index}` });
    slide.addText('Source sample content is removed from generated output.', { placeholder: `Copy_${index}` });
    if (index === 4) {
      slide.addText([
        { text: 'Mixed ', options: { bold: true, color: '15324B' } },
        { text: 'text runs and multiple paragraphs', options: { italic: true } },
      ], { x: 0.6, y: 2.0, w: 5.8, h: 0.9 });
      slide.addImage({ data: `image/png;base64,${png}`, x: 7.2, y: 1.8, w: 2.0, h: 1.6 });
      slide.addChart(deck.ChartType.bar, [{ name: 'Sample', labels: ['A', 'B'], values: [1, 2] }], { x: 0.7, y: 3.2, w: 5.5, h: 2.4, showLegend: false });
      slide.addTable([['Metric', 'Value'], ['Synthetic sample', '2']], { x: 7.0, y: 4.0, w: 5.5, h: 1.2 });
      slide.addShape(deck.ShapeType.line, { x: 6.0, y: 3.0, w: 1.0, h: 0, line: { color: profile.color, beginArrowType: 'none', endArrowType: 'triangle' } });
      slide.addNotes('T5 source-only speaker note; it should not leak into generated slides.');
    } else if (index === 2) {
      slide.addTable([['Metric', 'Value'], ['Synthetic sample', '2']], { x: 0.6, y: 2.0, w: 5.5, h: 1.2 });
    } else if (index === 1) {
      slide.addImage({ data: `image/png;base64,${png}`, x: 7.0, y: 1.8, w: 2.0, h: 1.6 });
    }
    const filePath = path.join(directory, `${profile.id.toLowerCase()}.pptx`);
    await deck.writeFile({ fileName: filePath });
    let bytes = await specializeVisualPlaceholders(new Uint8Array(await readFile(filePath)), index);
    await writeFile(filePath, bytes);
    if (index === 4) {
      bytes = await normalizeSyntheticShapeIds(bytes);
      const presentation = await loadPresentation(bytes);
      const croppedImage = getSlideShapes(getSlides(presentation)[0]).find((shape) => getShapeKind(shape) === 'picture');
      if (croppedImage) setShapeImageCrop(croppedImage, { left: 0.12, right: 0.08, top: 0.1, bottom: 0.05 });
      bytes = await injectOpaquePart(await savePresentation(presentation));
      await writeFile(filePath, bytes);
    }
    result.push({ id: profile.id, path: filePath, bytes });
  }
  return result;
}
