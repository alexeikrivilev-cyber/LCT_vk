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
