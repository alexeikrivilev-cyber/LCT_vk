import { createHash } from 'node:crypto';

import type { CompiledSlide } from './slide-compilation.js';
import type { TemplateElement, TemplateGeometry, TemplateIR, TemplateSlide } from '../domain/template-ir.js';
import { validateTemplateSemanticProfile, type TemplateSemanticProfile, type TemplateSemanticSlideProfile } from './template-semantic-profiler.js';

const MIN_EXEMPLAR_CONFIDENCE = 0.72;
const VARIANT_FAMILY_INDEX = { A: 0, B: 1, C: 2 } as const;

export type ExemplarArchetype =
  | 'cover'
  | 'section-divider'
  | 'hero'
  | 'content'
  | 'content-split'
  | 'content-dense'
  | 'metric-evidence'
  | 'table-data'
  | 'visual-led'
  | 'closing';

export interface ExemplarSlideSelection {
  sourceSlideIndex: number;
  sourcePart: string;
  layoutId: string;
  semanticArchetype: ExemplarArchetype;
  role: CompiledSlide['intent'];
  confidence: number;
  slots: {
    title: { elementId: string; nativeId: string };
    body: { elementId: string; nativeId: string };
    bodySlots: Array<{ elementId: string; nativeId: string }>;
    visual: null;
  };
  clearElementNativeIds: string[];
  preserveChromeNativeIds: string[];
  /** Legacy source morphology key, retained as evidence only. It is not used for A/B/C deduplication. */
  familyKey: string;
  projectedCompositionSignature: string;
  availableDistinctFamilies: number;
  titleGeometryNormalized: NormalizedGeometry;
  bodyGeometryNormalized: NormalizedGeometry;
  titleBodyFontHierarchy: { titlePt: number; bodyPt: number; ratio: number };
  selectionReason: string;
  evidence: string[];
  limitations: string[];
}

export interface ExemplarSelectionAssessment {
  selection: ExemplarSlideSelection | null;
  availableDistinctFamilies: number;
  distinctSourceFamilyKeys: string[];
  candidateDiagnostics: Array<{
    sourceSlideIndex: number;
    structuralArchetype: ExemplarArchetype | null;
    semanticArchetype: ExemplarArchetype | null;
    semanticConfidence: number | null;
    titleElementId: string | null;
    bodyElementIds: string[];
    visualElementIds: string[];
    visualClassification: string[];
    gate: string;
    rejectReason: string | null;
    familyKey: string | null;
    projectedCompositionSignature: string | null;
    projectionSafe: boolean | null;
    contentSafe: boolean | null;
    roleCompatible: boolean;
    titleGeometryNormalized: NormalizedGeometry | null;
    bodyGeometryNormalized: NormalizedGeometry | null;
    titleBodyFontHierarchy: { titlePt: number; bodyPt: number; ratio: number } | null;
    evidence: string[];
  }>;
  supportedCandidateCount: number;
  evidence: string[];
}

interface Candidate {
  selection: Omit<ExemplarSlideSelection, 'availableDistinctFamilies'>;
  score: number;
  projectionSafe: boolean;
  contentSafe: boolean;
  selectionReason: string;
  diagnostic: ExemplarSelectionAssessment['candidateDiagnostics'][number];
}

export interface ExemplarArchetypeAssessment {
  archetype: ExemplarArchetype;
  titleAreaShare: number;
  titleHeightShare: number;
  bodyAreaShare: number;
  bodyHeightShare: number;
  titleBodyFontRatio: number;
  majorTextCount: number;
  visualAreaShare: number;
  evidence: string[];
}

interface NormalizedGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

function area(box: { x: number; y: number; width: number; height: number } | null | undefined): number {
  return box && box.width > 0 && box.height > 0 ? box.width * box.height : 0;
}

function geometryOf(element: TemplateElement): TemplateGeometry | null {
  return element.geometry.resolved ?? element.geometry.direct;
}

function maxFont(element: TemplateElement): number {
  return Math.max(0, ...(element.directStyles.fontSizesPt ?? []));
}

function normalizedText(element: TemplateElement): string {
  return (element.text ?? '').trim().replace(/\s+/g, ' ');
}

function topLevelTextShapes(slide: TemplateSlide): TemplateElement[] {
  return slide.elements.filter((element) => element.kind.toLowerCase() === 'shape'
    && element.parentId === null && Boolean(normalizedText(element)));
}

function overlapFraction(box: NonNullable<ReturnType<typeof geometryOf>>, region: { x: number; y: number; width: number; height: number }): number {
  const left = Math.max(box.x, region.x);
  const top = Math.max(box.y, region.y);
  const right = Math.min(box.x + box.width, region.x + region.width);
  const bottom = Math.min(box.y + box.height, region.y + region.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top) / Math.max(1, area(box));
}

function geometryBand(value: number, unit: number): number {
  return Math.round(value / unit);
}

function estimatedLineFit(text: string, element: TemplateElement): number {
  const box = geometryOf(element);
  if (!box) return 0;
  const fontSizePt = Math.max(8, maxFont(element));
  const widthPt = box.width / 12700;
  const heightPt = box.height / 12700;
  const charactersPerLine = Math.max(6, widthPt / (fontSizePt * 0.52));
  const lineHeightPt = fontSizePt * 1.2;
  const requiredLines = Math.max(1, text.split(/\r?\n/).reduce((sum, line) => sum + Math.max(1, Math.ceil(Array.from(line).length / charactersPerLine)), 0));
  const availableLines = Math.max(0.25, heightPt / lineHeightPt);
  return Number(Math.min(1, availableLines / requiredLines).toFixed(4));
}

