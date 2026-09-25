import { createHash } from 'node:crypto';

import { validateContentIR, type ContentIR, type ContentUnit } from '../domain/content-ir.js';
import { validateDeckPlan, type DeckPlan, type DeckPlanSlide, type SemanticVisualType } from '../domain/deck-plan.js';
import { validateTemplateIR, type TemplateElement, type TemplateGeometry, type TemplateIR, type TemplateLayout, type TemplateSlide } from '../domain/template-ir.js';

/** Internal pre-TZ representation. Replaceable until the final product specification fixes this boundary. */
export type PresentationVariantId = 'A' | 'B' | 'C';
export type SlideIntent = 'title' | 'section' | 'narrative' | 'data' | 'visual' | 'summary';

export interface VariantPolicy {
  id: PresentationVariantId;
  version: string;
  label: string;
  visualAreaWeight: number;
  textCapacityWeight: number;
}

export const VARIANT_POLICIES: readonly VariantPolicy[] = [
  { id: 'A', version: 'variant-policy.v1', label: 'BALANCED', visualAreaWeight: 0.2, textCapacityWeight: 2 },
  { id: 'B', version: 'variant-policy.v1', label: 'VISUAL_FIRST', visualAreaWeight: 8, textCapacityWeight: 0.05 },
  { id: 'C', version: 'variant-policy.v1', label: 'DATA_FIRST', visualAreaWeight: 1.5, textCapacityWeight: 3 },
];

export interface PlacementBox {
  x: number;
  y: number;
  width: number;
  height: number;
  unit: 'EMU';
}

export interface SlotEvidence {
  role: 'title' | 'body' | 'visual';
  geometry: PlacementBox;
  provenance: 'explicit_placeholder' | 'inferred_exemplar';
  confidence: number;
  sampleCount: number;
  sourceEvidence: Array<{
    sourcePart: string;
    slideIndex: number | null;
    elementId: string;
    kind: string;
    geometry: PlacementBox;
    fontSizesPt: number[] | null;
  }>;
  reasons: string[];
}

export interface LayoutMatchCandidate {
  layoutId: string;
  sourcePart: string;
  score: number;
  reasons: string[];
  evidence: {
    titleElementId: string | null;
    bodyElementId: string | null;
    visualElementId: string | null;
    measuredPlaceholderCount: number;
    unknownGeometryCount: number;
    textAreaRatio: number;
    visualAreaRatio: number;
  };
  scoreContributions: Array<{ feature: string; points: number }>;
  unknownReasons: string[];
  slotEvidence: { title: SlotEvidence | null; body: SlotEvidence | null; visual: SlotEvidence | null };
  titleBox: PlacementBox | null;
  bodyBox: PlacementBox | null;
  visualBox: PlacementBox | null;
}

export type CompatibleLayoutMatchCandidate = LayoutMatchCandidate & {
  slotEvidence: LayoutMatchCandidate['slotEvidence'] & { title: SlotEvidence; body: SlotEvidence };
  titleBox: PlacementBox;
  bodyBox: PlacementBox;
};

export interface CompiledSlide {
  id: string;
  sourceDeckPlanSlideId: string;
  intent: SlideIntent;
  layoutId: string;
  layoutSourcePart: string;
  variantId: PresentationVariantId;
  title: string;
  body: string[];
  visualization: {
    type: SemanticVisualType;
    sourceRefs: string[];
    status: 'none' | 'referenced' | 'unresolved';
    tableData: string[][] | null;
    tableCellRefs: string[][] | null;
    chartData: CompiledChartData | null;
    processSteps: Array<{ text: string; sourceRef: string }>;
    kpi: { label: string; value: string; sourceRefs: string[] } | null;
  };
  imageRefs: Array<{ contentUnitId: string; sourceId: string; sourcePath: string; mediaType: string; sha256: string }>;
  provenanceRefs: string[];
  placements: { title: PlacementBox; body: PlacementBox; visual: PlacementBox | null };
  layoutCandidates: CompatibleLayoutMatchCandidate[];
  selectedCandidateIndex: number;
}

export interface CompiledChartData {
  kind: 'column' | 'line';
  categories: string[];
  series: Array<{ name: string; nameSourceRef: string; values: number[]; sourceRefs: string[] }>;
  categorySourceRefs: string[];
  unit: string | null;
  title: string;
  provenanceRefs: string[];
}

export interface CompiledPresentation {
  schemaVersion: 1;
  id: string;
  variantId: PresentationVariantId;
  variantPolicyVersion: string;
  deckPlanId: string;
  deckPlanHash: string;
  contentIRHash: string;
  templateIRId: string;
  templateIRHash: string;
  slides: CompiledSlide[];
}

/** Facts and their evidence without variant-specific layout or rendering choices. */
export interface CanonicalFactualPayload {
  sourceSlideId: string;
  intent: SlideIntent;
  title: string;
  body: string[];
  provenanceRefs: string[];
  table: { values: string[][]; sourceRefs: string[][] } | null;
  chart: CompiledChartData | null;
  kpi: { label: string; value: string; sourceRefs: string[] } | null;
  process: Array<{ text: string; sourceRef: string }>;
  images: Array<{ sourceId: string; sha256: string }>;
}

