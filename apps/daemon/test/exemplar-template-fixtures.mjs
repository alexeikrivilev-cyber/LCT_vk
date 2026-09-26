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
export async function createFamilyExemplarTemplate(filePath, { masterName = 'Unlabelled composition families', mixedStyleBody = false, hyperlinkBody = false, varyingFooter = false, masterStaticText = null } = {}) {
  const deck = new pptxgen();
  deck.layout = 'LAYOUT_WIDE';
  const familyMasters = Array.from({ length: 3 }, (_, family) => `${masterName} ${family + 1}`);
  for (const title of familyMasters) deck.defineSlideMaster({ title, objects: masterStaticText
    ? [{ text: { text: masterStaticText, options: { x: 0.7, y: 0.95, w: 5.5, h: 0.35, fontFace: 'Aptos', fontSize: 18 } } }]
    : [] });
  for (let index = 0; index < 12; index += 1) {
    const family = Math.floor(index / 4);
    const slide = deck.addSlide({ masterName: familyMasters[family] });
    slide.addText(`Original source headline ${index + 1}`, {
      x: 0.62, y: 0.32, w: 11.9, h: 0.72, fontFace: 'Aptos Display', fontSize: 30, bold: true, margin: 0,
    });
    slide.addText(mixedStyleBody
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
    if (varyingFooter) slide.addText(`Source page ${index + 1}`, {
      x: 11.25, y: 7.08, w: 1.45, h: 0.18, fontFace: 'Aptos', fontSize: 9, margin: 0,
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

/** Structural role fixtures; titles and bodies share geometry so only measured typography/topology distinguishes them. */
export async function createRoleExemplarTemplate(filePath, { masterName = 'Structural role fixtures' } = {}) {
  const deck = new pptxgen();
  deck.layout = 'LAYOUT_WIDE';
  deck.defineSlideMaster({ title: masterName, objects: [] });
  const layouts = [
    ...Array.from({ length: 9 }, () => ({ role: 'content', titleSize: 30, bodySize: 18 })),
    ...Array.from({ length: 3 }, () => ({ role: 'hero', titleSize: 58, bodySize: 8 })),
    ...Array.from({ length: 3 }, () => ({ role: 'split', titleSize: 30, bodySize: 16 })),
  ];
  for (const [index, item] of layouts.entries()) {
    const slide = deck.addSlide({ masterName });
    slide.addText(`Source headline ${index + 1}`, {
      x: 0.62, y: 0.32, w: 11.9, h: 0.72, fontFace: 'Aptos Display', fontSize: item.titleSize, bold: true, margin: 0,
    });
    slide.addText(`Source body ${index + 1}. Supporting evidence remains available in the larger body region.`, {
      x: 0.68, y: 1.35, w: 4.7, h: item.role === 'split' ? 1.0 : 5.45, fontFace: 'Aptos', fontSize: item.bodySize, margin: 0,
    });
    if (item.role === 'split') slide.addText(`Second source column ${index + 1}. Additional evidence occupies a parallel region.`, {
      x: 6.0, y: 1.35, w: 5.8, h: 1.0, fontFace: 'Aptos', fontSize: item.bodySize, margin: 0,
    });
    slide.addText('REPEATED BRAND', {
      x: 0.62, y: 7.08, w: 2.4, h: 0.18, fontFace: 'Aptos', fontSize: 9, margin: 0,
    });
  }
  await deck.writeFile({ fileName: filePath });
}

/** A repeated native two-region layout with compact, non-overlapping text slots. */
export async function createTwoRegionExemplarTemplate(filePath, { masterName = 'Two-region layout' } = {}) {
  const deck = new pptxgen();
  deck.layout = 'LAYOUT_WIDE';
  deck.defineSlideMaster({ title: masterName, objects: [] });
  for (let index = 0; index < 4; index += 1) {
    const slide = deck.addSlide({ masterName });
    slide.addText(`Source headline ${index + 1}`, {
      x: 0.62, y: 0.32, w: 11.9, h: 0.72, fontFace: 'Aptos Display', fontSize: 30, bold: true, margin: 0,
    });
    slide.addText(`Left source region ${index + 1}`, {
      x: 0.68, y: 1.4, w: 5.35, h: 1.2, fontFace: 'Aptos', fontSize: 16, margin: 0,
    });
    slide.addText(`Right source region ${index + 1}`, {
      x: 6.55, y: 1.4, w: 5.85, h: 1.2, fontFace: 'Aptos', fontSize: 16, margin: 0,
    });
    slide.addText('REPEATED TWO-REGION BRAND', {
      x: 0.62, y: 7.08, w: 3.4, h: 0.18, fontFace: 'Aptos', fontSize: 9, margin: 0,
    });
  }
  await deck.writeFile({ fileName: filePath });
}

/** Two repeated exemplar families plus a third, separately styled native-placeholder layout. */
export async function createHybridExemplarTemplate(filePath, { masterName = 'Hybrid qualification' } = {}) {
  const deck = new pptxgen();
  deck.layout = 'LAYOUT_WIDE';
  const familyMasters = [`${masterName} A`, `${masterName} B`];
  for (const title of familyMasters) deck.defineSlideMaster({ title, objects: [] });
  const nativeMaster = `${masterName} native`;
  deck.defineSlideMaster({
    title: nativeMaster,
    background: { color: 'F3F7FB' },
    objects: [
      { placeholder: { options: { name: 'Hybrid native title', type: 'title', x: 0.55, y: 0.35, w: 11.9, h: 0.8, fontFace: 'Aptos Display', fontSize: 30, bold: true, color: '183B56', margin: 0 } } },
      { placeholder: { options: { name: 'Hybrid native body', type: 'body', x: 0.65, y: 1.45, w: 7.4, h: 3.8, fontFace: 'Aptos', fontSize: 18, color: '243B53', margin: 0.05 } } },
      { rect: { x: 0.55, y: 7.08, w: 2.7, h: 0.12, line: { color: '1687C9', transparency: 100 }, fill: { color: '1687C9' } } },
    ],
  });
  for (let family = 0; family < 2; family += 1) {
    for (let index = 0; index < 4; index += 1) {
      const slide = deck.addSlide({ masterName: familyMasters[family] });
      slide.addText(`Hybrid source headline ${family}-${index}`, {
        x: 0.62, y: 0.32, w: 11.9, h: 0.72, fontFace: 'Aptos Display', fontSize: 30, bold: true, margin: 0,
      });
      slide.addText(`Hybrid source body ${family}-${index}. Supporting evidence is retained in this measured region.`, {
        x: 0.68, y: 1.35, w: 4.7, h: 5.2, fontFace: 'Aptos', fontSize: 16, margin: 0,
      });
      slide.addText('SYNTHETIC BRAND', {
        x: 0.62, y: 7.08, w: 2.4, h: 0.18, fontFace: 'Aptos', fontSize: 9, margin: 0,
      });
      for (let decoration = 0; decoration < family + 1; decoration += 1) {
        slide.addShape('rect', {
          x: 6.2 + decoration * 0.42, y: 1.45, w: 0.24, h: 0.18,
          line: { color: '274C77', transparency: 100 }, fill: { color: family ? 'A9C5DF' : 'D9E3F0' },
        });
      }
    }
  }
  const nativeSlide = deck.addSlide({ masterName: nativeMaster });
  nativeSlide.addText('Native source title sample', { placeholder: 'Hybrid native title' });
  nativeSlide.addText('Native source body sample', { placeholder: 'Hybrid native body' });
  await deck.writeFile({ fileName: filePath });
}

/** Two otherwise similar layouts with independent recurring footer chrome for cross-layout profile tests. */
export async function createCrossLayoutFooterTemplate(filePath) {
  const deck = new pptxgen();
  deck.layout = 'LAYOUT_WIDE';
  deck.defineSlideMaster({ title: 'First composition layout', objects: [] });
  deck.defineSlideMaster({ title: 'Second composition layout', objects: [] });
  for (let index = 0; index < 8; index += 1) {
    const masterName = index < 4 ? 'First composition layout' : 'Second composition layout';
    const slide = deck.addSlide({ masterName });
    slide.addText(`Source headline ${index + 1}`, {
      x: 0.62, y: 0.32, w: 11.9, h: 0.72, fontFace: 'Aptos Display', fontSize: 30, bold: true, margin: 0,
    });
    slide.addText(`Source body ${index + 1}. Supporting evidence remains in the body region.`, {
      x: 0.68, y: 1.35, w: 4.7, h: 5.45, fontFace: 'Aptos', fontSize: 16, margin: 0,
    });
    slide.addText('REPEATED LAYOUT BRAND', {
      x: 0.62, y: 7.08, w: 2.4, h: 0.18, fontFace: 'Aptos', fontSize: 9, margin: 0,
    });
    if (index >= 4) slide.addShape('rect', {
      x: 6.2, y: 1.45, w: 0.24, h: 0.18,
      line: { color: '274C77', transparency: 100 }, fill: { color: 'D9E3F0' },
    });
  }
  await deck.writeFile({ fileName: filePath });
}

/** Three old familyKey buckets collapse to one composition once the added source-only text is cleared. */
export async function createDuplicateProjectionExemplarTemplate(filePath, { masterName = 'Duplicate projected families' } = {}) {
  const deck = new pptxgen();
  deck.layout = 'LAYOUT_WIDE';
  deck.defineSlideMaster({ title: masterName, objects: [] });
  const sourceOnlyTextCounts = [0, 2, 7];
  for (let index = 0; index < 12; index += 1) {
    const family = Math.floor(index / 4);
    const slide = deck.addSlide({ masterName });
    slide.addText(`Source headline ${index + 1}`, {
      x: 0.62, y: 0.32, w: 11.9, h: 0.72, fontFace: 'Aptos Display', fontSize: 30, bold: true, margin: 0,
    });
    slide.addText(`Source body ${index + 1}. Supporting evidence remains in the same mapped text region.`, {
      x: 0.68, y: 1.35, w: 4.7, h: 5.45, fontFace: 'Aptos', fontSize: 16, margin: 0,
    });
    slide.addText('REPEATED BRAND', {
      x: 0.62, y: 7.08, w: 2.4, h: 0.18, fontFace: 'Aptos', fontSize: 9, margin: 0,
    });
    for (let detail = 0; detail < sourceOnlyTextCounts[family]; detail += 1) {
      slide.addText(`Unique removable note ${index + 1} ${detail + 1}`, {
        x: 6.0 + (detail % 3) * 1.3, y: 6.55 + Math.floor(detail / 3) * 0.22, w: 1.1, h: 0.16,
        fontFace: 'Aptos', fontSize: 7, margin: 0,
      });
    }
  }
  await deck.writeFile({ fileName: filePath });
}
