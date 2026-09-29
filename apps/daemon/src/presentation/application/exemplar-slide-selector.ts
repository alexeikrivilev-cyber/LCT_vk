import { createHash } from 'node:crypto';
import type { PerformanceDiagnosticsPort } from '../performance-diagnostics.js';

import type { CompiledSlide, CompatibleLayoutMatchCandidate, PlacementBox } from './slide-compilation.js';
import { applyNativeLayoutCandidate } from './slide-compilation.js';
import type { TemplateElement, TemplateGeometry, TemplateIR, TemplateSlide } from '../domain/template-ir.js';
import { fitProcessNodeLayout } from './process-layout.js';
import { validateTemplateSemanticProfile, type TemplateSemanticProfile, type TemplateSemanticSlideProfile } from './template-semantic-profiler.js';

const MIN_EXEMPLAR_CONFIDENCE = 0.72;
const MIN_PROJECTED_BODY_FIT = 0.68;
const MAX_BODY_SLOT_CANDIDATES = 6;
const VARIANT_FAMILY_INDEX = { A: 0, B: 1, C: 2 } as const;

const VARIANT_ARCHETYPE_PREFERENCE: Record<CompiledSlide['variantId'], Partial<Record<ExemplarArchetype, number>>> = {
  A: { content: 0.24, 'content-split': 0.2, cover: 0.18, hero: 0.14, closing: 0.12, 'section-divider': 0.08, 'content-dense': 0.02, 'metric-evidence': 0, 'table-data': -0.02, 'visual-led': 0.04 },
  B: { 'visual-led': 0.3, hero: 0.26, cover: 0.2, closing: 0.18, 'content-split': 0.18, 'section-divider': 0.14, 'metric-evidence': 0.08, content: 0.02, 'content-dense': -0.08, 'table-data': -0.02 },
  C: { 'content-dense': 0.3, 'table-data': 0.28, 'metric-evidence': 0.24, content: 0.16, 'content-split': 0.08, 'visual-led': -0.02, hero: -0.02, cover: 0.02, closing: 0.08, 'section-divider': -0.02 },
};

function rolePreference(intent: CompiledSlide['intent'], archetype: ExemplarArchetype): number {
  if (intent === 'title') return ['cover', 'hero'].includes(archetype) ? 0.35 : -0.1;
  if (intent === 'section') return ['section-divider', 'hero'].includes(archetype) ? 0.3 : -0.08;
  if (intent === 'summary') return ['closing', 'content-dense'].includes(archetype) ? 0.25 : -0.04;
  return ['content', 'content-split', 'content-dense', 'table-data'].includes(archetype) ? 0.14 : -0.04;
}

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
    removed: string[];
    blocked: string[];
  };
  clearElementNativeIds: string[];
  /** Source body copy and a uniquely geometry-associated panel may be removed when a trusted profile marks the slot unused. */
  removeElementNativeIds: string[];
  preserveChromeNativeIds: string[];
  /** Legacy source morphology key, retained as evidence only. It is not used for A/B/C deduplication. */
  familyKey: string;
  projectedCompositionSignature: string;
  availableDistinctFamilies: number;
  titleGeometryNormalized: NormalizedGeometry;
  bodyGeometryNormalized: NormalizedGeometry;
  titleBodyFontHierarchy: { titlePt: number; bodyPt: number; ratio: number };
  designFeatures: {
    structuralArchetype: ExemplarArchetype;
    mappedBodyRegionCount: number;
    projectedBodyRegionCount: number;
    unusedMappedBodyRegionCount: number;
    unusedVisualSlotAreaShare: number;
    visualAreaShare: number;
    bodyAreaShare: number;
    bodyArrangementScore: number;
    textDensity: number;
    /** Bounded score for recurring, safe template shell objects retained in the projection. */
    shellRichnessScore?: number;
    connectorCount: number;
  };
  selectionReason: string;
  evidence: string[];
  limitations: string[];
}

export interface ExemplarSelectionAssessment {
  selection: ExemplarSlideSelection | null;
  /** Every distinct candidate that passed all hard projection and geometry gates, ranked deterministically. */
  safeSelections: ExemplarSlideSelection[];
  /** Exact already-qualified native/exemplar options by variant for bounded whole-deck assignment. */
  safeOptionsByVariant?: Record<CompiledSlide['variantId'], VariantCompositionAssignment[]>;
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
    removedTextElementIds: string[];
    removedPanelElementIds: string[];
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
    designFeatures: {
      structuralArchetype: ExemplarArchetype;
      mappedBodyRegionCount: number;
      projectedBodyRegionCount: number;
      unusedMappedBodyRegionCount: number;
      unusedVisualSlotAreaShare: number;
      visualAreaShare: number;
      bodyAreaShare: number;
      bodyArrangementScore: number;
      textDensity: number;
      shellRichnessScore?: number;
      connectorCount: number;
    } | null;
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
  compositionKind: 'exemplar-backed' | 'layout-placeholder-backed' | 'safe-generated-fallback' | 'template-derived-fallback';
  layoutCandidateIndex: number;
  projectedCompositionSignature: string;
  /** Generic native family identity used only to prefer deck-level visual variety. */
  compositionFamilyKey?: string;
  /** Present for exemplar-backed choices so the renderer can honor the joint assignment exactly. */
  exemplarSelection?: ExemplarSlideSelection;
}

export interface ExemplarSelectionHistoryEntry {
  sourcePart: string;
  sourceSlideIndex: number;
  familyKey?: string;
  semanticArchetype?: ExemplarArchetype;
}
export type ExemplarSelectionHistory = Partial<Record<CompiledSlide['variantId'], readonly ExemplarSelectionHistoryEntry[]>>;

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
  return Math.max(0, ...(element.effectiveFontSizesPt ?? element.directStyles.fontSizesPt ?? []));
}

function representativeTemplateRoleFontPt(template: TemplateIR, role: 'title' | 'body'): number {
  const accepted = role === 'title' ? new Set(['title', 'ctrtitle', 'subtitle']) : new Set(['body', 'obj', 'content', 'subtitle']);
  const sizes = template.slides.flatMap((slide) => slide.elements)
    .filter((element) => accepted.has(String(element.placeholder?.role ?? element.placeholder?.type ?? '').toLowerCase()))
    .flatMap((element) => element.effectiveFontSizesPt ?? element.directStyles.fontSizesPt ?? [])
    .filter((size) => Number.isFinite(size) && size > 0)
    .sort((left, right) => left - right);
  return sizes.length ? sizes[Math.floor(sizes.length / 2)]! : 0;
}

function normalizedText(element: TemplateElement): string {
  return (element.text ?? '').trim().replace(/\s+/g, ' ');
}

function isFullCanvasImage(element: TemplateElement, template: TemplateIR): boolean {
  const box = geometryOf(element);
  if (!box || Math.abs(box.rotation) > 0.01) return false;
  const width = template.slideSize.width;
  const height = template.slideSize.height;
  const toleranceX = width * 0.005;
  const toleranceY = height * 0.005;
  return Math.abs(box.x) <= toleranceX && Math.abs(box.y) <= toleranceY
    && Math.abs(box.width - width) <= toleranceX
    && Math.abs(box.height - height) <= toleranceY;
}

function hasEditableTextAbove(element: TemplateElement, slide: TemplateSlide): boolean {
  const editableTextAbove = slide.elements.filter((candidate) => candidate.kind.toLowerCase() === 'shape'
    && candidate.parentId === null
    && candidate.nativeId !== null
    && candidate.order > element.order
    && normalizedText(candidate).length > 0
    && geometryOf(candidate) !== null);
  return editableTextAbove.length >= 3;
}

function fullCanvasMediaFingerprint(element: TemplateElement, slide: TemplateSlide, template: TemplateIR): string | null {
  const imageRelationships = slide.relationships.filter((relationship) => element.relationshipIds.includes(relationship.id)
    && relationship.mode === 'internal' && relationship.targetPart !== null);
  if (imageRelationships.length !== 1) return null;
  return template.assets.find((asset) => asset.part === imageRelationships[0]!.targetPart)?.visualFingerprint ?? null;
}