const MIN_EXEMPLAR_SLIDES = 3;
const MIN_EXEMPLAR_SUPPORT = 0.6;
const MIN_SLOT_CONFIDENCE = 0.72;
const MAX_SLOT_EVIDENCE_RECORDS = 16;
const MAX_VISUAL_GEOMETRY_SEEDS = 128;
const MIN_BODY_FONT_PT = 7.5;
const MAX_BODY_FONT_PT = 24;
const BOTTOM_FURNITURE_TOP = 0.9;
const MAX_BOTTOM_FURNITURE_HEIGHT = 0.06;

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function area(box: TemplateGeometry | PlacementBox | null | undefined): number {
  return box && box.width > 0 && box.height > 0 ? box.width * box.height : 0;
}

function asBox(geometry: TemplateGeometry | null | undefined): PlacementBox | null {
  if (!geometry || geometry.unit !== 'EMU' || geometry.width <= 0 || geometry.height <= 0) return null;
  return { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height, unit: 'EMU' };
}

function fitVisualBoxToCanvas(box: PlacementBox, template: TemplateIR): PlacementBox | null {
  const left = Math.max(0, box.x);
  const top = Math.max(0, box.y);
  const right = Math.min(template.slideSize.width, box.x + box.width);
  const bottom = Math.min(template.slideSize.height, box.y + box.height);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top, unit: 'EMU' };
}

function intentFor(slide: DeckPlanSlide): SlideIntent {
  if (slide.narrativeRole === 'opening') return 'title';
  if (slide.narrativeRole === 'section-divider') return 'section';
  if (slide.narrativeRole === 'closing') return 'summary';
  if (['chart', 'table', 'kpi', 'comparison'].includes(slide.semanticVisualType)) return 'data';
  if (['image', 'diagram', 'timeline', 'process'].includes(slide.semanticVisualType)) return 'visual';
  return 'narrative';
}

function placeholderType(element: TemplateLayout['elements'][number]): string {
  return element.placeholder?.type?.toLowerCase().replaceAll('_', '').replaceAll('-', '') ?? '';
}

function isTitleSlot(element: TemplateLayout['elements'][number]): boolean {
  const type = placeholderType(element);
  const role = element.placeholder?.role?.toLowerCase() ?? '';
  return ['title', 'ctrtitle', 'subtitle'].includes(type) || ['title', 'subtitle'].includes(role);
}

function isBodySlot(element: TemplateLayout['elements'][number]): boolean {
  const type = placeholderType(element);
  const role = element.placeholder?.role?.toLowerCase() ?? '';
  return ['body', 'obj', 'content'].includes(type) || ['body', 'content'].includes(role);
}

function visualSlotType(element: TemplateLayout['elements'][number]): string | null {
  const type = placeholderType(element);
  if (['pic', 'chart', 'table', 'tbl', 'graphicframe'].includes(type)) return type === 'tbl' ? 'table' : type;
  const kind = element.kind.toLowerCase().replaceAll('_', '').replaceAll('-', '');
  if (['picture', 'image', 'chart', 'table', 'graphicframe'].includes(kind)) return ['picture', 'image'].includes(kind) ? 'pic' : kind;
  return null;
}

function requestedVisualSlot(slide: DeckPlanSlide): string | null {
  return slide.semanticVisualType === 'image' ? 'pic'
    : slide.semanticVisualType === 'chart' ? 'chart'
      : slide.semanticVisualType === 'table' ? 'table'
      : ['kpi', 'process', 'diagram', 'timeline', 'comparison'].includes(slide.semanticVisualType) ? 'any' : null;
}

type SlotSample = {
  slide: TemplateSlide;
  element: TemplateElement;
  box: PlacementBox;
};

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function normalizedBox(box: PlacementBox, width: number, height: number): [number, number, number, number] {
  return [box.x / width, box.y / height, box.width / width, box.height / height];
}

function consensus(samples: SlotSample[], template: TemplateIR, role: SlotEvidence['role'], reasons: string[]): SlotEvidence | null {
  const layoutSlides = template.slides.filter((slide) => slide.layoutId === samples[0]?.slide.layoutId);
  const distinctSlides = new Map(samples.map((sample) => [sample.slide.id, sample]));
  const unique = [...distinctSlides.values()];
  const support = layoutSlides.length ? unique.length / layoutSlides.length : 0;
  if (unique.length < MIN_EXEMPLAR_SLIDES || support < MIN_EXEMPLAR_SUPPORT) return null;
  const normalized = unique.map((sample) => normalizedBox(sample.box, template.slideSize.width, template.slideSize.height));
  const center = [0, 1, 2, 3].map((axis) => median(normalized.map((box) => box[axis]!)));
  const tolerances = role === 'title' ? [0.08, 0.08, 0.2, 0.14]
    : role === 'body' ? [0.12, 0.18, 0.2, 0.3]
      : [0.12, 0.12, 0.24, 0.24];
  const deviations = [0, 1, 2, 3].map((axis) => median(normalized.map((box) => Math.abs(box[axis]! - center[axis]!))));
  const consistency = Math.max(0, Math.min(1, 1 - deviations.reduce((sum, value, axis) => sum + value / tolerances[axis]!, 0) / 4));
  const confidence = 0.4 * support + 0.25 * Math.min(1, unique.length / 4) + 0.35 * consistency;
  if (consistency < 0.58 || confidence < MIN_SLOT_CONFIDENCE) return null;
  const geometry: PlacementBox = {
    x: Math.round(center[0]! * template.slideSize.width),
    y: Math.round(center[1]! * template.slideSize.height),
    width: Math.round(center[2]! * template.slideSize.width),
    height: Math.round(center[3]! * template.slideSize.height),
    unit: 'EMU',
  };
  if (geometry.width <= 0 || geometry.height <= 0) return null;
  return {
    role, geometry, provenance: 'inferred_exemplar', confidence: Number(confidence.toFixed(4)), sampleCount: unique.length,
    sourceEvidence: unique.slice(0, MAX_SLOT_EVIDENCE_RECORDS).map(({ slide, element, box }) => ({
      sourcePart: slide.sourcePart, slideIndex: slide.index, elementId: element.id, kind: element.kind,
      geometry: box, fontSizesPt: element.directStyles.fontSizesPt,
    })),
    reasons: [...reasons, `repeated across ${unique.length} of ${layoutSlides.length} slides using the same layout`, `normalized geometry consistency ${consistency.toFixed(2)}`],
  };
}

