import { createHash } from 'node:crypto';
import type { PerformanceDiagnosticsPort } from '../performance-diagnostics.js';

import type { CompiledSlide, CompatibleLayoutMatchCandidate } from './slide-compilation.js';
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
    visual: { elementId: string; nativeId: string; geometry: TemplateGeometry; kind: string } | null;
  };
  /** Exclusive, ordered ranges of bounded natural text fragments assigned to matching bodySlots. */
  bodyContentRanges: Array<{ start: number; end: number }>;
  /** Exact source text assigned to each body region; concatenating preserves CompiledSlide.body.join('\\n'). */
  bodyContentSegments: string[];
  bodySegmentation: {
    method: 'existing-blocks' | 'paragraphs' | 'sentences' | 'mixed';
    sourceTextSha256: string;
    sourceBodyBlockCount: number;
    fragmentCount: number;
    regionCount: number;
  };
  textProjection: {
    preserved: string[];
    replaced: string[];
    cleared: string[];
    blocked: string[];
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
  /** Every distinct candidate that passed all hard projection and geometry gates, ranked deterministically. */
  safeSelections: ExemplarSlideSelection[];
  availableDistinctFamilies: number;
  distinctSourceFamilyKeys: string[];
  candidateDiagnostics: Array<{
    sourceSlideIndex: number;
    structuralArchetype: ExemplarArchetype | null;
    semanticArchetype: ExemplarArchetype | null;
    semanticConfidence: number | null;
    titleElementId: string | null;
    bodyElementIds: string[];
    bodyMappingOptionIndex: number;
    bodyMappingOptionCount: number;
    bodyRegionCount: number;
    bodySegmentation: ExemplarSlideSelection['bodySegmentation'] | null;
    projectedFit: { title: number | null; body: number | null; combined: number | null };
    sourceResidueRisk: 'unassessed' | 'clear' | 'ambiguous' | 'source-specific';
    visualElementIds: string[];
    visualClassification: string[];
    preservedTextElementIds: string[];
    replacedTextElementIds: string[];
    clearedTextElementIds: string[];
    blockedTextElementIds: string[];
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

export interface VariantCompositionAssignment {
  variantId: CompiledSlide['variantId'];
  compositionKind: 'exemplar-backed' | 'layout-placeholder-backed' | 'safe-generated-fallback';
  layoutCandidateIndex: number;
  projectedCompositionSignature: string;
  /** Present for exemplar-backed choices so the renderer can honor the joint assignment exactly. */
  exemplarSelection?: ExemplarSlideSelection;
}

/** Minimal persisted identity for an exact exemplar choice; content is recomputed from the current plan. */
export interface ExemplarSelectionReference {
  sourcePart: string;
  sourceSlideIndex: number;
  projectedCompositionSignature: string;
}

export function exemplarSelectionReference(selection: ExemplarSlideSelection | undefined): ExemplarSelectionReference | null {
  return selection ? {
    sourcePart: selection.sourcePart,
    sourceSlideIndex: selection.sourceSlideIndex,
    projectedCompositionSignature: selection.projectedCompositionSignature,
  } : null;
}

/** Restore and revalidate an exact persisted donor instead of silently choosing a new ranked donor. */
export function applyPersistedExemplarSelection(
  compiled: CompiledSlide,
  reference: ExemplarSelectionReference,
  template: TemplateIR,
  semanticProfile?: TemplateSemanticProfile,
): CompiledSlide {
  const assessment = assessExemplarSelection(compiled, template, semanticProfile);
  const selection = assessment.safeSelections.find((candidate) => candidate.sourcePart === reference.sourcePart
    && candidate.sourceSlideIndex === reference.sourceSlideIndex
    && candidate.projectedCompositionSignature === reference.projectedCompositionSignature);
  if (!selection) throw new TypeError('Persisted exemplar choice no longer passes the current projection gates');
  return applyVariantCompositionAssignment(compiled, {
    variantId: compiled.variantId,
    compositionKind: 'exemplar-backed',
    layoutCandidateIndex: compiled.selectedCandidateIndex,
    projectedCompositionSignature: selection.projectedCompositionSignature,
    exemplarSelection: selection,
  }, template, semanticProfile);
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

function inheritedStaticText(template: TemplateIR, layoutId: string | null | undefined, masterId?: string | null): TemplateElement[] {
  const layout = layoutId ? template.layouts.find((item) => item.id === layoutId) : null;
  const master = template.masters.find((item) => item.id === (layout?.masterId ?? masterId));
  return [...(layout?.elements ?? []), ...(master?.elements ?? [])]
    .filter((element) => element.placeholder === null && normalizedText(element).length > 0);
}

function topLevelTextShapes(slide: TemplateSlide): TemplateElement[] {
  return slide.elements.filter((element) => element.kind.toLowerCase() === 'shape' && Boolean(normalizedText(element)));
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
  return slide.elements.filter((element) => {
    const kind = element.kind.toLowerCase().replaceAll('_', '').replaceAll('-', '');
    const placeholder = `${element.placeholder?.type ?? ''} ${element.placeholder?.role ?? ''}`.toLowerCase();
    return ['picture', 'image', 'table', 'chart', 'graphicframe', 'group'].includes(kind)
      || /picture|image|chart|table|graphic/.test(placeholder);
  });
}

type VisualSafetyKind = 'template-decoration' | 'content-slot' | 'source-specific-content' | 'opaque-unsafe';

export interface VisualSafetyClassification {
  elementId: string;
  kind: VisualSafetyKind;
  reason: string;
}

/** Generation-scoped memoization of immutable template/profile visual safety evidence. */
export interface CompositionVisualClassificationCache {
  readonly classifications: Map<string, VisualSafetyClassification[]>;
}

export function createCompositionVisualClassificationCache(): CompositionVisualClassificationCache {
  return { classifications: new Map() };
}

function supportedNestedElements(slide: TemplateSlide): boolean {
  const byId = new Map(slide.elements.map((element) => [element.id, element]));
  const supportedKinds = new Set(['shape', 'connector', 'picture', 'image', 'table', 'chart', 'graphicframe', 'group']);
  for (const element of slide.elements) {
    if (!supportedKinds.has(element.kind.toLowerCase().replaceAll('_', '').replaceAll('-', ''))) return false;
    if (element.parentId === null) continue;
    let parentId: string | null = element.parentId;
    let depth = 0;
    while (parentId) {
      const parent = byId.get(parentId);
      if (!parent || parent.kind.toLowerCase().replaceAll('_', '').replaceAll('-', '') !== 'group' || ++depth > 4) return false;
      parentId = parent.parentId;
    }
    if (!element.nativeId || (normalizedText(element) && !geometryOf(element))) return false;
  }
  return true;
}

function visualClassification(
  slide: TemplateSlide,
  template: TemplateIR,
  profileVisualIds: readonly string[] = [],
): VisualSafetyClassification[] {
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
  const visualIds = new Set(profileVisualIds);
  const candidates = slide.elements.filter((element) => {
    const kind = element.kind.toLowerCase().replaceAll('_', '').replaceAll('-', '');
    return visualKinds({ ...slide, elements: [element] }).length > 0
      || (['shape', 'connector'].includes(kind) && !normalizedText(element));
  });
  return candidates.map((element) => {
    const box = geometryOf(element);
    const kind = element.kind.toLowerCase().replaceAll('_', '').replaceAll('-', '');
    const relationships = element.relationshipIds.length;
    const placeholderType = `${element.placeholder?.type ?? ''} ${element.placeholder?.role ?? ''}`.toLowerCase();
    const isVisualPlaceholder = /picture|image|chart|table|graphic/.test(placeholderType);
    if (kind === 'group') {
      return supportedNestedElements(slide)
        ? { elementId: element.id, kind: 'template-decoration', reason: 'recognized Office Kit group is preserved; children are classified separately' }
        : { elementId: element.id, kind: 'opaque-unsafe', reason: 'group contains unsupported or unresolved child geometry' };
    }
    if (isVisualPlaceholder && !relationships) {
      return { elementId: element.id, kind: 'content-slot', reason: 'native visual placeholder has no source relationship to preserve' };
    }
    if (kind === 'picture' || kind === 'image') {
      if (!box || !relationships) return { elementId: element.id, kind: 'opaque-unsafe', reason: 'picture geometry or package relationship is unresolved' };
      const smallPicture = area(box) / canvasArea <= 0.04;
      const repeated = occurrences(element);
      const minimum = Math.max(2, Math.ceil(family.length * 0.8));
      if (smallPicture && family.length >= 2 && repeated >= minimum) {
        return { elementId: element.id, kind: 'template-decoration', reason: 'small picture and its relationship recur at the same geometry across the layout family' };
      }
      return { elementId: element.id, kind: 'source-specific-content', reason: 'picture is tied to a source relationship and is not proven recurring template decoration' };
    }
    if (['table', 'chart', 'graphicframe'].includes(kind)) {
      return relationships || !isVisualPlaceholder
        ? { elementId: element.id, kind: 'source-specific-content', reason: `${kind} carries source data or an unresolved visual relationship` }
        : { elementId: element.id, kind: 'content-slot', reason: `empty native ${kind} placeholder` };
    }
    const smallPicture = ['picture', 'image'].includes(kind) && box !== null && area(box) / canvasArea <= 0.04;
    const repeated = occurrences(element);
    const minimum = Math.max(2, Math.ceil(family.length * 0.8));
    if (['shape', 'connector'].includes(kind)) {
      if (!box || relationships) return { elementId: element.id, kind: 'opaque-unsafe', reason: 'native vector object geometry or relationship is unresolved' };
      if (family.length >= 2 && repeated >= minimum && area(box) / canvasArea <= 0.04) {
        return { elementId: element.id, kind: 'template-decoration', reason: 'small native vector decoration recurs with the same geometry and style in the layout family' };
      }
      if (element.placeholder || visualIds.has(element.id)) return { elementId: element.id, kind: 'content-slot', reason: 'native placeholder or semantic visual slot has no source relationship' };
      if (family.length >= 2 && repeated >= minimum) return { elementId: element.id, kind: 'template-decoration', reason: 'native vector decoration recurs with the same geometry and style in the layout family' };
      return { elementId: element.id, kind: 'opaque-unsafe', reason: 'one-off vector object is not proven to be reusable template decoration' };
    }
    if (smallPicture && family.length >= 2 && repeated >= minimum) return { elementId: element.id, kind: 'template-decoration', reason: 'small visual object recurs in the layout family' };
    return { elementId: element.id, kind: 'opaque-unsafe', reason: `unrecognized native visual kind ${element.kind}` };
  });
}

function cachedVisualClassification(
  slide: TemplateSlide,
  template: TemplateIR,
  profileVisualIds: readonly string[],
  cache: CompositionVisualClassificationCache | undefined,
  diagnostics: PerformanceDiagnosticsPort | undefined,
): VisualSafetyClassification[] {
  if (!cache) return visualClassification(slide, template, profileVisualIds);
  const key = JSON.stringify([template.hash, slide.sourcePart, slide.index, profileVisualIds]);
  const existing = cache.classifications.get(key);
  if (existing) {
    diagnostics?.increment('composition.visualClassificationCacheHit');
    return existing;
  }
  diagnostics?.increment('composition.visualClassificationCacheMiss');
  const startedAt = performance.now();
  const result = visualClassification(slide, template, profileVisualIds);
  diagnostics?.recordDuration('composition.visualClassification', performance.now() - startedAt);
  cache.classifications.set(key, result);
  return result;
}

function classifyStructuralArchetype(
  slide: TemplateSlide,
  template: TemplateIR,
  title: TemplateElement,
  bodyInput: TemplateElement | readonly TemplateElement[],
  preservedChromeIds: ReadonlySet<string>,
): ExemplarArchetypeAssessment {
  const bodies = Array.isArray(bodyInput) ? bodyInput : [bodyInput];
  const titleBox = geometryOf(title)!;
  const bodyBoxes = bodies.map((body) => geometryOf(body)!);
  const bodyBox = bodyBoxes[0]!;
  const canvasArea = Math.max(1, template.slideSize.width * template.slideSize.height);
  const titleAreaShare = area(titleBox) / canvasArea;
  const titleHeightShare = titleBox.height / template.slideSize.height;
  const bodyAreaShare = Math.min(1, bodyBoxes.reduce((sum, box) => sum + area(box), 0) / canvasArea);
  const bodyHeightShare = (Math.max(...bodyBoxes.map((box) => box.y + box.height)!) - Math.min(...bodyBoxes.map((box) => box.y))) / template.slideSize.height;
  const titleBodyFontRatio = maxFont(title) / Math.max(1, ...bodies.map(maxFont));
  const textShapes = topLevelTextShapes(slide);
  const majorText = textShapes.filter((element) => {
    const box = geometryOf(element);
    return Boolean(box && (area(box) / canvasArea >= 0.018 || maxFont(element) >= 20));
  });
  const bodyIds = new Set(bodies.map((body) => body.id));
  const secondaryMajor = majorText.filter((element) => element.id !== title.id && !bodyIds.has(element.id)
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
  const mappedBodyCenterX = bodyBoxes.reduce((sum, box) => sum + box.x + box.width / 2, 0) / bodyBoxes.length;
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
  else if (heroTypography && titleBodyFontRatio >= 3.6 && Math.max(...bodies.map(maxFont)) <= 10) archetype = 'hero';
  else if (heroTypography && bodyAreaShare < 0.045 && majorText.length <= 2) archetype = 'section-divider';
  else if (heroTypography && (majorTextShare > 0.11 || majorText.length >= 3)) archetype = 'cover';
  else if (heroTypography) archetype = 'hero';
  else if (secondaryMajor.length >= 3 || (majorText.length >= 5 && majorTextShare > 0.2)) archetype = 'content-dense';

  const evidence = [
    `title occupies ${(titleAreaShare * 100).toFixed(1)}% of the canvas and ${(titleHeightShare * 100).toFixed(1)}% of its height`,
    `mapped body occupies ${(bodyAreaShare * 100).toFixed(1)}% of the canvas and ${(bodyHeightShare * 100).toFixed(1)}% of slide height; title/body font ratio is ${titleBodyFontRatio.toFixed(2)}`,
    `${bodies.length} mapped body region(s); ${majorText.length} major text regions, ${secondaryMajor.length} additional non-chrome text regions, and ${(visualAreaShare * 100).toFixed(1)}% unlabelled/visual object area`,
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
  bodyHasContent: boolean,
  preservedChromeIds: ReadonlySet<string>,
  template: TemplateIR,
  visualSlot: TemplateElement | null,
): string {
  // When there is no body copy, choosing different empty text regions does not
  // change the rendered slide: the entire donor remains, with source text cleared.
  // Do not let an empty-region mapping manufacture A/B/C visual distinctness.
  const projectedBodies = bodyHasContent ? bodies : [];
  const bodyIds = new Set(projectedBodies.map((body) => body.id));
  const mappedVisualId = visualSlot?.id ?? null;
  const keptTextIds = new Set([title.id, ...bodyIds, ...preservedChromeIds]);
  const projectedElements = slide.elements.filter((element) => {
    if (element.id === title.id || bodyIds.has(element.id) || element.id === mappedVisualId) return false;
    if (keptTextIds.has(element.id)) return true;
    if (normalizedText(element)) {
      // Text is cleared from source-specific boxes. Include only any directly styled box/line left visible.
      return hasVisibleDirectStyle(element);
    }
    return true;
  });
  const allProjectedElements = [...projectedElements, title, ...projectedBodies, ...(visualSlot ? [visualSlot] : [])].sort((left, right) => left.order - right.order);
  const relativeZOrder = new Map(allProjectedElements.map((element, index) => [element.id, index]));
  const retainedElements = projectedElements.map((element) => elementDescriptor(element, template, relativeZOrder.get(element.id)!));
  return signature({
    mappedText: {
      title: elementDescriptor(title, template, relativeZOrder.get(title.id)!),
      body: projectedBodies.map((body) => elementDescriptor(body, template, relativeZOrder.get(body.id)!)),
    },
    mappedVisualSlot: visualSlot ? elementDescriptor(visualSlot, template, relativeZOrder.get(visualSlot.id)!) : null,
    retainedNativeElements: retainedElements,
  });
}

function hasRenderableVisual(compiled: CompiledSlide): boolean {
  return Boolean(compiled.visualization.tableData || compiled.visualization.chartData || compiled.visualization.kpi
    || compiled.visualization.processSteps.length >= 2 || compiled.imageRefs.length > 0);
}

function fallbackCompositionSignature(compiled: CompiledSlide, template: TemplateIR): string {
  const layout = template.layouts.find((item) => item.id === compiled.layoutId
    && item.sourcePart === compiled.layoutSourcePart);
  const master = layout?.masterId ? template.masters.find((item) => item.id === layout.masterId) : null;
  return signature({
    layoutBackground: layout?.background ?? null,
    masterBackground: master?.background ?? null,
    nativeLayout: layout?.elements.map((element) => elementDescriptor(element, template)) ?? [],
    nativeMaster: master?.elements.map((element) => elementDescriptor(element, template)) ?? [],
    // Title/body are filled into exact native placeholders. Compiled placement estimates can
    // differ by a few EMUs across policies even though Office Kit selects the same placeholders;
    // they must not manufacture a distinct composition signature.
    generatedVisual: compiled.placements.visual
      ? normalizedGeometry({ ...compiled.placements.visual, rotation: 0, unit: 'EMU' }, template)
      : null,
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

interface BodySlotsChoice {
  elements: TemplateElement[];
  ranges: Array<{ start: number; end: number }>;
  fits: number[];
  segments: string[];
  segmentation: ExemplarSlideSelection['bodySegmentation'];
}

function bodySlotsFor(
  candidates: TemplateElement[],
  compiled: CompiledSlide,
  allowMultiple: boolean,
  diagnostics?: PerformanceDiagnosticsPort,
): BodySlotsChoice[] {
  const startedAt = performance.now();
  diagnostics?.increment('composition.bodySlotSearchCount');
  if (!candidates.length) return [];
  const sourceText = compiled.body.join('\n');
  const boundaryPattern = /(?:\r?\n)+|(?<=[.!?])(?=\s|$)/gu;
  const fragments: string[] = [];
  let cursor = 0;
  let usedSentenceBoundary = false;
  let usedParagraphBoundary = false;
  for (const match of sourceText.matchAll(boundaryPattern)) {
    const index = match.index ?? 0;
    const boundary = match[0];
    const end = index + boundary.length;
    if (end <= cursor) continue;
    fragments.push(sourceText.slice(cursor, end));
    cursor = end;
    if (/\n/.test(boundary)) usedParagraphBoundary = true;
    else usedSentenceBoundary = true;
  }
  if (cursor < sourceText.length || fragments.length === 0) fragments.push(sourceText.slice(cursor));
  // Keep search bounded even for pasted documents with thousands of sentences.
  const boundedFragments = fragments.length <= 64 ? fragments : [sourceText];
  const segmentationMethod = boundedFragments.length > compiled.body.length
    ? usedParagraphBoundary && usedSentenceBoundary ? 'mixed' : usedParagraphBoundary ? 'paragraphs' : 'sentences'
    : 'existing-blocks';
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
    if (available.length >= (allowMultiple ? 4 : 1)) break;
  }
  const elements = available.sort((left, right) => geometryOf(left)!.y - geometryOf(right)!.y
    || geometryOf(left)!.x - geometryOf(right)!.x || left.order - right.order);
  // Splitting a single Worker block is permitted only with trusted, explicit
  // multi-region semantics. Sentence/paragraph boundaries remain intact and
  // every resulting segment is independently fit-checked below.
  const maxCount = Math.min(elements.length, boundedFragments.length);
  const choices: BodySlotsChoice[] = [];
  for (let count = maxCount; count >= 1; count -= 1) {
    const combinations: TemplateElement[][] = [];
    const chosen: TemplateElement[] = [];
    const visit = (start: number): void => {
      if (chosen.length === count) { combinations.push([...chosen]); return; }
      for (let index = start; index <= elements.length - (count - chosen.length); index += 1) {
        chosen.push(elements[index]!);
        visit(index + 1);
        chosen.pop();
      }
    };
    visit(0);
    for (const selected of combinations) {
      const blocks = boundedFragments;
      const capacities = selected.map((element) => {
        const box = geometryOf(element)!;
        const font = Math.max(8, maxFont(element));
        return Math.max(0.25, (box.width / 12700) / (font * 0.52) * (box.height / 12700) / (font * 1.2));
      });
      const demandFor = (text: string, element: TemplateElement) => {
        const box = geometryOf(element)!;
        const font = Math.max(8, maxFont(element));
        const charsPerLine = Math.max(6, (box.width / 12700) / (font * 0.52));
        return Math.max(1, text.split(/\r?\n/).reduce((sum, line) => sum + Math.max(1, Math.ceil(Array.from(line).length / charsPerLine)), 0));
      };
      type Partition = { cost: number; ranges: Array<{ start: number; end: number }>; fits: number[] };
      const dp: Array<Array<Partition | null>> = Array.from({ length: count + 1 }, () => Array(blocks.length + 1).fill(null));
      dp[0]![0] = { cost: 0, ranges: [], fits: [] };
      for (let regionIndex = 0; regionIndex < count; regionIndex += 1) {
        for (let end = regionIndex + 1; end <= blocks.length; end += 1) {
          for (let start = regionIndex; start < end; start += 1) {
            const previous = dp[regionIndex]![start];
            if (!previous) continue;
            const text = blocks.slice(start, end).join('');
            const fit = estimatedLineFit(text, selected[regionIndex]!);
            if (fit < 0.55) continue;
            const utilization = demandFor(text, selected[regionIndex]!) / capacities[regionIndex]!;
            const next: Partition = {
              cost: previous.cost + utilization * utilization,
              ranges: [...previous.ranges, { start, end }],
              fits: [...previous.fits, fit],
            };
            const current = dp[regionIndex + 1]![end];
            if (!current || next.cost < current.cost - 1e-9) dp[regionIndex + 1]![end] = next;
          }
        }
      }
      const assignment = dp[count]![blocks.length];
      if (assignment && assignment.ranges.every((range) => range.end > range.start)) {
        choices.push({
          elements: selected,
          ranges: assignment.ranges,
          fits: assignment.fits,
          segments: assignment.ranges.map((range) => blocks.slice(range.start, range.end).join('')),
          segmentation: {
            method: segmentationMethod,
            sourceTextSha256: createHash('sha256').update(sourceText).digest('hex'),
            sourceBodyBlockCount: compiled.body.length,
            fragmentCount: blocks.length,
            regionCount: selected.length,
          },
        });
      }
    }
  }
  diagnostics?.recordDuration('composition.bodySlotSearch', performance.now() - startedAt);
  diagnostics?.increment('composition.bodySlotChoiceCount', choices.length);
  return choices;
}

function candidateFor(
  compiled: CompiledSlide,
  template: TemplateIR,
  slide: TemplateSlide,
  titleEvidence: NonNullable<CompiledSlide['layoutCandidates'][number]['slotEvidence']['title']> | null,
  bodyEvidence: NonNullable<CompiledSlide['layoutCandidates'][number]['slotEvidence']['body']> | null,
  profileSlide: TemplateSemanticSlideProfile | undefined,
  bodyMappingOptionIndex = 0,
  diagnostics?: PerformanceDiagnosticsPort,
  visualClassificationCache?: CompositionVisualClassificationCache,
): CandidateBuild {
  const startedAt = performance.now();
  diagnostics?.increment('composition.candidateBuildCount');
  const trustedProfile = profileSlide && profileSlide.confidence >= 0.6 ? profileSlide : null;
  const preservedChromeIds = chromeIds(template, slide.layoutId ?? '');
  const visualClasses = cachedVisualClassification(slide, template, trustedProfile?.visualElementIds ?? [], visualClassificationCache, diagnostics);
  const visualElementIds = trustedProfile?.visualElementIds ?? visualClasses.map((item) => item.elementId);
  const diagnostic: CandidateDiagnostic = {
    sourceSlideIndex: slide.index,
    structuralArchetype: null,
    semanticArchetype: trustedProfile?.archetype ?? null,
    semanticConfidence: profileSlide?.confidence ?? null,
    titleElementId: trustedProfile?.titleElementId ?? null,
    bodyElementIds: trustedProfile?.bodyElementIds ?? [],
    bodyMappingOptionIndex,
    bodyMappingOptionCount: 0,
    bodyRegionCount: 0,
    bodySegmentation: null,
    projectedFit: { title: null, body: null, combined: null },
    sourceResidueRisk: 'unassessed',
    visualElementIds,
    visualClassification: visualClasses.map((item) => `${item.elementId}:${item.kind}:${item.reason}`),
    preservedTextElementIds: [], replacedTextElementIds: [], clearedTextElementIds: [], blockedTextElementIds: [],
    gate: 'candidate-filter', rejectReason: null, familyKey: null, projectedCompositionSignature: null,
    projectionSafe: null, contentSafe: null, roleCompatible: false,
    titleGeometryNormalized: null, bodyGeometryNormalized: null, titleBodyFontHierarchy: null, evidence: [],
  };
  const reject = (gate: string, reason: string): CandidateBuild => {
    diagnostics?.recordDuration('composition.candidateBuild', performance.now() - startedAt);
    diagnostic.gate = gate;
    diagnostic.rejectReason = reason;
    diagnostic.evidence = [reason];
    return { candidate: null, diagnostic };
  };
  if (!slide.sourcePart) return reject('source-part', 'source slide part is missing');
  const inheritedText = inheritedStaticText(template, slide.layoutId, slide.masterId);
  if (inheritedText.length) {
    diagnostic.sourceResidueRisk = 'ambiguous';
    return reject('inherited-source-text',
      `${inheritedText.length} non-placeholder text element(s) inherited from the layout/master cannot be proven to be template chrome; projection is withheld`);
  }
  if (slide.layoutId !== compiled.layoutId && !trustedProfile) return reject('layout-match', `donor layout ${slide.layoutId ?? 'null'} differs from compiled layout ${compiled.layoutId}; no trusted semantic role mapping`);
  if (!supportedNestedElements(slide)) return reject('opaque-unsafe', 'nested/grouped elements contain unsupported kinds, unresolved native IDs, or unsafe ancestry');
  if (slide.relationships.some((relationship) => {
    const type = relationship.type.toLowerCase();
    return type.endsWith('/slide') || type.endsWith('/hyperlink');
  })) return reject('relationships', 'slide/hyperlink relationship is unsafe');
  const unsafeVisuals = visualClasses.filter((item) => item.kind === 'source-specific-content' || item.kind === 'opaque-unsafe');
  if (unsafeVisuals.length) {
    diagnostic.sourceResidueRisk = 'source-specific';
    return reject('visual-safety', `source-specific content or opaque native visuals are unsafe to preserve: ${unsafeVisuals.map((item) => `${item.elementId} (${item.kind})`).join(',')}`);
  }

  const profileTitle = trustedProfile?.titleElementId
    ? slide.elements.find((element) => element.id === trustedProfile.titleElementId) : null;
  const profileTitleUsable = Boolean(profileTitle && profileTitle.nativeId && geometryOf(profileTitle)
    && profileTitle.kind.toLowerCase() === 'shape' && normalizedText(profileTitle));
  const title = profileTitleUsable ? profileTitle! : titleEvidence ? titleForSlide(slide, titleEvidence) : null;
  if (trustedProfile?.titleElementId && !profileTitleUsable) {
    diagnostic.evidence.push('semantic title mapping conflicts with native text/geometry requirements; structural fallback was attempted');
  }
  const titleBox = title ? geometryOf(title) : null;
  if (!title || !title.nativeId || !titleBox) return reject('title-role', 'no usable mapped title text shape with native ID and geometry');
  const bodySamples = (bodyEvidence?.sourceEvidence ?? []).filter((item) => item.sourcePart === slide.sourcePart && item.slideIndex === slide.index);
  if (trustedProfile && trustedProfile.bodyElementIds.length > 4) return reject('body-role-fit', `semantic profile mapped ${trustedProfile.bodyElementIds.length} body regions; the bounded projector supports at most four`);
  const semanticBodyCandidates = trustedProfile?.bodyElementIds.map((id) => slide.elements.find((element) => element.id === id))
    .filter((element): element is TemplateElement => Boolean(element));
  const structuralBodyCandidates = bodySamples.map((sample) => slide.elements.find((element) => element.id === sample.elementId));
  const bodyCandidates = (trustedProfile && semanticBodyCandidates?.length ? semanticBodyCandidates : structuralBodyCandidates)
    .filter((element): element is TemplateElement => Boolean(element && element.id !== title.id && element.nativeId
      && element.kind.toLowerCase() === 'shape' && normalizedText(element)
      && geometryOf(element) && maxFont(element) >= 7.5 && maxFont(element) <= 72))
    .map((element) => ({
      element,
      overlap: bodyEvidence ? overlapFraction(geometryOf(element)!, bodyEvidence.geometry) : 1,
      areaRatio: area(geometryOf(element)!) / Math.max(1, area(bodyEvidence?.geometry)),
    }))
    .filter((item) => trustedProfile && semanticBodyCandidates?.length ? true : item.overlap >= 0.65)
    .sort((left, right) => right.areaRatio - left.areaRatio || left.element.order - right.element.order);
  const bodyChoices = bodySlotsFor(bodyCandidates.map((item) => item.element), compiled, Boolean(trustedProfile), diagnostics);
  diagnostic.bodyMappingOptionCount = bodyChoices.length;
  const bodyChoice = bodyChoices[bodyMappingOptionIndex];
  if (!bodyChoice) return reject('body-role-fit', trustedProfile
    ? 'semantic body mappings did not provide usable, non-overlapping text geometry with sufficient projected fit'
    : 'no repeated body-evidence shape overlaps inferred region by at least 65% with sufficient projected fit');
  const bodies = bodyChoice.elements;
  const body = bodies[0]!;
  diagnostic.bodyRegionCount = bodies.length;
  diagnostic.bodySegmentation = bodyChoice.segmentation;
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
  diagnostic.projectedFit = { title: titleFit, body: bodyFit, combined: contentFit };
  if (contentFit < 0.55) return reject('projected-text-fit', `projected title/body text fit ${contentFit}<0.55`);
  const confidence = trustedProfile
    ? Number((0.42 * trustedProfile.confidence + 0.22 * geometryFit + 0.18 * styleHierarchy + 0.18 * contentFit).toFixed(4))
    : Number((0.36 * (titleEvidence?.confidence ?? 0) + 0.36 * (bodyEvidence?.confidence ?? 0)
      + 0.16 * geometryFit + 0.12 * styleHierarchy).toFixed(4));
  if (confidence < MIN_EXEMPLAR_CONFIDENCE) return reject('confidence', `candidate confidence ${confidence}<${MIN_EXEMPLAR_CONFIDENCE}`);

  const archetype = classifyStructuralArchetype(slide, template, title, bodies, preservedChromeIds);
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
  const mappedBodyIds = new Set(trustedProfile?.bodyElementIds ?? bodies.map((item) => item.id));
  const selectedBodyIds = new Set(bodies.map((element) => element.id));
  // Mapped body roles are validated template-source content. When the current
  // source has fewer body blocks than the donor has regions, clear the unused
  // sample regions instead of treating them as unknown text or preserving old facts.
  const unprojectedMappedBodies = trustedProfile
    ? textShapes.filter((element) => mappedBodyIds.has(element.id) && !selectedBodyIds.has(element.id))
    : [];
  const replacedTextIds = [title.id, ...bodies.map((element) => element.id)];
  const semanticPreservedIds = new Set(trustedProfile?.preservedElementIds ?? []);
  const semanticReplaceableIds = new Set(trustedProfile?.replaceableTextElementIds ?? []);
  const preservedText = textShapes.filter((element) => (preservedChromeIds.has(element.id) || semanticPreservedIds.has(element.id))
    && !replacedTextIds.includes(element.id));
  const unusedMappedBodyIds = new Set(unprojectedMappedBodies.map((element) => element.id));
  const explicitlyReplaceableText = textShapes.filter((element) => (semanticReplaceableIds.has(element.id) || unusedMappedBodyIds.has(element.id))
    && !replacedTextIds.includes(element.id) && !preservedText.includes(element));
  const blockedText = textShapes.filter((element) => !replacedTextIds.includes(element.id)
    && !preservedText.includes(element) && !explicitlyReplaceableText.includes(element));
  diagnostic.sourceResidueRisk = blockedText.length ? 'ambiguous' : 'clear';
  diagnostic.preservedTextElementIds = preservedText.map((element) => element.id);
  diagnostic.replacedTextElementIds = replacedTextIds;
  diagnostic.clearedTextElementIds = explicitlyReplaceableText.map((element) => element.id);
  diagnostic.blockedTextElementIds = blockedText.map((element) => element.id);
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
  if (blockedText.length > 0) contentGateReasons.push(`${blockedText.length} ambiguous meaningful text region(s) lack validated preserve/replaceable evidence`);
  if (textDensity < 0.08 && bodyAreaShare > 0.3) contentGateReasons.push('projected text is sparse for the large donor body region');
  const projectionSafe = blockedText.length === 0;
  if (!projectionSafe) {
    diagnostic.projectionSafe = false;
    diagnostic.contentSafe = false;
    return reject('ambiguous-text', contentGateReasons.filter((reason) => /ambiguous meaningful|mapped body region/.test(reason)).join('; '));
  }
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
  const segmentedRegionBoost = bodies.length > 1 && bodyChoice.segmentation.method !== 'existing-blocks' ? 0.08 : 0;
  const score = confidenceScore + semanticBoost + segmentedRegionBoost - Math.min(0.25, contentGateReasons.length * 0.1)
    - (textDensity < 0.08 && bodyAreaShare > 0.3 ? 0.12 : 0);
  const clearElementNativeIds = [...new Set(explicitlyReplaceableText)].map((element) => element.nativeId!);
  const renderableVisual = hasRenderableVisual(compiled);
  const visualSlots = renderableVisual ? visualClasses.filter((item) => item.kind === 'content-slot'
    && (visualElementIds.includes(item.elementId) || /picture|image|chart|table|graphic/i.test(
      `${slide.elements.find((element) => element.id === item.elementId)?.placeholder?.type ?? ''} ${slide.elements.find((element) => element.id === item.elementId)?.placeholder?.role ?? ''}`)))
    .map((item) => slide.elements.find((element) => element.id === item.elementId))
    .filter((element): element is TemplateElement => Boolean(element?.nativeId && geometryOf(element)
      && !element.relationshipIds.length && inCanvas(geometryOf(element)!, template)))
    .filter((element) => {
      const box = geometryOf(element)!;
      return !allBoxes.some((textBox) => textBox.x < box.x + box.width && textBox.x + textBox.width > box.x
        && textBox.y < box.y + box.height && textBox.y + textBox.height > box.y);
    }) : [];
  const visualSlot = visualSlots.length === 1 ? visualSlots[0]! : null;
  if (renderableVisual && !visualSlot) return reject('visual-slot-fit', visualSlots.length
    ? `${visualSlots.length} replaceable visual regions remain ambiguous after semantic and geometry checks`
    : 'no single source-free native visual slot is available for the requested chart, table, process, KPI, or image');
  const preserveChromeNativeIds = textShapes.filter((element) => preservedChromeIds.has(element.id)
    && element.id !== title.id && element.id !== body.id).map((element) => element.nativeId!);
  const visualClassCounts = visualClasses.reduce<Record<string, number>>((counts, item) => {
    counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    return counts;
  }, {});
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
    `${textShapes.length} text shapes classified: ${preservedText.length} preserved, ${replacedTextIds.length} replaced, ${clearElementNativeIds.length} cleared, ${blockedText.length} blocked`,
    `${visualClasses.length} visual object(s) classified as ${Object.entries(visualClassCounts).map(([kind, count]) => `${kind}=${count}`).join(', ') || 'none'}`,
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
      visual: visualSlot ? { elementId: visualSlot.id, nativeId: visualSlot.nativeId!, geometry: geometryOf(visualSlot)!, kind: visualSlot.kind } : null,
    },
      bodyContentRanges: bodyChoice.ranges,
      bodyContentSegments: bodyChoice.segments,
      bodySegmentation: bodyChoice.segmentation,
      textProjection: {
        preserved: preservedText.map((element) => element.nativeId!).filter(Boolean),
        replaced: replacedTextIds.map((id) => slide.elements.find((element) => element.id === id)?.nativeId).filter((id): id is string => Boolean(id)),
        cleared: clearElementNativeIds,
        blocked: blockedText.map((element) => element.nativeId!).filter(Boolean),
      },
      clearElementNativeIds,
      preserveChromeNativeIds,
      familyKey: familyKey(slide, title, body, template),
      projectedCompositionSignature: projectedCompositionSignature(slide, title, bodies, compiled.body.some((text) => text.trim()),
        new Set([...preservedChromeIds, ...preservedText.map((element) => element.id)]), template, visualSlot),
      titleGeometryNormalized: titleNormalized,
      bodyGeometryNormalized: bodyNormalized,
      titleBodyFontHierarchy: { titlePt: maxFont(title), bodyPt: maxFont(body), ratio: Number(fontRatio.toFixed(3)) },
      selectionReason: '',
      evidence,
      limitations: trustedProfile ? ['Semantic body regions are mapped in reading order; unsupported visual/data structures remain fail-closed.']
        : ['The structural selector can project one compatible body region; ambiguous unmapped text blocks donor reuse.'],
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
  diagnostics?.recordDuration('composition.candidateBuild', performance.now() - startedAt);
  return { candidate, diagnostic };
}

function semanticCandidates(candidates: Candidate[], intent: CompiledSlide['intent']): Candidate[] {
  // Intent/archetype is a ranking signal only. Projection safety, source residue,
  // geometry, and per-region fit have already been enforced as hard gates.
  void intent;
  return candidates.filter((candidate) => candidate.projectionSafe);
}

function nativePlaceholderFallbackSupported(
  compiled: CompiledSlide,
  template: TemplateIR,
  candidate: CompatibleLayoutMatchCandidate,
): boolean {
  if (candidate.slotEvidence.title.provenance !== 'explicit_placeholder'
      || candidate.slotEvidence.body.provenance !== 'explicit_placeholder') return false;
  const sourceLayout = template.layouts.find((item) => item.id === candidate.layoutId && item.sourcePart === candidate.sourcePart);
  if (!sourceLayout) return false;
  const titleId = candidate.slotEvidence.title.sourceEvidence[0]?.elementId;
  const bodyId = candidate.slotEvidence.body.sourceEvidence[0]?.elementId;
  const title = sourceLayout.elements.find((element) => element.id === titleId && element.placeholder !== null);
  const body = sourceLayout.elements.find((element) => element.id === bodyId && element.placeholder !== null);
  if (!title || !body || !/title|subtitle/i.test(`${title.placeholder?.type ?? ''} ${title.placeholder?.role ?? ''}`)
      || !/body|obj|content|subtitle/i.test(`${body.placeholder?.type ?? ''} ${body.placeholder?.role ?? ''}`)) return false;
  const titleBox = geometryOf(title);
  const bodyBox = geometryOf(body);
  if (!titleBox || !bodyBox || !inCanvas(titleBox, template) || !inCanvas(bodyBox, template)
      || (titleBox.x < bodyBox.x + bodyBox.width && titleBox.x + titleBox.width > bodyBox.x
        && titleBox.y < bodyBox.y + bodyBox.height && titleBox.y + titleBox.height > bodyBox.y)
      || estimatedLineFit(compiled.title, title) < 0.55
      || compiled.body.length > 0 && estimatedLineFit(compiled.body.join('\n'), body) < 0.55) return false;
  const master = sourceLayout.masterId ? template.masters.find((candidate) => candidate.id === sourceLayout.masterId) : null;
  // Static inherited text is not editable through the generated slide. Repetition
  // across sibling layouts is insufficient evidence that sample copy is chrome.
  if (inheritedStaticText(template, sourceLayout.id, sourceLayout.masterId).length) return false;
  const designElements = [...sourceLayout.elements, ...(master?.elements ?? [])].filter((element) => element.placeholder === null);
  const hasNativeChrome = designElements.some((element) => geometryOf(element)
      && (element.relationshipIds.length > 0 || element.kind.toLowerCase() !== 'shape'
        || hasVisibleDirectStyle(element) || Boolean(normalizedText(element))))
    || Boolean(sourceLayout.background?.kind === 'explicit' || master?.background?.kind === 'explicit');
  return hasNativeChrome;
}

function withLayoutCandidate(compiled: CompiledSlide, candidate: CompatibleLayoutMatchCandidate, index: number): CompiledSlide {
  return {
    ...compiled,
    layoutId: candidate.layoutId,
    layoutSourcePart: candidate.sourcePart,
    placements: { title: candidate.titleBox, body: candidate.bodyBox, visual: candidate.visualBox },
    selectedCandidateIndex: index,
  };
}

/** Apply the exact composition assignment that the A/B/C gate qualified. */
export function applyVariantCompositionAssignment(
  compiled: CompiledSlide,
  assignment: VariantCompositionAssignment,
  template: TemplateIR,
  semanticProfile?: TemplateSemanticProfile,
): CompiledSlide {
  if (compiled.variantId !== assignment.variantId) throw new TypeError('Composition assignment does not match the compiled variant');
  if (assignment.compositionKind === 'exemplar-backed') {
    const selection = assignment.exemplarSelection;
    if (!selection || !template.slides.some((slide) => slide.sourcePart === selection.sourcePart && slide.index === selection.sourceSlideIndex)
        || selection.projectedCompositionSignature !== assignment.projectedCompositionSignature) {
      throw new TypeError('Qualified exemplar assignment is missing its exact validated donor selection');
    }
    const assessment = assessExemplarSelection(compiled, template, semanticProfile);
    if (!assessment.safeSelections.some((candidate) => candidate.sourcePart === selection.sourcePart
        && candidate.sourceSlideIndex === selection.sourceSlideIndex
        && candidate.projectedCompositionSignature === selection.projectedCompositionSignature)) {
      throw new TypeError('Qualified exemplar assignment no longer passes the current hard projection gates');
    }
    const { nativeLayoutFallback: _fallback, ...automatic } = compiled;
    return { ...automatic, exemplarSelection: selection };
  }
  if (assignment.compositionKind === 'safe-generated-fallback') {
    const { nativeLayoutFallback: _fallback, exemplarSelection: _exemplar, ...automatic } = compiled;
    return automatic;
  }
  const candidate = compiled.layoutCandidates[assignment.layoutCandidateIndex];
  if (!candidate || !nativePlaceholderFallbackSupported(compiled, template, candidate)) {
    throw new TypeError('Qualified native layout composition is no longer safe for the compiled slide');
  }
  const { exemplarSelection: _exemplar, ...withoutExemplar } = withLayoutCandidate(compiled, candidate, assignment.layoutCandidateIndex);
  return { ...withoutExemplar, nativeLayoutFallback: true };
}

/**
 * Inspect donor choices and return explicit distinct-family evidence even when the requested rank is unavailable.
 * A/B/C are deduplicated after text replacement, source-text cleanup, chrome retention, and note removal.
 */
export function assessExemplarSelection(
  compiled: CompiledSlide,
  template: TemplateIR,
  semanticProfileInput?: TemplateSemanticProfile,
  diagnostics?: PerformanceDiagnosticsPort,
  visualClassificationCache?: CompositionVisualClassificationCache,
): ExemplarSelectionAssessment {
  const startedAt = performance.now();
  diagnostics?.increment('composition.exemplarAssessmentCount');
  if (compiled.nativeLayoutFallback) return {
    selection: null,
    safeSelections: [],
    availableDistinctFamilies: 0,
    distinctSourceFamilyKeys: [],
    candidateDiagnostics: [],
    supportedCandidateCount: 0,
    evidence: ['the qualified composition assignment requires the measured native layout placeholders'],
  };
  const validationStartedAt = performance.now();
  const semanticProfile = semanticProfileInput ? validateTemplateSemanticProfile(semanticProfileInput, template) : undefined;
  diagnostics?.recordDuration('composition.semanticProfileValidation', performance.now() - validationStartedAt);
  const layout = compiled.layoutCandidates.find((candidate) => candidate.layoutId === compiled.layoutId
    && candidate.sourcePart === compiled.layoutSourcePart);
  const titleEvidence = layout?.slotEvidence.title;
  const bodyEvidence = layout?.slotEvidence.body;
  const hasHighStructuralEvidence = Boolean(titleEvidence && bodyEvidence
    && titleEvidence.confidence >= MIN_EXEMPLAR_CONFIDENCE && bodyEvidence.confidence >= MIN_EXEMPLAR_CONFIDENCE);
  if (!hasHighStructuralEvidence && !semanticProfile) {
    return { selection: null, safeSelections: [], availableDistinctFamilies: 0, distinctSourceFamilyKeys: [], candidateDiagnostics: [], supportedCandidateCount: 0,
      evidence: ['high-confidence repeated title/body evidence is unavailable for the selected layout'] };
  }
  const profileByIndex = new Map(semanticProfile?.slides.map((slide) => [slide.sourceSlideIndex, slide]) ?? []);
  const attempts: CandidateBuild[] = [];
  for (const slide of template.slides) {
    const title = hasHighStructuralEvidence ? titleEvidence! : null;
    const body = hasHighStructuralEvidence ? bodyEvidence! : null;
    const profile = profileByIndex.get(slide.index);
    const first = candidateFor(compiled, template, slide, title, body, profile, 0, diagnostics, visualClassificationCache);
    attempts.push(first);
    for (let optionIndex = 1; optionIndex < first.diagnostic.bodyMappingOptionCount; optionIndex += 1) {
      attempts.push(candidateFor(compiled, template, slide, title, body, profile, optionIndex, diagnostics, visualClassificationCache));
    }
  }
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
  const safeSelections: ExemplarSlideSelection[] = families.map((candidate, familyIndex) => {
    const selectionReason = candidate.contentSafe
      ? `${candidate.selection.semanticArchetype} donor passed content-sanity gates and is distinct after projection`
      : `${candidate.selection.semanticArchetype} donor passed hard projection gates; content/archetype preference is lower-ranked`;
    return {
      ...candidate.selection,
      selectionReason,
      availableDistinctFamilies: families.length,
      evidence: [
        `availableDistinctFamilies=${families.length}`,
        ...candidate.selection.evidence,
        selectionReason,
        `rank ${familyIndex + 1} of ${families.length} distinct safe projected compositions for variant ${compiled.variantId}`,
      ],
    };
  });
  const familyIndex = VARIANT_FAMILY_INDEX[compiled.variantId];
  const selection = safeSelections[familyIndex] ?? null;
  const result = {
    selection,
    safeSelections,
    availableDistinctFamilies: families.length,
    distinctSourceFamilyKeys,
    candidateDiagnostics,
    supportedCandidateCount: compatible.length,
    evidence: selection?.evidence ?? [
      `availableDistinctFamilies=${families.length}`,
      `variant ${compiled.variantId} has no preferred rank, but every item in safeSelections remains available to joint assignment`,
    ],
  };
  diagnostics?.recordDuration('composition.exemplarAssessment', performance.now() - startedAt);
  diagnostics?.increment('composition.candidateAttemptCount', attempts.length);
  return result;
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
  candidateCounts: { sourceCandidates: number; safeExemplarOptions: number; safeLayoutOptions: number; distinctSafeSignatures: number };
  signatures: string[];
  assignments: VariantCompositionAssignment[];
  evidence: string[];
}

/** Check one planned slide across all three tracks before presenting them as A/B/C alternatives. */
export function assessVariantCompositionDistinctness(
  slides: readonly CompiledSlide[],
  template: TemplateIR,
  backend: 'custom' | 'office-kit',
  semanticProfile?: TemplateSemanticProfile,
  diagnostics?: PerformanceDiagnosticsPort,
  visualClassificationCache?: CompositionVisualClassificationCache,
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
    const assignments = ordered.map((slide, index): VariantCompositionAssignment => ({
      variantId: slide.variantId,
      compositionKind: 'safe-generated-fallback',
      layoutCandidateIndex: slide.selectedCandidateIndex,
      projectedCompositionSignature: signatures[index]!,
    }));
    const availableDistinctFamilies = new Set(signatures).size;
    const distinct = signatures.length === variants.length && availableDistinctFamilies === variants.length;
    return {
      distinct, availableDistinctFamilies,
      candidateCounts: { sourceCandidates: 0, safeExemplarOptions: 0, safeLayoutOptions: 0, distinctSafeSignatures: availableDistinctFamilies },
      signatures, assignments,
      evidence: distinct ? ['A/B/C have three distinct projected composition signatures']
        : [`availableDistinctFamilies=${availableDistinctFamilies}; duplicate projected compositions are withheld`],
    };
  } else {
    const assessments = ordered.map((slide) => assessExemplarSelection(slide, template, semanticProfile, diagnostics, visualClassificationCache));
    type Option = VariantCompositionAssignment;
    const optionsByVariant = ordered.map((slide, index) => {
      const options: Option[] = [];
      for (const selection of assessments[index]!.safeSelections) options.push({
        variantId: slide.variantId,
        compositionKind: 'exemplar-backed',
        layoutCandidateIndex: slide.selectedCandidateIndex,
        projectedCompositionSignature: selection.projectedCompositionSignature,
        exemplarSelection: selection,
      });
      slide.layoutCandidates.forEach((candidate, candidateIndex) => {
        if (!nativePlaceholderFallbackSupported(slide, template, candidate)) return;
        const nativeSlide = withLayoutCandidate(slide, candidate, candidateIndex);
        options.push({
          variantId: slide.variantId,
          compositionKind: 'layout-placeholder-backed',
          layoutCandidateIndex: candidateIndex,
          projectedCompositionSignature: generatedFallbackCompositionSignature(nativeSlide, template),
        });
      });
      const signaturesSeen = new Set<string>();
      return options.filter((option) => {
        if (signaturesSeen.has(option.projectedCompositionSignature)) return false;
        signaturesSeen.add(option.projectedCompositionSignature);
        return true;
      });
    });
    let best: Option[] = [];
    let bestExemplarCount = -1;
    let bestRankCost = Number.POSITIVE_INFINITY;
    const chosen: Option[] = [];
    const usedSignatures = new Set<string>();
    const visit = (variantIndex: number, exemplarCount: number, rankCost: number): void => {
      if (variantIndex === ordered.length) {
        if (chosen.length > best.length || chosen.length === best.length
            && (exemplarCount > bestExemplarCount || exemplarCount === bestExemplarCount && rankCost < bestRankCost)) {
          best = [...chosen];
          bestExemplarCount = exemplarCount;
          bestRankCost = rankCost;
        }
        return;
      }
      if (chosen.length + ordered.length - variantIndex < best.length) return;
      for (const [optionIndex, option] of optionsByVariant[variantIndex]!.entries()) {
        if (usedSignatures.has(option.projectedCompositionSignature)) continue;
        usedSignatures.add(option.projectedCompositionSignature);
        chosen.push(option);
        visit(variantIndex + 1, exemplarCount + Number(option.compositionKind === 'exemplar-backed'), rankCost + optionIndex);
        chosen.pop();
        usedSignatures.delete(option.projectedCompositionSignature);
      }
      visit(variantIndex + 1, exemplarCount, rankCost + optionsByVariant[variantIndex]!.length + 1);
    };
    visit(0, 0, 0);
    const distinct = best.length === variants.length;
    const proposedAssignments = distinct ? best
      : optionsByVariant.every((options) => options.length > 0)
        ? optionsByVariant.map((options) => options[0]!)
        : best;
    signatures = distinct ? best.map((option) => option.projectedCompositionSignature)
      : optionsByVariant.every((options) => options.length > 0)
        ? optionsByVariant.map((options) => options[0]!.projectedCompositionSignature)
        : [];
    const assignments = proposedAssignments;
    const safeExemplarSignatures = new Set(optionsByVariant.flat().filter((option) => option.compositionKind === 'exemplar-backed')
      .map((option) => option.projectedCompositionSignature));
    const safeLayoutSignatures = new Set(optionsByVariant.flat().filter((option) => option.compositionKind === 'layout-placeholder-backed')
      .map((option) => option.projectedCompositionSignature));
    const allSafeSignatures = new Set([...safeExemplarSignatures, ...safeLayoutSignatures]);
    return {
      distinct,
      availableDistinctFamilies: best.length,
      candidateCounts: {
        sourceCandidates: assessments[0]?.candidateDiagnostics.length ?? 0,
        safeExemplarOptions: safeExemplarSignatures.size,
        safeLayoutOptions: safeLayoutSignatures.size,
        distinctSafeSignatures: allSafeSignatures.size,
      },
      signatures,
      assignments,
      evidence: distinct
        ? ['A/B/C have three distinct post-projection compositions', ...assignments.map((assignment) => `${assignment.variantId}=${assignment.compositionKind}`)]
        : [
          `availableDistinctFamilies=${best.length}`,
          ...assessments.flatMap((assessment) => assessment.evidence).slice(0, 8),
          'A/B/C could not be assigned three distinct safe exemplar/native-layout compositions.',
        ],
    };
  }
}