function similarMediaFingerprint(left: string, right: string): boolean {
  const prefix = 'rgb16x9-v1:';
  if (!left.startsWith(prefix) || !right.startsWith(prefix)) return false;
  const a = Buffer.from(left.slice(prefix.length), 'base64');
  const b = Buffer.from(right.slice(prefix.length), 'base64');
  if (a.length !== 16 * 9 * 3 || b.length !== a.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference += Math.abs(a[index]! - b[index]!);
  return difference / a.length <= 8;
}

function isFullCanvasBackgroundShell(
  element: TemplateElement,
  slide: TemplateSlide,
  family: readonly TemplateSlide[],
  template: TemplateIR,
): boolean {
  const fullCanvasImages = slide.elements.filter((other) => ['picture', 'image'].includes(other.kind.toLowerCase())
    && isFullCanvasImage(other, template));
  const fingerprint = fullCanvasMediaFingerprint(element, slide, template);
  if (!slide.layoutId || fullCanvasImages.length !== 1 || !fullCanvasImages.includes(element)
      || !hasEditableTextAbove(element, slide) || !fingerprint) return false;
  const minimum = Math.max(2, Math.ceil(family.length * 0.8));
  const similarMediaRoleCount = family.filter((candidate) => {
    const images = candidate.elements.filter((other) => ['picture', 'image'].includes(other.kind.toLowerCase())
      && isFullCanvasImage(other, template));
    if (images.length !== 1 || !hasEditableTextAbove(images[0]!, candidate)) return false;
    const candidateFingerprint = fullCanvasMediaFingerprint(images[0]!, candidate, template);
    return candidateFingerprint !== null && similarMediaFingerprint(fingerprint, candidateFingerprint);
  }).length;
  // Repetition of both near-full-canvas geometry and sampled image appearance
  // is required so a one-off customer photo cannot inherit the shell role.
  return family.length >= 2 && similarMediaRoleCount >= minimum;
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

function overlapFraction(box: { x: number; y: number; width: number; height: number }, region: { x: number; y: number; width: number; height: number }): number {
  const left = Math.max(box.x, region.x);
  const top = Math.max(box.y, region.y);
  const right = Math.min(box.x + box.width, region.x + region.width);
  const bottom = Math.min(box.y + box.height, region.y + region.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top) / Math.max(1, area(box));
}

function associatedUnusedBodyPanels(
  slide: TemplateSlide,
  unusedBodies: readonly TemplateElement[],
  protectedElementIds: ReadonlySet<string>,
  template: TemplateIR,
): TemplateElement[] {
  const canvasArea = template.slideSize.width * template.slideSize.height;
  const textElements = slide.elements.filter((element) => element.kind.toLowerCase() === 'shape' && normalizedText(element));
  const associations = unusedBodies.map((body) => {
    const bodyBox = geometryOf(body);
    if (!bodyBox || body.parentId !== null) return { panel: null as TemplateElement | null };
    const matches = slide.elements.filter((element) => {
      if (protectedElementIds.has(element.id) || element.parentId !== body.parentId || element.kind.toLowerCase() !== 'shape'
          || element.placeholder !== null || normalizedText(element) || !element.nativeId || element.relationshipIds.length
          || (!element.directStyles.fillColor && !element.directStyles.lineColor) || !geometryOf(element)) return false;
      const panelBox = geometryOf(element)!;
      const panelArea = area(panelBox);
      return inCanvas(panelBox, template) && panelArea >= area(bodyBox) && panelArea <= canvasArea * 0.3
        && panelArea / Math.max(1, area(bodyBox)) <= 2.2
        && overlapFraction(bodyBox, panelBox) >= 0.92
        && !textElements.some((text) => text.id !== body.id && geometryOf(text)
          && overlapFraction(geometryOf(text)!, panelBox) >= 0.2);
    });
    return { panel: matches.length === 1 ? matches[0]! : null };
  });
  const panelCounts = new Map<string, number>();
  for (const item of associations) if (item.panel) panelCounts.set(item.panel.id, (panelCounts.get(item.panel.id) ?? 0) + 1);
  return associations.flatMap((item) => item.panel && panelCounts.get(item.panel.id) === 1 ? [item.panel] : []);
}

function unusedSemanticVisualSlots(
  slide: TemplateSlide,
  visualElementIds: readonly string[],
  protectedTextIds: ReadonlySet<string>,
  template: TemplateIR,
): TemplateElement[] {
  const canvasArea = template.slideSize.width * template.slideSize.height;
  const protectedText = slide.elements.filter((element) => protectedTextIds.has(element.id) && normalizedText(element));
  return slide.elements.filter((element) => {
    if (!visualElementIds.includes(element.id) || element.parentId !== null || !element.nativeId
        || element.kind.toLowerCase() !== 'shape' || element.placeholder !== null || normalizedText(element)
        || element.relationshipIds.length) return false;
    const box = geometryOf(element);
    const visualArea = area(box);
    // Only remove a large, explicitly profiled, empty vector slot. Keep small
    // template accents and linked/native visual assets, and fail closed on unknown shapes.
    // PPTX EMU conversion can leave a one-unit edge overhang (as in some
    // Office Kit inspected layouts). Treat only that sub-pixel rounding as
    // on-canvas; larger out-of-bounds objects remain protected.
    const withinCanvasRounding = box && box.x >= -1 && box.y >= -1
      && box.x + box.width <= template.slideSize.width + 1
      && box.y + box.height <= template.slideSize.height + 1;
    if (!box || !withinCanvasRounding || visualArea < canvasArea * 0.04 || visualArea > canvasArea * 0.32) return false;
    return !protectedText.some((text) => geometryOf(text) && overlapFraction(geometryOf(text)!, box) >= 0.2);
  });
}

function geometryBand(value: number, unit: number): number {
  return Math.round(value / unit);
}

function estimatedLineFit(text: string, element: TemplateElement, minimumFontSizePt = 8, averageGlyphWidthEm = 0.52): number {
  const box = geometryOf(element);
  if (!box) return 0;
  const fontSizePt = Math.max(8, minimumFontSizePt, maxFont(element));
  const widthPt = box.width / 12700;
  const heightPt = box.height / 12700;
  const charactersPerLine = Math.max(6, widthPt / (fontSizePt * averageGlyphWidthEm));
  const lineHeightPt = fontSizePt * 1.2;
  const requiredLines = Math.max(1, text.split(/\r?\n/).reduce((sum, line) => sum + Math.max(1, Math.ceil(Array.from(line).length / charactersPerLine)), 0));
  const availableLines = Math.max(0.25, heightPt / lineHeightPt);
  return Number(Math.min(1, availableLines / requiredLines).toFixed(4));
}

function estimatedWrappedLineCount(text: string, element: TemplateElement): number {
  const box = geometryOf(element);
  if (!box) return 0;
  const fontSizePt = Math.max(8, maxFont(element));
  const charactersPerLine = Math.max(6, (box.width / 12700) / (fontSizePt * 0.52));
  return text.split(/\r?\n/u).reduce((sum, line) => sum + Math.max(1,
    Math.ceil(Array.from(line).length / charactersPerLine)), 0);
}

function estimatedBodyLineCapacity(element: TemplateElement): number {
  const box = geometryOf(element);
  if (!box) return 0;
  const fontSizePt = Math.max(8, maxFont(element));
  const charactersPerLine = Math.max(6, (box.width / 12700) / (fontSizePt * 0.52));
  const linesPerRegion = (box.height / 12700) / (fontSizePt * 1.2);
  return Math.max(0.25, charactersPerLine * linesPerRegion);
}

function projectedTitleFit(text: string, title: TemplateElement, body: TemplateElement): { fit: number; minimum: number } {
  const hasMeasuredTitleSize = maxFont(title) > 0;
  const inheritedSizeEstimate = Math.max(18, maxFont(body) * 2);
  return {
    // Approximate title width conservatively: the previous 0.52-em average
    // marked some long source-template titles as fitting when PowerPoint clipped them.
    fit: estimatedLineFit(text, title, hasMeasuredTitleSize ? 8 : inheritedSizeEstimate, 0.68),
    // Unknown inheritance needs extra headroom because its effective font size
    // is estimated; measured donor typography is adjusted to its box in render.
    minimum: hasMeasuredTitleSize ? 0.72 : 0.9,
  };
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
      if (isFullCanvasBackgroundShell(element, slide, family, template)) {
        return { elementId: element.id, kind: 'template-decoration', reason: 'full-canvas image role recurs across the layout family behind independent editable text objects' };
      }
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
  const family = template.slides.filter((candidate) => candidate.layoutId === slide.layoutId);
  const backgroundShellIds = new Set(slide.elements.filter((element) => ['picture', 'image'].includes(element.kind.toLowerCase())
    && isFullCanvasBackgroundShell(element, slide, family, template)).map((element) => element.id));
  const specialVisuals = visualKinds(slide).filter((element) => !backgroundShellIds.has(element.id));
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
  removedBodyIds: ReadonlySet<string>,
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
    if (removedBodyIds.has(element.id)) return false;
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
  const normalizeCopy = (value: string) => value.replace(/^\s*(?:\d+[.)]|[-*•])\s+/u, '').trim().replace(/\s+/gu, ' ').toLowerCase();
  const bodyHostsSequence = compiled.visualization.processSteps.length >= 2 && compiled.body.length > 0
    && compiled.body.length <= compiled.visualization.processSteps.length
    && compiled.body.every((text) => compiled.visualization.processSteps.some((step) =>
      normalizeCopy(text) === normalizeCopy(step.text)));
  return Boolean(compiled.visualization.tableData || compiled.visualization.chartData || compiled.visualization.kpi
    || compiled.visualization.processSteps.length >= 2 && !bodyHostsSequence || compiled.imageRefs.length > 0);
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
    templateDerivedCompositionStrategy: compiled.templateDerivedCompositionStrategy ?? null,
    ...(compiled.templateDerivedCompositionStrategy ? {
      templateDerivedTitle: normalizedGeometry({ ...compiled.placements.title, rotation: 0, unit: 'EMU' }, template),
      templateDerivedBody: normalizedGeometry({ ...compiled.placements.body, rotation: 0, unit: 'EMU' }, template),
    } : {}),
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

function inCanvas(box: { x: number; y: number; width: number; height: number }, template: TemplateIR): boolean {
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

/** Prefer a compact, aligned group of body regions over arbitrary holes in a larger grid. */
function bodyArrangementScore(elements: readonly TemplateElement[]): number {
  if (elements.length < 2) return 0.5;
  const boxes = elements.map((element) => geometryOf(element)!).filter(Boolean);
  if (boxes.length !== elements.length) return 0;
  const median = (values: number[]) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  };
  const rowTolerance = Math.max(1, median(boxes.map((box) => box.height)) * 0.32);
  const columnTolerance = Math.max(1, median(boxes.map((box) => box.width)) * 0.32);
  const clusterCount = (values: number[], tolerance: number) => {
    let clusters = 0;
    let clusterCenter = Number.NEGATIVE_INFINITY;
    for (const value of [...values].sort((left, right) => left - right)) {
      if (!clusters || Math.abs(value - clusterCenter) > tolerance) {
        clusters += 1;
        clusterCenter = value;
      } else {
        clusterCenter = (clusterCenter * 0.5) + (value * 0.5);
      }
    }
    return clusters;
  };
  const rowCount = clusterCount(boxes.map((box) => box.y + box.height / 2), rowTolerance);
  const columnCount = clusterCount(boxes.map((box) => box.x + box.width / 2), columnTolerance);
  const bestAlignment = Math.max(1 / rowCount, 1 / columnCount);
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));
  const occupiedArea = boxes.reduce((sum, box) => sum + box.width * box.height, 0);
  const compactness = Math.min(1, occupiedArea / Math.max(1, (maxX - minX) * (maxY - minY)));
  const spacingRegularity = (axis: 'x' | 'y'): number => {
    const dimension = axis === 'x' ? 'width' : 'height';
    const ordered = [...boxes].sort((left, right) => left[axis] - right[axis]);
    const gaps = ordered.slice(1).map((box, index) => {
      const previous = ordered[index]!;
      return Math.max(0, box[axis] - (previous[axis] + previous[dimension]));
    });
    if (gaps.length < 2) return 0.5;
    const average = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    if (average <= 0) return 1;
    const deviation = gaps.reduce((sum, gap) => sum + Math.abs(gap - average), 0) / gaps.length;
    return Math.max(0, 1 - deviation / average);
  };
  const bestSpacing = Math.max(spacingRegularity('x'), spacingRegularity('y'));
  return Number((0.52 * bestAlignment + 0.28 * compactness + 0.2 * bestSpacing).toFixed(4));
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
    if (available.length >= (allowMultiple ? MAX_BODY_SLOT_CANDIDATES : 1)) break;
  }
  const elements = available.sort((left, right) => geometryOf(left)!.y - geometryOf(right)!.y
    || geometryOf(left)!.x - geometryOf(right)!.x || left.order - right.order);
  const normalizeSequenceLabel = (value: string) => value.replace(/^\s*(?:\d+[.)]|[-*•])\s+/u, '')
    .trim().replace(/\s+/gu, ' ').toLowerCase();
  const sequenceLabels = compiled.visualization.processSteps.map((step) => step.text);
  const bodyHostsSequence = sequenceLabels.length >= 2 && compiled.body.length > 0
    && compiled.body.length <= sequenceLabels.length
    && compiled.body.every((text) => sequenceLabels.some((step) => normalizeSequenceLabel(text) === normalizeSequenceLabel(step)));
  if (bodyHostsSequence) {
    const choices = elements.flatMap((element): BodySlotsChoice[] => {
      const box = geometryOf(element)!;
      if (!fitProcessNodeLayout({ x: box.x, y: box.y, width: box.width, height: box.height }, sequenceLabels, maxFont(element))) return [];
      return [{
        elements: [element],
        ranges: [{ start: 0, end: compiled.body.length }],
        fits: [1],
        segments: [compiled.body.join('\n')],
        segmentation: {
          method: 'existing-blocks',
          sourceTextSha256: createHash('sha256').update(sourceText).digest('hex'),
          sourceBodyBlockCount: compiled.body.length,
          fragmentCount: compiled.body.length,
          regionCount: 1,
        },
      }];
    });
    diagnostics?.recordDuration('composition.bodySlotSearch', performance.now() - startedAt);
    diagnostics?.increment('composition.bodySlotChoiceCount', choices.length);
    return choices;
  }
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
      const capacities = selected.map(estimatedBodyLineCapacity);
      const demandFor = estimatedWrappedLineCount;
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
            if (fit < MIN_PROJECTED_BODY_FIT) continue;
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
  const structurallyReusedProfile = trustedProfile?.reasonCodes.includes('structural_family_reuse') ?? false;
  const preservedChromeIds = chromeIds(template, slide.layoutId ?? '');
  const visualClasses = cachedVisualClassification(slide, template, trustedProfile?.visualElementIds ?? [], visualClassificationCache, diagnostics);
  const visualElementIds = trustedProfile?.visualElementIds ?? visualClasses.map((item) => item.elementId);
  const diagnostic: CandidateDiagnostic = {
    sourceSlideIndex: slide.index,
    structuralArchetype: null,
    semanticArchetype: trustedProfile && !structurallyReusedProfile ? trustedProfile.archetype : null,
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
    preservedTextElementIds: [], replacedTextElementIds: [], clearedTextElementIds: [], removedTextElementIds: [], removedPanelElementIds: [], blockedTextElementIds: [],
    gate: 'candidate-filter', rejectReason: null, familyKey: null, projectedCompositionSignature: null,
    projectionSafe: null, contentSafe: null, roleCompatible: false,
    titleGeometryNormalized: null, bodyGeometryNormalized: null, titleBodyFontHierarchy: null, designFeatures: null, evidence: [],
  };
  for (const classification of visualClasses) {
    if (classification.kind === 'template-decoration'
        && classification.reason.includes('full-canvas image role recurs across the layout family')
        && trustedProfile?.visualElementIds.includes(classification.elementId)) {
      diagnostic.evidence.push(`semantic profile lists ${classification.elementId} as a visual element; recurring full-canvas geometry is treated as background shell evidence`);
    }
  }
  const reject = (gate: string, reason: string): CandidateBuild => {
    diagnostics?.recordDuration('composition.candidateBuild', performance.now() - startedAt);
    diagnostic.gate = gate;
    diagnostic.rejectReason = reason;
    diagnostic.evidence = [reason, ...diagnostic.evidence];
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
  // Profiles describe every source text region, not just the bounded number of
  // regions the projector can fill. bodySlotsFor keeps the candidate pool capped
  // at six and the projected output capped at four; other explicitly mapped body regions are cleared below so their
  // source copy cannot leak into the projected slide.
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
  const projectedTitle = projectedTitleFit(compiled.title, title, body);
  const titleFit = projectedTitle.fit;
  const bodyFit = Math.min(...bodyChoice.fits);
  const bodyArrangement = bodyArrangementScore(bodies);
  const contentFit = Math.min(titleFit, bodyFit);
  diagnostic.projectedFit = { title: titleFit, body: bodyFit, combined: contentFit };
  if (titleFit < projectedTitle.minimum || bodyFit < MIN_PROJECTED_BODY_FIT) return reject('projected-text-fit',
    `projected title/body text fit title=${titleFit} (minimum ${projectedTitle.minimum}), body=${bodyFit} (minimum ${MIN_PROJECTED_BODY_FIT})`);
  const confidence = trustedProfile
    ? Number((0.42 * trustedProfile.confidence + 0.22 * geometryFit + 0.18 * styleHierarchy + 0.18 * contentFit).toFixed(4))
    : Number((0.36 * (titleEvidence?.confidence ?? 0) + 0.36 * (bodyEvidence?.confidence ?? 0)
      + 0.16 * geometryFit + 0.12 * styleHierarchy).toFixed(4));
  if (confidence < MIN_EXEMPLAR_CONFIDENCE) return reject('confidence', `candidate confidence ${confidence}<${MIN_EXEMPLAR_CONFIDENCE}`);

  const archetype = classifyStructuralArchetype(slide, template, title, bodies, preservedChromeIds);
  const chosenArchetype = trustedProfile && !structurallyReusedProfile
    ? trustedProfile.archetype as ExemplarArchetype : archetype.archetype;
  const semanticConflict = Boolean(trustedProfile && !structurallyReusedProfile && trustedProfile.archetype !== archetype.archetype);
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
  // Mapped body roles are validated template-source content. An unused top-level
  // body shape is safe to omit as a whole: clearing only its copy would leave an
  // empty card/panel. Nested/related shapes are not removed and remain fail-closed.
  const unprojectedMappedBodies = trustedProfile
    ? textShapes.filter((element) => mappedBodyIds.has(element.id) && !selectedBodyIds.has(element.id))
    : [];
  const replacedTextIds = [title.id, ...bodies.map((element) => element.id)];
  const semanticPreservedIds = new Set(trustedProfile?.preservedElementIds ?? []);
  const semanticReplaceableIds = new Set(trustedProfile?.replaceableTextElementIds ?? []);
  const preservedText = textShapes.filter((element) => (preservedChromeIds.has(element.id) || semanticPreservedIds.has(element.id))
    && !replacedTextIds.includes(element.id));
  const unprojectedReplaceableText = textShapes.filter((element) => semanticReplaceableIds.has(element.id)
    && !replacedTextIds.includes(element.id) && !preservedText.includes(element));
  const removableUnusedReplaceableText = unprojectedReplaceableText.filter((element) => element.parentId === null
    && Boolean(element.nativeId) && element.kind.toLowerCase() === 'shape' && element.relationshipIds.length === 0);
  const removableUnusedReplaceableIds = new Set(removableUnusedReplaceableText.map((element) => element.id));
  const unusedMappedBodyIds = new Set(unprojectedMappedBodies.map((element) => element.id));
  const removableUnusedBodyIds = new Set(unprojectedMappedBodies.filter((element) => element.parentId === null
    && Boolean(element.nativeId) && element.kind.toLowerCase() === 'shape' && element.relationshipIds.length === 0)
    .map((element) => element.id));
  const removableUnusedBodies = unprojectedMappedBodies.filter((element) => removableUnusedBodyIds.has(element.id));
  const removableUnusedPanels = associatedUnusedBodyPanels(slide, [...removableUnusedBodies, ...removableUnusedReplaceableText],
    new Set([...preservedChromeIds, ...visualElementIds, ...preservedText.map((element) => element.id), title.id, ...bodies.map((element) => element.id)]), template);
  const renderableVisual = hasRenderableVisual(compiled);
  const removableUnusedVisuals = renderableVisual ? [] : unusedSemanticVisualSlots(slide, visualElementIds,
    new Set([...preservedChromeIds, ...preservedText.map((element) => element.id), title.id, ...bodies.map((element) => element.id)]), template);
  const explicitlyReplaceableText = textShapes.filter((element) => (semanticReplaceableIds.has(element.id) && !removableUnusedReplaceableIds.has(element.id)
    || unusedMappedBodyIds.has(element.id) && !removableUnusedBodyIds.has(element.id))
    && !replacedTextIds.includes(element.id) && !preservedText.includes(element));
  const projectedAwayText = [...explicitlyReplaceableText, ...removableUnusedBodies, ...removableUnusedReplaceableText];
  const blockedText = textShapes.filter((element) => !replacedTextIds.includes(element.id)
    && !preservedText.includes(element) && !projectedAwayText.includes(element));
  diagnostic.sourceResidueRisk = blockedText.length ? 'ambiguous' : 'clear';
  diagnostic.preservedTextElementIds = preservedText.map((element) => element.id);
  diagnostic.replacedTextElementIds = replacedTextIds;
  diagnostic.clearedTextElementIds = explicitlyReplaceableText.map((element) => element.id);
  diagnostic.removedTextElementIds = [...removableUnusedBodies, ...removableUnusedReplaceableText].map((element) => element.id);
  diagnostic.removedPanelElementIds = removableUnusedPanels.map((element) => element.id);
  diagnostic.blockedTextElementIds = blockedText.map((element) => element.id);
  const bodyLineCapacity = Math.max(0.25, bodies.reduce((sum, item) => sum + estimatedBodyLineCapacity(item), 0));
  const projectedLines = bodyChoice.segments.reduce((sum, text, index) => sum
    + estimatedWrappedLineCount(text, bodies[index]!), 0);
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
  const strategyArchetype = archetype.archetype;
  const profileArchetype = chosenArchetype;
  const strategyScore = VARIANT_ARCHETYPE_PREFERENCE[compiled.variantId][strategyArchetype] ?? 0;
  const profileStrategyScore = (VARIANT_ARCHETYPE_PREFERENCE[compiled.variantId][profileArchetype] ?? 0) * 2.5;
  const hasSourceBackedStructuredData = Boolean(compiled.visualization.tableData || compiled.visualization.chartData || compiled.visualization.kpi);
  const unsupportedDataArchetypePenalty = !hasSourceBackedStructuredData
    && ['table-data', 'metric-evidence'].some((archetypeName) => archetypeName === strategyArchetype || archetypeName === profileArchetype)
    ? 0.52 : 0;
  const noVisualContentPenalty = !renderableVisual
    && ['visual-led', 'hero'].some((archetypeName) => archetypeName === strategyArchetype || archetypeName === profileArchetype)
    ? 0.5 : 0;
  const roleScore = rolePreference(compiled.intent, strategyArchetype);
  const semanticConflictPenalty = semanticConflict ? 0.04 : 0;
  const connectorCount = slide.elements.filter((element) => element.kind.toLowerCase() === 'connector').length;
  const requestedVisualType = compiled.visualization.type;
  const visualIntentScore = ['process', 'timeline', 'diagram'].includes(requestedVisualType)
    ? Math.min(0.12, connectorCount * 0.03 + archetype.visualAreaShare * 0.2)
    : requestedVisualType === 'comparison'
      ? strategyArchetype === 'content-split' || strategyArchetype === 'table-data' ? 0.12 : 0
      : ['kpi', 'chart', 'table'].includes(requestedVisualType)
        ? compiled.visualization.tableData || compiled.visualization.chartData || compiled.visualization.kpi
          ? strategyArchetype === 'table-data' || strategyArchetype === 'metric-evidence' ? 0.14 : 0.04
          : 0
        : requestedVisualType === 'image' && compiled.imageRefs.length > 0 && ['visual-led', 'content-split'].includes(strategyArchetype) ? 0.14 : 0;
  const targetDensity = compiled.targetDensity ?? 'balanced';
  const densityPreference = targetDensity === 'detailed'
    ? (['content-dense', 'table-data', 'metric-evidence'].includes(strategyArchetype) ? 0.08 : -0.02)
    : targetDensity === 'compact'
      ? (['cover', 'hero', 'visual-led', 'content'].includes(strategyArchetype) ? 0.05 : 0)
      : (['content', 'content-split'].includes(strategyArchetype) ? 0.04 : 0);
  const densityTarget = compiled.body.length === 0 ? 0
    : ['title', 'section', 'summary'].includes(compiled.intent)
      ? (targetDensity === 'detailed' ? 0.34 : targetDensity === 'compact' ? 0.18 : 0.26)
      : (targetDensity === 'detailed' ? 0.62 : targetDensity === 'compact' ? 0.32 : 0.44);
  // Favor a donor whose measured body capacity suits the planned copy amount.
  // This changes layout choice only; it never adds copy or relaxes text-fit gates.
  const densityFitPreference = -Math.min(0.2, Math.max(0, densityTarget - textDensity) * 0.35);
  const bodyPointCount = compiled.body.length;
  const bodyRegionMatch = Math.max(-0.12, 0.06 - Math.abs(bodies.length - bodyPointCount) * 0.04);
  const unusedBodyPenalty = Math.min(0.3, removableUnusedBodies.length * 0.025);
  const unusedVisualSlotAreaShare = Number((removableUnusedVisuals.reduce((sum, element) => sum + area(geometryOf(element)), 0) / canvasArea).toFixed(4));
  const unusedVisualSlotPenalty = Math.min(0.24, unusedVisualSlotAreaShare * 0.8);
  const bodyArrangementPreference = (bodyArrangement - 0.5) * 0.3;
  const safeShellVisuals = visualClasses.filter((item) => item.kind === 'template-decoration')
    .map((item) => slide.elements.find((element) => element.id === item.elementId))
    .filter((element): element is TemplateElement => Boolean(element));
  const safeShellAreaShare = safeShellVisuals.reduce((sum, element) => sum + area(geometryOf(element)), 0) / canvasArea;
  const shellRichnessScore = Number(Math.min(1,
    Math.min(0.5, safeShellAreaShare) + Math.min(0.3, safeShellVisuals.length * 0.08)
      + Math.min(0.2, preservedText.length * 0.06)).toFixed(4));
  const shellRichnessPreference = shellRichnessScore * 0.1;
  const semanticBoost = roleScore + strategyScore + profileStrategyScore + visualIntentScore + densityPreference
    + densityFitPreference + shellRichnessPreference
    + bodyRegionMatch + bodyArrangementPreference - unusedBodyPenalty - unusedVisualSlotPenalty - semanticConflictPenalty
    - unsupportedDataArchetypePenalty - noVisualContentPenalty;
  const segmentedRegionBoost = bodies.length > 1 && bodyChoice.segmentation.method !== 'existing-blocks' ? 0.08 : 0;
  const score = confidenceScore + semanticBoost + segmentedRegionBoost - Math.min(0.25, contentGateReasons.length * 0.1)
    - (textDensity < 0.08 && bodyAreaShare > 0.3 ? 0.12 : 0);
  const clearElementNativeIds = [...new Set(explicitlyReplaceableText)].map((element) => element.nativeId!);
  const removeElementNativeIds = [...new Set([...removableUnusedBodies, ...removableUnusedReplaceableText, ...removableUnusedPanels, ...removableUnusedVisuals])].map((element) => element.nativeId!);
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
    ...visualClasses.filter((item) => item.kind === 'template-decoration'
      && item.reason.includes('full-canvas image role recurs across the layout family')
      && trustedProfile?.visualElementIds.includes(item.elementId))
      .map((item) => `semantic profile lists ${item.elementId} as a visual element; recurring full-canvas geometry is treated as background shell evidence`),
    `projected body density estimate ${textDensity.toFixed(3)}`,
    `planned body utilization target=${densityTarget.toFixed(2)}; fit preference=${densityFitPreference.toFixed(3)}`,
    `safe recurring shell richness=${shellRichnessScore.toFixed(3)} from ${safeShellVisuals.length} decorative visual(s), ${preservedText.length} chrome text region(s)`,
    `projected body region arrangement score ${bodyArrangement.toFixed(3)}`,
    `strategy preference=${strategyScore.toFixed(3)}, profile preference=${profileStrategyScore.toFixed(3)}, no-visual-content penalty=${noVisualContentPenalty.toFixed(3)}, unused-body penalty=${unusedBodyPenalty.toFixed(3)}, unused-visual-slot area=${unusedVisualSlotAreaShare.toFixed(4)} penalty=${unusedVisualSlotPenalty.toFixed(3)}`,
    ...contentGateReasons.map((reason) => `content-sanity gate: ${reason}`),
    `${textShapes.length} text shapes classified: ${preservedText.length} preserved, ${replacedTextIds.length} replaced, ${clearElementNativeIds.length} cleared; ${removableUnusedBodies.length} unused body region(s), ${removableUnusedReplaceableText.length} unused replaceable text shape(s), ${removableUnusedPanels.length} associated panel(s), and ${removableUnusedVisuals.length} empty profiled visual slot(s) removed; ${blockedText.length} blocked`,
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
        removed: removeElementNativeIds,
        blocked: blockedText.map((element) => element.nativeId!).filter(Boolean),
      },
      clearElementNativeIds,
      removeElementNativeIds,
      preserveChromeNativeIds,
      familyKey: familyKey(slide, title, body, template),
      projectedCompositionSignature: projectedCompositionSignature(slide, title, bodies,
        new Set([...removableUnusedBodyIds, ...removableUnusedReplaceableIds, ...removableUnusedPanels.map((element) => element.id), ...removableUnusedVisuals.map((element) => element.id)]),
        compiled.body.some((text) => text.trim()),
        new Set([...preservedChromeIds, ...preservedText.map((element) => element.id)]), template, visualSlot),
      titleGeometryNormalized: titleNormalized,
      bodyGeometryNormalized: bodyNormalized,
      titleBodyFontHierarchy: { titlePt: maxFont(title), bodyPt: maxFont(body), ratio: Number(fontRatio.toFixed(3)) },
      designFeatures: {
        structuralArchetype: archetype.archetype,
        mappedBodyRegionCount: trustedProfile?.bodyElementIds.length ?? bodies.length,
        projectedBodyRegionCount: bodies.length,
        unusedMappedBodyRegionCount: removableUnusedBodies.length,
        unusedVisualSlotAreaShare,
        visualAreaShare: Number(archetype.visualAreaShare.toFixed(4)),
        bodyAreaShare: Number(bodyAreaShare.toFixed(4)),
        bodyArrangementScore: bodyArrangement,
        textDensity,
        shellRichnessScore,
        connectorCount,
      },
      selectionReason: '',
      evidence,
      limitations: trustedProfile ? ['Semantic body regions are mapped in reading order; unsupported visual/data structures remain fail-closed.']
        : ['The structural selector can project one compatible body region; ambiguous unmapped text blocks donor reuse.'],
    };
  diagnostic.structuralArchetype = archetype.archetype;
  diagnostic.semanticArchetype = trustedProfile && !structurallyReusedProfile ? trustedProfile.archetype : archetype.archetype;
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
  diagnostic.designFeatures = selection.designFeatures;
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