function validSlideBox(box: PlacementBox, template: TemplateIR): boolean {
  return box.x >= 0 && box.y >= 0 && box.x + box.width <= template.slideSize.width * 1.01
    && box.y + box.height <= template.slideSize.height * 1.01;
}

function fontMax(element: TemplateElement): number {
  return Math.max(0, ...(element.directStyles.fontSizesPt ?? []));
}

function inferTitle(layout: TemplateLayout, template: TemplateIR): SlotEvidence | null {
  const slides = template.slides.filter((slide) => slide.layoutId === layout.id);
  const samples: SlotSample[] = [];
  for (const slide of slides) {
    const candidates = slide.elements.flatMap((element) => {
      const box = asBox(element.geometry.resolved ?? element.geometry.direct);
      const text = element.text?.trim() ?? '';
      if (!box || !validSlideBox(box, template) || element.kind.toLowerCase() !== 'shape' || element.parentId !== null
        || element.placeholder !== null || text.length < 2 || text.length > 240) return [];
      const [x, y, width, height] = normalizedBox(box, template.slideSize.width, template.slideSize.height);
      const size = fontMax(element);
      if (x > 0.35 || y > 0.32 || width < 0.24 || height < 0.025 || height > 0.24 || !(size >= 18 || size >= 14 && element.directStyles.bold === true)) return [];
      const score = Math.min(size, 60) / 60 + (1 - y) * 0.3 + Math.min(width, 0.95) * 0.2 - Math.max(0, text.length - 120) / 400;
      return [{ sample: { slide, element, box }, score }];
    }).sort((left, right) => right.score - left.score);
    if (candidates[0]) samples.push(candidates[0].sample);
  }
  return consensus(samples, template, 'title', ['selected top-left short text shapes with major typography; no semantic placeholder was present']);
}

function quantile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * fraction)]!;
}

function trimmedTextHull(samples: SlotSample[], template: TemplateIR): PlacementBox | null {
  if (!samples.length) return null;
  const coordinates = samples.map(({ box }) => [box.x, box.y, box.x + box.width, box.y + box.height]);
  const trim = samples.length >= 10 ? 0.05 : 0;
  const left = quantile(coordinates.map((item) => item[0]!), trim);
  const top = quantile(coordinates.map((item) => item[1]!), trim);
  const right = quantile(coordinates.map((item) => item[2]!), 1 - trim);
  const bottom = quantile(coordinates.map((item) => item[3]!), 1 - trim);
  const box = { x: left, y: top, width: right - left, height: bottom - top, unit: 'EMU' as const };
  return validSlideBox(box, template) ? box : null;
}

function balancedEvidence(samplesBySlide: SlotSample[][]): SlotSample[] {
  const result: SlotSample[] = [];
  for (let index = 0; result.length < MAX_SLOT_EVIDENCE_RECORDS; index += 1) {
    let added = false;
    for (const samples of samplesBySlide) {
      const sample = samples[index];
      if (!sample) continue;
      result.push(sample);
      added = true;
      if (result.length === MAX_SLOT_EVIDENCE_RECORDS) break;
    }
    if (!added) break;
  }
  return result;
}

function inferBody(layout: TemplateLayout, template: TemplateIR, title: SlotEvidence | null): SlotEvidence | null {
  if (!title) return null;
  const slides = template.slides.filter((slide) => slide.layoutId === layout.id);
  const samplesBySlide: SlotSample[][] = [];
  const regions: SlotSample[] = [];
  for (const slide of slides) {
    const slideTitle = title.sourceEvidence.find((item) => item.slideIndex === slide.index)?.geometry ?? title.geometry;
    const titleBottom = slideTitle.y + slideTitle.height;
    const textSamples = slide.elements.flatMap((element) => {
      const box = asBox(element.geometry.resolved ?? element.geometry.direct);
      const text = element.text?.trim() ?? '';
      if (!box || !validSlideBox(box, template) || element.kind.toLowerCase() !== 'shape' || element.parentId !== null
        || element.placeholder !== null || text.length < 4) return [];
      const [x, y, width, height] = normalizedBox(box, template.slideSize.width, template.slideSize.height);
      const fontSize = fontMax(element);
      if (box.y < titleBottom + template.slideSize.height * 0.005 || width < 0.08 || height < 0.018
        || area(box) < template.slideSize.width * template.slideSize.height * 0.0008
        || (fontSize > 0 && fontSize < MIN_BODY_FONT_PT)
        || fontSize > MAX_BODY_FONT_PT
        || (y >= BOTTOM_FURNITURE_TOP && height <= MAX_BOTTOM_FURNITURE_HEIGHT)) return [];
      return [{ slide, element, box, normalized: [x, y, width, height] }];
    });
    const candidateHull = trimmedTextHull(textSamples, template);
    if (!candidateHull) continue;
    const [x, y, width, height] = normalizedBox(candidateHull, template.slideSize.width, template.slideSize.height);
    if (width < 0.3 || height < 0.12 || area(candidateHull) < template.slideSize.width * template.slideSize.height * 0.055) continue;
    const ordered = textSamples.sort((left, right) => area(right.box) - area(left.box));
    samplesBySlide.push(ordered.map(({ slide: sourceSlide, element, box }) => ({ slide: sourceSlide, element, box })));
    const representative = ordered[0]!;
    regions.push({ slide, element: representative.element, box: candidateHull });
  }
  const evidence = consensus(regions, template, 'body', ['trimmed envelope of repeated lower-slide text; slide-local title, oversized typography, and thin bottom-edge furniture excluded']);
  if (!evidence) return null;
  evidence.sourceEvidence = balancedEvidence(samplesBySlide).map(({ slide, element, box }) => ({
    sourcePart: slide.sourcePart, slideIndex: slide.index, elementId: element.id, kind: element.kind,
    geometry: box, fontSizesPt: element.directStyles.fontSizesPt,
  }));
  return evidence;
}

