import { createHash } from 'node:crypto';

import { validateContentIR, type ContentIR, type ContentUnit } from '../domain/content-ir.js';
import { validateDeckPlan, type DeckPlan, type DeckPlanSlide, type SemanticVisualType } from '../domain/deck-plan.js';
import { validateTemplateIR, type TemplateGeometry, type TemplateIR, type TemplateLayout } from '../domain/template-ir.js';

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
  { id: 'A', version: 'variant-policy.v1', label: 'BALANCED', visualAreaWeight: 0.1, textCapacityWeight: 0.4 },
  { id: 'B', version: 'variant-policy.v1', label: 'VISUAL_FIRST', visualAreaWeight: 4, textCapacityWeight: 0.5 },
  { id: 'C', version: 'variant-policy.v1', label: 'DATA_FIRST', visualAreaWeight: 1.5, textCapacityWeight: 3 },
];

export interface PlacementBox {
  x: number;
  y: number;
  width: number;
  height: number;
  unit: 'EMU';
}

export interface LayoutMatchCandidate {
  layoutId: string;
  sourcePart: string;
  score: number;
  reasons: string[];
  titleBox: PlacementBox;
  bodyBox: PlacementBox;
}

export interface CompiledSlide {
  id: string;
  sourceDeckPlanSlideId: string;
  intent: SlideIntent;
  layoutId: string;
  layoutSourcePart: string;
  variantId: PresentationVariantId;
  title: string;
  body: string[];
  visualization: { type: SemanticVisualType; sourceRefs: string[]; status: 'none' | 'referenced' | 'unresolved'; tableData: string[][] | null };
  imageRefs: Array<{ contentUnitId: string; sourceId: string; sourcePath: string; sha256: string }>;
  provenanceRefs: string[];
  placements: { title: PlacementBox; body: PlacementBox };
  layoutCandidates: LayoutMatchCandidate[];
  selectedCandidateIndex: number;
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

const TEMPLATE_INSET = 457200;
const MIN_BOX = 1000;

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

function intentFor(slide: DeckPlanSlide): SlideIntent {
  if (slide.narrativeRole === 'opening') return 'title';
  if (slide.narrativeRole === 'section-divider') return 'section';
  if (slide.narrativeRole === 'closing') return 'summary';
  if (['chart', 'table', 'kpi', 'comparison'].includes(slide.semanticVisualType)) return 'data';
  if (['image', 'diagram', 'timeline', 'process'].includes(slide.semanticVisualType)) return 'visual';
  return 'narrative';
}

function roleOf(element: TemplateLayout['elements'][number]): string {
  return `${element.placeholder?.role ?? ''} ${element.placeholder?.type ?? ''} ${element.kind}`.toLowerCase();
}

function profile(layout: TemplateLayout, template: TemplateIR): {
  titleBox: PlacementBox;
  bodyBox: PlacementBox;
  titleArea: number;
  textArea: number;
  visualArea: number;
  slotCount: number;
} {
  const geometries = layout.elements.map((element) => ({ element, box: asBox(element.geometry.resolved ?? element.geometry.direct) }))
    .filter((item): item is { element: TemplateLayout['elements'][number]; box: PlacementBox } => item.box !== null);
  const title = geometries.filter(({ element }) => /title|ctrtitle|subtitle/.test(roleOf(element)))
    .sort((left, right) => area(right.box) - area(left.box))[0]?.box;
  const body = geometries.filter(({ element }) => /body|obj|content|text/.test(roleOf(element))
      && !/title|subtitle/.test(roleOf(element)))
    .sort((left, right) => area(right.box) - area(left.box))[0]?.box;
  const fallbackTitle: PlacementBox = {
    x: TEMPLATE_INSET,
    y: TEMPLATE_INSET,
    width: Math.max(MIN_BOX, template.slideSize.width - 2 * TEMPLATE_INSET),
    height: Math.max(MIN_BOX, Math.round(template.slideSize.height * 0.13)),
    unit: 'EMU',
  };
  const titleBox = title ?? fallbackTitle;
  const fallbackBodyY = Math.min(template.slideSize.height - TEMPLATE_INSET - MIN_BOX, titleBox.y + titleBox.height + TEMPLATE_INSET / 2);
  const fallbackBody: PlacementBox = {
    x: TEMPLATE_INSET,
    y: Math.max(TEMPLATE_INSET, fallbackBodyY),
    width: Math.max(MIN_BOX, template.slideSize.width - 2 * TEMPLATE_INSET),
    height: Math.max(MIN_BOX, template.slideSize.height - Math.max(TEMPLATE_INSET, fallbackBodyY) - TEMPLATE_INSET),
    unit: 'EMU',
  };
  const bodyBox = body ?? fallbackBody;
  const visualArea = geometries.filter(({ element }) => /pic|chart|table|graphic|media|image/.test(roleOf(element)))
    .reduce((sum, item) => sum + area(item.box), 0);
  const textArea = geometries.filter(({ element }) => /body|obj|content|text/.test(roleOf(element)) && !/title|subtitle/.test(roleOf(element)))
    .reduce((sum, item) => sum + area(item.box), 0);
  const slotCount = geometries.filter(({ element }) => element.placeholder !== null).length;
  return { titleBox, bodyBox, titleArea: area(title), textArea, visualArea, slotCount };
}

function matchLayouts(slide: DeckPlanSlide, template: TemplateIR, policy: VariantPolicy): LayoutMatchCandidate[] {
  if (template.layouts.length === 0) throw new TypeError('TemplateIR has no layouts to compile against');
  const intent = intentFor(slide);
  const totalArea = template.slideSize.width * template.slideSize.height;
  const ranked = template.layouts.map((layout) => {
    const features = profile(layout, template);
    const reasons: string[] = [];
    const titleRatio = features.titleArea / totalArea;
    const textRatio = features.textArea / totalArea;
    const visualRatio = features.visualArea / totalArea;
    let score = 0;
    if (features.titleArea > 0) { score += 25; reasons.push('has a measured title zone'); }
    else reasons.push('uses a generic title zone because no title placeholder geometry was observed');
    score += Math.min(24, titleRatio * 120);
    score += policy.textCapacityWeight * Math.min(30, textRatio * 90);
    score += policy.visualAreaWeight * Math.min(28, visualRatio * 100);
    score += Math.min(8, features.slotCount);
    if (intent === 'data' && visualRatio > 0) { score += 12; reasons.push('provides measured chart/table/media area for data intent'); }
    if (intent === 'visual' && visualRatio > 0) { score += 12; reasons.push('provides measured visual area for visual intent'); }
    if (intent === 'narrative' && textRatio > 0) { score += 8; reasons.push('provides measured text capacity for narrative intent'); }
    if (intent === 'title' || intent === 'section' || intent === 'summary') reasons.push(`supports ${intent} intent through its title zone`);
    if (textRatio > 0) reasons.push('text capacity is measured from placeholder geometry');
    if (visualRatio > 0) reasons.push('visual capacity is measured from template element geometry');
    return {
      layoutId: layout.id,
      sourcePart: layout.sourcePart,
      score: Number(score.toFixed(6)),
      reasons,
      titleBox: features.titleBox,
      bodyBox: features.bodyBox,
    };
  });
  return ranked.sort((left, right) => right.score - left.score || left.sourcePart.localeCompare(right.sourcePart));
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

function makeSlide(slide: DeckPlanSlide, contentIR: ContentIR, template: TemplateIR, policy: VariantPolicy): CompiledSlide {
  const byId = new Map(contentIR.units.map((unit) => [unit.id, unit]));
  const sourceById = new Map(contentIR.sources.map((source) => [source.id, source]));
  const referenced = slide.contentRefs.map((id) => {
    const unit = byId.get(id);
    if (!unit) throw new TypeError(`DeckPlan slide ${slide.id} refers to missing ContentIR unit ${id}`);
    return unit;
  });
  const layoutCandidates = matchLayouts(slide, template, policy);
  const chosen = layoutCandidates[0]!;
  const tableData = slide.semanticVisualType === 'table' ? tableDataFor(referenced) : null;
  const body = referenced.flatMap((unit) => {
    if (tableData && unit.kind === 'table-cell') return [];
    const value = textForUnit(unit);
    return value === null || !value.trim() ? [] : [value];
  });
  const imageRefs = referenced.filter((unit) => unit.kind === 'media-reference').flatMap((unit) => {
    const source = sourceById.get(unit.sourceId);
    return source?.kind === 'image' ? [{ contentUnitId: unit.id, sourceId: source.id, sourcePath: source.sourcePath, sha256: source.sha256 }] : [];
  });
  const visualStatus = slide.semanticVisualType === 'none'
    ? 'none'
    : tableData || imageRefs.length ? 'referenced' : 'unresolved';
  return {
    id: `compiled_${slide.id}_${policy.id}`,
    sourceDeckPlanSlideId: slide.id,
    intent: intentFor(slide),
    layoutId: chosen.layoutId,
    layoutSourcePart: chosen.sourcePart,
    variantId: policy.id,
    title: slide.takeaway,
    body,
    visualization: { type: slide.semanticVisualType, sourceRefs: [...slide.contentRefs], status: visualStatus, tableData },
    imageRefs,
    provenanceRefs: [...slide.contentRefs],
    placements: { title: chosen.titleBox, body: chosen.bodyBox },
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
  const deckPlan = validateDeckPlan(deckPlanValue, new Set(contentIR.units.map((unit) => unit.id)));
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