export function nativePlaceholderFallbackSupported(
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
        && titleBox.y < bodyBox.y + bodyBox.height && titleBox.y + titleBox.height > bodyBox.y)) return false;
  const processSteps = compiled.visualization.processSteps;
  if (processSteps.length >= 2) {
    const fontPt = maxFont(body) || representativeTemplateRoleFontPt(template, 'body');
    if (fontPt < 7.5) return false;
    const visualBox = candidate.visualBox;
    const separateVisualIsSafe = Boolean(visualBox && inCanvas(visualBox, template)
      && ![titleBox, bodyBox].some((box) => box.x < visualBox.x + visualBox.width && box.x + box.width > visualBox.x
        && box.y < visualBox.y + visualBox.height && box.y + box.height > visualBox.y));
    const processBox = separateVisualIsSafe ? visualBox
      : compiled.body.length <= processSteps.length ? bodyBox : null;
    if (!processBox) return false;
    if (!fitProcessNodeLayout({ x: processBox.x, y: processBox.y, width: processBox.width, height: processBox.height },
      processSteps.map((step) => step.text), fontPt)) return false;
  }
  // These structurally valid native placeholder layouts are measurement
  // candidates, not publishable output. Estimated font metrics omit inherited
  // paragraph spacing and internal margins, so the actual rendered preview is
  // the fit authority; its unchanged blocking gate runs before a variant is
  // marked ready or exported.
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
  qualifiedOptions?: readonly VariantCompositionAssignment[],
): CompiledSlide {
  if (compiled.variantId !== assignment.variantId) throw new TypeError('Composition assignment does not match the compiled variant');
  if (assignment.compositionKind === 'exemplar-backed') {
    const selection = assignment.exemplarSelection;
    if (!selection || !template.slides.some((slide) => slide.sourcePart === selection.sourcePart && slide.index === selection.sourceSlideIndex)
        || selection.projectedCompositionSignature !== assignment.projectedCompositionSignature) {
      throw new TypeError('Qualified exemplar assignment is missing its exact validated donor selection');
    }
    if (!qualifiedOptions?.includes(assignment)) {
      const assessment = assessExemplarSelection(compiled, template, semanticProfile);
      if (!assessment.safeSelections.some((candidate) => candidate.sourcePart === selection.sourcePart
          && candidate.sourceSlideIndex === selection.sourceSlideIndex
          && candidate.projectedCompositionSignature === selection.projectedCompositionSignature)) {
        throw new TypeError('Qualified exemplar assignment no longer passes the current hard projection gates');
      }
    }
    const { nativeLayoutFallback: _fallback, exemplarSelectionValidation: _priorValidation, ...automatic } = compiled;
    return { ...automatic, exemplarSelection: selection,
      exemplarSelectionValidation: { templateIRHash: template.hash, signature: selection.projectedCompositionSignature } };
  }
  if (assignment.compositionKind === 'safe-generated-fallback') {
    const { nativeLayoutFallback: _fallback, exemplarSelection: _exemplar, ...automatic } = compiled;
    return automatic;
  }
  if (assignment.compositionKind === 'template-derived-fallback') {
    const candidate = compiled.layoutCandidates[assignment.layoutCandidateIndex];
    if (!candidate || !templateDerivedCompositionSupported(compiled, template, candidate)) {
      throw new TypeError('Qualified template-derived composition no longer passes geometry or chrome safety');
    }
    const selected = withLayoutCandidate(compiled, candidate, assignment.layoutCandidateIndex);
    const { nativeLayoutFallback: _nativeFallback, exemplarSelection: _exemplar, exemplarSelectionValidation: _validation, ...automatic } = selected;
    const title = deriveTemplateTitleBox(candidate);
    if (!title || !inCanvas(title, template)) throw new TypeError('Qualified template-derived title geometry is outside the slide canvas');
    return { ...automatic, placements: { ...automatic.placements, title }, templateDerivedCompositionStrategy: compiled.variantId === 'A' ? 'balanced'
      : compiled.variantId === 'B' ? 'visual-first' : 'structured-dense' };
  }
  const candidate = compiled.layoutCandidates[assignment.layoutCandidateIndex];
  if (!candidate || !nativePlaceholderFallbackSupported(compiled, template, candidate)) {
    throw new TypeError('Qualified native layout composition is no longer safe for the compiled slide');
  }
  return applyNativeLayoutCandidate(compiled, candidate, assignment.layoutCandidateIndex, template);
}