function inferredVisual(layout: TemplateLayout, template: TemplateIR, requested: string | null): SlotEvidence | null {
  const slides = template.slides.filter((slide) => slide.layoutId === layout.id);
  const kinds = new Set<string>();
  for (const slide of slides) for (const element of slide.elements) {
    const kind = visualSlotType(element as TemplateLayout['elements'][number]);
    if (kind && (requested === null || requested === 'any' || requested === kind || kind === 'graphicframe')) kinds.add(kind);
  }
  const candidates: SlotEvidence[] = [];
  for (const kind of kinds) {
    const samplesBySlide = slides.map((slide) => slide.elements.flatMap((element) => {
      const elementKind = visualSlotType(element as TemplateLayout['elements'][number]);
      const box = asBox(element.geometry.resolved ?? element.geometry.direct);
      if (!box || !validSlideBox(box, template) || elementKind !== kind
        || area(box) < template.slideSize.width * template.slideSize.height * 0.025) return [];
      return [{ slide, element, box }];
    }));
    const seeds = samplesBySlide.flat();
    if (seeds.length > MAX_VISUAL_GEOMETRY_SEEDS) return null;
    const tolerances = [0.12, 0.12, 0.24, 0.24];
    const inferred = new Map<string, SlotEvidence>();
    for (const seed of seeds) {
      const target = normalizedBox(seed.box, template.slideSize.width, template.slideSize.height);
      const samples = samplesBySlide.flatMap((onSlide) => {
        const nearest = onSlide.map((sample) => {
          const normalized = normalizedBox(sample.box, template.slideSize.width, template.slideSize.height);
          const differences = normalized.map((value, axis) => Math.abs(value - target[axis]!));
          return { sample, differences, distance: differences.reduce((sum, value) => sum + value, 0) };
        }).filter(({ differences }) => differences.every((difference, axis) => difference <= tolerances[axis]!))
          .sort((left, right) => left.distance - right.distance)[0];
        return nearest ? [nearest.sample] : [];
      });
      const evidence = consensus(samples, template, 'visual', [
        `repeated native ${kind} objects with matching geometry; no arbitrary shape was treated as a visual slot`,
      ]);
      if (evidence) {
        const signature = samples.map(({ slide, element }) => `${slide.id}:${element.id}`).sort().join('|');
        inferred.set(signature, evidence);
      }
    }
    candidates.push(...inferred.values());
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

function explicitEvidence(element: TemplateElement | undefined, role: SlotEvidence['role'], sourcePart: string): SlotEvidence | null {
  if (!element) return null;
  const geometry = asBox(element.geometry.resolved ?? element.geometry.direct);
  if (!geometry) return null;
  return {
    role, geometry, provenance: 'explicit_placeholder', confidence: 1, sampleCount: 1,
    sourceEvidence: [{ sourcePart, slideIndex: null, elementId: element.id, kind: element.kind, geometry, fontSizesPt: element.directStyles.fontSizesPt }],
    reasons: [`explicit ${role} placeholder with resolved TemplateIR geometry`],
  };
}

function profile(layout: TemplateLayout, template: TemplateIR, slide: DeckPlanSlide): {
  titleSlot: SlotEvidence | null;
  bodySlot: SlotEvidence | null;
  visualSlot: SlotEvidence | null;
  titleElementId: string | null;
  bodyElementId: string | null;
  visualElementId: string | null;
  titleArea: number;
  textArea: number;
  visualArea: number;
  slotCount: number;
  measuredPlaceholderCount: number;
  unknownGeometryCount: number;
} {
  const geometries = layout.elements.map((element) => ({ element, box: asBox(element.geometry.resolved ?? element.geometry.direct) }))
    .filter((item): item is { element: TemplateLayout['elements'][number]; box: PlacementBox } => item.box !== null);
  const titleElement = geometries.filter(({ element }) => isTitleSlot(element)).sort((left, right) => area(right.box) - area(left.box))[0]?.element;
  const bodyElement = geometries.filter(({ element }) => isBodySlot(element)).sort((left, right) => area(right.box) - area(left.box))[0]?.element;
  const requested = requestedVisualSlot(slide);
  const visualElement = geometries.filter(({ element }) => {
    const type = visualSlotType(element);
    return type !== null && (requested === null || requested === 'any' || type === requested || type === 'graphicframe');
  }).sort((left, right) => area(right.box) - area(left.box))[0]?.element;
  const titleSlot = explicitEvidence(titleElement, 'title', layout.sourcePart) ?? inferTitle(layout, template);
  const bodySlot = explicitEvidence(bodyElement, 'body', layout.sourcePart) ?? inferBody(layout, template, titleSlot);
  const visualSlot = explicitEvidence(visualElement, 'visual', layout.sourcePart) ?? inferredVisual(layout, template, requested);
  const explicit = geometries.filter(({ element }) => element.placeholder !== null);
  const unknownGeometryCount = layout.elements.filter((element) => element.placeholder !== null
    && asBox(element.geometry.resolved ?? element.geometry.direct) === null).length;
  return {
    titleSlot, bodySlot, visualSlot,
    titleElementId: titleElement?.id ?? titleSlot?.sourceEvidence[0]?.elementId ?? null,
    bodyElementId: bodyElement?.id ?? bodySlot?.sourceEvidence[0]?.elementId ?? null,
    visualElementId: visualElement?.id ?? visualSlot?.sourceEvidence[0]?.elementId ?? null,
    titleArea: area(titleSlot?.geometry), textArea: area(bodySlot?.geometry), visualArea: area(visualSlot?.geometry),
    slotCount: explicit.length, measuredPlaceholderCount: explicit.length, unknownGeometryCount,
  };
}

function matchLayouts(slide: DeckPlanSlide, template: TemplateIR, policy: VariantPolicy): LayoutMatchCandidate[] {
  if (template.layouts.length === 0) throw new TypeError('TemplateIR has no layouts to compile against');
  const intent = intentFor(slide);
  const totalArea = template.slideSize.width * template.slideSize.height;
  const ranked = template.layouts.map((layout) => {
    const features = profile(layout, template, slide);
    const reasons: string[] = [];
    const unknownReasons: string[] = [];
    const scoreContributions: Array<{ feature: string; points: number }> = [];
    const titleRatio = features.titleArea / totalArea;
    const textRatio = features.textArea / totalArea;
    const visualRatio = features.visualArea / totalArea;
    let score = 0;
    const contribute = (feature: string, points: number, reason?: string) => {
      score += points;
      scoreContributions.push({ feature, points: Number(points.toFixed(6)) });
      if (reason) reasons.push(reason);
    };
    if (features.titleSlot) contribute('title-slot', 25 + Math.min(24, titleRatio * 120), `${features.titleSlot.provenance} title geometry, confidence ${features.titleSlot.confidence}`);
    else unknownReasons.push('no explicit title placeholder or repeated exemplar geometry passed the confidence gate');
    if (features.bodySlot) contribute('body-capacity', policy.textCapacityWeight * Math.min(30, textRatio * 90), `${features.bodySlot.provenance} body geometry, confidence ${features.bodySlot.confidence}`);
    else unknownReasons.push('no explicit body/content placeholder or repeated text-region geometry passed the confidence gate');
    if (visualRatio > 0) contribute('visual-capacity', policy.visualAreaWeight * Math.min(28, visualRatio * 100), `${features.visualSlot?.provenance} visual geometry, confidence ${features.visualSlot?.confidence}`);
    else if (slide.semanticVisualType !== 'none') unknownReasons.push('no explicit visual placeholder or repeated native visual-object geometry passed the confidence gate');
    contribute('placeholder-count', Math.min(8, features.slotCount), 'placeholder count is measured from layout elements');
    const requestedSlot = requestedVisualSlot(slide);
    const matchingVisual = layout.elements.some((element) => visualSlotType(element) === requestedSlot
      || requestedSlot !== null && (visualSlotType(element) === 'graphicframe' || requestedSlot === 'any' && visualSlotType(element) !== null));
    if (requestedSlot && (matchingVisual || features.visualSlot)) contribute('visual-type-match', 12 * Math.min(1, policy.visualAreaWeight / 4), features.visualSlot?.provenance === 'inferred_exemplar'
      ? 'contains repeated measured native visual-object geometry'
      : requestedSlot === 'any' ? 'contains a measured visual placeholder compatible with editable shapes' : `contains an explicit ${requestedSlot} placeholder`);
    else if (requestedSlot) unknownReasons.push(`no explicit ${requestedSlot} placeholder or repeated native visual object observed`);
    if (slide.targetDensity === 'detailed' && textRatio > 0) contribute('density-detail', Math.min(5, textRatio * 20), 'detailed density has measured body area');
    if (slide.targetDensity === 'compact' && textRatio > 0) contribute('density-compact', Math.max(0, 5 - textRatio * 20), 'compact density uses measured body area');
    if (intent === 'data' && visualRatio > 0) contribute('data-visual-fit', 6, 'provides measured visual area for data intent');
    if (intent === 'visual' && visualRatio > 0) contribute('visual-intent-fit', 6, 'provides measured visual area for visual intent');
    if (intent === 'narrative' && textRatio > 0) contribute('narrative-text-fit', 6, 'provides measured text capacity for narrative intent');
    if (intent === 'title' || intent === 'section' || intent === 'summary') reasons.push(`supports ${intent} intent through its title zone`);
    return {
      layoutId: layout.id,
      sourcePart: layout.sourcePart,
      score: Number(score.toFixed(6)),
      reasons,
      evidence: {
        titleElementId: features.titleElementId,
        bodyElementId: features.bodyElementId,
        visualElementId: features.visualElementId,
        measuredPlaceholderCount: features.measuredPlaceholderCount,
        unknownGeometryCount: features.unknownGeometryCount,
        textAreaRatio: Number(textRatio.toFixed(6)),
        visualAreaRatio: Number(visualRatio.toFixed(6)),
      },
      scoreContributions,
      unknownReasons,
      slotEvidence: { title: features.titleSlot, body: features.bodySlot, visual: features.visualSlot },
      titleBox: features.titleSlot?.geometry ?? null,
      bodyBox: features.bodySlot?.geometry ?? null,
      visualBox: features.visualSlot?.geometry ?? null,
    };
  });
  return ranked.sort((left, right) => right.score - left.score || (left.sourcePart < right.sourcePart ? -1 : left.sourcePart > right.sourcePart ? 1 : 0));
}

function textForUnit(unit: ContentUnit): string | null {
  if (typeof unit.text === 'string') return unit.text;
  if (typeof unit.cellValue === 'string') return unit.cellValue;
  if (typeof unit.numericLexeme === 'string') return unit.numericLexeme;
  return null;
}

function tableDataFor(units: ContentUnit[]): string[][] | null {
  const cells = units.filter((unit) => unit.kind === 'table-cell');
  if (!cells.length || cells.length !== units.length || new Set(cells.map((unit) => unit.sourceId)).size !== 1) return null;
  const positions = cells.map((unit) => ({
    row: unit.locator.rowIndex,
    column: unit.locator.columnIndex,
    value: unit.cellValue,
  }));
  if (positions.some((item) => !Number.isSafeInteger(item.row) || !Number.isSafeInteger(item.column) || typeof item.value !== 'string')) return null;
  const minRow = Math.min(...positions.map((item) => item.row!));
  const maxRow = Math.max(...positions.map((item) => item.row!));
  const minColumn = Math.min(...positions.map((item) => item.column!));
  const maxColumn = Math.max(...positions.map((item) => item.column!));
  if (positions.length !== (maxRow - minRow + 1) * (maxColumn - minColumn + 1)) return null;
  const grid = Array.from({ length: maxRow - minRow + 1 }, () => Array.from({ length: maxColumn - minColumn + 1 }, () => null as string | null));
  for (const item of positions) {
    const rowIndex = item.row! - minRow;
    const columnIndex = item.column! - minColumn;
    if (grid[rowIndex]![columnIndex] !== null) return null;
    grid[rowIndex]![columnIndex] = item.value!;
  }
  return grid.map((row) => row.map((cell) => cell ?? ''));
}

function tableCellRefsFor(units: ContentUnit[]): string[][] | null {
  const cells = units.filter((unit) => unit.kind === 'table-cell');
  if (!cells.length || cells.length !== units.length || new Set(cells.map((unit) => unit.sourceId)).size !== 1) return null;
  const positions = cells.map((unit) => ({ row: unit.locator.rowIndex, column: unit.locator.columnIndex, id: unit.id }));
  if (positions.some((item) => !Number.isSafeInteger(item.row) || !Number.isSafeInteger(item.column))) return null;
  const minRow = Math.min(...positions.map((item) => item.row!));
  const maxRow = Math.max(...positions.map((item) => item.row!));
  const minColumn = Math.min(...positions.map((item) => item.column!));
  const maxColumn = Math.max(...positions.map((item) => item.column!));
  if (positions.length !== (maxRow - minRow + 1) * (maxColumn - minColumn + 1)) return null;
  const grid = Array.from({ length: maxRow - minRow + 1 }, () => Array.from({ length: maxColumn - minColumn + 1 }, () => null as string | null));
  for (const item of positions) {
    const row = item.row! - minRow;
    const column = item.column! - minColumn;
    if (grid[row]![column] !== null) return null;
    grid[row]![column] = item.id;
  }
  if (grid.some((row) => row.some((cell) => cell === null))) return null;
  return grid as string[][];
}

function chartDataFor(units: ContentUnit[], title: string): CompiledChartData | null {
  const cells = units.filter((unit) => unit.kind === 'table-cell');
  if (cells.length !== units.length || cells.length < 4 || new Set(cells.map((unit) => unit.sourceId)).size !== 1) return null;
  const grid = tableDataFor(cells);
  if (!grid || grid.length < 2 || (grid[0]?.length ?? 0) < 2 || grid.some((row) => row.length !== grid[0]!.length)) return null;
  const minRow = Math.min(...cells.map((unit) => unit.locator.rowIndex!));
  const minColumn = Math.min(...cells.map((unit) => unit.locator.columnIndex!));
  const sourceCells = new Map(cells.map((unit) => [`${unit.locator.rowIndex! - minRow}:${unit.locator.columnIndex! - minColumn}`, unit]));
  const categories = grid.slice(1).map((row) => row[0]!);
  if (!categories.length || categories.some((item) => !item.trim())) return null;
  const series = grid[0]!.slice(1).map((name, seriesIndex) => {
    const column = seriesIndex + 1;
    const cellUnits = grid.slice(1).map((_row, rowIndex) => sourceCells.get(`${rowIndex + 1}:${column}`));
    if (!name.trim() || cellUnits.some((unit) => !unit || typeof unit.numericLexeme !== 'string')) return null;
    const values = cellUnits.map((unit) => Number(unit!.numericLexeme));
    if (values.some((value) => !Number.isFinite(value))) return null;
    return { name, nameSourceRef: sourceCells.get(`0:${column}`)!.id, values, sourceRefs: cellUnits.map((unit) => unit!.id) };
  });
  if (series.some((item) => item === null)) return null;
  const categorySourceRefs = grid.slice(1).map((_row, rowIndex) => sourceCells.get(`${rowIndex + 1}:0`)!.id);
  const headerRefs = grid[0]!.map((_cell, column) => sourceCells.get(`0:${column}`)!.id);
  const provenanceRefs = [...new Set([...categorySourceRefs, ...headerRefs, ...series.flatMap((item) => item!.sourceRefs)])];
  const periodCategories = categories.every((category) => /^(?:\d{4}(?:[-/]\d{1,2})?|Q[1-4](?:\s+\d{4})?)$/i.test(category.trim()));
  return {
    kind: periodCategories ? 'line' : 'column',
    categories,
    series: series as Array<{ name: string; nameSourceRef: string; values: number[]; sourceRefs: string[] }>,
    categorySourceRefs,
    unit: null,
    title,
    provenanceRefs,
  };
}

function processStepsFor(units: ContentUnit[]): Array<{ text: string; sourceRef: string }> {
  const textUnits = units.filter((unit) => unit.text && unit.kind !== 'json-value');
  if (textUnits.length < 2 || textUnits.some((unit) => !/^\s*(?:\d+[.)]|[-*•])\s+/.test(unit.text!))) return [];
  return textUnits.map((unit) => ({
    text: unit.text!.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, '').trim(),
    sourceRef: unit.id,
  }));
}

