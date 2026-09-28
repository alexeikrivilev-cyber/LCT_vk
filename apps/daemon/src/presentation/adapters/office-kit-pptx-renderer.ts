import { createHash } from 'node:crypto';
import { readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path, { sep } from 'node:path';

import {
  addSlide,
  addSlideChart,
  addSlideImage,
  addSlideLine,
  addSlideShape,
  addSlideTable,
  addSlideTextBox,
  asColor,
  compactPackage,
  duplicateSlide,
  emu,
  findSlidePlaceholder,
  findSlideLayoutByPartName,
  findSlidePlaceholderByIdx,
  getShapeId,
  getShapeKind,
  getShapeBoundsResolved,
  getShapePlaceholderIdx,
  getShapePlaceholderType,
  getShapeParagraphCount,
  getShapeRunCount,
  getShapeRunFormatEffective,
  getShapeTextMargins,
  getShapeText,
  getShapeTextAutoFitParams,
  getSlideCharts,
  getSlidePartName,
  getSlideLayoutPlaceholders,
  getSlideShapes,
  getSlideTables,
  getSlides,
  hasShapeText,
  loadPresentation,
  removeSlide,
  removeShape,
  removeSlideNotes,
  resolveDeckBodyTextColor,
  savePresentation,
  setShapeText,
  setShapeAlignment,
  setShapeNoFill,
  setShapeStroke,
  setShapeStrokeArrow,
  setShapeTextAnchor,
  setShapeTextMargins,
  setShapeTextAutoFit,
  setShapeTextFormat,
  sortSlides,
  validatePresentation,
} from '@office-kit/pptx/node';
import JSZip from 'jszip';

import { auditCompiledPresentation } from '../application/deterministic-audit.js';
import { fitProcessNodeLayout, fitsProcessLabel, type ProcessLayoutBox, type ProcessNodeLayout } from '../application/process-layout.js';
import {
  assessExemplarSelection,
  generatedFallbackCompositionSignature,
  type ExemplarSelectionAssessment,
  type ExemplarSlideSelection,
} from '../application/exemplar-slide-selector.js';
import { collectSourceSlideVisualArtifacts, relationshipPartFor, removeUnreachableSourceVisualArtifacts } from '../application/pptx-source-artifacts.js';
import type { CompiledSlide } from '../application/slide-compilation.js';
import type { PptxRenderInput, PptxRenderResult, PptxRendererPort } from '../application/pptx-backend-port.js';
import { recordElapsed, type PerformanceDiagnosticsPort } from '../performance-diagnostics.js';

const MAX_TEMPLATE_BYTES = 64 * 1024 * 1024;
const REWRITTEN_PACKAGE_PARTS = new Set([
  '[Content_Types].xml',
  'ppt/presentation.xml',
  'ppt/_rels/presentation.xml.rels',
  'docProps/app.xml',
  'docProps/core.xml',
]);

async function preservedTemplateParts(bytes: Uint8Array, excludedParts: ReadonlySet<string> = new Set()): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(bytes);
  const parts = new Map<string, string>();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || excludedParts.has(name) || REWRITTEN_PACKAGE_PARTS.has(name)
        || name.startsWith('ppt/slides/') || name.startsWith('ppt/notesSlides/') || name.startsWith('ppt/notesMasters/')) continue;
    parts.set(name, createHash('sha256').update(await entry.async('uint8array')).digest('hex'));
  }
  return parts;
}

async function comparePreservedTemplateParts(source: Uint8Array, output: Uint8Array, sourceChartArtifacts: ReadonlySet<string>): Promise<boolean> {
  const excluded = new Set(sourceChartArtifacts);
  for (const part of sourceChartArtifacts) excluded.add(relationshipPartFor(part));
  const expected = await preservedTemplateParts(source, excluded);
  const actual = await preservedTemplateParts(output);
  return [...expected].every(([name, hash]) => actual.get(name) === hash);
}

export class PptxBackendError extends Error {
  readonly code: string;
  readonly finding: { ruleId: string; severity: 'error'; message: string; sourcePath: string | null };

  constructor(code: string, message: string, sourcePath: string | null = null, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PptxBackendError';
    this.code = code;
    this.finding = { ruleId: `visual.${code.toLowerCase().replaceAll('_', '-')}`, severity: 'error', message, sourcePath };
  }
}

