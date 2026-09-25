import { createHash } from 'node:crypto';

import type { CompiledSlide } from './slide-compilation.js';
import type { TemplateElement, TemplateGeometry, TemplateIR, TemplateSlide } from '../domain/template-ir.js';

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
  | 'visual-led';

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
    semanticArchetype: ExemplarArchetype;
    familyKey: string;
    projectedCompositionSignature: string;
    projectionSafe: boolean;
    contentSafe: boolean;
    roleCompatible: boolean;
    titleGeometryNormalized: NormalizedGeometry;
    bodyGeometryNormalized: NormalizedGeometry;
    titleBodyFontHierarchy: { titlePt: number; bodyPt: number; ratio: number };
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
  body: TemplateElement,
  preservedChromeIds: ReadonlySet<string>,
  template: TemplateIR,
): string {
  const keptTextIds = new Set([title.id, body.id, ...preservedChromeIds]);
  const projectedElements = slide.elements.filter((element) => {
    if (element.parentId !== null || element.id === title.id || element.id === body.id) return false;
    if (keptTextIds.has(element.id)) return true;
    if (normalizedText(element)) {
      // Text is cleared from source-specific boxes. Include only any directly styled box/line left visible.
      return hasVisibleDirectStyle(element);
    }
    return true;
  });
  const allProjectedElements = [...projectedElements, title, body].sort((left, right) => left.order - right.order);
  const relativeZOrder = new Map(allProjectedElements.map((element, index) => [element.id, index]));
  const retainedElements = projectedElements.map((element) => elementDescriptor(element, template, relativeZOrder.get(element.id)!));
  return signature({
    mappedText: {
      title: elementDescriptor(title, template, relativeZOrder.get(title.id)!),
      body: elementDescriptor(body, template, relativeZOrder.get(body.id)!),
    },
    retainedNativeElements: retainedElements,
  });
}