/**
 * Inspect donor choices and return explicit distinct-family evidence even when the requested rank is unavailable.
 * A/B/C are deduplicated after text replacement, source-text cleanup, chrome retention, and note removal.
 */
function assessExemplarSelectionWithValidatedProfile(
  compiled: CompiledSlide,
  template: TemplateIR,
  semanticProfile?: TemplateSemanticProfile,
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
  // Preserve deterministic A/B/C family ranks when candidates are structurally
  // equivalent. When a stronger safe candidate matches this track's semantic
  // archetype or narrative role, honor that design intent instead of selecting
  // a lower-quality donor solely because this is the second or third track.
  const rankedSelection = safeSelections[VARIANT_FAMILY_INDEX[compiled.variantId]] ?? null;
  const strategyAffinity = (candidate: ExemplarSlideSelection) =>
    (VARIANT_ARCHETYPE_PREFERENCE[compiled.variantId][candidate.semanticArchetype] ?? 0) * 2.5
      + rolePreference(compiled.intent, candidate.semanticArchetype);
  const bestStrategySelection = safeSelections.reduce<ExemplarSlideSelection | null>((best, candidate) =>
    !best || strategyAffinity(candidate) > strategyAffinity(best) ? candidate : best, null);
  const selection = bestStrategySelection && rankedSelection
    && strategyAffinity(bestStrategySelection) > strategyAffinity(rankedSelection)
    ? bestStrategySelection : rankedSelection;
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

export function assessExemplarSelection(
  compiled: CompiledSlide,
  template: TemplateIR,
  semanticProfileInput?: TemplateSemanticProfile,
  diagnostics?: PerformanceDiagnosticsPort,
  visualClassificationCache?: CompositionVisualClassificationCache,
): ExemplarSelectionAssessment {
  if (compiled.nativeLayoutFallback) {
    return assessExemplarSelectionWithValidatedProfile(compiled, template, undefined, diagnostics, visualClassificationCache);
  }
  const validationStartedAt = performance.now();
  const semanticProfile = semanticProfileInput ? validateTemplateSemanticProfile(semanticProfileInput, template) : undefined;
  diagnostics?.recordDuration('composition.semanticProfileValidation', performance.now() - validationStartedAt);
  return assessExemplarSelectionWithValidatedProfile(compiled, template, semanticProfile, diagnostics, visualClassificationCache);
}

/** Select the safe post-projection family rank for this variant, or null if that distinct rank is unavailable. */
export function selectExemplarSlide(compiled: CompiledSlide, template: TemplateIR, semanticProfile?: TemplateSemanticProfile): ExemplarSlideSelection | null {
  return assessExemplarSelection(compiled, template, semanticProfile).selection;
}

/** Signature for the renderer's deterministic text/visual fallback when no safe exemplar rank exists. */
export function generatedFallbackCompositionSignature(compiled: CompiledSlide, template: TemplateIR): string {
  return fallbackCompositionSignature(compiled, template);
}

/**
 * Last-resort Office Kit composition gate. It uses measured title/body region
 * evidence and an existing layout/master; actual fit and collision checks
 * remain the renderer preview's hard authority.
 */
export function templateDerivedCompositionSupported(
  compiled: CompiledSlide,
  template: TemplateIR,
  candidate: CompatibleLayoutMatchCandidate,
): boolean {
  const title = deriveTemplateTitleBox(candidate);
  const body = candidate.bodyBox;
  const overlaps = (left: { x: number; y: number; width: number; height: number }, right: { x: number; y: number; width: number; height: number }) =>
    left.x < right.x + right.width && left.x + left.width > right.x
      && left.y < right.y + right.height && left.y + left.height > right.y;
  if (!title || !body || !candidate.slotEvidence.title || !candidate.slotEvidence.body
      || Math.min(candidate.slotEvidence.title.confidence, candidate.slotEvidence.body.confidence) < MIN_EXEMPLAR_CONFIDENCE
      || !candidate.slotEvidence.title.sourceEvidence.length || !candidate.slotEvidence.body.sourceEvidence.length
      || !inCanvas(title, template) || !inCanvas(body, template) || overlaps(title, body)) return false;
  const layout = template.layouts.find((item) => item.id === candidate.layoutId && item.sourcePart === candidate.sourcePart);
  if (!layout || inheritedStaticText(template, layout.id, layout.masterId).length) return false;
  const master = layout.masterId ? template.masters.find((item) => item.id === layout.masterId) : null;
  const staticElements = [...layout.elements, ...(master?.elements ?? [])].filter((element) => element.placeholder === null);
  const isContained = (outer: TemplateGeometry, inner: PlacementBox) => inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
  for (const element of staticElements) {
    const geometry = geometryOf(element);
    if (!geometry) continue;
    for (const region of [title, body]) {
      if (!overlaps(geometry, region)) continue;
      const fullCanvasBackground = geometry.x <= 0 && geometry.y <= 0
        && geometry.x + geometry.width >= template.slideSize.width
        && geometry.y + geometry.height >= template.slideSize.height
        && element.kind.toLowerCase() === 'shape' && !normalizedText(element) && !element.relationshipIds.length;
      const panelBehindContent = element.kind.toLowerCase() === 'shape' && !normalizedText(element)
        && !element.relationshipIds.length && isContained(geometry, region);
      if (!fullCanvasBackground && !panelBehindContent) return false;
    }
  }
  if (compiled.imageRefs.length && !candidate.visualBox) return false;
  const textComparison = compiled.visualization.type === 'comparison'
    && !compiled.visualization.tableData && !compiled.visualization.chartData && !compiled.visualization.kpi
    && compiled.body.length >= 2;
  if (compiled.visualization.type !== 'none' && compiled.visualization.type !== 'process' && !textComparison) return false;
  if ((compiled.visualization.chartData || compiled.visualization.tableData || compiled.visualization.kpi)
      && !candidate.visualBox && compiled.body.length) return false;
  if (compiled.visualization.processSteps.length >= 2) {
    const fontPt = Math.max(0, ...candidate.slotEvidence.body.sourceEvidence.flatMap((item) => item.fontSizesPt ?? []))
      || representativeTemplateRoleFontPt(template, 'body');
    if (fontPt <= 0 || !fitProcessNodeLayout(body, compiled.visualization.processSteps.map((step) => step.text), fontPt)) return false;
  }
  return true;
}

/** Borrow only measured whitespace between title/body regions; never reduce type size. */
export function deriveTemplateTitleBox(candidate: CompatibleLayoutMatchCandidate): PlacementBox | null {
  let title = candidate.titleBox;
  const body = candidate.bodyBox;
  if (!title || !body) return null;
  const horizontalOverlap = title.x < body.x + body.width && title.x + title.width > body.x;
  const titleBottom = title.y + title.height;
  // Some valid OOXML templates place adjacent title/body placeholders with a
  // small geometric intersection caused by rounding. For a vertically stacked
  // pair, trim exactly the measured intersection from the generated title box;
  // preview remains responsible for proving that the retained title still fits.
  if (horizontalOverlap && title.y <= body.y && titleBottom > body.y) {
    const nonOverlappingHeight = body.y - title.y;
    if (nonOverlappingHeight <= 0) return null;
    title = { ...title, height: nonOverlappingHeight };
  }
  const gap = Math.max(0, body.y - (title.y + title.height));
  const borrowedHeight = Math.min(Math.round(title.height * 0.4), Math.floor(gap * 0.45));
  return { ...title, height: title.height + borrowedHeight };
}

export interface VariantCompositionDistinctness {
  hasSafeAssignments: boolean;
  /** Per-slide diagnostic only; deck-level distinctness is enforced after all slide assignments. */
  distinct: boolean;
  availableDistinctFamilies: number;
  candidateCounts: { sourceCandidates: number; safeExemplarOptions: number; safeLayoutOptions: number; distinctSafeSignatures: number };
  signatures: string[];
  assignments: VariantCompositionAssignment[];
  /** Exact qualified options by track for bounded deck-level distinctness assignment. */
  safeOptionsByVariant: Record<CompiledSlide['variantId'], VariantCompositionAssignment[]>;
  evidence: string[];
}

/** Pick one already-qualified safe option for each track, maximizing distinct signatures first. */
export function assignSafeVariantCompositions(
  optionsByVariant: readonly (readonly VariantCompositionAssignment[])[],
): VariantCompositionAssignment[] {
  if (optionsByVariant.length !== 3 || optionsByVariant.some((options) => options.length === 0)) return [];
  // This local choice only supplies a preferred option for each track. The
  // complete safe-option lists remain available to assignDeckVariantCompositions.
  // Bound the local preference search because arbitrary templates can contribute
  // hundreds of qualified donors per slide.
  const rankedOptions = optionsByVariant.map((options) => options.slice(0, 16));
  let best: VariantCompositionAssignment[] | null = null;
  let bestDistinctDonorCount = -1;
  let bestDistinctCount = -1;
  let bestExemplarCount = -1;
  let bestRankCost = Number.POSITIVE_INFINITY;
  const chosen: Array<VariantCompositionAssignment | null> = [];
  const usedSignatures = new Set<string>();

  const visit = (variantIndex: number): void => {
    if (variantIndex === optionsByVariant.length) {
      const complete = chosen.map((option, index) => option ?? rankedOptions[index]![0]!);
      const distinctDonorCount = new Set(complete.map((option) => option.compositionFamilyKey ?? (option.exemplarSelection
        ? `${option.exemplarSelection.sourcePart}|${option.exemplarSelection.sourceSlideIndex}`
        : `${option.compositionKind}|${option.layoutCandidateIndex}`))).size;
      const distinctCount = new Set(complete.map((option) => option.projectedCompositionSignature)).size;
      const exemplarCount = complete.filter((option) => option.compositionKind === 'exemplar-backed').length;
      const rankCost = complete.reduce((cost, option, index) => cost + rankedOptions[index]!.indexOf(option), 0);
      if (distinctCount > bestDistinctCount
          || distinctCount === bestDistinctCount && (exemplarCount > bestExemplarCount
            || exemplarCount === bestExemplarCount && (distinctDonorCount > bestDistinctDonorCount
              || distinctDonorCount === bestDistinctDonorCount && rankCost < bestRankCost))) {
        best = complete;
        bestDistinctDonorCount = distinctDonorCount;
        bestDistinctCount = distinctCount;
        bestExemplarCount = exemplarCount;
        bestRankCost = rankCost;
      }
      return;
    }

    for (const option of rankedOptions[variantIndex]!) {
      if (usedSignatures.has(option.projectedCompositionSignature)) continue;
      usedSignatures.add(option.projectedCompositionSignature);
      chosen.push(option);
      visit(variantIndex + 1);
      chosen.pop();
      usedSignatures.delete(option.projectedCompositionSignature);
    }
    // Unassigned tracks receive their highest-ranked safe option when the partial
    // distinct assignment is completed at the leaf.
    chosen.push(null);
    visit(variantIndex + 1);
    chosen.pop();
  };
  visit(0);
  return best ?? [];
}

interface DeckSequenceCandidate {
  assignments: VariantCompositionAssignment[];
  signatures: string[];
  signature: string;
  cost: number;
}

function deckSequenceDistance(left: readonly string[], right: readonly string[]): number {
  let differentSlides = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) differentSlides += 1;
  }
  return differentSlides;
}