function normalizedGeometry(box: TemplateGeometry, template: TemplateIR): NormalizedGeometry {
  const q = (value: number) => Number((Math.round(value * 200) / 200).toFixed(3));
  return {
    x: q(box.x / template.slideSize.width),
    y: q(box.y / template.slideSize.height),
    width: q(box.width / template.slideSize.width),
    height: q(box.height / template.slideSize.height),
    rotation: q(box.rotation / 360),
  };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function signature(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function elementDescriptor(element: TemplateElement, template: TemplateIR, relativeZOrder?: number) {
  const box = geometryOf(element);
  return {
    kind: element.kind.toLowerCase().replaceAll('_', '-'),
    geometry: box ? normalizedGeometry(box, template) : null,
    style: {
      fonts: [...(element.directStyles.fonts ?? [])].sort(),
      fontSizesPt: [...(element.directStyles.fontSizesPt ?? [])].map((size) => Math.round(size)).sort((left, right) => left - right),
      bold: element.directStyles.bold,
      italic: element.directStyles.italic,
      fillColor: element.directStyles.fillColor?.toUpperCase() ?? null,
      lineColor: element.directStyles.lineColor?.toUpperCase() ?? null,
    },
    ...(relativeZOrder === undefined ? {} : { zOrder: relativeZOrder }),
  };
}

function hasVisibleDirectStyle(element: TemplateElement): boolean {
  const visibleColor = (value: string | null) => Boolean(value
    && !['none', 'transparent', '00000000'].includes(value.trim().toLowerCase()));
  return visibleColor(element.directStyles.fillColor) || visibleColor(element.directStyles.lineColor);
}

function familyKey(slide: TemplateSlide, title: TemplateElement, body: TemplateElement, template: TemplateIR): string {
  const titleBox = geometryOf(title)!;
  const bodyBox = geometryOf(body)!;
  const textCount = topLevelTextShapes(slide).length;
  const shapeCount = slide.elements.filter((element) => element.kind.toLowerCase() === 'shape' && !normalizedText(element)).length;
  const connectorCount = slide.elements.filter((element) => element.kind.toLowerCase() === 'connector').length;
  const bucket = (box: typeof titleBox) => [
    geometryBand(box.x / template.slideSize.width, 0.1),
    geometryBand(box.y / template.slideSize.height, 0.1),
    geometryBand(box.width / template.slideSize.width, 0.15),
    geometryBand(box.height / template.slideSize.height, 0.08),
  ].join(',');
  return [slide.layoutId, bucket(titleBox), bucket(bodyBox),
    geometryBand(maxFont(title), 8), geometryBand(maxFont(body), 4),
    Math.floor(textCount / 5), Math.floor(shapeCount / 3), Math.floor(connectorCount / 4)].join('|');
}

function chromeIds(template: TemplateIR, layoutId: string): Set<string> {
  const slides = template.slides.filter((slide) => slide.layoutId === layoutId);
  const occurrences = new Map<string, Set<string>>();
  for (const slide of slides) for (const element of topLevelTextShapes(slide)) {
    const box = geometryOf(element);
    if (!box || !element.nativeId) continue;
    const edgeText = box.y <= template.slideSize.height * 0.12
      || box.y + box.height >= template.slideSize.height * 0.92;
    if (!edgeText || maxFont(element) > 12 || box.height > template.slideSize.height * 0.06) continue;
    const structure = canonical({
      kind: element.kind.toLowerCase(),
      geometry: normalizedGeometry(box, template),
      fontSizesPt: [...(element.directStyles.fontSizesPt ?? [])].map(Math.round).sort((a, b) => a - b),
      bold: element.directStyles.bold,
      italic: element.directStyles.italic,
      fillColor: element.directStyles.fillColor?.toUpperCase() ?? null,
      lineColor: element.directStyles.lineColor?.toUpperCase() ?? null,
      // Repeated position/style alone can identify a changing page number as chrome.
      // Preserve edge text only when the same short furniture value recurs as well.
      text: normalizedText(element),
    });
    const seen = occurrences.get(structure) ?? new Set<string>();
    seen.add(slide.sourcePart);
    occurrences.set(structure, seen);
  }
  const minimum = Math.ceil(slides.length * 0.6);
  const ids = new Set<string>();
  for (const slide of slides) for (const element of topLevelTextShapes(slide)) {
    const box = geometryOf(element);
    if (!box || !element.nativeId || maxFont(element) > 12 || box.height > template.slideSize.height * 0.06) continue;
    const atEdge = box.y <= template.slideSize.height * 0.12
      || box.y + box.height >= template.slideSize.height * 0.92;
    if (!atEdge) continue;
    const structure = canonical({
      kind: element.kind.toLowerCase(),
      geometry: normalizedGeometry(box, template),
      fontSizesPt: [...(element.directStyles.fontSizesPt ?? [])].map(Math.round).sort((a, b) => a - b),
      bold: element.directStyles.bold,
      italic: element.directStyles.italic,
      fillColor: element.directStyles.fillColor?.toUpperCase() ?? null,
      lineColor: element.directStyles.lineColor?.toUpperCase() ?? null,
      text: normalizedText(element),
    });
    if ((occurrences.get(structure)?.size ?? 0) >= minimum) ids.add(element.id);
  }
  return ids;
}

function titleForSlide(slide: TemplateSlide, evidence: NonNullable<CompiledSlide['layoutCandidates'][number]['slotEvidence']['title']>) {
  const sample = evidence.sourceEvidence.find((item) => item.sourcePart === slide.sourcePart && item.slideIndex === slide.index);
  if (sample) return slide.elements.find((element) => element.id === sample.elementId) ?? null;
  const placeholders = slide.elements.filter((element) => {
    const identity = `${element.placeholder?.type ?? ''} ${element.placeholder?.role ?? ''}`.toLowerCase();
    return /title|subtitle/.test(identity) && normalizedText(element).length > 0;
  });
  return placeholders.length === 1 ? placeholders[0]! : null;
}

function visualKinds(slide: TemplateSlide): TemplateElement[] {
  return slide.elements.filter((element) => ['picture', 'image', 'table', 'chart', 'graphicframe', 'group']
    .includes(element.kind.toLowerCase().replaceAll('_', '').replaceAll('-', '')));
}

function visualClassification(slide: TemplateSlide, template: TemplateIR): Array<{ elementId: string; kind: string }> {
  const family = template.slides.filter((candidate) => candidate.layoutId === slide.layoutId);
  const occurrences = (element: TemplateElement): number => {
    const box = geometryOf(element);
    if (!box || !slide.layoutId) return 0;
    const relationshipTargets = slide.relationships.filter((relationship) => element.relationshipIds.includes(relationship.id))
      .map((relationship) => relationship.targetPart ?? relationship.target).sort();
    const descriptor = canonical({
      kind: element.kind.toLowerCase(), geometry: normalizedGeometry(box, template), relationshipTargets,
      style: element.directStyles,
    });
    return family.filter((candidate) => candidate.elements.some((other) => {
      const otherBox = geometryOf(other);
      if (!otherBox || other.kind.toLowerCase() !== element.kind.toLowerCase()) return false;
      const targets = candidate.relationships.filter((relationship) => other.relationshipIds.includes(relationship.id))
        .map((relationship) => relationship.targetPart ?? relationship.target).sort();
      return canonical({ kind: other.kind.toLowerCase(), geometry: normalizedGeometry(otherBox, template), relationshipTargets: targets, style: other.directStyles }) === descriptor;
    })).length;
  };
  const canvasArea = Math.max(1, template.slideSize.width * template.slideSize.height);
  return visualKinds(slide).map((element) => {
    const box = geometryOf(element);
    const kind = element.kind.toLowerCase().replaceAll('_', '').replaceAll('-', '');
    const smallPicture = ['picture', 'image'].includes(kind) && box !== null && area(box) / canvasArea <= 0.04;
    const repeated = occurrences(element);
    const minimum = Math.max(2, Math.ceil(family.length * 0.8));
    if (smallPicture && family.length >= 2 && repeated >= minimum) return { elementId: element.id, kind: 'preservable-template-visual' };
    if (element.placeholder && !element.relationshipIds.length && !['picture', 'image', 'table', 'chart', 'graphicframe'].includes(kind)) {
      return { elementId: element.id, kind: 'replaceable-visual-slot' };
    }
    return { elementId: element.id, kind: 'source-specific-unsafe-visual' };
  });
}

function classifyStructuralArchetype(
  slide: TemplateSlide,
  template: TemplateIR,
  title: TemplateElement,
  body: TemplateElement,
  preservedChromeIds: ReadonlySet<string>,
): ExemplarArchetypeAssessment {
  const titleBox = geometryOf(title)!;
  const bodyBox = geometryOf(body)!;
  const canvasArea = Math.max(1, template.slideSize.width * template.slideSize.height);
  const titleAreaShare = area(titleBox) / canvasArea;
  const titleHeightShare = titleBox.height / template.slideSize.height;
  const bodyAreaShare = area(bodyBox) / canvasArea;
  const bodyHeightShare = bodyBox.height / template.slideSize.height;
  const titleBodyFontRatio = maxFont(title) / Math.max(1, maxFont(body));
  const textShapes = topLevelTextShapes(slide);
  const majorText = textShapes.filter((element) => {
    const box = geometryOf(element);
    return Boolean(box && (area(box) / canvasArea >= 0.018 || maxFont(element) >= 20));
  });
  const secondaryMajor = majorText.filter((element) => element.id !== title.id && element.id !== body.id
    && !preservedChromeIds.has(element.id));
  const specialVisuals = visualKinds(slide);
  const unlabelledShapes = slide.elements.filter((element) => element.parentId === null
    && ['shape', 'connector'].includes(element.kind.toLowerCase()) && !normalizedText(element));
  const visualAreaShare = Math.min(1, [...specialVisuals, ...unlabelledShapes]
    .reduce((sum, element) => sum + area(geometryOf(element)), 0) / canvasArea);
  const hasDataObject = slide.elements.some((element) => ['table', 'chart', 'graphicframe']
    .includes(element.kind.toLowerCase().replaceAll('_', '').replaceAll('-', '')));
  const pictureArea = specialVisuals.filter((element) => ['picture', 'image'].includes(element.kind.toLowerCase()))
    .reduce((sum, element) => sum + area(geometryOf(element)), 0) / canvasArea;
  const mappedBodyCenterX = bodyBox.x + bodyBox.width / 2;
  const sideBySideMajor = secondaryMajor.some((element) => {
    const box = geometryOf(element);
    if (!box) return false;
    const centerX = box.x + box.width / 2;
    return Math.abs(centerX - mappedBodyCenterX) >= template.slideSize.width * 0.18
      && Math.min(box.y + box.height, bodyBox.y + bodyBox.height) > Math.max(box.y, bodyBox.y);
  });
  const largeMetricCount = majorText.filter((element) => maxFont(element) >= 20).length;
  const majorTextShare = majorText.reduce((sum, element) => sum + area(geometryOf(element)), 0) / canvasArea;
  const heroTypography = titleBodyFontRatio >= 3.6
    && (titleHeightShare >= 0.08 || titleAreaShare >= 0.06)
    || (titleBodyFontRatio >= 2.5 && titleHeightShare >= 0.14 && bodyAreaShare < 0.15);
  let archetype: ExemplarArchetype = 'content';

  if (hasDataObject) archetype = 'table-data';
  else if (pictureArea >= 0.16 || visualAreaShare >= 0.34) archetype = 'visual-led';
  else if (sideBySideMajor || (pictureArea >= 0.1 && mappedBodyCenterX / template.slideSize.width < 0.55)) archetype = 'content-split';
  else if (largeMetricCount >= 3 && majorText.length >= 5) archetype = 'metric-evidence';
  else if (heroTypography && titleBodyFontRatio >= 3.6 && maxFont(body) <= 10) archetype = 'hero';
  else if (heroTypography && bodyAreaShare < 0.045 && majorText.length <= 2) archetype = 'section-divider';
  else if (heroTypography && (majorTextShare > 0.11 || majorText.length >= 3)) archetype = 'cover';
  else if (heroTypography) archetype = 'hero';
  else if (secondaryMajor.length >= 3 || (majorText.length >= 5 && majorTextShare > 0.2)) archetype = 'content-dense';

  const evidence = [
    `title occupies ${(titleAreaShare * 100).toFixed(1)}% of the canvas and ${(titleHeightShare * 100).toFixed(1)}% of its height`,
    `mapped body occupies ${(bodyAreaShare * 100).toFixed(1)}% of the canvas and ${(bodyHeightShare * 100).toFixed(1)}% of slide height; title/body font ratio is ${titleBodyFontRatio.toFixed(2)}`,
    `${majorText.length} major text regions, ${secondaryMajor.length} additional non-chrome text regions, and ${(visualAreaShare * 100).toFixed(1)}% unlabelled/visual object area`,
  ];
  return { archetype, titleAreaShare, titleHeightShare, bodyAreaShare, bodyHeightShare, titleBodyFontRatio,
    majorTextCount: majorText.length, visualAreaShare, evidence };
}

/** Classifies a donor from geometry, typography, and native-object topology only. */
export function classifyExemplarArchetype(
  slide: TemplateSlide,
  template: TemplateIR,
  titleElementId: string,
  bodyElementId: string,
): ExemplarArchetypeAssessment {
  const title = slide.elements.find((element) => element.id === titleElementId);
  const body = slide.elements.find((element) => element.id === bodyElementId);
  if (!title || !body || !geometryOf(title) || !geometryOf(body)) throw new TypeError('Archetype classification requires measured title and body elements');
  return classifyStructuralArchetype(slide, template, title, body, chromeIds(template, slide.layoutId ?? ''));
}

function projectedCompositionSignature(
  slide: TemplateSlide,
  title: TemplateElement,
  bodies: readonly TemplateElement[],
  preservedChromeIds: ReadonlySet<string>,
  template: TemplateIR,
): string {
  const bodyIds = new Set(bodies.map((body) => body.id));
  const keptTextIds = new Set([title.id, ...bodyIds, ...preservedChromeIds]);
  const projectedElements = slide.elements.filter((element) => {
    if (element.parentId !== null || element.id === title.id || bodyIds.has(element.id)) return false;
    if (keptTextIds.has(element.id)) return true;
    if (normalizedText(element)) {
      // Text is cleared from source-specific boxes. Include only any directly styled box/line left visible.
      return hasVisibleDirectStyle(element);
    }
    return true;
  });
  const allProjectedElements = [...projectedElements, title, ...bodies].sort((left, right) => left.order - right.order);
  const relativeZOrder = new Map(allProjectedElements.map((element, index) => [element.id, index]));
  const retainedElements = projectedElements.map((element) => elementDescriptor(element, template, relativeZOrder.get(element.id)!));
  return signature({
    mappedText: {
      title: elementDescriptor(title, template, relativeZOrder.get(title.id)!),
      body: bodies.map((body) => elementDescriptor(body, template, relativeZOrder.get(body.id)!)),
    },
    retainedNativeElements: retainedElements,
  });
}

function fallbackCompositionSignature(compiled: CompiledSlide, template: TemplateIR): string {
  const layout = template.layouts.find((item) => item.id === compiled.layoutId);
  const master = layout?.masterId ? template.masters.find((item) => item.id === layout.masterId) : null;
  return signature({
    nativeLayout: layout?.elements.map((element) => elementDescriptor(element, template)) ?? [],
    nativeMaster: master?.elements.map((element) => elementDescriptor(element, template)) ?? [],
    generatedText: {
      title: normalizedGeometry({ ...compiled.placements.title, rotation: 0, unit: 'EMU' }, template),
      body: normalizedGeometry({ ...compiled.placements.body, rotation: 0, unit: 'EMU' }, template),
      visual: compiled.placements.visual
        ? normalizedGeometry({ ...compiled.placements.visual, rotation: 0, unit: 'EMU' }, template)
        : null,
    },
    visualTopology: {
      type: compiled.visualization.type,
      status: compiled.visualization.status,
      chart: compiled.visualization.chartData ? {
        kind: compiled.visualization.chartData.kind,
        categoryCount: compiled.visualization.chartData.categories.length,
        seriesCount: compiled.visualization.chartData.series.length,
      } : null,
      table: compiled.visualization.tableData ? {
        rowCount: compiled.visualization.tableData.length,
        columnCount: Math.max(0, ...compiled.visualization.tableData.map((row) => row.length)),
      } : null,
      processSteps: compiled.visualization.processSteps.length,
      hasKpi: compiled.visualization.kpi !== null,
      imageCount: compiled.imageRefs.length,
    },
  });
}

type CandidateDiagnostic = ExemplarSelectionAssessment['candidateDiagnostics'][number];

interface CandidateBuild {
  candidate: Candidate | null;
  diagnostic: CandidateDiagnostic;
}

function inCanvas(box: TemplateGeometry, template: TemplateIR): boolean {
  return box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0
    && box.x + box.width <= template.slideSize.width && box.y + box.height <= template.slideSize.height;
}

function bodyChunks(lines: readonly string[], count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => {
    const start = Math.floor(index * lines.length / count);
    const end = Math.floor((index + 1) * lines.length / count);
    return lines.slice(start, end).join('\n');
  });
}

function bodySlotsFor(
  candidates: TemplateElement[],
  compiled: CompiledSlide,
  allowMultiple: boolean,
): { elements: TemplateElement[]; fits: number[] } | null {
  if (!candidates.length) return null;
  const orderedByArea = [...candidates].sort((left, right) => area(geometryOf(right)) - area(geometryOf(left)) || left.order - right.order);
  const available: TemplateElement[] = [];
  for (const element of orderedByArea) {
    const box = geometryOf(element)!;
    if (available.some((existing) => {
      const other = geometryOf(existing)!;
      return box.x < other.x + other.width && box.x + box.width > other.x
        && box.y < other.y + other.height && box.y + box.height > other.y;
    })) continue;
    available.push(element);
    if (available.length >= (allowMultiple ? Math.min(3, Math.max(1, compiled.body.length)) : 1)) break;
  }
  const elements = available.sort((left, right) => geometryOf(left)!.y - geometryOf(right)!.y
    || geometryOf(left)!.x - geometryOf(right)!.x || left.order - right.order);
  for (let count = elements.length; count >= 1; count -= 1) {
    const selected = elements.slice(0, count);
    const fits = bodyChunks(compiled.body, count).map((text, index) => estimatedLineFit(text, selected[index]!));
    if (fits.every((fit) => fit >= 0.55)) return { elements: selected, fits };
  }
  return null;
}

function candidateFor(
  compiled: CompiledSlide,
  template: TemplateIR,
  slide: TemplateSlide,
  titleEvidence: NonNullable<CompiledSlide['layoutCandidates'][number]['slotEvidence']['title']> | null,
  bodyEvidence: NonNullable<CompiledSlide['layoutCandidates'][number]['slotEvidence']['body']> | null,
  profileSlide: TemplateSemanticSlideProfile | undefined,
): CandidateBuild {
  const trustedProfile = profileSlide && profileSlide.confidence >= 0.6 ? profileSlide : null;
  const preservedChromeIds = chromeIds(template, slide.layoutId ?? '');
  const visualClasses = visualClassification(slide, template);
  const visualElementIds = trustedProfile?.visualElementIds ?? visualClasses.map((item) => item.elementId);
  const diagnostic: CandidateDiagnostic = {
    sourceSlideIndex: slide.index,
    structuralArchetype: null,
    semanticArchetype: trustedProfile?.archetype ?? null,
    semanticConfidence: profileSlide?.confidence ?? null,
    titleElementId: trustedProfile?.titleElementId ?? null,
    bodyElementIds: trustedProfile?.bodyElementIds ?? [],
    visualElementIds,
    visualClassification: visualClasses.map((item) => `${item.elementId}:${item.kind}`),
    gate: 'candidate-filter', rejectReason: null, familyKey: null, projectedCompositionSignature: null,
    projectionSafe: null, contentSafe: null, roleCompatible: false,
    titleGeometryNormalized: null, bodyGeometryNormalized: null, titleBodyFontHierarchy: null, evidence: [],
  };
  const reject = (gate: string, reason: string): CandidateBuild => {
    diagnostic.gate = gate;
    diagnostic.rejectReason = reason;
    diagnostic.evidence = [reason];
    return { candidate: null, diagnostic };
  };
  if (!slide.sourcePart) return reject('source-part', 'source slide part is missing');
  if (slide.layoutId !== compiled.layoutId && !trustedProfile) return reject('layout-match', `donor layout ${slide.layoutId ?? 'null'} differs from compiled layout ${compiled.layoutId}; no trusted semantic role mapping`);
  if (slide.elements.some((element) => element.parentId !== null)) return reject('nested-elements', 'nested/grouped elements are unsupported by the native text projector');
  if (slide.relationships.some((relationship) => {
    const type = relationship.type.toLowerCase();
    return type.endsWith('/slide') || type.endsWith('/hyperlink');
  })) return reject('relationships', 'slide/hyperlink relationship is unsafe');
  const unsafeVisuals = visualClasses.filter((item) => item.kind === 'source-specific-unsafe-visual');
  if (unsafeVisuals.length) return reject('visual-safety', `source-specific or opaque visual objects are unsafe to preserve: ${unsafeVisuals.map((item) => item.elementId).join(',')}`);

  const profileTitle = trustedProfile?.titleElementId
    ? slide.elements.find((element) => element.id === trustedProfile.titleElementId) : null;
  const profileTitleUsable = Boolean(profileTitle && profileTitle.nativeId && geometryOf(profileTitle)
    && profileTitle.parentId === null && profileTitle.kind.toLowerCase() === 'shape' && normalizedText(profileTitle));
  const title = profileTitleUsable ? profileTitle! : titleEvidence ? titleForSlide(slide, titleEvidence) : null;
  if (trustedProfile?.titleElementId && !profileTitleUsable) {
    diagnostic.evidence.push('semantic title mapping conflicts with native text/geometry requirements; structural fallback was attempted');
  }
  const titleBox = title ? geometryOf(title) : null;
  if (!title || !title.nativeId || !titleBox) return reject('title-role', 'no usable mapped title text shape with native ID and geometry');
  const bodySamples = (bodyEvidence?.sourceEvidence ?? []).filter((item) => item.sourcePart === slide.sourcePart && item.slideIndex === slide.index);
  const semanticBodyCandidates = trustedProfile?.bodyElementIds.map((id) => slide.elements.find((element) => element.id === id))
    .filter((element): element is TemplateElement => Boolean(element));
  const structuralBodyCandidates = bodySamples.map((sample) => slide.elements.find((element) => element.id === sample.elementId));
  const bodyCandidates = (trustedProfile && semanticBodyCandidates?.length ? semanticBodyCandidates : structuralBodyCandidates)
    .filter((element): element is TemplateElement => Boolean(element && element.id !== title.id && element.nativeId
      && element.kind.toLowerCase() === 'shape' && element.parentId === null && normalizedText(element)
      && geometryOf(element) && maxFont(element) >= 7.5 && maxFont(element) <= 72))
    .map((element) => ({
      element,
      overlap: bodyEvidence ? overlapFraction(geometryOf(element)!, bodyEvidence.geometry) : 1,
      areaRatio: area(geometryOf(element)!) / Math.max(1, area(bodyEvidence?.geometry)),
    }))
    .filter((item) => trustedProfile && semanticBodyCandidates?.length ? true : item.overlap >= 0.65)
    .sort((left, right) => right.areaRatio - left.areaRatio || left.element.order - right.element.order);
  const bodyChoice = bodySlotsFor(bodyCandidates.map((item) => item.element), compiled, Boolean(trustedProfile));
  if (!bodyChoice) return reject('body-role-fit', trustedProfile
    ? 'semantic body mappings did not provide usable, non-overlapping text geometry with sufficient projected fit'
    : 'no repeated body-evidence shape overlaps inferred region by at least 65% with sufficient projected fit');
  const bodies = bodyChoice.elements;
  const body = bodies[0]!;
  const bodyBox = geometryOf(body)!;
  const allBoxes = [titleBox, ...bodies.map((element) => geometryOf(element)!)];
  if (allBoxes.some((box) => !inCanvas(box, template))) return reject('candidate-geometry', 'mapped title/body geometry extends outside the slide canvas');
  for (let left = 0; left < allBoxes.length; left += 1) for (let right = left + 1; right < allBoxes.length; right += 1) {
    const a = allBoxes[left]!; const b = allBoxes[right]!;
    if (a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y) {
      return reject('candidate-geometry', 'mapped title/body text regions overlap');
    }
  }
  const textShapes = topLevelTextShapes(slide);
  if (textShapes.length < 2 || textShapes.some((element) => !element.nativeId)) return reject('native-text-mapping', 'top-level donor text contains shapes without native IDs');

  const titleSupport = titleEvidence?.sourceEvidence.filter((item) => item.sourcePart === slide.sourcePart).length ?? 0;
  const bodySupport = bodyEvidence?.sourceEvidence.filter((item) => item.sourcePart === slide.sourcePart).length ?? 0;
  const styleHierarchy = maxFont(title) > maxFont(body) ? 1 : 0.55;
  const geometryFit = trustedProfile ? 1 : bodyCandidates.find((item) => item.element.id === body.id)?.overlap ?? 0;
  const titleFit = estimatedLineFit(compiled.title, title);
  const bodyFit = Math.min(...bodyChoice.fits);
  const contentFit = Math.min(titleFit, bodyFit);
  if (contentFit < 0.55) return reject('projected-text-fit', `projected title/body text fit ${contentFit}<0.55`);
  const confidence = trustedProfile
    ? Number((0.42 * trustedProfile.confidence + 0.22 * geometryFit + 0.18 * styleHierarchy + 0.18 * contentFit).toFixed(4))
    : Number((0.36 * (titleEvidence?.confidence ?? 0) + 0.36 * (bodyEvidence?.confidence ?? 0)
      + 0.16 * geometryFit + 0.12 * styleHierarchy).toFixed(4));
  if (confidence < MIN_EXEMPLAR_CONFIDENCE) return reject('confidence', `candidate confidence ${confidence}<${MIN_EXEMPLAR_CONFIDENCE}`);

  const archetype = classifyStructuralArchetype(slide, template, title, body, preservedChromeIds);
  const chosenArchetype = trustedProfile ? trustedProfile.archetype as ExemplarArchetype : archetype.archetype;
  const semanticConflict = Boolean(trustedProfile && trustedProfile.archetype !== archetype.archetype);
  const titleAreaShare = archetype.titleAreaShare;
  const canvasArea = Math.max(1, template.slideSize.width * template.slideSize.height);
  const bodyAreaShare = Math.min(1, bodies.reduce((sum, element) => sum + area(geometryOf(element)), 0) / canvasArea);
  const bodyTop = Math.min(...bodies.map((element) => geometryOf(element)!.y));
  const bodyBottom = Math.max(...bodies.map((element) => geometryOf(element)!.y + geometryOf(element)!.height));
  const bodyHeightShare = (bodyBottom - bodyTop) / template.slideSize.height;
  const fontRatio = archetype.titleBodyFontRatio;
  const titleHeightShare = archetype.titleHeightShare;
  const mappedBodyIds = new Set(trustedProfile?.bodyElementIds ?? [body.id]);
  const sourceSpecificText = textShapes.filter((element) => element.id !== title.id && !mappedBodyIds.has(element.id)
    && !preservedChromeIds.has(element.id));
  const selectedBodyIds = new Set(bodies.map((element) => element.id));
  const unprojectedMappedBodies = textShapes.filter((element) => mappedBodyIds.has(element.id) && !selectedBodyIds.has(element.id));
  const isMajorText = (element: TemplateElement) => {
    const box = geometryOf(element);
    return Boolean(box && (area(box) / Math.max(1, template.slideSize.width * template.slideSize.height) >= 0.055
      || (maxFont(element) >= 20 && area(box) / Math.max(1, template.slideSize.width * template.slideSize.height) >= 0.012)));
  };
  const majorTextToClear = sourceSpecificText.filter(isMajorText).length;
  const majorMappedTextToClear = unprojectedMappedBodies.filter(isMajorText).length;
  const bodyLineCapacity = Math.max(0.25, bodies.reduce((sum, item) => {
    const box = geometryOf(item)!;
    return sum + (box.width / 12700) / (Math.max(8, maxFont(item)) * 0.52)
      * (box.height / 12700) / (Math.max(8, maxFont(item)) * 1.2);
  }, 0));
  const projectedLines = Math.max(1, compiled.body.length);
  const textDensity = Number(Math.min(1, projectedLines / bodyLineCapacity).toFixed(4));
  const contentGateReasons: string[] = [];
  if (titleHeightShare > 0.22) contentGateReasons.push('title consumes too much vertical space for a content slide');
  if (titleAreaShare > 0.14) contentGateReasons.push('title occupies excessive canvas area for a content slide');
  if (bodyAreaShare < 0.06 || bodyHeightShare < 0.09) contentGateReasons.push('body donor region is too small to carry content');
  if (fontRatio > 2.2 && bodyAreaShare < 0.12) contentGateReasons.push('title/body typography ratio leaves a small body region visually subordinate');
  if (majorTextToClear > 0) contentGateReasons.push(`${majorTextToClear} major source-specific text region(s) would be erased outside the mapped body`);
  if (majorMappedTextToClear > 0) contentGateReasons.push(`${majorMappedTextToClear} major semantic body region(s) are mapped but not projected and would be erased`);
  if (textDensity < 0.08 && bodyAreaShare > 0.3) contentGateReasons.push('projected text is sparse for the large donor body region');
  const projectionSafe = majorTextToClear === 0 && majorMappedTextToClear === 0;
  const structuralContentRole = ['content', 'content-dense'].includes(archetype.archetype);
  const contentSafe = projectionSafe && contentGateReasons.length === 0 && (trustedProfile !== null || structuralContentRole);

  const confidenceScore = 0.32 * confidence + 0.23 * geometryFit + 0.15 * styleHierarchy + 0.3 * contentFit;
  const preferredByVariant: Record<CompiledSlide['variantId'], string[]> = {
    A: ['content', 'content-split', 'cover', 'hero'],
    B: ['visual-led', 'content-split', 'metric-evidence'],
    C: ['content-dense', 'metric-evidence', 'table-data', 'content'],
  };
  const intentPreference = compiled.intent === 'title' ? ['cover', 'hero']
    : compiled.intent === 'section' ? ['section-divider', 'hero']
      : compiled.intent === 'summary' ? ['closing', 'content-dense', 'content'] : [];
  const semanticBoost = trustedProfile
    ? (intentPreference.includes(chosenArchetype) ? 0.16 : 0)
      + (preferredByVariant[compiled.variantId].includes(chosenArchetype) ? 0.12 : -0.04)
      + (semanticConflict ? -0.025 : 0)
    : compiled.intent === 'title'
      ? archetype.archetype === 'cover' ? 0.16 : archetype.archetype === 'hero' ? 0.1 : 0
      : compiled.intent === 'section'
        ? ['section-divider', 'hero'].includes(archetype.archetype) ? 0.16 : 0
        : ['content', 'content-dense'].includes(archetype.archetype) ? 0.12 : -0.12;
  const score = confidenceScore + semanticBoost - Math.min(0.25, contentGateReasons.length * 0.1)
    - (textDensity < 0.08 && bodyAreaShare > 0.3 ? 0.12 : 0);
  const additionalMappedBodies = (trustedProfile?.bodyElementIds ?? []).map((id) => slide.elements.find((element) => element.id === id))
    .filter((element): element is TemplateElement => Boolean(element && !selectedBodyIds.has(element.id)
      && element.id !== title.id && element.nativeId && normalizedText(element)));
  const clearElementNativeIds = [...new Set([...sourceSpecificText, ...additionalMappedBodies])].map((element) => element.nativeId!);
  const preserveChromeNativeIds = textShapes.filter((element) => preservedChromeIds.has(element.id)
    && element.id !== title.id && element.id !== body.id).map((element) => element.nativeId!);
  const evidence = [
    trustedProfile ? `semantic profile confidence ${trustedProfile.confidence} mapped ${bodies.length} body region(s)` : `title donor repeats across ${titleEvidence?.sampleCount ?? 0} slides in the selected layout`,
    trustedProfile ? `profile mapped ${trustedProfile.bodyElementIds.length} source body element(s)` : `body donor region repeats across ${bodyEvidence?.sampleCount ?? 0} slides in the selected layout`,
    `mapped body shape overlaps ${Math.round(geometryFit * 100)}% of its inferred body region`,
    `title/body font hierarchy ${maxFont(title)}pt > ${maxFont(body)}pt`,
    `approximate text-height fit title=${titleFit} body=${bodyFit}; visual preview remains required`,
    ...archetype.evidence,
    ...(semanticConflict ? [`semantic/structural conflict: profile=${trustedProfile!.archetype}, structural=${archetype.archetype}; structural safety remains authoritative`] : []),
    `projected body density estimate ${textDensity.toFixed(3)}`,
    ...contentGateReasons.map((reason) => `content-sanity gate: ${reason}`),
    `${textShapes.length} text shapes inspected; ${clearElementNativeIds.length} source-specific shapes will be cleared`,
    `${slide.elements.filter((element) => element.kind.toLowerCase() === 'connector').length} native connectors and ${slide.elements.filter((element) => element.kind.toLowerCase() === 'shape' && !normalizedText(element)).length} unlabelled shapes retained`,
    `${titleSupport} title evidence records and ${bodySupport} body evidence records refer to this source slide`,
  ];
  const titleNormalized = normalizedGeometry(titleBox, template);
  const bodyNormalized = normalizedGeometry(bodyBox, template);
  const selectionReason = contentSafe
      ? 'structural content archetype passed the normalized content-sanity gates'
      : 'structural role is less compatible with this slide intent or a content-sanity gate did not pass';
  const selection: Omit<ExemplarSlideSelection, 'availableDistinctFamilies'> = {
      sourceSlideIndex: slide.index,
      sourcePart: slide.sourcePart,
      layoutId: slide.layoutId!,
      semanticArchetype: chosenArchetype,
      role: compiled.intent,
      confidence,
      slots: {
        title: { elementId: title.id, nativeId: title.nativeId },
        body: { elementId: body.id, nativeId: body.nativeId! },
        bodySlots: bodies.map((element) => ({ elementId: element.id, nativeId: element.nativeId! })),
        visual: null,
      },
      clearElementNativeIds,
      preserveChromeNativeIds,
      familyKey: familyKey(slide, title, body, template),
      projectedCompositionSignature: projectedCompositionSignature(slide, title, bodies, preservedChromeIds, template),
      titleGeometryNormalized: titleNormalized,
      bodyGeometryNormalized: bodyNormalized,
      titleBodyFontHierarchy: { titlePt: maxFont(title), bodyPt: maxFont(body), ratio: Number(fontRatio.toFixed(3)) },
      selectionReason: '',
      evidence,
      limitations: trustedProfile ? ['Semantic body regions are mapped in reading order; unsupported visual/data structures remain fail-closed.']
        : ['The compiled text body uses the structural selector evidence for a single compatible donor region.'],
    };
  diagnostic.structuralArchetype = archetype.archetype;
  diagnostic.semanticArchetype = trustedProfile?.archetype ?? archetype.archetype;
  diagnostic.titleElementId = title.id;
  diagnostic.bodyElementIds = trustedProfile?.bodyElementIds ?? bodies.map((element) => element.id);
  diagnostic.gate = 'passed';
  diagnostic.rejectReason = null;
  diagnostic.familyKey = selection.familyKey;
  diagnostic.projectedCompositionSignature = selection.projectedCompositionSignature;
  diagnostic.projectionSafe = projectionSafe;
  diagnostic.contentSafe = contentSafe;
  diagnostic.roleCompatible = projectionSafe && (compiled.intent === 'title' || compiled.intent === 'section' || contentSafe);
  diagnostic.titleGeometryNormalized = selection.titleGeometryNormalized;
  diagnostic.bodyGeometryNormalized = selection.bodyGeometryNormalized;
  diagnostic.titleBodyFontHierarchy = selection.titleBodyFontHierarchy;
  diagnostic.evidence = evidence;
  const candidate: Candidate = { selection, score, projectionSafe, contentSafe, selectionReason, diagnostic };
  return { candidate, diagnostic };
}

function semanticCandidates(candidates: Candidate[], intent: CompiledSlide['intent']): Candidate[] {
  if (intent === 'narrative') {
    return candidates.filter((candidate) => candidate.projectionSafe && candidate.contentSafe);
  }
  if (intent === 'title') {
    const eligible = candidates.filter((candidate) => candidate.projectionSafe);
    const preferred = eligible.filter((candidate) => ['cover', 'hero'].includes(candidate.selection.semanticArchetype));
    return preferred.length ? preferred : candidates.filter((candidate) => candidate.contentSafe);
  }
  if (intent === 'section') {
    const eligible = candidates.filter((candidate) => candidate.projectionSafe);
    const preferred = eligible.filter((candidate) => ['section-divider', 'hero'].includes(candidate.selection.semanticArchetype));
    return preferred.length ? preferred : candidates.filter((candidate) => candidate.contentSafe);
  }
  return candidates.filter((candidate) => candidate.projectionSafe && candidate.contentSafe);
}

function nativePlaceholderFallbackSupported(compiled: CompiledSlide, template: TemplateIR): boolean {
  const layout = compiled.layoutCandidates.find((candidate) => candidate.layoutId === compiled.layoutId
    && candidate.sourcePart === compiled.layoutSourcePart);
  const sourceLayout = template.layouts.find((candidate) => candidate.id === compiled.layoutId);
  if (!layout || !sourceLayout || layout.slotEvidence.title?.provenance !== 'explicit_placeholder'
      || layout.slotEvidence.body?.provenance !== 'explicit_placeholder') return false;
  const placeholders = sourceLayout.elements.filter((element) => element.placeholder !== null);
  return placeholders.some((element) => element.id === layout.slotEvidence.title?.sourceEvidence[0]?.elementId
      && /title|subtitle/i.test(`${element.placeholder?.type ?? ''} ${element.placeholder?.role ?? ''}`))
    && placeholders.some((element) => element.id === layout.slotEvidence.body?.sourceEvidence[0]?.elementId
      && /body|obj|content|subtitle/i.test(`${element.placeholder?.type ?? ''} ${element.placeholder?.role ?? ''}`));
}

/**
 * Inspect donor choices and return explicit distinct-family evidence even when the requested rank is unavailable.
 * A/B/C are deduplicated after text replacement, source-text cleanup, chrome retention, and note removal.
 */
export function assessExemplarSelection(
  compiled: CompiledSlide,
  template: TemplateIR,
  semanticProfileInput?: TemplateSemanticProfile,
): ExemplarSelectionAssessment {
  const semanticProfile = semanticProfileInput ? validateTemplateSemanticProfile(semanticProfileInput, template) : undefined;
  if (compiled.visualization.type !== 'none' || compiled.visualization.status !== 'none' || compiled.imageRefs.length) {
    const profileByIndex = new Map(semanticProfile?.slides.map((slide) => [slide.sourceSlideIndex, slide]) ?? []);
    const candidateDiagnostics = template.slides.map((slide): CandidateDiagnostic => {
      const profileSlide = profileByIndex.get(slide.index);
      const title = profileSlide?.titleElementId ? slide.elements.find((element) => element.id === profileSlide.titleElementId) : null;
      const body = profileSlide?.bodyElementIds.map((id) => slide.elements.find((element) => element.id === id)).find((element) => element !== undefined) ?? null;
      let structuralArchetype: ExemplarArchetype | null = null;
      if (title && body && geometryOf(title) && geometryOf(body)) {
        structuralArchetype = classifyStructuralArchetype(slide, template, title, body, chromeIds(template, slide.layoutId ?? '')).archetype;
      }
      const visualClasses = visualClassification(slide, template);
      return {
        sourceSlideIndex: slide.index,
        structuralArchetype,
        semanticArchetype: profileSlide?.archetype ?? null,
        semanticConfidence: profileSlide?.confidence ?? null,
        titleElementId: profileSlide?.titleElementId ?? null,
        bodyElementIds: profileSlide?.bodyElementIds ?? [],
        visualElementIds: profileSlide?.visualElementIds ?? visualClasses.map((item) => item.elementId),
        visualClassification: visualClasses.map((item) => `${item.elementId}:${item.kind}`),
        gate: 'compiled-visual-projection',
        rejectReason: 'compiled slide requests a visual or image; the text-only exemplar projector cannot safely combine it with the generated visual',
        familyKey: null,
        projectedCompositionSignature: null,
        projectionSafe: null,
        contentSafe: null,
        roleCompatible: false,
        titleGeometryNormalized: title && geometryOf(title) ? normalizedGeometry(geometryOf(title)!, template) : null,
        bodyGeometryNormalized: body && geometryOf(body) ? normalizedGeometry(geometryOf(body)!, template) : null,
        titleBodyFontHierarchy: title && body ? {
          titlePt: maxFont(title), bodyPt: maxFont(body), ratio: Number((maxFont(title) / Math.max(1, maxFont(body))).toFixed(3)),
        } : null,
        evidence: [`${visualClasses.length} source visual object(s) classified without projection`, 'active visual payload remains fail-closed'],
      };
    });
    return { selection: null, availableDistinctFamilies: 0, distinctSourceFamilyKeys: [], candidateDiagnostics, supportedCandidateCount: 0,
      evidence: ['compiled slide has a requested visual or image; this one-body exemplar selector is not compatible'] };
  }
  const layout = compiled.layoutCandidates.find((candidate) => candidate.layoutId === compiled.layoutId
    && candidate.sourcePart === compiled.layoutSourcePart);
  const titleEvidence = layout?.slotEvidence.title;
  const bodyEvidence = layout?.slotEvidence.body;
  const hasHighStructuralEvidence = Boolean(titleEvidence && bodyEvidence
    && titleEvidence.confidence >= MIN_EXEMPLAR_CONFIDENCE && bodyEvidence.confidence >= MIN_EXEMPLAR_CONFIDENCE);
  if (!hasHighStructuralEvidence && !semanticProfile) {
    return { selection: null, availableDistinctFamilies: 0, distinctSourceFamilyKeys: [], candidateDiagnostics: [], supportedCandidateCount: 0,
      evidence: ['high-confidence repeated title/body evidence is unavailable for the selected layout'] };
  }
  const profileByIndex = new Map(semanticProfile?.slides.map((slide) => [slide.sourceSlideIndex, slide]) ?? []);
  const attempts = template.slides.map((slide) => candidateFor(compiled, template, slide,
    hasHighStructuralEvidence ? titleEvidence! : null,
    hasHighStructuralEvidence ? bodyEvidence! : null,
    profileByIndex.get(slide.index)));
  const candidates = attempts.map((attempt) => attempt.candidate).filter((candidate): candidate is Candidate => candidate !== null);
  const compatible = semanticCandidates(candidates, compiled.intent);
  const compatibleCandidates = new Set(compatible);
  for (const candidate of candidates) candidate.diagnostic.roleCompatible = compatibleCandidates.has(candidate);
  const candidateDiagnostics = attempts.map((attempt) => attempt.diagnostic);
  const distinctSourceFamilyKeys = [...new Set(compatible.map((candidate) => candidate.selection.familyKey))].sort();
  const bySignature = new Map<string, Candidate>();
  for (const candidate of compatible.sort((left, right) => right.score - left.score
    || left.selection.projectedCompositionSignature.localeCompare(right.selection.projectedCompositionSignature)
    || left.selection.familyKey.localeCompare(right.selection.familyKey))) {
    if (!bySignature.has(candidate.selection.projectedCompositionSignature)) bySignature.set(candidate.selection.projectedCompositionSignature, candidate);
  }
  const families = [...bySignature.values()].sort((left, right) => right.score - left.score
    || left.selection.projectedCompositionSignature.localeCompare(right.selection.projectedCompositionSignature));
  const familyIndex = VARIANT_FAMILY_INDEX[compiled.variantId];
  const chosen = families[familyIndex];
  if (!chosen) return {
    selection: null,
    availableDistinctFamilies: families.length,
    distinctSourceFamilyKeys,
    candidateDiagnostics,
    supportedCandidateCount: compatible.length,
    evidence: [
      `availableDistinctFamilies=${families.length}`,
      `variant ${compiled.variantId} needs distinct rank ${familyIndex + 1}; no safe projected composition is available at that rank`,
      ...(families[0]?.selection.evidence ?? []),
    ],
  };
  const selectionReason = chosen.contentSafe
    ? `${chosen.selection.semanticArchetype} donor passed content-sanity gates and is distinct after projection`
    : `no safer supported content donor exists; used ${chosen.selection.semanticArchetype} as the remaining compatible path`;
  const selection: ExemplarSlideSelection = {
    ...chosen.selection,
    selectionReason,
    availableDistinctFamilies: families.length,
    evidence: [
      `availableDistinctFamilies=${families.length}`,
      ...chosen.selection.evidence,
      selectionReason,
      `selected projected composition rank ${familyIndex + 1} of ${families.length} distinct supported families for variant ${compiled.variantId}`,
    ],
  };
  return {
    selection,
    availableDistinctFamilies: families.length,
    distinctSourceFamilyKeys,
    candidateDiagnostics,
    supportedCandidateCount: compatible.length,
    evidence: selection.evidence,
  };
}

/** Select the safe post-projection family rank for this variant, or null if that distinct rank is unavailable. */
export function selectExemplarSlide(compiled: CompiledSlide, template: TemplateIR, semanticProfile?: TemplateSemanticProfile): ExemplarSlideSelection | null {
  return assessExemplarSelection(compiled, template, semanticProfile).selection;
}

/** Signature for the renderer's deterministic text/visual fallback when no safe exemplar rank exists. */
export function generatedFallbackCompositionSignature(compiled: CompiledSlide, template: TemplateIR): string {
  return fallbackCompositionSignature(compiled, template);
}

export interface VariantCompositionDistinctness {
  distinct: boolean;
  availableDistinctFamilies: number;
  signatures: string[];
  evidence: string[];
}

/** Check one planned slide across all three tracks before presenting them as A/B/C alternatives. */
export function assessVariantCompositionDistinctness(
  slides: readonly CompiledSlide[],
  template: TemplateIR,
  backend: 'custom' | 'office-kit',
  semanticProfile?: TemplateSemanticProfile,
): VariantCompositionDistinctness {
  const variants = ['A', 'B', 'C'];
  if (slides.length !== variants.length || variants.some((variant) => !slides.some((slide) => slide.variantId === variant))) {
    throw new TypeError('Variant composition assessment requires one compiled slide for each A/B/C track');
  }
  const ordered = variants.map((variant) => slides.find((slide) => slide.variantId === variant)!);
  if (new Set(ordered.map((slide) => slide.sourceDeckPlanSlideId)).size !== 1) {
    throw new TypeError('Variant composition assessment requires the same planned slide in A/B/C');
  }

  let signatures: string[];
  if (backend === 'custom') {
    signatures = ordered.map((slide) => generatedFallbackCompositionSignature(slide, template));
  } else {
    const assessments = ordered.map((slide) => assessExemplarSelection(slide, template, semanticProfile));
    const projected = ordered.map((slide, index) => {
      const selection = assessments[index]!.selection;
      if (selection) return selection.projectedCompositionSignature;
      if (nativePlaceholderFallbackSupported(slide, template)) return generatedFallbackCompositionSignature(slide, template);
      return null;
    });
    if (projected.some((item) => item === null)) return {
      distinct: false,
      availableDistinctFamilies: new Set(projected.filter((item): item is string => item !== null)).size,
      signatures: [],
      evidence: [
        `availableDistinctFamilies=${new Set(projected.filter((item): item is string => item !== null)).size}`,
        ...assessments.flatMap((assessment) => assessment.evidence).slice(0, 8),
        'A/B/C have duplicate projected compositions or no safe native title/body placeholder fallback for at least one variant.',
      ],
    };
    signatures = projected as string[];
  }

  const availableDistinctFamilies = new Set(signatures).size;
  const distinct = signatures.length === variants.length && availableDistinctFamilies === variants.length;
  return {
    distinct,
    availableDistinctFamilies,
    signatures,
    evidence: distinct
      ? ['A/B/C have three distinct projected composition signatures']
      : [`availableDistinctFamilies=${availableDistinctFamilies}; duplicate projected compositions are withheld`],
  };
}