function kpiFor(units: ContentUnit[]): { label: string; value: string; sourceRefs: string[] } | null {
  const cells = units.filter((unit) => unit.kind === 'table-cell');
  const grid = cells.length === units.length ? tableDataFor(cells) : null;
  if (!grid || grid.length !== 2 || grid[0]?.length !== 2 || grid[1]?.length !== 2) return null;
  const minRow = Math.min(...cells.map((unit) => unit.locator.rowIndex!));
  const minColumn = Math.min(...cells.map((unit) => unit.locator.columnIndex!));
  const at = (row: number, column: number) => cells.find((unit) => unit.locator.rowIndex === minRow + row && unit.locator.columnIndex === minColumn + column);
  const labelCell = at(1, 0);
  const valueCell = at(1, 1);
  if (!labelCell?.cellValue?.trim() || !valueCell?.numericLexeme) return null;
  return { label: labelCell.cellValue, value: valueCell.cellValue!, sourceRefs: [labelCell.id, valueCell.id] };
}

export class UnsupportedTemplateLayoutError extends Error {
  readonly code = 'UNSUPPORTED_TEMPLATE_LAYOUT';
  readonly candidates: Array<{
    layoutId: string;
    sourcePart: string;
    reasons: string[];
    slots: LayoutMatchCandidate['slotEvidence'];
  }>;