function fallbackCompositionSignature(compiled: CompiledSlide, template: TemplateIR): string {
  return signature({
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

function candidateFor(
  compiled: CompiledSlide,
  template: TemplateIR,
  slide: TemplateSlide,
  titleEvidence: NonNullable<CompiledSlide['layoutCandidates'][number]['slotEvidence']['title']>,
  bodyEvidence: NonNullable<CompiledSlide['layoutCandidates'][number]['slotEvidence']['body']>,
  preservedChromeIds: ReadonlySet<string>,
): Candidate | null {
  if (slide.layoutId !== compiled.layoutId || !slide.sourcePart || slide.elements.some((element) => element.parentId !== null)) return null;
  if (slide.relationships.some((relationship) => {
    const type = relationship.type.toLowerCase();
    return type.endsWith('/slide') || type.endsWith('/hyperlink');
  })) return null;
  if (visualKinds(slide).length) return null;

  const title = titleForSlide(slide, titleEvidence);
  const titleBox = title ? geometryOf(title) : null;
  if (!title || !title.nativeId || !titleBox) return null;
  const bodySamples = bodyEvidence.sourceEvidence.filter((item) => item.sourcePart === slide.sourcePart && item.slideIndex === slide.index);
  const bodyCandidates = bodySamples.map((sample) => slide.elements.find((element) => element.id === sample.elementId))
    .filter((element): element is TemplateElement => Boolean(element && element.id !== title.id && element.nativeId
      && element.kind.toLowerCase() === 'shape' && element.parentId === null && normalizedText(element)
      && geometryOf(element) && maxFont(element) >= 7.5 && maxFont(element) <= 24))
    .map((element) => ({
      element,
      overlap: overlapFraction(geometryOf(element)!, bodyEvidence.geometry),
      areaRatio: area(geometryOf(element)) / Math.max(1, area(bodyEvidence.geometry)),
    }))
    .filter((item) => item.overlap >= 0.65)
    .sort((left, right) => right.areaRatio - left.areaRatio || left.element.order - right.element.order);
  const selectedBody = bodyCandidates[0];
  if (!selectedBody || selectedBody.element.id === title.id) return null;
  const body = selectedBody.element;
  const bodyBox = geometryOf(body)!;
  const overlapArea = Math.max(0, Math.min(titleBox.x + titleBox.width, bodyBox.x + bodyBox.width) - Math.max(titleBox.x, bodyBox.x))
    * Math.max(0, Math.min(titleBox.y + titleBox.height, bodyBox.y + bodyBox.height) - Math.max(titleBox.y, bodyBox.y));
  if (overlapArea / Math.max(1, Math.min(area(titleBox), area(bodyBox))) > 0.08) return null;
  const textShapes = topLevelTextShapes(slide);
  if (textShapes.length < 2 || textShapes.some((element) => !element.nativeId)) return null;

  const titleSupport = titleEvidence.sourceEvidence.filter((item) => item.sourcePart === slide.sourcePart).length;
  const bodySupport = bodyEvidence.sourceEvidence.filter((item) => item.sourcePart === slide.sourcePart).length;
  const styleHierarchy = maxFont(title) > maxFont(body) ? 1 : 0.55;
  const geometryFit = selectedBody.overlap;
  const titleFit = estimatedLineFit(compiled.title, title);
  const bodyFit = estimatedLineFit(compiled.body.join('\n'), body);
  const contentFit = Math.min(titleFit, bodyFit);
  if (contentFit < 0.55) return null;
  const confidence = Number((0.36 * titleEvidence.confidence + 0.36 * bodyEvidence.confidence
    + 0.16 * geometryFit + 0.12 * styleHierarchy).toFixed(4));
  if (confidence < MIN_EXEMPLAR_CONFIDENCE) return null;

  const archetype = classifyStructuralArchetype(slide, template, title, body, preservedChromeIds);
  const titleAreaShare = archetype.titleAreaShare;
  const bodyAreaShare = archetype.bodyAreaShare;
  const bodyHeightShare = archetype.bodyHeightShare;
  const fontRatio = archetype.titleBodyFontRatio;
  const titleHeightShare = archetype.titleHeightShare;
  const sourceSpecificText = textShapes.filter((element) => element.id !== title.id && element.id !== body.id
    && !preservedChromeIds.has(element.id));
  const majorTextToClear = sourceSpecificText.filter((element) => {
    const box = geometryOf(element);
    return Boolean(box && (area(box) / Math.max(1, template.slideSize.width * template.slideSize.height) >= 0.055
      || (maxFont(element) >= 20 && area(box) / Math.max(1, template.slideSize.width * template.slideSize.height) >= 0.012)));
  }).length;
  const bodyFontPt = Math.max(8, maxFont(body));
  const bodyWidthPt = bodyBox.width / 12700;
  const bodyHeightPt = bodyBox.height / 12700;
  const bodyCharsPerLine = Math.max(6, bodyWidthPt / (bodyFontPt * 0.52));
  const projectedLines = Math.max(1, compiled.body.join('\n').split(/\r?\n/)
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(Array.from(line).length / bodyCharsPerLine)), 0));
  const bodyLineCapacity = Math.max(0.25, bodyHeightPt / (bodyFontPt * 1.2));
  const textDensity = Number(Math.min(1, projectedLines / bodyLineCapacity).toFixed(4));
  const contentGateReasons: string[] = [];
  if (titleHeightShare > 0.22) contentGateReasons.push('title consumes too much vertical space for a content slide');
  if (titleAreaShare > 0.14) contentGateReasons.push('title occupies excessive canvas area for a content slide');
  if (bodyAreaShare < 0.06 || bodyHeightShare < 0.09) contentGateReasons.push('body donor region is too small to carry content');
  if (fontRatio > 2.2 && bodyAreaShare < 0.12) contentGateReasons.push('title/body typography ratio leaves a small body region visually subordinate');
  if (majorTextToClear > 0) contentGateReasons.push(`${majorTextToClear} major source-specific text region(s) would be erased outside the mapped body`);
  if (textDensity < 0.08 && bodyAreaShare > 0.3) contentGateReasons.push('projected text is sparse for the large donor body region');
  const projectionSafe = majorTextToClear === 0;
  const contentSafe = projectionSafe && contentGateReasons.length === 0
    && ['content', 'content-dense'].includes(archetype.archetype);

  const confidenceScore = 0.32 * confidence + 0.23 * geometryFit + 0.15 * styleHierarchy + 0.3 * contentFit;
  const semanticBoost = compiled.intent === 'title'
    ? archetype.archetype === 'cover' ? 0.16 : archetype.archetype === 'hero' ? 0.1 : 0
    : compiled.intent === 'section'
      ? ['section-divider', 'hero'].includes(archetype.archetype) ? 0.16 : 0
      : ['content', 'content-dense'].includes(archetype.archetype) ? 0.12 : -0.12;
  const score = confidenceScore + semanticBoost - Math.min(0.25, contentGateReasons.length * 0.1)
    - (textDensity < 0.08 && bodyAreaShare > 0.3 ? 0.12 : 0);
  const clearElementNativeIds = sourceSpecificText.map((element) => element.nativeId!);
  const preserveChromeNativeIds = textShapes.filter((element) => preservedChromeIds.has(element.id)
    && element.id !== title.id && element.id !== body.id).map((element) => element.nativeId!);
  const evidence = [
    `title donor repeats across ${titleEvidence.sampleCount} slides in the selected layout`,
    `body donor region repeats across ${bodyEvidence.sampleCount} slides in the selected layout`,
    `mapped body shape overlaps ${Math.round(geometryFit * 100)}% of its inferred body region`,
    `title/body font hierarchy ${maxFont(title)}pt > ${maxFont(body)}pt`,
    `approximate text-height fit title=${titleFit} body=${bodyFit}; visual preview remains required`,
    ...archetype.evidence,
    `projected body density estimate ${textDensity.toFixed(3)}`,
    ...contentGateReasons.map((reason) => `content-sanity gate: ${reason}`),
    `${textShapes.length} text shapes inspected; ${clearElementNativeIds.length} source-specific shapes will be cleared`,
    `${slide.elements.filter((element) => element.kind.toLowerCase() === 'connector').length} native connectors and ${slide.elements.filter((element) => element.kind.toLowerCase() === 'shape' && !normalizedText(element)).length} unlabelled shapes retained`,
    `${titleSupport} title evidence records and ${bodySupport} body evidence records refer to this source slide`,
  ];
  const titleNormalized = normalizedGeometry(titleBox, template);
  const bodyNormalized = normalizedGeometry(bodyBox, template);
  return {
    score,
    projectionSafe,
    contentSafe,
    selectionReason: contentSafe
      ? 'structural content archetype passed the normalized content-sanity gates'
      : 'structural role is less compatible with this slide intent or a content-sanity gate did not pass',
    selection: {
      sourceSlideIndex: slide.index,
      sourcePart: slide.sourcePart,
      layoutId: slide.layoutId!,
      semanticArchetype: archetype.archetype,
      role: compiled.intent,
      confidence,
      slots: {
        title: { elementId: title.id, nativeId: title.nativeId },
        body: { elementId: body.id, nativeId: body.nativeId! },
        visual: null,
      },
      clearElementNativeIds,
      preserveChromeNativeIds,
      familyKey: familyKey(slide, title, body, template),
      projectedCompositionSignature: projectedCompositionSignature(slide, title, body, preservedChromeIds, template),
      titleGeometryNormalized: titleNormalized,
      bodyGeometryNormalized: bodyNormalized,
      titleBodyFontHierarchy: { titlePt: maxFont(title), bodyPt: maxFont(body), ratio: Number(fontRatio.toFixed(3)) },
      selectionReason: '',
      evidence,
      limitations: ['The compiled text body is projected into one donor text shape; richer multi-slot narrative mapping is not inferred.'],
    },
  };
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

/**
 * Inspect donor choices and return explicit distinct-family evidence even when the requested rank is unavailable.
 * A/B/C are deduplicated after text replacement, source-text cleanup, chrome retention, and note removal.
 */
export function assessExemplarSelection(compiled: CompiledSlide, template: TemplateIR): ExemplarSelectionAssessment {
  if (compiled.visualization.type !== 'none' || compiled.visualization.status !== 'none' || compiled.imageRefs.length) {
    return { selection: null, availableDistinctFamilies: 0, distinctSourceFamilyKeys: [], candidateDiagnostics: [], supportedCandidateCount: 0,
      evidence: ['compiled slide has a requested visual or image; this one-body exemplar selector is not compatible'] };
  }
  const layout = compiled.layoutCandidates.find((candidate) => candidate.layoutId === compiled.layoutId
    && candidate.sourcePart === compiled.layoutSourcePart);
  const titleEvidence = layout?.slotEvidence.title;
  const bodyEvidence = layout?.slotEvidence.body;
  if (!titleEvidence || !bodyEvidence || titleEvidence.confidence < MIN_EXEMPLAR_CONFIDENCE
      || bodyEvidence.confidence < MIN_EXEMPLAR_CONFIDENCE) {
    return { selection: null, availableDistinctFamilies: 0, distinctSourceFamilyKeys: [], candidateDiagnostics: [], supportedCandidateCount: 0,
      evidence: ['high-confidence repeated title/body evidence is unavailable for the selected layout'] };
  }
  const chrome = chromeIds(template, layout.layoutId);
  const candidates = template.slides.map((slide) => candidateFor(compiled, template, slide, titleEvidence, bodyEvidence, chrome))
    .filter((candidate): candidate is Candidate => candidate !== null);
  const compatible = semanticCandidates(candidates, compiled.intent);
  const compatibleCandidates = new Set(compatible);
  const candidateDiagnostics = candidates.map((candidate) => ({
    sourceSlideIndex: candidate.selection.sourceSlideIndex,
    semanticArchetype: candidate.selection.semanticArchetype,
    familyKey: candidate.selection.familyKey,
    projectedCompositionSignature: candidate.selection.projectedCompositionSignature,
    projectionSafe: candidate.projectionSafe,
    contentSafe: candidate.contentSafe,
    roleCompatible: compatibleCandidates.has(candidate),
    titleGeometryNormalized: candidate.selection.titleGeometryNormalized,
    bodyGeometryNormalized: candidate.selection.bodyGeometryNormalized,
    titleBodyFontHierarchy: candidate.selection.titleBodyFontHierarchy,
    evidence: candidate.selection.evidence,
  }));
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
export function selectExemplarSlide(compiled: CompiledSlide, template: TemplateIR): ExemplarSlideSelection | null {
  return assessExemplarSelection(compiled, template).selection;
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
    const assessments = ordered.map((slide) => assessExemplarSelection(slide, template));
    const selections = assessments.map((assessment) => assessment.selection);
    if (selections.every((selection) => selection !== null)) {
      signatures = selections.map((selection) => selection!.projectedCompositionSignature);
    } else if (selections.every((selection) => selection === null)) {
      signatures = ordered.map((slide) => generatedFallbackCompositionSignature(slide, template));
    } else {
      const compatibleSignatureSets = assessments.map((assessment) => new Set(assessment.candidateDiagnostics
        .filter((candidate) => candidate.roleCompatible && candidate.projectionSafe)
        .map((candidate) => candidate.projectedCompositionSignature)));
      const sharedSignatures = compatibleSignatureSets.slice(1).reduce((shared, current) => new Set([...shared].filter((item) => current.has(item))), compatibleSignatureSets[0]!);
      const availableDistinctFamilies = sharedSignatures.size;
      return {
        distinct: false,
        availableDistinctFamilies,
        signatures: [],
        evidence: [
          `availableDistinctFamilies=${availableDistinctFamilies}`,
          'A/B/C mix exemplar projections and generated fallback layouts; distinctness cannot be established across these projection paths',
        ],
      };
    }
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