function retainDiverseDeckCandidates(
  candidates: readonly DeckSequenceCandidate[],
  limit: number,
): DeckSequenceCandidate[] {
  const ranked = [...candidates].sort((left, right) => left.cost - right.cost || left.signature.localeCompare(right.signature));
  if (ranked.length <= limit) return ranked;

  // Keep low-cost anchors for the track policy, then reserve the rest of the
  // bounded search beam for different safe slide sequences. A cost-only beam
  // can otherwise discard the alternatives needed for visibly distinct decks.
  const anchors = Math.min(24, Math.floor(limit / 3));
  const selected = ranked.slice(0, anchors);
  const selectedSignatures = new Set(selected.map((candidate) => candidate.signature));
  const remaining = ranked.slice(anchors, Math.min(ranked.length, limit * 8));
  const nearestDistance = new Map(remaining.map((candidate) => [candidate.signature,
    selected.length ? Math.min(...selected.map((existing) => deckSequenceDistance(candidate.signatures, existing.signatures))) : 0]));
  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestDistance = -1;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index]!;
      const minimumDistance = nearestDistance.get(candidate.signature) ?? 0;
      const current = remaining[bestIndex]!;
      if (minimumDistance > bestDistance
          || (minimumDistance === bestDistance && (candidate.cost < current.cost
            || (candidate.cost === current.cost && candidate.signature.localeCompare(current.signature) < 0)))) {
        bestIndex = index;
        bestDistance = minimumDistance;
      }
    }
    const [candidate] = remaining.splice(bestIndex, 1);
    if (candidate && !selectedSignatures.has(candidate.signature)) {
      selected.push(candidate);
      selectedSignatures.add(candidate.signature);
      for (const other of remaining) {
        nearestDistance.set(other.signature, Math.min(nearestDistance.get(other.signature) ?? 0,
          deckSequenceDistance(candidate.signatures, other.signatures)));
      }
    }
  }
  return selected.sort((left, right) => left.cost - right.cost || left.signature.localeCompare(right.signature));
}

