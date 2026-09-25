import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pptxgen = require('pptxgenjs');
const fixtureImage = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Y6sAAAAASUVORK5CYII=';

/** Small, library-generated decks that exercise replaceable exemplar evidence. */
export async function createExemplarTemplate(filePath, { masterName = 'Unnamed donor layout', ambiguous = false, includePicture = true, pictureCopies = 1, evidenceFragments = 0, addLargeFooter = false, addSmallFooter = false } = {}) {
  const deck = new pptxgen();
  deck.layout = 'LAYOUT_WIDE';
  deck.defineSlideMaster({ title: masterName, objects: [] });
  for (let index = 0; index < 4; index += 1) {
    const slide = deck.addSlide({ masterName });
    const titleY = ambiguous && index >= 2 ? 3.2 + (index - 2) * 0.4 : 0.32;
    slide.addText(`Measured takeaway ${index + 1}`, {
      x: ambiguous && index % 2 ? 1.1 : 0.62, y: titleY, w: 11.9, h: 0.72,
      fontFace: 'Aptos Display', fontSize: 30, bold: true, margin: 0,
    });
    slide.addText(`Repeated body region ${index + 1}\n\nEvidence stays in an ordinary editable text box.`, {
      x: 0.68, y: 1.35, w: 4.7, h: 5.45,
      fontFace: 'Aptos', fontSize: 16, margin: 0,
    });
    if (index === 0) for (let fragment = 0; fragment < evidenceFragments; fragment += 1) {
      slide.addText(`Supporting detail ${fragment + 1}`, {
        x: 0.8 + fragment % 4 * 0.75, y: 2.2 + Math.floor(fragment / 4) * 0.3, w: 0.7, h: 0.2,
        fontFace: 'Aptos', fontSize: 10, margin: 0,
      });
    }
    if (addLargeFooter) slide.addText(`Large secondary heading ${index + 1}`, {
      x: 0.68, y: 6.85, w: 4.7, h: 0.45, fontFace: 'Aptos Display', fontSize: 30, bold: true, margin: 0,
    });
    if (addSmallFooter) slide.addText(`Repeated page furniture ${index + 1} with ordinary typography`, {
      x: 0.68, y: 7.02, w: 4.7, h: 0.24, fontFace: 'Aptos', fontSize: 9, margin: 0,
    });
    if (includePicture) {
      slide.addImage({ data: `image/png;base64,${fixtureImage}`, x: 5.75, y: 1.35, w: 6.8, h: 5.45 });
      for (let copy = 1; copy < pictureCopies; copy += 1) {
        slide.addImage({ data: `image/png;base64,${fixtureImage}`, x: 0.68, y: 1.35, w: 4.7, h: 5.45 });
      }
    }
  }
  await deck.writeFile({ fileName: filePath });
}

/** Three repeated but structurally distinct vector compositions for selector/render tests. */
export async function createFamilyExemplarTemplate(filePath, { masterName = 'Unlabelled composition families', mixedStyleBody = false, hyperlinkBody = false } = {}) {
  const deck = new pptxgen();
  deck.layout = 'LAYOUT_WIDE';
  deck.defineSlideMaster({ title: masterName, objects: [] });
  for (let index = 0; index < 12; index += 1) {
    const family = Math.floor(index / 4);
    const slide = deck.addSlide({ masterName });
    slide.addText(`Original source headline ${index + 1}`, {
      x: 0.62, y: 0.32, w: 11.9, h: 0.72, fontFace: 'Aptos Display', fontSize: 30, bold: true, margin: 0,
    });
    slide.addText(mixedStyleBody && index === 0
      ? [
        { text: 'Original source body ', options: { fontFace: 'Aptos', fontSize: 16 } },
        { text: `${index + 1}`, options: { fontFace: 'Aptos', fontSize: 16, italic: true, color: '274C77' } },
      ]
      : `Original source body ${index + 1}`, {
      x: 0.68, y: 1.35, w: 4.7, h: 5.45, fontFace: 'Aptos', fontSize: 16, margin: 0,
      ...(hyperlinkBody ? { hyperlink: { url: 'https://source-link.example.test' } } : {}),
    });
    slide.addText(`Source only detail ${index + 1}`, {
      x: 0.8, y: 6.5, w: 3.8, h: 0.3, fontFace: 'Aptos', fontSize: 10, margin: 0,
    });
    slide.addText('SYNTHETIC BRAND', {
      x: 0.62, y: 7.08, w: 2.4, h: 0.18, fontFace: 'Aptos', fontSize: 9, margin: 0,
    });
    for (let decoration = 0; decoration < 1 + family * 3; decoration += 1) {
      slide.addShape('rect', {
        x: 6.2 + (decoration % 3) * 0.42,
        y: 1.45 + Math.floor(decoration / 3) * 0.32,
        w: 0.24,
        h: 0.18,
        line: { color: '274C77', transparency: 100 },
        fill: { color: family === 1 ? 'C6D7E8' : 'D9E3F0' },
      });
    }
    slide.addNotes(`Source only note ${index + 1}`);
  }
  await deck.writeFile({ fileName: filePath });
}
