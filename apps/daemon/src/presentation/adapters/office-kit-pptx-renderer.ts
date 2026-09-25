import { createHash } from 'node:crypto';
import { readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path, { sep } from 'node:path';

import {
  addSlide,
  addSlideChart,
  addSlideImage,
  addSlideLine,
  addSlideTable,
  addSlideTextBox,
  compactPackage,
  duplicateSlide,
  emu,
  findSlidePlaceholder,
  findSlideLayoutByPartName,
  findSlidePlaceholderByIdx,
  getShapeId,
  getShapeKind,
  getShapePlaceholderIdx,
  getShapePlaceholderType,
  getShapeParagraphCount,
  getShapeRunCount,
  getShapeText,
  getSlideCharts,
  getSlidePartName,
  getSlideLayoutPlaceholders,
  getSlideShapes,
  getSlideTables,
  getSlides,
  hasShapeText,
  loadPresentation,
  removeSlide,
  removeSlideNotes,
  savePresentation,
  setShapeText,
  setShapeTextAutoFit,
  validatePresentation,
} from '@office-kit/pptx/node';
import JSZip from 'jszip';

import { auditCompiledPresentation } from '../application/deterministic-audit.js';
import {
  assessExemplarSelection,
  generatedFallbackCompositionSignature,
  type ExemplarSelectionAssessment,
  type ExemplarSlideSelection,
} from '../application/exemplar-slide-selector.js';
import { collectSourceSlideVisualArtifacts, relationshipPartFor, removeUnreachableSourceVisualArtifacts } from '../application/pptx-source-artifacts.js';
import type { CompiledSlide } from '../application/slide-compilation.js';
import type { PptxRenderInput, PptxRenderResult, PptxRendererPort } from '../application/pptx-backend-port.js';

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

async function readVerifiedImage(input: PptxRenderInput, image: PptxRenderInput['compiledPresentation']['slides'][number]['imageRefs'][number]): Promise<Uint8Array> {
  if (!input.contentRoot || !path.isAbsolute(input.contentRoot)) {
    throw new PptxBackendError('MEDIA_ROOT_REQUIRED', 'Image rendering requires an absolute project content root.', image.sourcePath);
  }
  const root = await realpath(input.contentRoot);
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

function normalizeIssues(issues: ReturnType<typeof validatePresentation>) {
  return issues.map((issue) => ({ severity: issue.severity, message: issue.message, partName: issue.partName ?? null }));
}

function normalizePart(partName: string): string {
  return partName.replace(/^\/+/, '');
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
  for (const [role, shape] of [['title', title] as const, ...bodyShapes.map((shape, index) => [`body ${index + 1}`, shape] as const)]) {
    const segmentation = textSegmentation(shape);
    textStyleWarnings.push(`Exemplar slide ${selection.sourceSlideIndex} ${role} donor was replaced with Office Kit setShapeText; paragraph-end formatting may not be retained.`);
    if (segmentation.paragraphs > 1 || segmentation.runs > 1) {
      textStyleWarnings.push(`Exemplar slide ${selection.sourceSlideIndex} ${role} donor has ${segmentation.paragraphs} paragraph(s) and ${segmentation.runs} run(s); Office Kit setShapeText was used, so secondary mixed-run styling may be collapsed.`);
    }
  }
  const replacementIds = new Set([selection.slots.title.nativeId, ...bodySlots.map((slot) => slot.nativeId)]);
  for (const nativeId of selection.clearElementNativeIds) {
    if (replacementIds.has(nativeId)) continue;
    const shape = byNativeId.get(nativeId);
    if (!shape || !hasShapeText(shape)) throw new PptxBackendError('EXEMPLAR_CLEANUP_MAPPING_FAILED', `A source-specific text shape on exemplar slide ${selection.sourceSlideIndex} could not be cleared safely.`);
    setShapeText(shape, '');
  }
  setShapeText(title, compiled.title);
  for (let index = 0; index < bodyShapes.length; index += 1) {
    const start = Math.floor(index * compiled.body.length / bodyShapes.length);
    const end = Math.floor((index + 1) * compiled.body.length / bodyShapes.length);
    setShapeText(bodyShapes[index]!, compiled.body.slice(start, end).join('\n'));
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

function matchingNativePlaceholder(
  slide: ReturnType<typeof getSlides>[number],
  layout: Parameters<typeof getSlideLayoutPlaceholders>[0],
  placement: { x: number; y: number; width: number; height: number },
  role: 'title' | 'body',
) {
  const allowedTypes = role === 'title'
    ? new Set(['title', 'ctrTitle', 'subTitle'])
    : new Set(['body', 'obj', 'subTitle']);
  const matches = getSlideLayoutPlaceholders(layout).filter((placeholder) => {
    if (!placeholder.bounds || !allowedTypes.has(placeholder.type ?? '')) return false;
    return Math.abs(placeholder.bounds.x - placement.x) <= 1
      && Math.abs(placeholder.bounds.y - placement.y) <= 1
      && Math.abs(placeholder.bounds.w - placement.width) <= 1
      && Math.abs(placeholder.bounds.h - placement.height) <= 1;
  });
  if (matches.length !== 1) return null;
  const descriptor = matches[0]!;
  const shape = typeof descriptor.idx === 'number'
    ? findSlidePlaceholderByIdx(slide, descriptor.idx)
    : findSlidePlaceholder(slide, descriptor.type as 'title' | 'ctrTitle' | 'subTitle' | 'body' | 'obj');
  if (!shape || getShapePlaceholderIdx(shape) !== descriptor.idx || getShapePlaceholderType(shape) !== descriptor.type) return null;
  return shape;
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

  async render(input: PptxRenderInput): Promise<PptxRenderResult> {
    const sourceBytes = await readFile(input.templatePath);
    if (sourceBytes.byteLength > MAX_TEMPLATE_BYTES) throw new TypeError('Template PPTX exceeds the 64 MiB render limit');
    const templateHash = createHash('sha256').update(sourceBytes).digest('hex');
    if (templateHash !== input.templateIR.source.sha256) throw new TypeError('Template PPTX bytes do not match the compiled TemplateIR source hash');
    if (input.compiledPresentation.templateIRHash !== input.templateIR.hash || input.compiledPresentation.contentIRHash !== input.contentIR.hash) {
      throw new TypeError('Compiled presentation source hashes do not match the render inputs');
    }
    const audit = auditCompiledPresentation(input.compiledPresentation, input.contentIR, input.templateIR);
    const blocking = audit.findings.filter((finding) => finding.severity === 'error');
    if (blocking.length) throw new TypeError(`Office Kit render blocked by ${blocking.length} deterministic error(s)`);
    if (!input.compiledPresentation.slides.length) throw new TypeError('Cannot render an empty presentation');

    const presentation = await loadPresentation(sourceBytes);
    const sourcePackage = await JSZip.loadAsync(sourceBytes);
    const sourceVisualArtifacts = await collectSourceSlideVisualArtifacts(sourcePackage);
    const layoutsByPart = new Map(input.compiledPresentation.slides.map((compiled) => {
      const layoutPartName = compiled.layoutSourcePart.startsWith('/') ? compiled.layoutSourcePart : `/${compiled.layoutSourcePart}`;
      const layout = findSlideLayoutByPartName(presentation, layoutPartName);
      if (!layout) throw new TypeError(`Office Kit cannot resolve selected layout part ${compiled.layoutSourcePart}`);
      return [compiled.layoutSourcePart, layout] as const;
    }));
    const sourceSlides = [...getSlides(presentation)];
    const sourceSlidesByPart = new Map(sourceSlides.map((slide) => [normalizePart(getSlidePartName(slide)), slide]));
    const exemplarAssessments = new Map(input.compiledPresentation.slides.map((compiled) => [
      compiled.id, assessExemplarSelection(compiled, input.templateIR, input.semanticProfile),
    ] as const));
    const exemplarSelections = new Map(input.compiledPresentation.slides.flatMap((compiled) => {
      const selection = exemplarAssessments.get(compiled.id)?.selection;
      if (!selection || !sourceSlidesByPart.has(selection.sourcePart)) return [];
      return [[compiled.id, selection] as const];
    }));
    const duplicatedSlides = new Map<string, ReturnType<typeof duplicateSlide>>();
    for (const compiled of input.compiledPresentation.slides) {
      const selection = exemplarSelections.get(compiled.id);
      if (!selection) continue;
      const sourceSlide = sourceSlidesByPart.get(selection.sourcePart);
      if (!sourceSlide) throw new PptxBackendError('EXEMPLAR_SOURCE_SLIDE_MISSING', `The selected source slide ${selection.sourceSlideIndex} is unavailable in the loaded package.`);
      const duplicate = duplicateSlide(presentation, sourceSlide);
      removeSlideNotes(duplicate);
      duplicatedSlides.set(compiled.id, duplicate);
    }
    for (const slide of sourceSlides) removeSlideNotes(slide);
    for (const slide of sourceSlides) removeSlide(presentation, slide);
    compactPackage(presentation);

    let nativeTableCount = 0;
    let nativeChartCount = 0;
    let nativeImageCount = 0;
    let nativeTextShapeCount = 0;
    let nativeShapeCount = 0;
    let nativeConnectorCount = 0;
    const unresolvedVisualTypes = new Set<string>();
    const textStyleWarnings: string[] = [];
    for (const compiled of input.compiledPresentation.slides) {
      const selection = exemplarSelections.get(compiled.id);
      let slide = duplicatedSlides.get(compiled.id);
      if (selection && slide) {
        projectExemplarText(slide, compiled, selection, textStyleWarnings);
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
      const titlePlaceholder = matchingNativePlaceholder(slide, layout, compiled.placements.title, 'title');
      if (titlePlaceholder) {
        setShapeText(titlePlaceholder, compiled.title);
        setShapeTextAutoFit(titlePlaceholder, 'normal');
      }
      else addSlideTextBox(slide, {
          x: emu(compiled.placements.title.x),
          y: emu(compiled.placements.title.y),
          w: emu(compiled.placements.title.width),
          h: emu(compiled.placements.title.height),
          text: compiled.title,
        });
      nativeTextShapeCount += 1;
      if (compiled.body.length) {
        const chartHasSlot = Boolean(compiled.placements.visual || compiled.body.length === 0);
        const imageHasSlot = Boolean(compiled.placements.visual || compiled.body.length === 0);
        const kpiHasSlot = Boolean(compiled.placements.visual || compiled.body.length === 0);
        const processHasSlot = Boolean(compiled.placements.visual || compiled.body.length <= compiled.visualization.processSteps.length);
        const specialVisualUsesBody = Boolean((compiled.visualization.chartData && chartHasSlot) || (compiled.visualization.kpi && kpiHasSlot)
          || (compiled.visualization.processSteps.length >= 2 && processHasSlot)
          || (compiled.imageRefs.length && imageHasSlot) || compiled.visualization.tableData);
        if (!specialVisualUsesBody) {
          const bodyPlaceholder = matchingNativePlaceholder(slide, layout, compiled.placements.body, 'body');
          if (bodyPlaceholder) {
            setShapeText(bodyPlaceholder, compiled.body.join('\n'));
            setShapeTextAutoFit(bodyPlaceholder, 'normal');
          }
          else addSlideTextBox(slide, {
            x: emu(compiled.placements.body.x),
            y: emu(compiled.placements.body.y),
            w: emu(compiled.placements.body.width),
            h: emu(compiled.placements.body.height),
            text: compiled.body.join('\n'),
          });
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
          addSlideTextBox(slide, {
            x: emu(visualBox.x), y: emu(visualBox.y + valueHeight), w: emu(visualBox.width), h: emu(visualBox.height - valueHeight),
            text: compiled.visualization.kpi.label,
          });
          nativeTextShapeCount += 2;
          nativeShapeCount += 2;
          void value;
        }
      }
      if (compiled.visualization.processSteps.length >= 2) {
        const visualBox = compiled.placements.visual ?? (compiled.body.length <= compiled.visualization.processSteps.length ? compiled.placements.body : null);
        if (!visualBox) unresolvedVisualTypes.add('process');
        else {
          const gap = Math.max(1, Math.round(visualBox.width * 0.025));
          const nodeWidth = Math.max(1, Math.floor((visualBox.width - gap * (compiled.visualization.processSteps.length - 1)) / compiled.visualization.processSteps.length));
          const nodeY = visualBox.y + Math.floor(visualBox.height * 0.2);
          const nodeHeight = Math.max(1, Math.floor(visualBox.height * 0.6));
          const nodes = compiled.visualization.processSteps.map((step, index) => {
            const x = visualBox.x + index * (nodeWidth + gap);
            addSlideTextBox(slide, { x: emu(x), y: emu(nodeY), w: emu(nodeWidth), h: emu(nodeHeight), text: step.text });
            return { x, centerY: nodeY + Math.floor(nodeHeight / 2) };
          });
          nativeTextShapeCount += nodes.length;
          nativeShapeCount += nodes.length;
          for (let index = 0; index < nodes.length - 1; index += 1) {
            const from = nodes[index]!;
            const to = nodes[index + 1]!;
            addSlideLine(slide, { from: { x: emu(from.x + nodeWidth), y: emu(from.centerY) }, to: { x: emu(to.x), y: emu(to.centerY) } });
            nativeConnectorCount += 1;
          }
        }
      }
      if (compiled.imageRefs.length) {
        if (compiled.imageRefs.length > 1) throw new PptxBackendError('MULTIPLE_IMAGES_UNSUPPORTED', 'A slide currently supports one source-backed image in its selected visual slot.', compiled.imageRefs[1]!.sourcePath);
        const visualBox = compiled.placements.visual ?? (compiled.body.length ? null : compiled.placements.body);
        if (!visualBox) unresolvedVisualTypes.add('image');
        else {
          const image = compiled.imageRefs[0]!;
          const imageBytes = await readVerifiedImage(input, image);
          addSlideImage(slide, imageBytes, {
            x: emu(visualBox.x), y: emu(visualBox.y), w: emu(visualBox.width), h: emu(visualBox.height), fit: 'contain',
          });
          nativeImageCount += 1;
        }
      }
      if (compiled.visualization.type !== 'none' && compiled.visualization.status === 'unresolved') unresolvedVisualTypes.add(compiled.visualization.type);
    }

    const savedBytes = await savePresentation(presentation);
    const outputPackage = await JSZip.loadAsync(savedBytes);
    await removeUnreachableSourceVisualArtifacts(outputPackage, sourceVisualArtifacts);
    const outputBytes = await outputPackage.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const reopened = await loadPresentation(outputBytes);
    if (getSlides(reopened).length !== input.compiledPresentation.slides.length) {
      throw new PptxBackendError('SLIDE_PROJECTION_FAILED', 'The active output slide list does not match the generated presentation slide count.');
    }
    const validationIssues = normalizeIssues(validatePresentation(reopened));
    const templatePreservationStatus = await comparePreservedTemplateParts(sourceBytes, outputBytes, sourceVisualArtifacts) ? 'passed' as const : 'failed' as const;
    if (templatePreservationStatus === 'failed') {
      validationIssues.push({ severity: 'error', message: 'One or more retained template package parts changed or were removed.', partName: null });
    }
    for (const visualType of unresolvedVisualTypes) {
      validationIssues.push({ severity: 'warning', message: `No compatible template slot was available to render the requested ${visualType} visual; source-backed text is retained.`, partName: null });
    }
    for (const message of textStyleWarnings) validationIssues.push({ severity: 'warning', message, partName: null });
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
      projectedCompositions: input.compiledPresentation.slides.map((compiled) => {
        const assessment: ExemplarSelectionAssessment = exemplarAssessments.get(compiled.id)!;
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
    };
  }
}