/**
 * Selects among exact per-slide safe options so A/B/C are as different as
 * possible as complete ordered decks. Pairwise slide difference is optimized
 * before strategy/rank cost; no candidate is synthesized or allowed past an
 * existing hard gate. The search is bounded to 128 sequences and 64 options
 * per slide.
 */
export function assignDeckVariantCompositions(
  slides: readonly Record<CompiledSlide['variantId'], readonly VariantCompositionAssignment[]>[],
): Record<CompiledSlide['variantId'], VariantCompositionAssignment[]> | null {
  // Prefer the already-qualified semantic donors and native placeholder
  // layouts. Generic template-derived compositions are a last resort for the
  // exact case where tiers 1–2 cannot form three distinct complete decks.
  const higherTierOptions = slides.map((slide) => Object.fromEntries(
    (['A', 'B', 'C'] as const).map((variant) => [variant,
      slide[variant].filter((option) => option.compositionKind !== 'template-derived-fallback')]),
  ) as Record<CompiledSlide['variantId'], VariantCompositionAssignment[]>);
  if (higherTierOptions.length && higherTierOptions.every((slide) => (['A', 'B', 'C'] as const)
    .every((variant) => slide[variant].length > 0))) {
    const higherTierAssignment = assignDeckVariantCompositionsFromOptions(higherTierOptions);
    if (higherTierAssignment) return higherTierAssignment;
  }
  return assignDeckVariantCompositionsFromOptions(slides);
}