export async function readVerifiedImageAt(contentRoot: string | undefined, image: PptxRenderInput['compiledPresentation']['slides'][number]['imageRefs'][number]): Promise<Uint8Array> {
  if (!contentRoot || !path.isAbsolute(contentRoot)) {
    throw new PptxBackendError('MEDIA_ROOT_REQUIRED', 'Image rendering requires an absolute project content root.', image.sourcePath);
  }
  const root = await realpath(contentRoot);
  const candidate = path.resolve(root, ...image.sourcePath.split('/'));
  const file = await realpath(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new PptxBackendError('MISSING_ASSET', 'Referenced image file is missing from the project.', image.sourcePath, { cause: error });
    throw new PptxBackendError('ASSET_UNAVAILABLE', 'Referenced image file could not be read safely.', image.sourcePath, { cause: error });
  });
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${sep}`) || path.isAbsolute(relative)) {
    throw new PptxBackendError('ASSET_PATH_ESCAPE', 'Referenced image resolves outside the project content root.', image.sourcePath);
  }
  const bytes = await readFile(file);
  if (createHash('sha256').update(bytes).digest('hex') !== image.sha256) {
    throw new PptxBackendError('ASSET_HASH_MISMATCH', 'Referenced image bytes do not match their ContentIR hash.', image.sourcePath);
  }
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (image.mediaType === 'image/png' && png || image.mediaType === 'image/jpeg' && jpeg) return bytes;
  if (webp || image.mediaType === 'image/webp') {
    throw new PptxBackendError('UNSUPPORTED_IMAGE_FORMAT', 'Office Kit does not document aspect-safe WebP image authoring; use PNG or JPEG.', image.sourcePath);
  }
  throw new PptxBackendError('CORRUPT_ASSET', 'Image bytes do not match the declared PNG or JPEG media type.', image.sourcePath);
}

async function readVerifiedImage(input: PptxRenderInput, image: PptxRenderInput['compiledPresentation']['slides'][number]['imageRefs'][number]): Promise<Uint8Array> {
  return readVerifiedImageAt(input.contentRoot, image);
}

function normalizeIssues(issues: ReturnType<typeof validatePresentation>) {
  return issues.map((issue) => ({ severity: issue.severity, message: issue.message, partName: issue.partName ?? null }));
}

function normalizePart(partName: string): string {
  return partName.replace(/^\/+/, '');
}

function normalizedVisibleText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function textSegmentation(shape: ReturnType<typeof getSlideShapes>[number]): { paragraphs: number; runs: number } {
  const paragraphs = getShapeParagraphCount(shape);
  let runs = 0;
  for (let paragraph = 0; paragraph < paragraphs; paragraph += 1) runs += getShapeRunCount(shape, paragraph);
  return { paragraphs, runs };
}

function requiredDonorShape(slide: ReturnType<typeof getSlides>[number], nativeId: string, role: string) {
  const shape = getSlideShapes(slide).find((candidate) => String(getShapeId(candidate)) === nativeId);
  if (!shape || !hasShapeText(shape)) throw new PptxBackendError('EXEMPLAR_DONOR_MISSING', `The selected exemplar ${role} donor could not be mapped to its Office Kit shape.`);
  return shape;
}

function roleTextStyle(
  presentation: Awaited<ReturnType<typeof loadPresentation>>,
  slide: ReturnType<typeof getSlides>[number],
  role: 'title' | 'body',
  preferredShapes: readonly ReturnType<typeof getSlideShapes>[number][] = [],
) {
  const allowedTypes = role === 'title'
    ? new Set(['title', 'ctrTitle', 'subTitle'])
    : new Set(['body', 'obj', 'subTitle']);
  const shapes = getSlideShapes(slide);
  const candidates = [...preferredShapes, ...shapes.filter((shape) => allowedTypes.has(getShapePlaceholderType(shape) ?? '')),
  ];
  const seen = new Set<object>();
  for (const shape of candidates) {
    if (seen.has(shape)) continue;
    seen.add(shape);
    try {
      const format = getShapeRunFormatEffective(presentation, shape, 0, 0);
      const color = format.color ?? resolveDeckBodyTextColor(slide);
      if (color) return { color, size: format.size !== undefined && Number.isFinite(format.size) && format.size > 0 ? format.size : undefined,
        font: format.font ?? undefined, fontEastAsian: format.fontEastAsian ?? undefined,
        fontComplexScript: format.fontComplexScript ?? undefined };
    } catch {
      // Try the next template role source; never fall back to a generic black text color.
    }
  }
  const deckBodyColor = resolveDeckBodyTextColor(slide);
  if (deckBodyColor) return { color: deckBodyColor };
  throw new PptxBackendError('TEMPLATE_TEXT_STYLE_UNRESOLVED', `Could not derive a ${role} text color from the template role or theme.`);
}

function applyRoleTextStyle(
  presentation: Awaited<ReturnType<typeof loadPresentation>>,
  slide: ReturnType<typeof getSlides>[number],
  shape: ReturnType<typeof getSlideShapes>[number],
  role: 'title' | 'body',
  preferredShapes: readonly ReturnType<typeof getSlideShapes>[number][] = [],
): void {
  applyResolvedRoleTextStyle(shape, roleTextStyle(presentation, slide, role, preferredShapes));
}

function applyResolvedRoleTextStyle(
  shape: ReturnType<typeof getSlideShapes>[number],
  style: ReturnType<typeof roleTextStyle>,
): void {
  setShapeTextFormat(shape, {
    color: asColor(style.color),
    ...(style.size ? { size: style.size } : {}),
    ...(style.font ? { font: style.font } : {}),
    ...(style.fontEastAsian ? { fontEastAsian: style.fontEastAsian } : {}),
    ...(style.fontComplexScript ? { fontComplexScript: style.fontComplexScript } : {}),
  });
}

function requiredTemplateColor(color: string) {
  const resolved = asColor(color);
  if (!resolved) throw new PptxBackendError('TEMPLATE_TEXT_STYLE_UNRESOLVED', 'Could not derive a connector color from the template body text role.');
  return resolved;
}

function boxesOverlap(left: { x: number; y: number; width: number; height: number }, right: { x: number; y: number; width: number; height: number }): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x
    && left.y < right.y + right.height && left.y + left.height > right.y;
}

function safeProcessVisualBox(compiled: CompiledSlide, bodyFontPt: number): ProcessLayoutBox | null {
  const title = compiled.placements.title;
  const body = compiled.placements.body;
  const candidate = compiled.placements.visual;
  const stepCount = compiled.visualization.processSteps.length;
  const labels = compiled.visualization.processSteps.map((step) => step.text);
  const candidates = candidate && !boxesOverlap(candidate, title) && !boxesOverlap(candidate, body)
    ? [candidate]
    : compiled.body.length <= stepCount && !boxesOverlap(body, title) ? [body] : [];
  return candidates.find((box) => fitProcessNodeLayout(box, labels, bodyFontPt) !== null) ?? null;
}

const PROCESS_CONNECTOR_WIDTH_EMU = 25_400;
const PROCESS_NODE_TEXT_MARGIN_EMU = 45_720;

function addProcessNode(
  slide: ReturnType<typeof getSlides>[number],
  text: string,
  box: { x: number; y: number; width: number; height: number },
  color: string,
  bodyStyle: ReturnType<typeof roleTextStyle>,
) {
  const node = addSlideShape(slide, {
    preset: 'roundRect', x: emu(box.x), y: emu(box.y), w: emu(box.width), h: emu(box.height), text, textAnchor: 'ctr',
    name: 'lct-generated-process-step',
  });
  setShapeNoFill(node);
  setShapeStroke(node, { color: requiredTemplateColor(color), widthEmu: PROCESS_CONNECTOR_WIDTH_EMU });
  setShapeAlignment(node, 'center');
  setShapeTextAnchor(node, 'center');
  setShapeTextMargins(node, {
    left: PROCESS_NODE_TEXT_MARGIN_EMU, right: PROCESS_NODE_TEXT_MARGIN_EMU,
    top: PROCESS_NODE_TEXT_MARGIN_EMU, bottom: PROCESS_NODE_TEXT_MARGIN_EMU,
  });
  applyResolvedRoleTextStyle(node, bodyStyle);
  return node;
}

function addProcessConnector(
  slide: ReturnType<typeof getSlides>[number],
  from: { x: number; y: number },
  to: { x: number; y: number },
  color: string,
) {
  const connector = addSlideLine(slide, {
    from: { x: emu(from.x), y: emu(from.y) }, to: { x: emu(to.x), y: emu(to.y) },
    color: requiredTemplateColor(color), widthEmu: PROCESS_CONNECTOR_WIDTH_EMU,
    name: 'lct-generated-process-connector',
  });
  setShapeStrokeArrow(connector, 'tail', { type: 'triangle', width: 'sm', length: 'sm' });
  return connector;
}

function connectProcessNodes(
  slide: ReturnType<typeof getSlides>[number],
  layout: ProcessNodeLayout,
  color: string,
): void {
  for (let index = 0; index < layout.nodes.length - 1; index += 1) {
    const from = layout.nodes[index]!;
    const to = layout.nodes[index + 1]!;
    if (layout.axis === 'x') {
      const gap = to.x - (from.x + from.width);
      const y = from.y + Math.floor(from.height / 2);
      const inset = Math.min(Math.round(gap * 0.08), PROCESS_CONNECTOR_WIDTH_EMU);
      addProcessConnector(slide, { x: from.x + from.width + inset, y }, { x: to.x - inset, y }, color);
    } else {
      const gap = to.y - (from.y + from.height);
      const x = from.x + Math.floor(from.width / 2);
      const inset = Math.min(Math.round(gap * 0.08), PROCESS_CONNECTOR_WIDTH_EMU);
      addProcessConnector(slide, { x, y: from.y + from.height + inset }, { x, y: to.y - inset }, color);
    }
  }
}

function projectExemplarText(
  slide: ReturnType<typeof getSlides>[number],
  compiled: CompiledSlide,
  selection: ExemplarSlideSelection,
  textStyleWarnings: string[],
): void {
  const shapes = getSlideShapes(slide);
  const byNativeId = new Map(shapes.map((shape) => [String(getShapeId(shape)), shape]));
  const title = requiredDonorShape(slide, selection.slots.title.nativeId, 'title');
  const bodySlots = selection.slots.bodySlots.length ? selection.slots.bodySlots : [selection.slots.body];
  const bodyShapes = bodySlots.map((slot, index) => requiredDonorShape(slide, slot.nativeId, `body ${index + 1}`));
  const sourceBodyText = compiled.body.join('\n');
  if (selection.bodyContentRanges.length !== bodyShapes.length
      || selection.bodyContentSegments.length !== bodyShapes.length
      || selection.bodySegmentation.regionCount !== bodyShapes.length
      || selection.bodySegmentation.fragmentCount < bodyShapes.length
      || selection.bodySegmentation.sourceTextSha256 !== createHash('sha256').update(sourceBodyText).digest('hex')
      || selection.bodyContentSegments.join('') !== sourceBodyText
      || selection.bodyContentRanges.some((range, index) => !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
        || range.start < 0 || range.end <= range.start || range.end > selection.bodySegmentation.fragmentCount
        || (index > 0 && selection.bodyContentRanges[index - 1]!.end !== range.start))
      || selection.bodyContentRanges[0]?.start !== 0
      || selection.bodyContentRanges.at(-1)?.end !== selection.bodySegmentation.fragmentCount) {
    throw new PptxBackendError('EXEMPLAR_BODY_ASSIGNMENT_INVALID', `The selected exemplar body assignment does not cover the source text exactly once.`);
  }
  for (const [role, shape] of [['title', title] as const, ...bodyShapes.map((shape, index) => [`body ${index + 1}`, shape] as const)]) {
    const segmentation = textSegmentation(shape);
    textStyleWarnings.push(`Exemplar slide ${selection.sourceSlideIndex} ${role} donor was replaced with Office Kit setShapeText; paragraph-end formatting may not be retained.`);
    if (segmentation.paragraphs > 1 || segmentation.runs > 1) {
      textStyleWarnings.push(`Exemplar slide ${selection.sourceSlideIndex} ${role} donor has ${segmentation.paragraphs} paragraph(s) and ${segmentation.runs} run(s); Office Kit setShapeText was used, so secondary mixed-run styling may be collapsed.`);
    }
  }
  const replacementIds = new Set([selection.slots.title.nativeId, ...bodySlots.map((slot) => slot.nativeId)]);
  for (const nativeId of selection.removeElementNativeIds) {
    if (replacementIds.has(nativeId)) throw new PptxBackendError('EXEMPLAR_CLEANUP_MAPPING_FAILED', 'A mapped title/body object cannot also be removed.');
    const shape = byNativeId.get(nativeId);
    if (!shape || getShapeKind(shape) !== 'shape') {
      throw new PptxBackendError('EXEMPLAR_CLEANUP_MAPPING_FAILED', `A validated unused exemplar object on source slide ${selection.sourceSlideIndex} could not be removed safely.`);
    }
    removeShape(shape);
  }
  for (const nativeId of selection.clearElementNativeIds) {
    if (replacementIds.has(nativeId)) continue;
    const shape = byNativeId.get(nativeId);
    if (!shape || !hasShapeText(shape)) throw new PptxBackendError('EXEMPLAR_CLEANUP_MAPPING_FAILED', `A source-specific text shape on exemplar slide ${selection.sourceSlideIndex} could not be cleared safely.`);
    setShapeText(shape, '');
  }
  setShapeText(title, compiled.title);
  for (let index = 0; index < bodyShapes.length; index += 1) {
    setShapeText(bodyShapes[index]!, selection.bodyContentSegments[index]!);
  }
}

function countExemplarObjects(slide: ReturnType<typeof getSlides>[number]) {
  const shapes = getSlideShapes(slide);
  const textShapes = shapes.filter((shape) => hasShapeText(shape) && getShapeText(shape).trim()).length;
  const connectors = shapes.filter((shape) => getShapeKind(shape) === 'connector').length;
  const pictures = shapes.filter((shape) => getShapeKind(shape) === 'picture').length;
  const editableShapes = shapes.filter((shape) => getShapeKind(shape) === 'shape' && !hasShapeText(shape)).length;
  return { textShapes, connectors, pictures, editableShapes, charts: getSlideCharts(slide).length, tables: getSlideTables(slide).length };
}

async function addProjectedVisual(
  presentation: Awaited<ReturnType<typeof loadPresentation>>,
  slide: ReturnType<typeof getSlides>[number],
  compiled: CompiledSlide,
  visualBox: { x: number; y: number; width: number; height: number },
  roleSources: { title: ReturnType<typeof getSlideShapes>[number]; body?: ReturnType<typeof getSlideShapes>[number] },
  input: PptxRenderInput,
): Promise<{ text: number; tables: number; charts: number; images: number; shapes: number; connectors: number }> {
  const counts = { text: 0, tables: 0, charts: 0, images: 0, shapes: 0, connectors: 0 };
  if (compiled.visualization.tableData) {
    addSlideTable(slide, {
      x: emu(visualBox.x), y: emu(visualBox.y), w: emu(visualBox.width), h: emu(visualBox.height),
      rows: compiled.visualization.tableData,
    });
    counts.tables += 1;
  }
  if (compiled.visualization.chartData) {
    addSlideChart(slide, {
      x: emu(visualBox.x), y: emu(visualBox.y), w: emu(visualBox.width), h: emu(visualBox.height),
      spec: {
        kind: compiled.visualization.chartData.kind,
        categories: compiled.visualization.chartData.categories,
        series: compiled.visualization.chartData.series.map(({ name, values }) => ({ name, values })),
        title: compiled.visualization.chartData.title,
      },
    });
    counts.charts += 1;
  }
  if (compiled.visualization.kpi) {
    const valueHeight = Math.max(1, Math.floor(visualBox.height * 0.62));
    const value = addSlideTextBox(slide, {
      x: emu(visualBox.x), y: emu(visualBox.y), w: emu(visualBox.width), h: emu(valueHeight),
      text: compiled.visualization.kpi.value,
    });
    applyRoleTextStyle(presentation, slide, value, 'title', [roleSources.title]);
    const label = addSlideTextBox(slide, {
      x: emu(visualBox.x), y: emu(visualBox.y + valueHeight), w: emu(visualBox.width), h: emu(visualBox.height - valueHeight),
      text: compiled.visualization.kpi.label,
    });
    applyRoleTextStyle(presentation, slide, label, 'body', roleSources.body ? [roleSources.body] : []);
    counts.text += 2;
    counts.shapes += 2;
  }
  if (compiled.visualization.processSteps.length >= 2) {
    const bodyStyle = roleTextStyle(presentation, slide, 'body', roleSources.body ? [roleSources.body] : []);
    const actualTitle = getShapeBoundsResolved(presentation, roleSources.title);
    const actualBody = roleSources.body ? getShapeBoundsResolved(presentation, roleSources.body) : null;
    if (actualTitle && boxesOverlap(visualBox, { x: actualTitle.x, y: actualTitle.y, width: actualTitle.w, height: actualTitle.h })
        || actualBody && boxesOverlap(visualBox, { x: actualBody.x, y: actualBody.y, width: actualBody.w, height: actualBody.h })) return counts;
    const nodeLayout = bodyStyle.size
      ? fitProcessNodeLayout(visualBox, compiled.visualization.processSteps.map((step) => step.text), bodyStyle.size)
      : null;
    if (!nodeLayout) return counts;
    compiled.visualization.processSteps.forEach((step, index) => addProcessNode(slide, step.text, nodeLayout.nodes[index]!, bodyStyle.color, bodyStyle));
    connectProcessNodes(slide, nodeLayout, bodyStyle.color);
    counts.text += nodeLayout.nodes.length;
    counts.shapes += nodeLayout.nodes.length;
    counts.connectors += nodeLayout.nodes.length - 1;
  }
  if (compiled.imageRefs.length) {
    if (compiled.imageRefs.length > 1) throw new PptxBackendError('MULTIPLE_IMAGES_UNSUPPORTED', 'A slide currently supports one source-backed image in its selected visual slot.', compiled.imageRefs[1]!.sourcePath);
    const image = compiled.imageRefs[0]!;
    const imageBytes = await readVerifiedImage(input, image);
    addSlideImage(slide, imageBytes, {
      x: emu(visualBox.x), y: emu(visualBox.y), w: emu(visualBox.width), h: emu(visualBox.height), fit: 'contain',
    });
    counts.images += 1;
  }
  return counts;
}

/**
 * A process/timeline may safely occupy measured native body regions when the
 * template has no separate visual slot. Reuse those editable regions as nodes
 * and connect only a verified row/column; never draw guessed/crossing lines.
 */
function addBodyHostedSequence(
  presentation: Awaited<ReturnType<typeof loadPresentation>>,
  slide: ReturnType<typeof getSlides>[number],
  compiled: CompiledSlide,
  selection: ExemplarSlideSelection,
): { textShapes: number; connectors: number } | null {
  const slots = selection.slots.bodySlots.length ? selection.slots.bodySlots : [selection.slots.body];
  if (slots.length < 1 || compiled.visualization.processSteps.length < 2) return null;
  const shapes = getSlideShapes(slide);
  const nodes = slots.map((slot) => {
    const shape = shapes.find((candidate) => String(getShapeId(candidate)) === slot.nativeId);
    const bounds = shape ? getShapeBoundsResolved(presentation, shape) : null;
    return shape && bounds ? { shape, bounds } : null;
  });
  if (nodes.some((node) => node === null)) return null;
  const resolvedNodes = nodes as Array<NonNullable<(typeof nodes)[number]>>;

  if (resolvedNodes.length === 1) {
    const { shape, bounds } = resolvedNodes[0]!;
    const bodyStyle = roleTextStyle(presentation, slide, 'body', [shape]);
    const layout = fitProcessNodeLayout({ x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h },
      compiled.visualization.processSteps.map((step) => step.text), bodyStyle.size ?? 0);
    if (!layout) return null;
    setShapeText(shape, '');
    compiled.visualization.processSteps.forEach((step, index) => addProcessNode(slide, step.text, layout.nodes[index]!, bodyStyle.color, bodyStyle));
    connectProcessNodes(slide, layout, bodyStyle.color);
    return { textShapes: compiled.visualization.processSteps.length, connectors: compiled.visualization.processSteps.length - 1 };
  }

  const minGap = Math.max(12_700, Math.round(Math.min(...resolvedNodes.map((node) => Math.min(node.bounds.w, node.bounds.h))) * 0.02));
  const aligned = (axis: 'x' | 'y') => {
    const crossAxis = axis === 'x' ? 'y' : 'x';
    const extent = axis === 'x' ? 'w' : 'h';
    const crossExtent = crossAxis === 'x' ? 'w' : 'h';
    const maxCrossExtent = Math.max(...resolvedNodes.map((node) => node.bounds[crossExtent]));
    for (let index = 0; index < resolvedNodes.length; index += 1) {
      const current = resolvedNodes[index]!.bounds;
      const currentCenter = current[crossAxis] + current[crossExtent] / 2;
      const firstCenter = resolvedNodes[0]!.bounds[crossAxis] + resolvedNodes[0]!.bounds[crossExtent] / 2;
      if (Math.abs(currentCenter - firstCenter) > maxCrossExtent * 0.2) return false;
      if (index === 0) continue;
      const previous = resolvedNodes[index - 1]!.bounds;
      if (current[axis] - (previous[axis] + previous[extent]) < minGap) return false;
    }
    return true;
  };
  const horizontal = aligned('x');
  const vertical = aligned('y');
  const axis = horizontal ? 'x' : vertical ? 'y' : null;
  if (!axis) return null;
  const processSteps = compiled.visualization.processSteps;
  if (resolvedNodes.length !== processSteps.length || selection.bodyContentSegments.length !== processSteps.length) return null;
  for (const [index, node] of resolvedNodes.entries()) {
    const label = selection.bodyContentSegments[index];
    const step = processSteps[index];
    if (!label || !step || normalizedVisibleText(label) !== normalizedVisibleText(step.text)) return null;
    const style = roleTextStyle(presentation, slide, 'body', [node.shape]);
    let margins: ReturnType<typeof getShapeTextMargins>;
    try { margins = getShapeTextMargins(node.shape); } catch { return null; }
    if (!style.size || !fitsProcessLabel({ x: node.bounds.x, y: node.bounds.y, width: node.bounds.w, height: node.bounds.h }, label, style.size, margins)) return null;
  }
  const bodyStyleSource = resolvedNodes[0]!.shape;
  const bodyStyle = roleTextStyle(presentation, slide, 'body', [bodyStyleSource]);
  const crossAxis = axis === 'x' ? 'y' : 'x';
  const extent = axis === 'x' ? 'w' : 'h';
  const crossExtent = crossAxis === 'x' ? 'w' : 'h';
  const connectorSegments: Parameters<typeof addSlideLine>[1][] = [];
  for (let index = 0; index < resolvedNodes.length - 1; index += 1) {
    const from = resolvedNodes[index]!.bounds;
    const to = resolvedNodes[index + 1]!.bounds;
    const center = Math.round((from[crossAxis] + from[crossExtent] / 2 + to[crossAxis] + to[crossExtent] / 2) / 2);
    const fromEdge = from[axis] + from[extent];
    const toEdge = to[axis];
    const gap = toEdge - fromEdge;
    const inset = Math.min(Math.round(gap * 0.15), Math.round(Math.min(from[crossExtent], to[crossExtent]) * 0.08));
    if (gap <= inset * 2 + 12_700) return null;
    connectorSegments.push(axis === 'x'
      ? { from: { x: emu(fromEdge + inset), y: emu(center) }, to: { x: emu(toEdge - inset), y: emu(center) },
        color: requiredTemplateColor(bodyStyle.color), widthEmu: PROCESS_CONNECTOR_WIDTH_EMU }
      : { from: { x: emu(center), y: emu(fromEdge + inset) }, to: { x: emu(center), y: emu(toEdge - inset) },
        color: requiredTemplateColor(bodyStyle.color), widthEmu: PROCESS_CONNECTOR_WIDTH_EMU });
  }
  for (const connector of connectorSegments) {
    const shape = addSlideLine(slide, connector);
    setShapeStrokeArrow(shape, 'tail', { type: 'triangle', width: 'sm', length: 'sm' });
  }
  return { textShapes: 0, connectors: resolvedNodes.length - 1 };
}

function sideBySideBodyComposition(
  presentation: Awaited<ReturnType<typeof loadPresentation>>,
  slide: ReturnType<typeof getSlides>[number],
  selection: ExemplarSlideSelection,
): boolean {
  const slots = selection.slots.bodySlots.length ? selection.slots.bodySlots : [selection.slots.body];
  if (slots.length < 2) return false;
  const shapes = getSlideShapes(slide);
  const nodes = slots.map((slot) => {
    const shape = shapes.find((candidate) => String(getShapeId(candidate)) === slot.nativeId);
    const bounds = shape ? getShapeBoundsResolved(presentation, shape) : null;
    return shape && bounds ? { shape, bounds } : null;
  });
  if (nodes.some((node) => node === null)) return false;
  const ordered = (nodes as Array<NonNullable<(typeof nodes)[number]>>).sort((left, right) => left.bounds.x - right.bounds.x);
  const tolerance = Math.min(...ordered.map((node) => node.bounds.h)) * 0.2;
  const baseline = ordered[0]!.bounds.y + ordered[0]!.bounds.h / 2;
  return ordered.every((node, index) => {
    const center = node.bounds.y + node.bounds.h / 2;
    if (Math.abs(center - baseline) > tolerance) return false;
    if (!index) return true;
    const previous = ordered[index - 1]!.bounds;
    return node.bounds.x - (previous.x + previous.w) >= 12_700;
  });
}

function realizedNativeVisualType(
  compiled: CompiledSlide,
  counts: { tables: number; charts: number; images: number; text: number; connectors: number },
): CompiledSlide['visualization']['type'] | null {
  const requested = compiled.visualization.type;
  if (requested === 'table' && compiled.visualization.tableData && counts.tables > 0) return 'table';
  if (requested === 'chart' && compiled.visualization.chartData && counts.charts > 0) return 'chart';
  if (requested === 'kpi' && compiled.visualization.kpi && counts.text >= 2) return 'kpi';
  if (requested === 'image' && compiled.imageRefs.length > 0 && counts.images > 0) return 'image';
  if (['process', 'timeline', 'diagram'].includes(requested)
      && compiled.visualization.processSteps.length >= 2
      && counts.connectors >= compiled.visualization.processSteps.length - 1) return requested;
  return null;
}

function matchingNativePlaceholder(
  presentation: Awaited<ReturnType<typeof loadPresentation>>,
  slide: ReturnType<typeof getSlides>[number],
  layout: Parameters<typeof getSlideLayoutPlaceholders>[0],
  placement: { x: number; y: number; width: number; height: number },
  role: 'title' | 'body',
) {
  const allowedTypes = role === 'title'
    ? new Set(['title', 'ctrTitle', 'subTitle'])
    : new Set(['body', 'obj', 'subTitle']);
  const matches = getSlideLayoutPlaceholders(layout).flatMap((placeholder) => {
    const roleIsMeasuredGenericBody = role === 'body' && placeholder.type === null && Number.isSafeInteger(placeholder.idx);
    if (!allowedTypes.has(placeholder.type ?? '') && !roleIsMeasuredGenericBody) return [];
    const shape = typeof placeholder.idx === 'number'
      ? findSlidePlaceholderByIdx(slide, placeholder.idx)
      : findSlidePlaceholder(slide, placeholder.type as 'title' | 'ctrTitle' | 'subTitle' | 'body' | 'obj');
    if (!shape || getShapePlaceholderIdx(shape) !== placeholder.idx || getShapePlaceholderType(shape) !== placeholder.type) return [];
    const bounds = placeholder.bounds ?? getShapeBoundsResolved(presentation, shape);
    if (!bounds || Math.abs(bounds.x - placement.x) > 1 || Math.abs(bounds.y - placement.y) > 1
        || Math.abs(bounds.w - placement.width) > 1 || Math.abs(bounds.h - placement.height) > 1) return [];
    return [{ shape }];
  });
  if (matches.length !== 1) return null;
  return matches[0]!.shape;
}

async function writeAtomically(filePath: string, bytes: Uint8Array): Promise<string> {
  const resolved = path.resolve(filePath);
  const temporary = `${resolved}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, { flag: 'wx' });
  try {
    await rename(temporary, resolved);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return resolved;
}

