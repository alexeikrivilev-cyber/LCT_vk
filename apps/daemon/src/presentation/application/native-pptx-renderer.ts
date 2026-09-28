import { createHash } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import JSZip from 'jszip';

import type { ContentIR } from '../domain/content-ir.js';
import { validateTemplateIR, type TemplateIR } from '../domain/template-ir.js';
import { auditCompiledPresentation } from './deterministic-audit.js';
import { generatedFallbackCompositionSignature } from './exemplar-slide-selector.js';
import { collectSourceSlideVisualArtifacts, removeUnreachableSourceVisualArtifacts } from './pptx-source-artifacts.js';
import type { CompiledPresentation, CompiledSlide, PlacementBox } from './slide-compilation.js';
import type { PptxRenderResult } from './pptx-backend-port.js';

const FIXED_ZIP_DATE = new Date('1980-01-01T00:00:00.000Z');
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const MAX_TEMPLATE_BYTES = 64 * 1024 * 1024;

export type NativePptxRenderResult = PptxRenderResult;

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function xmlAttribute(xml: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}=["']([^"']*)["']`).exec(xml);
  return match?.[1] ?? null;
}

function rootStartTag(xml: string): string {
  return /<(?![!?])[^>]+>/.exec(xml)?.[0] ?? '';
}

function appendBeforeClose(xml: string, closeTag: string, addition: string): string {
  const index = xml.lastIndexOf(closeTag);
  if (index < 0) throw new TypeError(`PPTX package is missing ${closeTag}`);
  return `${xml.slice(0, index)}${addition}${xml.slice(index)}`;
}

function removeInactiveSourceSlidesAndNotes(zip: JSZip, contentTypesXml: string): string {
  const removedParts = new Set<string>();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const sourceSlide = /^ppt\/slides\/[^/]+\.xml$/i.test(name);
    const sourceSlideRels = /^ppt\/slides\/_rels\/[^/]+\.rels$/i.test(name);
    const sourceNotes = /^ppt\/notesSlides\/[^/]+\.xml$/i.test(name);
    const sourceNotesRels = /^ppt\/notesSlides\/_rels\/[^/]+\.rels$/i.test(name);
    if (sourceSlide || sourceSlideRels || sourceNotes || sourceNotesRels) {
      if (sourceSlide || sourceNotes) removedParts.add(name);
      zip.remove(name);
    }
  }
  return contentTypesXml.replace(/<Override\b[^>]*\bPartName\s*=\s*(["'])\/(ppt\/(?:slides|notesSlides)\/[^"']+\.xml)\1[^>]*\/>/giu,
    (tag, _quote: string, partName: string) => removedParts.has(partName) ? '' : tag);
}

function safePart(part: string): string {
  const normalized = path.posix.normalize(part);
  if (!normalized.startsWith('ppt/slideLayouts/') || normalized.split('/').includes('..')) {
    throw new TypeError('Template layout part is outside ppt/slideLayouts');
  }
  return normalized;
}

function textShape(input: {
  id: number;
  name: string;
  text: string[];
  box: PlacementBox;
  fontFace: string;
  fontSizePt: number;
  bold: boolean;
  drawingNs: string;
  presentationNs: string;
}): string {
  const paragraphs = input.text.map((line) => {
    const run = line.length === 0 ? '' : `<a:r><a:rPr lang="en-US" sz="${Math.round(input.fontSizePt * 100)}"${input.bold ? ' b="1"' : ''}><a:latin typeface="${escapeXml(input.fontFace)}"/><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:rPr><a:t xml:space="preserve">${escapeXml(line)}</a:t></a:r>`;
    return `<a:p><a:pPr algn="l"/>${run}<a:endParaRPr lang="en-US"/></a:p>`;
  }).join('');
  return `<p:sp><p:nvSpPr><p:cNvPr id="${input.id}" name="${escapeXml(input.name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${input.box.x}" y="${input.box.y}"/><a:ext cx="${input.box.width}" cy="${input.box.height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" anchor="t"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}