function assignDeckVariantCompositionsFromOptions(
  slides: readonly Record<CompiledSlide['variantId'], readonly VariantCompositionAssignment[]>[],
): Record<CompiledSlide['variantId'], VariantCompositionAssignment[]> | null {
  if (!slides.length || slides.some((slide) => (['A', 'B', 'C'] as const).some((variant) => slide[variant].length === 0
      || slide[variant].some((option) => option.variantId !== variant)))) return null;
  const beamWidth = 128;
  const optionLimit = 64;
  const deckCandidates = {} as Record<CompiledSlide['variantId'], DeckSequenceCandidate[]>;
  for (const variant of ['A', 'B', 'C'] as const) {
    let beam: DeckSequenceCandidate[] = [{ assignments: [], signatures: [], signature: '', cost: 0 }];
    for (const slide of slides) {
      const options = slide[variant].slice(0, optionLimit);
      const next = new Map<string, DeckSequenceCandidate>();
      for (const prefix of beam) for (const [rank, option] of options.entries()) {
        const previous = prefix.assignments.at(-1);
        const family = option.compositionFamilyKey
          ?? (option.exemplarSelection ? `${option.exemplarSelection.sourcePart}|${option.exemplarSelection.sourceSlideIndex}` : option.projectedCompositionSignature);
        const previousFamily = previous?.compositionFamilyKey
          ?? (previous?.exemplarSelection ? `${previous.exemplarSelection.sourcePart}|${previous.exemplarSelection.sourceSlideIndex}` : previous?.projectedCompositionSignature);
        const familyUseCount = prefix.assignments.filter((assigned) => {
          const assignedFamily = assigned.compositionFamilyKey
            ?? (assigned.exemplarSelection ? `${assigned.exemplarSelection.sourcePart}|${assigned.exemplarSelection.sourceSlideIndex}` : assigned.projectedCompositionSignature);
          return assignedFamily === family;
        }).length;
        const repeatCost = (previousFamily === family ? 1.25 : 0)
          + familyUseCount * Math.max(1, options.length / Math.max(2, slides.length / 2));
        const assignments = [...prefix.assignments, option];
        const signatures = [...prefix.signatures, option.projectedCompositionSignature];
        const signature = signatures.join('\u001f');
        const candidate = { assignments, signatures, signature, cost: prefix.cost + rank + repeatCost };
        const existing = next.get(signature);
        if (!existing || candidate.cost < existing.cost) next.set(signature, candidate);
      }
      beam = retainDiverseDeckCandidates([...next.values()], beamWidth);
    }
    deckCandidates[variant] = beam;
  }

  let best: [DeckSequenceCandidate, DeckSequenceCandidate, DeckSequenceCandidate] | null = null;
  let bestMinimumDistance = -1;
  let bestTotalDistance = -1;
  let bestCost = Number.POSITIVE_INFINITY;
  let bestSignature = '';
  for (const a of deckCandidates.A) for (const b of deckCandidates.B) {
    if (a.signature === b.signature) continue;
    const distanceAB = deckSequenceDistance(a.signatures, b.signatures);
    for (const c of deckCandidates.C) {
      if (c.signature === a.signature || c.signature === b.signature) continue;
      const distanceAC = deckSequenceDistance(a.signatures, c.signatures);
      const distanceBC = deckSequenceDistance(b.signatures, c.signatures);
      const minimumDistance = Math.min(distanceAB, distanceAC, distanceBC);
      const totalDistance = distanceAB + distanceAC + distanceBC;
      const cost = a.cost + b.cost + c.cost;
      const signature = `${a.signature}\u001e${b.signature}\u001e${c.signature}`;
      if (minimumDistance > bestMinimumDistance
          || (minimumDistance === bestMinimumDistance && totalDistance > bestTotalDistance)
          || (minimumDistance === bestMinimumDistance && totalDistance === bestTotalDistance && cost < bestCost)
          || (minimumDistance === bestMinimumDistance && totalDistance === bestTotalDistance && cost === bestCost
            && (bestSignature === '' || signature.localeCompare(bestSignature) < 0))) {
        best = [a, b, c];
        bestMinimumDistance = minimumDistance;
        bestTotalDistance = totalDistance;
        bestCost = cost;
        bestSignature = signature;
      }
    }
  }
  if (!best) return null;
  return {
    A: best[0].assignments,
    B: best[1].assignments,
    C: best[2].assignments,
  };
}