  constructor(slideId: string, candidates: LayoutMatchCandidate[]) {
    const summary = candidates.map((candidate) => `${candidate.sourcePart}: ${candidate.unknownReasons.join('; ') || 'slot evidence was insufficient'}`).join(' | ');
    super(`Template has no measured or high-confidence inferred title and content slots compatible with DeckPlan slide ${slideId}.${summary ? ` ${summary}` : ''}`);
    this.name = 'UnsupportedTemplateLayoutError';
    this.candidates = candidates.map((candidate) => ({
      layoutId: candidate.layoutId, sourcePart: candidate.sourcePart, reasons: [...candidate.unknownReasons], slots: candidate.slotEvidence,
    }));
  }
}

function makeSlide(slide: DeckPlanSlide, contentIR: ContentIR, template: TemplateIR, policy: VariantPolicy): CompiledSlide {
  const byId = new Map(contentIR.units.map((unit) => [unit.id, unit]));
  const sourceById = new Map(contentIR.sources.map((source) => [source.id, source]));
  const referenced = slide.contentRefs.map((id) => {
    const unit = byId.get(id);
    if (!unit) throw new TypeError(`DeckPlan slide ${slide.id} refers to missing ContentIR unit ${id}`);
    return unit;
  });
  const tableData = slide.semanticVisualType === 'table' ? tableDataFor(referenced) : null;
  const tableCellRefs = tableData ? tableCellRefsFor(referenced) : null;
  const chartData = slide.semanticVisualType === 'chart' ? chartDataFor(referenced, slide.takeaway) : null;
  const processSteps = slide.semanticVisualType === 'process' ? processStepsFor(referenced) : [];
  const kpi = slide.semanticVisualType === 'kpi' ? kpiFor(referenced) : null;
  const body = referenced.flatMap((unit) => {
    if ((tableData || chartData || kpi) && unit.kind === 'table-cell') return [];
    const value = textForUnit(unit);
    return value === null || !value.trim() ? [] : [value];
  });
  const mediaRefs = (slide.mediaRefs ?? []).map((id) => byId.get(id)).filter((unit): unit is ContentUnit => unit?.kind === 'media-reference');
  const imageRefs = mediaRefs.flatMap((unit) => {
    const source = sourceById.get(unit.sourceId);
    return source?.kind === 'image' ? [{ contentUnitId: unit.id, sourceId: source.id, sourcePath: source.sourcePath, mediaType: source.mediaType, sha256: source.sha256 }] : [];
  });
  const hasNativeVisual = Boolean(tableData || chartData || processSteps.length >= 2 || kpi);
  const requiresVisualSlot = imageRefs.length > 0 || hasNativeVisual;
  const allCandidates = matchLayouts(slide, template, policy);
  const layoutCandidates = allCandidates.filter((candidate): candidate is CompatibleLayoutMatchCandidate => {
    const hasTitle = candidate.slotEvidence.title !== null;
    const hasBody = candidate.slotEvidence.body !== null;
    const hasVisual = candidate.slotEvidence.visual !== null;
    const bodyCanHostVisual = body.length === 0
      || slide.semanticVisualType === 'process' && body.length <= processSteps.length;
    const contentHasSlot = imageRefs.length > 0
      ? hasVisual
      : !requiresVisualSlot || hasVisual || bodyCanHostVisual;
    return hasTitle && hasBody && contentHasSlot;
  });
  if (layoutCandidates.length === 0) throw new UnsupportedTemplateLayoutError(slide.id, allCandidates);
  const chosen = layoutCandidates[0]!;
  if (!chosen.titleBox || !chosen.bodyBox) throw new TypeError('Selected layout candidate lost required slot geometry');
  const visualStatus = slide.semanticVisualType === 'none'
    ? 'none'
    : tableData || imageRefs.length || chartData || processSteps.length >= 2 || kpi ? 'referenced' : 'unresolved';
  const visualPlacement = requiresVisualSlot && chosen.visualBox
    ? fitVisualBoxToCanvas(chosen.visualBox, template)
    : chosen.visualBox;
  if (requiresVisualSlot && chosen.visualBox && !visualPlacement) {
    throw new UnsupportedTemplateLayoutError(slide.id, allCandidates);
  }
  return {
    id: `compiled_${slide.id}_${policy.id}`,
    sourceDeckPlanSlideId: slide.id,
    intent: intentFor(slide),
    layoutId: chosen.layoutId,
    layoutSourcePart: chosen.sourcePart,
    variantId: policy.id,
    title: slide.takeaway,
    body,
    visualization: { type: slide.semanticVisualType, sourceRefs: [...slide.contentRefs], status: visualStatus, tableData, tableCellRefs, chartData, processSteps, kpi },
    imageRefs,
    provenanceRefs: [...slide.contentRefs],
    placements: { title: chosen.titleBox, body: chosen.bodyBox, visual: visualPlacement },
    layoutCandidates,
    selectedCandidateIndex: 0,
  };
}