function nativeTable(slide: CompiledSlide, tableNs: string): string {
  const rows = slide.visualization.tableData;
  if (!rows?.length) return '';
  const columns = Math.max(1, ...rows.map((row) => row.length));
  const box = slide.placements.body;
  const columnWidth = Math.max(1, Math.floor(box.width / columns));
  const rowHeight = Math.max(1, Math.floor(box.height / rows.length));
  const grid = Array.from({ length: columns }, () => `<a:gridCol w="${columnWidth}"/>`).join('');
  const xmlRows = rows.map((row) => {
    const cells = Array.from({ length: columns }, (_value, column) => {
      const text = row[column] ?? '';
      return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1400"><a:latin typeface="+mn-lt"/></a:rPr><a:t xml:space="preserve">${escapeXml(text)}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></a:txBody><a:tcPr/></a:tc>`;
    }).join('');
    return `<a:tr h="${rowHeight}">${cells}</a:tr>`;
  }).join('');
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="LCT editable table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.width}" cy="${box.height}"/></p:xfrm><a:graphic><a:graphicData uri="${tableNs}"><a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr><a:tblGrid>${grid}</a:tblGrid>${xmlRows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

function fontSizes(slide: CompiledSlide, template: TemplateIR): { title: number; body: number } {
  const layout = template.layouts.find((item) => item.id === slide.layoutId);
  const titleSizes = layout?.elements.filter((item) => /title|ctrtitle|subtitle/.test(`${item.placeholder?.role ?? ''} ${item.placeholder?.type ?? ''}`.toLowerCase()))
    .flatMap((item) => item.directStyles.fontSizesPt ?? []).filter((size) => size > 0) ?? [];
  const allSizes = template.layouts.flatMap((item) => item.elements.flatMap((element) => element.directStyles.fontSizesPt ?? [])).filter((size) => size > 0).sort((a, b) => a - b);
  const title = titleSizes.length ? Math.max(...titleSizes) : allSizes.at(-1) ?? 30;
  const body = allSizes.length ? allSizes[Math.floor((allSizes.length - 1) / 2)]! : 18;
  return { title, body: Math.min(body, title) };
}

function makeSlideXml(slide: CompiledSlide, template: TemplateIR, pNs: string, aNs: string, rNs: string): string {
  const fonts = fontSizes(slide, template);
  const titleFont = template.theme?.fonts.major || '+mj-lt';
  const bodyFont = template.theme?.fonts.minor || '+mn-lt';
  const title = textShape({ id: 2, name: 'LCT editable title', text: [slide.title], box: slide.placements.title, fontFace: titleFont, fontSizePt: fonts.title, bold: true, drawingNs: aNs, presentationNs: pNs });
  const body = textShape({ id: 3, name: 'LCT editable body', text: slide.body, box: slide.placements.body, fontFace: bodyFont, fontSizePt: fonts.body, bold: false, drawingNs: aNs, presentationNs: pNs });
  const tableNs = pNs.includes('purl.oclc.org')
    ? 'http://purl.oclc.org/ooxml/drawingml/table'
    : 'http://schemas.openxmlformats.org/drawingml/2006/table';
  const table = nativeTable(slide, tableNs);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="${pNs}" xmlns:a="${aNs}" xmlns:r="${rNs}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${title}${body}${table}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function slideRelationships(layoutPart: string, officeRelNs: string): string {
  const target = path.posix.relative('ppt/slides', safePart(layoutPart));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${officeRelNs}/slideLayout" Target="${escapeXml(target)}"/></Relationships>`;
}

function presentationParts(xml: string, relsXml: string, slides: CompiledSlide[], template: TemplateIR, pNs: string, aNs: string, rNs: string, officeRelNs: string, prefix: string): {
  presentation: string;
  relationships: string;
  slideEntries: Array<{ name: string; relsName: string; xml: string; relsXml: string }>;
} {
  const listMatch = /<p:sldIdLst(?:\s[^>]*)?>[\s\S]*?<\/p:sldIdLst>/.exec(xml);
  if (!listMatch) throw new TypeError('PPTX presentation has no slide list');
  const existingRids = new Set(Array.from(relsXml.matchAll(/\bId=["']([^"']+)["']/g), (match) => match[1]!));
  const existingSlideIds = Array.from(xml.matchAll(/<p:sldId\b[^>]*\bid=["'](\d+)["']/g), (match) => Number(match[1]));
  let nextSlideId = Math.max(255, ...existingSlideIds) + 1;
  let relNumber = 1;
  const generatedRelationshipIds: string[] = [];
  const contentTypeEntries: string[] = [];
  const slideEntries: Array<{ name: string; relsName: string; xml: string; relsXml: string }> = [];
  const ids: string[] = [];

  for (let index = 0; index < slides.length; index += 1) {
    const slide = slides[index]!;
    const layout = template.layouts.find((item) => item.id === slide.layoutId);
    if (!layout) throw new TypeError(`Compiled slide ${slide.id} references an unknown layout`);
    const layoutPart = safePart(layout.sourcePart);
    let rid = `rIdLct${relNumber++}`;
    while (existingRids.has(rid)) rid = `rIdLct${relNumber++}`;
    existingRids.add(rid);
    generatedRelationshipIds.push(rid);
    const part = `ppt/slides/${prefix}_slide_${index + 1}.xml`;
    const relPart = `ppt/slides/_rels/${prefix}_slide_${index + 1}.xml.rels`;
    ids.push(`<p:sldId id="${nextSlideId++}" r:id="${rid}"/>`);
    contentTypeEntries.push(`<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
    slideEntries.push({
      name: part,
      relsName: relPart,
      xml: makeSlideXml(slide, template, pNs, aNs, rNs),
      relsXml: slideRelationships(layoutPart, officeRelNs),
    });
  }

  let presentation = xml.replace(listMatch[0], `<p:sldIdLst>${ids.join('')}</p:sldIdLst>`);
  let relationships = relsXml.replace(/<Relationship\b(?=[^>]*\bType=["'][^"']*\/slide["'])[^>]*\/>/g, '');
  relationships = appendBeforeClose(relationships, '</Relationships>', slides.map((slide, index) => {
    const part = `ppt/slides/${prefix}_slide_${index + 1}.xml`;
    const target = path.posix.relative('ppt', part);
    const rel = generatedRelationshipIds[index]!;
    return `<Relationship Id="${rel}" Type="${officeRelNs}/slide" Target="${escapeXml(target)}"/>`;
  }).join(''));
  return {
    presentation,
    relationships,
    slideEntries,
  };
}

/** Create native editable text slides while retaining the source package's masters, theme, assets, and layouts. */
export async function renderNativePptx(input: {
  compiledPresentation: CompiledPresentation;
  contentIR: ContentIR;
  templateIR: TemplateIR;
  templatePath: string;
  outputPath: string;
}): Promise<NativePptxRenderResult> {
  const templateIR = validateTemplateIR(input.templateIR);
  if (input.compiledPresentation.templateIRHash !== templateIR.hash || input.compiledPresentation.contentIRHash !== input.contentIR.hash) {
    throw new TypeError('Compiled presentation source hashes do not match the render inputs');
  }
  const audit = auditCompiledPresentation(input.compiledPresentation, input.contentIR, templateIR);
  const blocking = audit.findings.filter((finding) => finding.severity === 'error');
  if (blocking.length) throw new TypeError(`Native PPTX render blocked by ${blocking.length} deterministic error(s)`);
  if (input.compiledPresentation.slides.length < 1) throw new TypeError('Cannot render an empty presentation');

  const inputBytes = await readFile(input.templatePath);
  if (inputBytes.byteLength > MAX_TEMPLATE_BYTES) throw new TypeError('Template PPTX exceeds the 64 MiB render limit');
  const inputHash = createHash('sha256').update(inputBytes).digest('hex');
  if (inputHash !== templateIR.source.sha256) throw new TypeError('Template PPTX bytes do not match the compiled TemplateIR source hash');
  const zip = await JSZip.loadAsync(inputBytes, { checkCRC32: true, createFolders: false });
  const sourceVisualArtifacts = await collectSourceSlideVisualArtifacts(zip);
  const presentationFile = zip.file('ppt/presentation.xml');
  const relsFile = zip.file('ppt/_rels/presentation.xml.rels');
  const contentTypesFile = zip.file('[Content_Types].xml');
  if (!presentationFile || !relsFile || !contentTypesFile) throw new TypeError('Template is missing required OPC presentation parts');
  const [presentationXml, relsXml, contentTypesXml] = await Promise.all([presentationFile.async('string'), relsFile.async('string'), contentTypesFile.async('string')]);
  const presentationRoot = rootStartTag(presentationXml);
  const pNs = xmlAttribute(presentationRoot, 'xmlns:p');
  const rNs = xmlAttribute(presentationRoot, 'xmlns:r');
  const relRoot = rootStartTag(relsXml);
  const relNs = xmlAttribute(relRoot, 'xmlns');
  const strict = pNs?.includes('purl.oclc.org') === true;
  const aNs = strict ? 'http://purl.oclc.org/ooxml/drawingml/main' : 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const officeRelNs = strict ? 'http://purl.oclc.org/ooxml/officeDocument/relationships' : 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  if (!pNs || !rNs || relNs !== PACKAGE_REL_NS || !contentTypesXml.includes('<Types')) {
    throw new TypeError('Template uses an unsupported or incomplete OPC namespace profile');
  }
  for (const slide of input.compiledPresentation.slides) {
    const layout = templateIR.layouts.find((item) => item.id === slide.layoutId);
    if (!layout || !zip.file(safePart(layout.sourcePart))) throw new TypeError(`Template package is missing layout part for ${slide.id}`);
  }
  let prefix = `lct_${input.compiledPresentation.id.slice(-12)}_${input.compiledPresentation.variantId.toLowerCase()}`;
  let suffix = 1;
  while (zip.file(`ppt/slides/${prefix}_slide_1.xml`) || zip.file(`ppt/slides/_rels/${prefix}_slide_1.xml.rels`)) {
    prefix = `lct_${input.compiledPresentation.id.slice(-12)}_${input.compiledPresentation.variantId.toLowerCase()}_${suffix++}`;
  }
  const parts = presentationParts(presentationXml, relsXml, input.compiledPresentation.slides, templateIR, pNs, aNs, rNs, officeRelNs, prefix);
  const cleanedContentTypesXml = removeInactiveSourceSlidesAndNotes(zip, contentTypesXml);
  const nextContentTypes = appendBeforeClose(cleanedContentTypesXml, '</Types>', parts.slideEntries.map((_entry, index) =>
    `<Override PartName="/ppt/slides/${prefix}_slide_${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join(''));
  // Some generated fixtures declare only a generic XML default; keep all original declarations intact.
  zip.file('ppt/presentation.xml', parts.presentation, { date: FIXED_ZIP_DATE });
  zip.file('ppt/_rels/presentation.xml.rels', parts.relationships, { date: FIXED_ZIP_DATE });
  zip.file('[Content_Types].xml', nextContentTypes, { date: FIXED_ZIP_DATE });
  for (const part of parts.slideEntries) {
    if (zip.file(part.name) || zip.file(part.relsName)) throw new TypeError('Generated slide part path collision');
    zip.file(part.name, part.xml, { date: FIXED_ZIP_DATE });
    zip.file(part.relsName, part.relsXml, { date: FIXED_ZIP_DATE });
  }
  await removeUnreachableSourceVisualArtifacts(zip, sourceVisualArtifacts);

  const outputBytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const resolvedOutput = path.resolve(input.outputPath);
  const temporary = `${resolvedOutput}.${process.pid}.tmp`;
  await writeFile(temporary, outputBytes, { flag: 'wx' });
  try {
    await rename(temporary, resolvedOutput);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  const unresolvedVisualTypes = [...new Set(input.compiledPresentation.slides.flatMap((slide) => {
    const unresolved: string[] = [];
    if (slide.imageRefs.length > 0) unresolved.push('image');
    if (slide.visualization.type !== 'none'
        && (slide.visualization.type !== 'table' || slide.visualization.tableData === null)) {
      unresolved.push(slide.visualization.type);
    }
    return unresolved;
  }))];
  const unsupportedVisualIssues = unresolvedVisualTypes.map((visualType) => ({
    severity: 'warning' as const,
    message: `The custom backend does not materialize ${visualType} visuals; source-backed text is retained.`,
    partName: null,
  }));
  return {
    backend: 'custom',
    outputPath: resolvedOutput,
    presentationId: input.compiledPresentation.id,
    slideCount: input.compiledPresentation.slides.length,
    nativeTextShapeCount: input.compiledPresentation.slides.length * 2,
    nativeTableCount: input.compiledPresentation.slides.filter((slide) => slide.visualization.tableData !== null).length,
    nativeChartCount: 0,
    nativeImageCount: 0,
    nativeShapeCount: 0,
    nativeConnectorCount: 0,
    nativeNotesCount: 0,
    rasterSlideCount: 0,
    auditFindingCount: audit.findings.length + unsupportedVisualIssues.length,
    artifactSha256: createHash('sha256').update(outputBytes).digest('hex'),
    reopenStatus: 'not-run',
    validationStatus: 'not-run',
    templatePreservationStatus: 'unknown',
    validationIssues: unsupportedVisualIssues,
    unresolvedVisualTypes,
    visualIntents: input.compiledPresentation.slides.map((slide) => {
      const requestedType = slide.visualization.type;
      if (requestedType === 'none') return { slideId: slide.id, requestedType, realizedType: 'none' as const, fallbackReason: null };
      if (requestedType === 'table' && slide.visualization.tableData) {
        return { slideId: slide.id, requestedType, realizedType: 'table' as const, fallbackReason: null };
      }
      return {
        slideId: slide.id,
        requestedType,
        realizedType: 'unresolved' as const,
        fallbackReason: 'The custom renderer does not materialize this visual type; source-backed text remains in the slide.',
      };
    }),
    projectedCompositions: input.compiledPresentation.slides.map((slide) => ({
      slideId: slide.id,
      variantId: slide.variantId,
      sourceSlideIndex: null,
      semanticArchetype: null,
      confidence: null,
      projectedCompositionSignature: generatedFallbackCompositionSignature(slide, input.templateIR),
      availableDistinctFamilies: null,
      titleGeometryNormalized: null,
      bodyGeometryNormalized: null,
      titleBodyFontHierarchy: null,
      selectionReason: 'custom renderer used deterministic generated placements',
    })),
  };
}