/** Check one planned slide across all three tracks before presenting them as A/B/C alternatives. */
export function assessVariantCompositionDistinctness(
  slides: readonly CompiledSlide[],
  template: TemplateIR,
  backend: 'custom' | 'office-kit',
  semanticProfile?: TemplateSemanticProfile,
  diagnostics?: PerformanceDiagnosticsPort,
  visualClassificationCache?: CompositionVisualClassificationCache,
  history?: ExemplarSelectionHistory,
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
      compositionFamilyKey: `fallback:${signatures[index]}`,
    }));
    const availableDistinctFamilies = new Set(signatures).size;
    const distinct = signatures.length === variants.length && availableDistinctFamilies === variants.length;
    return {
      hasSafeAssignments: assignments.length === variants.length,
      distinct, availableDistinctFamilies,
      candidateCounts: { sourceCandidates: 0, safeExemplarOptions: 0, safeLayoutOptions: 0, distinctSafeSignatures: availableDistinctFamilies },
      signatures, assignments,
      safeOptionsByVariant: Object.fromEntries(assignments.map((assignment) => [assignment.variantId, [assignment]])) as Record<CompiledSlide['variantId'], VariantCompositionAssignment[]>,
      evidence: distinct ? ['A/B/C have three distinct projected composition signatures']
        : [`availableDistinctFamilies=${availableDistinctFamilies}; duplicate projected compositions are withheld`],
    };
  } else {
    const validationStartedAt = performance.now();
    const validatedProfile = semanticProfile ? validateTemplateSemanticProfile(semanticProfile, template) : undefined;
    diagnostics?.recordDuration('composition.semanticProfileValidation', performance.now() - validationStartedAt);
    const assessments = ordered.map((slide) => assessExemplarSelectionWithValidatedProfile(slide, template, validatedProfile, diagnostics, visualClassificationCache));
    type Option = VariantCompositionAssignment;
    const optionsByVariant = ordered.map((slide, index) => {
      const options: Option[] = [];
      for (const selection of assessments[index]!.safeSelections) options.push({
        variantId: slide.variantId,
        compositionKind: 'exemplar-backed',
        layoutCandidateIndex: slide.selectedCandidateIndex,
        projectedCompositionSignature: selection.projectedCompositionSignature,
        compositionFamilyKey: `exemplar:${selection.sourcePart}|${selection.sourceSlideIndex}`,
        exemplarSelection: selection,
      });
      slide.layoutCandidates.forEach((candidate, candidateIndex) => {
        if (!nativePlaceholderFallbackSupported(slide, template, candidate)) return;
        // Sign the exact normalized assignment used by the renderer. In
        // particular, applyNativeLayoutCandidate clips an optional visual box
        // to the canvas; signing the raw candidate first made qualification
        // disagree with the rendered layout even though both selected the
        // same native placeholders.
        const nativeSlide = applyNativeLayoutCandidate(slide, candidate, candidateIndex, template);
        options.push({
          variantId: slide.variantId,
          compositionKind: 'layout-placeholder-backed',
          layoutCandidateIndex: candidateIndex,
          projectedCompositionSignature: generatedFallbackCompositionSignature(nativeSlide, template),
          compositionFamilyKey: `layout:${candidate.sourcePart}|${candidate.layoutId}`,
        });
      });
      const signaturesSeen = new Set<string>();
      const uniqueOptions = options.filter((option) => {
        if (signaturesSeen.has(option.projectedCompositionSignature)) return false;
        signaturesSeen.add(option.projectedCompositionSignature);
        return true;
      });
      // Keep tier 3 as a qualified reserve even when one higher-tier choice
      // exists: a single safe donor/layout can still be insufficient for three
      // distinct complete decks. The deck resolver first tries tiers 1–2 and
      // only escalates to this reserve when those cannot produce distinct A/B/C.
      const strategy: NonNullable<CompiledSlide['templateDerivedCompositionStrategy']> = slide.variantId === 'A'
        ? 'balanced' : slide.variantId === 'B' ? 'visual-first' : 'structured-dense';
      for (const [candidateIndex, candidate] of slide.layoutCandidates.entries()) {
        if (!templateDerivedCompositionSupported(slide, template, candidate)) continue;
        const selected = withLayoutCandidate(slide, candidate, candidateIndex);
        const title = deriveTemplateTitleBox(candidate);
        if (!title) continue;
        const projected = { ...selected, placements: { ...selected.placements, title }, templateDerivedCompositionStrategy: strategy };
        const projectedCompositionSignature = generatedFallbackCompositionSignature(projected, template);
        if (signaturesSeen.has(projectedCompositionSignature)) continue;
        signaturesSeen.add(projectedCompositionSignature);
        uniqueOptions.push({
          variantId: slide.variantId,
          compositionKind: 'template-derived-fallback',
          layoutCandidateIndex: candidateIndex,
          projectedCompositionSignature,
          compositionFamilyKey: `template-derived:${strategy}:${candidate.sourcePart}:${projectedCompositionSignature}`,
        });
      }
      const prior = history?.[slide.variantId] ?? [];
      const priorLast = prior.at(-1);
      const preferenceCost = (option: Option, index: number) => {
        const selection = option.exemplarSelection;
        if (!selection) return index;
        const sameDonorCount = prior.filter((entry) => entry.sourcePart === selection.sourcePart
          && entry.sourceSlideIndex === selection.sourceSlideIndex).length;
        const sameFamilyCount = prior.filter((entry) => Boolean(entry.familyKey) && entry.familyKey === selection.familyKey).length;
        const adjacentDonorRepeat = priorLast?.sourcePart === selection.sourcePart
          && priorLast.sourceSlideIndex === selection.sourceSlideIndex;
        const adjacentFamilyRepeat = priorLast?.familyKey === selection.familyKey;
        const sourceRepeatPenalty = sameDonorCount ? uniqueOptions.length * (sameDonorCount + 1) : 0;
        const familyRepeatPenalty = sameFamilyCount ? Math.ceil(uniqueOptions.length * 0.35) * sameFamilyCount : 0;
        const adjacentPenalty = adjacentDonorRepeat ? uniqueOptions.length * 0.4 : adjacentFamilyRepeat ? uniqueOptions.length * 0.2 : 0;
        return index + sourceRepeatPenalty + familyRepeatPenalty + adjacentPenalty;
      };
      return uniqueOptions.map((option, index) => ({ option, index, cost: preferenceCost(option, index) }))
        .sort((left, right) => left.cost - right.cost || left.index - right.index)
        .map(({ option }) => option);
    });
    const assignments = assignSafeVariantCompositions(optionsByVariant);
    signatures = assignments.map((option) => option.projectedCompositionSignature);
    const availableDistinctFamilies = new Set(signatures).size;
    const distinct = assignments.length === variants.length && availableDistinctFamilies === variants.length;
    const safeExemplarSignatures = new Set(optionsByVariant.flat().filter((option) => option.compositionKind === 'exemplar-backed')
      .map((option) => option.projectedCompositionSignature));
    const safeLayoutSignatures = new Set(optionsByVariant.flat().filter((option) => option.compositionKind === 'layout-placeholder-backed')
      .map((option) => option.projectedCompositionSignature));
    const allSafeSignatures = new Set([...safeExemplarSignatures, ...safeLayoutSignatures]);
    return {
      hasSafeAssignments: assignments.length === variants.length,
      distinct,
      availableDistinctFamilies,
      candidateCounts: {
        sourceCandidates: assessments[0]?.candidateDiagnostics.length ?? 0,
        safeExemplarOptions: safeExemplarSignatures.size,
        safeLayoutOptions: safeLayoutSignatures.size,
        distinctSafeSignatures: allSafeSignatures.size,
      },
      signatures,
      assignments,
      safeOptionsByVariant: Object.fromEntries(variants.map((variant, index) => [variant, optionsByVariant[index]!])) as Record<CompiledSlide['variantId'], VariantCompositionAssignment[]>,
      evidence: assignments.length === variants.length
        ? [
          `availableDistinctFamilies=${availableDistinctFamilies}; safe assignments are available for every track`,
          ...(distinct ? ['A/B/C have three distinct post-projection compositions on this slide'] : ['Some tracks reuse a safe projected composition; distinctness is evaluated across the complete decks']),
          ...assignments.map((assignment) => `${assignment.variantId}=${assignment.compositionKind}`),
        ]
        : [
          'No complete safe A/B/C assignment is available for this slide.',
          ...assessments.flatMap((assessment) => assessment.evidence).slice(0, 8),
        ],
    };
  }
}