/** Compile one shared semantic plan without adding facts or performing inference. */
export function compilePresentation(
  deckPlanValue: DeckPlan,
  contentIRValue: ContentIR,
  templateIRValue: TemplateIR,
  policy: VariantPolicy,
): CompiledPresentation {
  const contentIR = validateContentIR(contentIRValue);
  const templateIR = validateTemplateIR(templateIRValue);
  const deckPlan = validateDeckPlan(deckPlanValue,
    new Set(contentIR.units.filter((unit) => unit.kind !== 'media-reference').map((unit) => unit.id)),
    undefined,
    new Set(contentIR.units.filter((unit) => unit.kind === 'media-reference').map((unit) => unit.id)));
  if (!['A', 'B', 'C'].includes(policy.id) || !policy.version || !Number.isFinite(policy.visualAreaWeight)
      || !Number.isFinite(policy.textCapacityWeight) || policy.visualAreaWeight < 0 || policy.textCapacityWeight < 0) {
    throw new TypeError('Variant policy is invalid');
  }
  const payload = {
    schemaVersion: 1 as const,
    variantId: policy.id,
    variantPolicyVersion: policy.version,
    deckPlanId: deckPlan.id,
    deckPlanHash: deckPlan.hash,
    contentIRHash: contentIR.hash,
    templateIRId: templateIR.id,
    templateIRHash: templateIR.hash,
    slides: deckPlan.slides.map((slide) => makeSlide(slide, contentIR, templateIR, policy)),
  };
  return { ...payload, id: `compiled_${digest(payload).slice(0, 24)}` };
}

/** Canonical, variant-independent factual projection used to verify A/B/C equivalence. */
export function extractCanonicalFactualPayload(presentation: CompiledPresentation): CanonicalFactualPayload[] {
  return presentation.slides.map((slide) => ({
    sourceSlideId: slide.sourceDeckPlanSlideId,
    intent: slide.intent,
    title: slide.title,
    body: [...slide.body],
    provenanceRefs: [...slide.provenanceRefs],
    table: slide.visualization.tableData && slide.visualization.tableCellRefs
      ? { values: slide.visualization.tableData.map((row) => [...row]), sourceRefs: slide.visualization.tableCellRefs.map((row) => [...row]) }
      : null,
    chart: slide.visualization.chartData ? structuredClone(slide.visualization.chartData) : null,
    kpi: slide.visualization.kpi ? { ...slide.visualization.kpi, sourceRefs: [...slide.visualization.kpi.sourceRefs] } : null,
    process: slide.visualization.processSteps.map((step) => ({ ...step })),
    images: slide.imageRefs.map((image) => ({ sourceId: image.sourceId, sha256: image.sha256 })),
  }));
}