/** Replaceable renderer/document adapter. It uses Office Kit only at this boundary. */
export class OfficeKitPptxRenderer implements PptxRendererPort {
  readonly id = 'office-kit' as const;

  constructor(private readonly diagnostics?: PerformanceDiagnosticsPort) {}

  async render(input: PptxRenderInput): Promise<PptxRenderResult> {
    const totalStartedAt = performance.now();
    this.diagnostics?.increment('rendererCallCount');
    try {
      return await this.renderMeasured(input);
    } finally {
      recordElapsed(this.diagnostics, 'renderer.total', totalStartedAt);
    }
  }

  private async renderMeasured(input: PptxRenderInput): Promise<PptxRenderResult> {
    let stageStartedAt = performance.now();
    const sourceBytes = await readFile(input.templatePath);
    recordElapsed(this.diagnostics, 'renderer.readTemplate', stageStartedAt);
    this.diagnostics?.increment('templateLoadCount');
    if (sourceBytes.byteLength > MAX_TEMPLATE_BYTES) throw new TypeError('Template PPTX exceeds the 64 MiB render limit');
    stageStartedAt = performance.now();
    const templateHash = createHash('sha256').update(sourceBytes).digest('hex');
    recordElapsed(this.diagnostics, 'renderer.verifyTemplateHash', stageStartedAt);
    if (templateHash !== input.templateIR.source.sha256) throw new TypeError('Template PPTX bytes do not match the compiled TemplateIR source hash');
    if (input.compiledPresentation.templateIRHash !== input.templateIR.hash || input.compiledPresentation.contentIRHash !== input.contentIR.hash) {
      throw new TypeError('Compiled presentation source hashes do not match the render inputs');
    }
    const audit = auditCompiledPresentation(input.compiledPresentation, input.contentIR, input.templateIR);
    const blocking = audit.findings.filter((finding) => finding.severity === 'error');
    if (blocking.length) throw new TypeError(`Office Kit render blocked by ${blocking.length} deterministic error(s)`);
    if (!input.compiledPresentation.slides.length) throw new TypeError('Cannot render an empty presentation');

    stageStartedAt = performance.now();
    const presentation = await loadPresentation(sourceBytes);
    recordElapsed(this.diagnostics, 'renderer.loadPresentation', stageStartedAt);
    stageStartedAt = performance.now();
    const sourcePackage = await JSZip.loadAsync(sourceBytes);
    recordElapsed(this.diagnostics, 'renderer.loadZip', stageStartedAt);
    this.diagnostics?.increment('sourceZipLoadCount');
    stageStartedAt = performance.now();
    const sourceVisualArtifacts = await collectSourceSlideVisualArtifacts(sourcePackage);
    recordElapsed(this.diagnostics, 'renderer.collectSourceArtifacts', stageStartedAt);
    stageStartedAt = performance.now();
    const layoutsByPart = new Map(input.compiledPresentation.slides.map((compiled) => {
      const layoutPartName = compiled.layoutSourcePart.startsWith('/') ? compiled.layoutSourcePart : `/${compiled.layoutSourcePart}`;
      const layout = findSlideLayoutByPartName(presentation, layoutPartName);
      if (!layout) throw new TypeError(`Office Kit cannot resolve selected layout part ${compiled.layoutSourcePart}`);
      return [compiled.layoutSourcePart, layout] as const;
    }));
    const sourceSlides = [...getSlides(presentation)];
    const sourceSlidesByPart = new Map(sourceSlides.map((slide) => [normalizePart(getSlidePartName(slide)), slide]));
    type RendererExemplarAssessment = Pick<ExemplarSelectionAssessment, 'selection' | 'safeSelections' | 'availableDistinctFamilies' | 'evidence'>;
    const exemplarAssessments = new Map<string, RendererExemplarAssessment>(input.compiledPresentation.slides.map((compiled) => {
      const selected = compiled.exemplarSelection;
      const validation = compiled.exemplarSelectionValidation;
      const alreadyQualified = selected && validation?.templateIRHash === input.templateIR.hash
        && validation.signature === selected.projectedCompositionSignature;
      return [compiled.id, alreadyQualified
        ? { selection: selected, safeSelections: [selected], availableDistinctFamilies: selected.availableDistinctFamilies, evidence: selected.evidence }
        : assessExemplarSelection(compiled, input.templateIR, input.semanticProfile)] as const;
    }));
    const exemplarSelections = new Map(input.compiledPresentation.slides.flatMap((compiled) => {
      const assessment = exemplarAssessments.get(compiled.id);
      const selected = compiled.exemplarSelection;
      const selection = selected
        ? assessment?.safeSelections.find((candidate) => candidate.sourcePart === selected.sourcePart
          && candidate.sourceSlideIndex === selected.sourceSlideIndex
          && candidate.projectedCompositionSignature === selected.projectedCompositionSignature)
        : assessment?.selection;
      if (selected && !selection) {
        throw new PptxBackendError('EXEMPLAR_ASSIGNMENT_REVALIDATION_FAILED',
          'The jointly qualified donor no longer passes the current template projection checks.');
      }
      if (!selection || !sourceSlidesByPart.has(selection.sourcePart)) return [];
      return [[compiled.id, selection] as const];
    }));
    recordElapsed(this.diagnostics, 'renderer.prepareLayoutsAndSources', stageStartedAt);
    const outputSlidesById = new Map<string, ReturnType<typeof duplicateSlide>>();
    stageStartedAt = performance.now();
    for (const compiled of input.compiledPresentation.slides) {
      const selection = exemplarSelections.get(compiled.id);
      if (!selection) continue;
      const sourceSlide = sourceSlidesByPart.get(selection.sourcePart);
      if (!sourceSlide) throw new PptxBackendError('EXEMPLAR_SOURCE_SLIDE_MISSING', `The selected source slide ${selection.sourceSlideIndex} is unavailable in the loaded package.`);
      const duplicate = duplicateSlide(presentation, sourceSlide);
      removeSlideNotes(duplicate);
      outputSlidesById.set(compiled.id, duplicate);
    }
    recordElapsed(this.diagnostics, 'renderer.duplicateSlides', stageStartedAt);
    stageStartedAt = performance.now();
    for (const slide of sourceSlides) removeSlideNotes(slide);
    for (const slide of sourceSlides) removeSlide(presentation, slide);
    recordElapsed(this.diagnostics, 'renderer.removeSourceSlides', stageStartedAt);
    stageStartedAt = performance.now();
    compactPackage(presentation);
    recordElapsed(this.diagnostics, 'renderer.compactPackage', stageStartedAt);

    let nativeTableCount = 0;
    let nativeChartCount = 0;
    let nativeImageCount = 0;
    let nativeTextShapeCount = 0;
    let nativeShapeCount = 0;
    let nativeConnectorCount = 0;
    const unresolvedVisualTypes = new Set<string>();
    const visualIntentBySlide = new Map<string, NonNullable<PptxRenderResult['visualIntents']>[number]>();
    const recordVisualIntent = (compiled: CompiledSlide,
      realizedType: NonNullable<PptxRenderResult['visualIntents']>[number]['realizedType'],
      fallbackReason: string | null = null) => {
      visualIntentBySlide.set(compiled.id, {
        slideId: compiled.id,
        requestedType: compiled.visualization.type,
        realizedType,
        fallbackReason,
      });
    };
    const textStyleWarnings: string[] = [];
    for (const compiled of input.compiledPresentation.slides) {
      const selection = exemplarSelections.get(compiled.id);
      let slide = outputSlidesById.get(compiled.id);
      if (selection && slide) {
        projectExemplarText(slide, compiled, selection, textStyleWarnings);
        if (compiled.visualization.type === 'kpi' && !compiled.visualization.kpi) {
          // A qualitative KPI request has no source-backed value to render. If
          // the selected donor has a source-free visual shape, remove it and
          // use only a measured side-by-side body composition as a downgrade.
          let visualSlotWasSafelyRemoved = !selection.slots.visual;
          if (selection.slots.visual) {
            const visualShape = getSlideShapes(slide).find((shape) => String(getShapeId(shape)) === selection.slots.visual!.nativeId);
            if (!visualShape) throw new PptxBackendError('EXEMPLAR_VISUAL_SLOT_MISSING', 'The selected source-free visual slot could not be mapped to its Office Kit shape.');
            if (getShapeKind(visualShape) === 'shape') {
              removeShape(visualShape);
              visualSlotWasSafelyRemoved = true;
            }
          }
          if (visualSlotWasSafelyRemoved && sideBySideBodyComposition(presentation, slide, selection)) {
            recordVisualIntent(compiled, 'comparison', 'No source-backed numeric value was available; the safe visual slot was removed and qualitative copy uses measured side-by-side body regions.');
          } else {
            unresolvedVisualTypes.add('kpi');
            recordVisualIntent(compiled, 'unresolved', 'No source-backed numeric value or measured side-by-side body composition was available.');
          }
        } else if (selection.slots.visual) {
          const visualShape = getSlideShapes(slide).find((shape) => String(getShapeId(shape)) === selection.slots.visual!.nativeId);
          if (!visualShape) throw new PptxBackendError('EXEMPLAR_VISUAL_SLOT_MISSING', 'The selected source-free visual slot could not be mapped to its Office Kit shape.');
          removeShape(visualShape);
          const titleStyleSource = requiredDonorShape(slide, selection.slots.title.nativeId, 'title style');
          const bodySlot = selection.slots.bodySlots[0] ?? selection.slots.body;
          const bodyStyleSource = getSlideShapes(slide).find((shape) => String(getShapeId(shape)) === bodySlot.nativeId);
          const visualCounts = await addProjectedVisual(presentation, slide, compiled, selection.slots.visual.geometry,
            { title: titleStyleSource, body: bodyStyleSource }, input);
          const realizedType = realizedNativeVisualType(compiled, visualCounts);
          if (realizedType) recordVisualIntent(compiled, realizedType);
          else {
            unresolvedVisualTypes.add(compiled.visualization.type);
            recordVisualIntent(compiled, 'unresolved', 'No native visual object was emitted for the requested visual type.');
          }
        } else if (compiled.visualization.processSteps.length >= 2) {
          const sequence = addBodyHostedSequence(presentation, slide, compiled, selection);
          if (sequence && sequence.connectors >= compiled.visualization.processSteps.length - 1) {
            recordVisualIntent(compiled, compiled.visualization.type,
              'Sequence labels reuse measured native body geometry because no separate safe visual slot was selected.');
          } else {
            unresolvedVisualTypes.add(compiled.visualization.type);
            recordVisualIntent(compiled, 'unresolved', 'Measured body regions could not host a non-overlapping ordered sequence.');
          }
        } else if (compiled.visualization.type === 'comparison'
            && sideBySideBodyComposition(presentation, slide, selection)) {
          recordVisualIntent(compiled, 'comparison');
        } else if (compiled.visualization.status === 'unresolved') {
          unresolvedVisualTypes.add(compiled.visualization.type);
          recordVisualIntent(compiled, 'unresolved', compiled.visualization.type === 'kpi'
            ? 'No source-backed numeric value or safe side-by-side fallback was available.'
            : `No safe native slot could realize the requested ${compiled.visualization.type} visual.`);
        } else if (compiled.visualization.type !== 'none') {
          unresolvedVisualTypes.add(compiled.visualization.type);
          recordVisualIntent(compiled, 'unresolved', `The selected composition retained text but did not materialize ${compiled.visualization.type}.`);
        } else {
          recordVisualIntent(compiled, 'none');
        }
        const counts = countExemplarObjects(slide);
        nativeTextShapeCount += counts.textShapes;
        nativeConnectorCount += counts.connectors;
        nativeImageCount += counts.pictures;
        nativeShapeCount += counts.editableShapes;
        nativeChartCount += counts.charts;
        nativeTableCount += counts.tables;
        continue;
      }
      const layout = layoutsByPart.get(compiled.layoutSourcePart);
      if (!layout) throw new TypeError(`Office Kit cannot resolve selected layout part ${compiled.layoutSourcePart}`);
      slide = addSlide(presentation, { layout });
      outputSlidesById.set(compiled.id, slide);
      const titlePlaceholder = matchingNativePlaceholder(presentation, slide, layout, compiled.placements.title, 'title');
      if (titlePlaceholder) {
        setShapeText(titlePlaceholder, compiled.title);
      }
      else throw new PptxBackendError('NATIVE_TITLE_PLACEHOLDER_REQUIRED', 'Safe layout-backed output requires the measured native title placeholder; generic text boxes are not emitted.');
      const bodyRolePlaceholder = matchingNativePlaceholder(presentation, slide, layout, compiled.placements.body, 'body');
      nativeTextShapeCount += 1;
      if (compiled.body.length) {
        const chartHasSlot = Boolean(compiled.placements.visual || compiled.body.length === 0);
        const imageHasSlot = Boolean(compiled.placements.visual || compiled.body.length === 0);
        const kpiHasSlot = Boolean(compiled.placements.visual || compiled.body.length === 0);
        const processHasSlot = Boolean(safeProcessVisualBox(compiled, bodyRolePlaceholder
          ? roleTextStyle(presentation, slide, 'body', [bodyRolePlaceholder]).size ?? 0 : 0));
        const specialVisualUsesBody = Boolean((compiled.visualization.chartData && chartHasSlot) || (compiled.visualization.kpi && kpiHasSlot)
          || (compiled.visualization.processSteps.length >= 2 && processHasSlot)
          || (compiled.imageRefs.length && imageHasSlot) || compiled.visualization.tableData);
        if (!specialVisualUsesBody) {
          if (bodyRolePlaceholder) {
            setShapeText(bodyRolePlaceholder, compiled.body.join('\n'));
          }
          else throw new PptxBackendError('NATIVE_BODY_PLACEHOLDER_REQUIRED', 'Safe layout-backed output requires the measured native body placeholder; generic text boxes are not emitted.');
        }
        if (!specialVisualUsesBody) nativeTextShapeCount += 1;
      }
      if (compiled.visualization.tableData) {
        const visualBox = compiled.placements.visual ?? compiled.placements.body;
        addSlideTable(slide, {
          x: emu(visualBox.x), y: emu(visualBox.y), w: emu(visualBox.width), h: emu(visualBox.height),
          rows: compiled.visualization.tableData,
        });
        nativeTableCount += 1;
        recordVisualIntent(compiled, 'table');
      }
      if (compiled.visualization.chartData) {
        const visualBox = compiled.placements.visual ?? (compiled.body.length ? null : compiled.placements.body);
        if (!visualBox) unresolvedVisualTypes.add('chart');
        else {
          addSlideChart(slide, {
            x: emu(visualBox.x), y: emu(visualBox.y), w: emu(visualBox.width), h: emu(visualBox.height),
            spec: {
              kind: compiled.visualization.chartData.kind,
              categories: compiled.visualization.chartData.categories,
              series: compiled.visualization.chartData.series.map(({ name, values }) => ({ name, values })),
              title: compiled.visualization.chartData.title,
            },
          });
          nativeChartCount += 1;
          recordVisualIntent(compiled, 'chart');
        }
      }
      if (compiled.visualization.kpi) {
        const visualBox = compiled.placements.visual ?? (compiled.body.length ? null : compiled.placements.body);
        if (!visualBox) unresolvedVisualTypes.add('kpi');
        else {
          const valueHeight = Math.max(1, Math.floor(visualBox.height * 0.62));
          const value = addSlideTextBox(slide, {
            x: emu(visualBox.x), y: emu(visualBox.y), w: emu(visualBox.width), h: emu(valueHeight),
            text: compiled.visualization.kpi.value,
          });
          applyRoleTextStyle(presentation, slide, value, 'title', [titlePlaceholder]);
          const label = addSlideTextBox(slide, {
            x: emu(visualBox.x), y: emu(visualBox.y + valueHeight), w: emu(visualBox.width), h: emu(visualBox.height - valueHeight),
            text: compiled.visualization.kpi.label,
          });
          applyRoleTextStyle(presentation, slide, label, 'body', bodyRolePlaceholder ? [bodyRolePlaceholder] : []);
          nativeTextShapeCount += 2;
          nativeShapeCount += 2;
          recordVisualIntent(compiled, 'kpi');
          void value;
        }
      }
      if (compiled.visualization.processSteps.length >= 2) {
        const bodyStyle = bodyRolePlaceholder ? roleTextStyle(presentation, slide, 'body', [bodyRolePlaceholder]) : null;
        const visualBox = bodyStyle?.size ? safeProcessVisualBox(compiled, bodyStyle.size) : null;
        if (!visualBox) {
          unresolvedVisualTypes.add('process');
          recordVisualIntent(compiled, 'unresolved', 'No measured visual/body region could contain the process sequence.');
        }
        else {
          const bodyStyle = roleTextStyle(presentation, slide, 'body', bodyRolePlaceholder ? [bodyRolePlaceholder] : []);
          const nodeLayout = fitProcessNodeLayout(visualBox, compiled.visualization.processSteps.map((step) => step.text), bodyStyle.size ?? 0);
          if (!nodeLayout) {
            unresolvedVisualTypes.add('process');
            recordVisualIntent(compiled, 'unresolved', 'No measured body region could fit the process labels at the template body font size.');
          } else {
            compiled.visualization.processSteps.forEach((step, index) => addProcessNode(slide, step.text, nodeLayout.nodes[index]!, bodyStyle.color, bodyStyle));
            connectProcessNodes(slide, nodeLayout, bodyStyle.color);
            nativeTextShapeCount += nodeLayout.nodes.length;
            nativeShapeCount += nodeLayout.nodes.length;
            nativeConnectorCount += nodeLayout.nodes.length - 1;
            recordVisualIntent(compiled, compiled.visualization.type);
          }
        }
      }
      if (compiled.imageRefs.length) {
        if (compiled.imageRefs.length > 1) throw new PptxBackendError('MULTIPLE_IMAGES_UNSUPPORTED', 'A slide currently supports one source-backed image in its selected visual slot.', compiled.imageRefs[1]!.sourcePath);
        const visualBox = compiled.placements.visual ?? (compiled.body.length ? null : compiled.placements.body);
        if (!visualBox) {
          unresolvedVisualTypes.add('image');
          recordVisualIntent(compiled, 'unresolved', 'No measured image-capable region was available.');
        }
        else {
          const image = compiled.imageRefs[0]!;
          const imageBytes = await readVerifiedImage(input, image);
          addSlideImage(slide, imageBytes, {
            x: emu(visualBox.x), y: emu(visualBox.y), w: emu(visualBox.width), h: emu(visualBox.height), fit: 'contain',
          });
          nativeImageCount += 1;
          recordVisualIntent(compiled, 'image');
        }
      }
      if (compiled.visualization.type === 'comparison' && !visualIntentBySlide.has(compiled.id)) {
        unresolvedVisualTypes.add('comparison');
        recordVisualIntent(compiled, 'unresolved', 'The selected native layout did not provide measured side-by-side body regions.');
      } else if (compiled.visualization.type === 'kpi' && !compiled.visualization.kpi && !visualIntentBySlide.has(compiled.id)) {
        unresolvedVisualTypes.add('kpi');
        recordVisualIntent(compiled, 'unresolved', 'No source-backed numeric value or safe side-by-side fallback was available.');
      } else if (compiled.visualization.type !== 'none' && compiled.visualization.status === 'unresolved'
          && !visualIntentBySlide.has(compiled.id)) {
        unresolvedVisualTypes.add(compiled.visualization.type);
        recordVisualIntent(compiled, 'unresolved', `No native visual data was available for ${compiled.visualization.type}.`);
      } else if (compiled.visualization.type !== 'none' && !visualIntentBySlide.has(compiled.id)) {
        unresolvedVisualTypes.add(compiled.visualization.type);
        recordVisualIntent(compiled, 'unresolved', `The native layout retained text but did not materialize ${compiled.visualization.type}.`);
      } else if (compiled.visualization.type === 'none' && !visualIntentBySlide.has(compiled.id)) {
        recordVisualIntent(compiled, 'none');
      }
    }
    for (const compiled of input.compiledPresentation.slides) {
      if (visualIntentBySlide.has(compiled.id)) continue;
      if (compiled.visualization.type === 'none') recordVisualIntent(compiled, 'none');
      else {
        unresolvedVisualTypes.add(compiled.visualization.type);
        recordVisualIntent(compiled, 'unresolved', 'The renderer did not record a realized visual intent for this slide.');
      }
    }

    // Office Kit duplicates adjacent to their donor. Sort every generated
    // slide, including layout-only fallbacks, back to the immutable DeckPlan
    // order before serializing the package.
    const plannedIndexByPart = new Map<string, number>();
    for (const [index, compiled] of input.compiledPresentation.slides.entries()) {
      const slide = outputSlidesById.get(compiled.id);
      if (!slide) throw new PptxBackendError('SLIDE_PROJECTION_FAILED', 'A generated slide could not be mapped back to its DeckPlan position.');
      plannedIndexByPart.set(normalizePart(getSlidePartName(slide)), index);
    }
    sortSlides(presentation, (left, right) =>
      (plannedIndexByPart.get(normalizePart(getSlidePartName(left))) ?? Number.MAX_SAFE_INTEGER)
      - (plannedIndexByPart.get(normalizePart(getSlidePartName(right))) ?? Number.MAX_SAFE_INTEGER));

    stageStartedAt = performance.now();
    const savedBytes = await savePresentation(presentation);
    recordElapsed(this.diagnostics, 'renderer.savePresentation', stageStartedAt);
    this.diagnostics?.increment('presentationSaveCount');
    stageStartedAt = performance.now();
    const outputPackage = await JSZip.loadAsync(savedBytes);
    await removeUnreachableSourceVisualArtifacts(outputPackage, sourceVisualArtifacts);
    const outputBytes = await outputPackage.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    recordElapsed(this.diagnostics, 'renderer.compactOutputZip', stageStartedAt);
    stageStartedAt = performance.now();
    const reopened = await loadPresentation(outputBytes);
    recordElapsed(this.diagnostics, 'renderer.reopenPresentation', stageStartedAt);
    this.diagnostics?.increment('presentationReopenCount');
    stageStartedAt = performance.now();
    if (getSlides(reopened).length !== input.compiledPresentation.slides.length) {
      throw new PptxBackendError('SLIDE_PROJECTION_FAILED', 'The active output slide list does not match the generated presentation slide count.');
    }
    const validationIssues = normalizeIssues(validatePresentation(reopened));
    recordElapsed(this.diagnostics, 'renderer.validatePresentation', stageStartedAt);
    stageStartedAt = performance.now();
    const templatePreservationStatus = await comparePreservedTemplateParts(sourceBytes, outputBytes, sourceVisualArtifacts) ? 'passed' as const : 'failed' as const;
    recordElapsed(this.diagnostics, 'renderer.templatePreservationValidation', stageStartedAt);
    this.diagnostics?.increment('rendererReopenValidationCount');
    if (templatePreservationStatus === 'failed') {
      validationIssues.push({ severity: 'error', message: 'One or more retained template package parts changed or were removed.', partName: null });
    }
    for (const visualType of unresolvedVisualTypes) {
      validationIssues.push({ severity: 'warning', message: `No compatible template slot was available to render the requested ${visualType} visual; source-backed text is retained.`, partName: null });
    }
    for (const message of textStyleWarnings) validationIssues.push({ severity: 'warning', message, partName: null });
    const sourceResidueFindings: Array<NonNullable<PptxRenderResult['qualityEvidence']>['sourceContentResidue']['findings'][number]> = [];
    const renderedTextObjects: Array<NonNullable<PptxRenderResult['qualityEvidence']>['textObjects'][number]> = [];
    const qualityEvidence: NonNullable<PptxRenderResult['qualityEvidence']> = {
      textObjects: renderedTextObjects,
      sourceContentResidue: { status: exemplarSelections.size ? 'checked' : 'not-applicable', findings: sourceResidueFindings },
    };
    const reopenedSlides = getSlides(reopened);
    for (const [slideIndex, compiled] of input.compiledPresentation.slides.entries()) {
      const outputSlide = reopenedSlides[slideIndex];
      if (!outputSlide) continue;
      const selection = exemplarSelections.get(compiled.id) ?? null;
      const titleNativeIds = new Set(selection ? [selection.slots.title.nativeId] : []);
      const bodyNativeIds = new Set(selection
        ? (selection.slots.bodySlots.length ? selection.slots.bodySlots : [selection.slots.body]).map((slot) => slot.nativeId)
        : []);
      const outputShapes = getSlideShapes(outputSlide);
      const expectedTitle = compiled.title.replace(/\s+/g, ' ').trim();
      const hasExpectedTitle = outputShapes.some((shape) => hasShapeText(shape)
        && getShapeText(shape).replace(/\s+/g, ' ').trim() === expectedTitle);
      if (!hasExpectedTitle) {
        throw new PptxBackendError('SLIDE_ORDER_MISMATCH', 'The reopened PPTX slide order does not match the generated DeckPlan.');
      }
      for (const shape of outputShapes) {
        if (!hasShapeText(shape)) continue;
        const text = getShapeText(shape).trim();
        if (!text) continue;
        const shapeId = String(getShapeId(shape));
        const placeholderType = getShapePlaceholderType(shape)?.toLowerCase() ?? '';
        const role = titleNativeIds.has(shapeId) || ['title', 'ctrtitle', 'subtitle'].includes(placeholderType)
          ? 'title' as const
          : bodyNativeIds.has(shapeId) || ['body', 'obj'].includes(placeholderType) ? 'body' as const : 'other' as const;
        let format: ReturnType<typeof getShapeRunFormatEffective> | null = null;
        try { format = getShapeRunFormatEffective(reopened, shape, 0, 0); } catch { /* style remains unknown */ }
        let rawAutoFit: ReturnType<typeof getShapeTextAutoFitParams> | null = null;
        try { rawAutoFit = getShapeTextAutoFitParams(shape); } catch { /* autofit remains unknown */ }
        const scaleValue = rawAutoFit && typeof rawAutoFit === 'object' && 'fontScale' in rawAutoFit
          ? Number(rawAutoFit.fontScale) : null;
        const autoFitScale = scaleValue !== null && Number.isFinite(scaleValue)
          ? Number((scaleValue > 10 ? scaleValue / 100000 : scaleValue).toFixed(4)) : null;
        const bounds = getShapeBoundsResolved(reopened, shape);
        renderedTextObjects.push({
          slideId: compiled.id,
          shapeId,
          role,
          textSha256: createHash('sha256').update(normalizedVisibleText(text)).digest('hex'),
          textLength: Array.from(text).length,
          fontSizePt: format?.size !== undefined && Number.isFinite(format.size) && format.size > 0 ? format.size : null,
          color: format?.color ?? null,
          autoFitScale,
          bounds: bounds ? { x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h } : null,
        });
      }

      if (!selection) continue;
      const sourceSlide = input.templateIR.slides.find((candidate) => candidate.sourcePart === selection.sourcePart);
      if (!sourceSlide) continue;
      const replacedNativeIds = new Set([selection.slots.title.nativeId,
        ...(selection.slots.bodySlots.length ? selection.slots.bodySlots : [selection.slots.body]).map((slot) => slot.nativeId)]);
      const chromeNativeIds = new Set(selection.preserveChromeNativeIds);
      const projectedText = new Set([
        compiled.title, ...compiled.body,
        ...(compiled.visualization.tableData ?? []).flat(),
        ...(compiled.visualization.chartData?.categories ?? []),
        ...(compiled.visualization.chartData?.series.flatMap((series) => [series.name, ...series.values.map(String)]) ?? []),
        ...(compiled.visualization.processSteps.map((step) => step.text)),
        ...(compiled.visualization.kpi ? [compiled.visualization.kpi.value, compiled.visualization.kpi.label] : []),
      ].map(normalizedVisibleText));
      const visibleOutputText = outputShapes.filter(hasShapeText).map((shape) => ({
        id: String(getShapeId(shape)), text: normalizedVisibleText(getShapeText(shape)),
      }));
      for (const element of sourceSlide.elements) {
        const oldText = element.text?.trim() ?? '';
        if (!element.nativeId || !oldText || replacedNativeIds.has(element.nativeId) || chromeNativeIds.has(element.nativeId)) continue;
        const normalized = normalizedVisibleText(oldText);
        if (normalized.length < 4 && !/\d/u.test(normalized) || projectedText.has(normalized)) continue;
        const remaining = visibleOutputText.find((candidate) => candidate.text === normalized);
        if (remaining) sourceResidueFindings.push({
          slideId: compiled.id,
          sourceSlideIndex: selection.sourceSlideIndex,
          sourceElementId: element.id,
          textSha256: createHash('sha256').update(normalized).digest('hex'),
          outputShapeId: remaining.id,
        });
      }
    }
    const outputPath = await writeAtomically(input.outputPath, outputBytes);
    return {
      backend: this.id,
      outputPath,
      presentationId: input.compiledPresentation.id,
      slideCount: getSlides(reopened).length,
      nativeTextShapeCount,
      nativeTableCount,
      nativeChartCount,
      nativeImageCount,
      nativeShapeCount,
      nativeConnectorCount,
      nativeNotesCount: 0,
      rasterSlideCount: 0,
      auditFindingCount: audit.findings.length + unresolvedVisualTypes.size + textStyleWarnings.length,
      artifactSha256: createHash('sha256').update(outputBytes).digest('hex'),
      reopenStatus: 'passed',
      validationStatus: validationIssues.some((issue) => issue.severity === 'error') ? 'failed' : 'passed',
      templatePreservationStatus,
      validationIssues,
      unresolvedVisualTypes: [...unresolvedVisualTypes],
      visualIntents: input.compiledPresentation.slides.map((compiled) => visualIntentBySlide.get(compiled.id)!),
      projectedCompositions: input.compiledPresentation.slides.map((compiled) => {
        const assessment: RendererExemplarAssessment = exemplarAssessments.get(compiled.id)!;
        const selection = exemplarSelections.get(compiled.id) ?? null;
        return selection ? {
          slideId: compiled.id,
          variantId: compiled.variantId,
          sourceSlideIndex: selection.sourceSlideIndex,
          semanticArchetype: selection.semanticArchetype,
          confidence: selection.confidence,
          projectedCompositionSignature: selection.projectedCompositionSignature,
          availableDistinctFamilies: assessment.availableDistinctFamilies,
          titleGeometryNormalized: selection.titleGeometryNormalized,
          bodyGeometryNormalized: selection.bodyGeometryNormalized,
          titleBodyFontHierarchy: selection.titleBodyFontHierarchy,
          selectionReason: selection.selectionReason,
        } : {
          slideId: compiled.id,
          variantId: compiled.variantId,
          sourceSlideIndex: null,
          semanticArchetype: null,
          confidence: null,
          projectedCompositionSignature: generatedFallbackCompositionSignature(compiled, input.templateIR),
          availableDistinctFamilies: assessment.availableDistinctFamilies,
          titleGeometryNormalized: null,
          bodyGeometryNormalized: null,
          titleBodyFontHierarchy: null,
          selectionReason: `generated fallback used because no safe exemplar rank was selected: ${assessment.evidence.join('; ')}`,
        };
      }),
      qualityEvidence,
    };
  }
}
