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
  titleBox: PlacementBox;
  bodyBox: PlacementBox;
  visualBox: PlacementBox | null;
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
  layoutCandidates: LayoutMatchCandidate[];
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
  if (['picture', 'chart', 'table', 'graphicframe'].includes(kind)) return kind === 'picture' ? 'pic' : kind;
  return null;
}

function requestedVisualSlot(slide: DeckPlanSlide): string | null {
  return slide.semanticVisualType === 'image' ? 'pic'
    : slide.semanticVisualType === 'chart' ? 'chart'
      : slide.semanticVisualType === 'table' ? 'table'
        : ['kpi', 'process', 'diagram', 'timeline', 'comparison'].includes(slide.semanticVisualType) ? 'any' : null;
}

function profile(layout: TemplateLayout, template: TemplateIR, slide: DeckPlanSlide): {
  titleBox: PlacementBox;
  bodyBox: PlacementBox;
  visualBox: PlacementBox | null;
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
  const titleSlot = geometries.filter(({ element }) => isTitleSlot(element))
    .sort((left, right) => area(right.box) - area(left.box))[0];
  const bodySlot = geometries.filter(({ element }) => isBodySlot(element))
    .sort((left, right) => area(right.box) - area(left.box))[0];
  const requestedSlot = requestedVisualSlot(slide);
  const visualSlot = geometries.filter(({ element }) => {
    const type = visualSlotType(element);
    return type !== null && (requestedSlot === 'any' || type === requestedSlot || type === 'graphicframe');
  })
    .sort((left, right) => area(right.box) - area(left.box))[0];
  const title = titleSlot?.box;
  const body = bodySlot?.box;
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
  const visualArea = visualSlot ? area(visualSlot.box) : 0;
  const textArea = geometries.filter(({ element }) => isBodySlot(element))
    .reduce((sum, item) => sum + area(item.box), 0);
  const slotCount = geometries.filter(({ element }) => element.placeholder !== null).length;
  const measuredPlaceholderCount = geometries.filter(({ element }) => element.placeholder !== null).length;
  const unknownGeometryCount = layout.elements.filter((element) => element.placeholder !== null
    && asBox(element.geometry.resolved ?? element.geometry.direct) === null).length;
  return {
    titleBox, bodyBox, visualBox: visualSlot?.box ?? null,
    titleElementId: titleSlot?.element.id ?? null,
    bodyElementId: bodySlot?.element.id ?? null,
    visualElementId: visualSlot?.element.id ?? null,
    titleArea: area(title), textArea, visualArea, slotCount, measuredPlaceholderCount, unknownGeometryCount,
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
    if (features.titleArea > 0) contribute('measured-title-slot', 25 + Math.min(24, titleRatio * 120), 'has a measured title placeholder and bounds');
    else unknownReasons.push('no measured title placeholder geometry; fallback title placement is not evidence of template fit');
    if (textRatio > 0) contribute('text-capacity', policy.textCapacityWeight * Math.min(30, textRatio * 90), 'body capacity is measured from body/content placeholders');
    else unknownReasons.push('no measured body/content placeholder geometry');
    if (visualRatio > 0) contribute('visual-capacity', policy.visualAreaWeight * Math.min(28, visualRatio * 100), 'visual capacity is measured from an explicit picture/chart/table slot');
    else if (slide.semanticVisualType !== 'none') unknownReasons.push('no explicit visual placeholder geometry for this visual intent');
    contribute('placeholder-count', Math.min(8, features.slotCount), 'placeholder count is measured from layout elements');
    const requestedSlot = requestedVisualSlot(slide);
    const matchingVisual = layout.elements.some((element) => visualSlotType(element) === requestedSlot
      || requestedSlot !== null && (visualSlotType(element) === 'graphicframe' || requestedSlot === 'any' && visualSlotType(element) !== null));
    if (requestedSlot && matchingVisual) contribute('visual-type-match', 12 * Math.min(1, policy.visualAreaWeight / 4), requestedSlot === 'any'
      ? 'contains a measured visual placeholder compatible with editable shapes'
      : `contains an explicit ${requestedSlot} placeholder`);
    else if (requestedSlot) unknownReasons.push(`no explicit ${requestedSlot} placeholder observed`);
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
      titleBox: features.titleBox,
      bodyBox: features.bodyBox,
      visualBox: features.visualBox,
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

  constructor(slideId: string) {
    super(`Template has no measured title and content slots compatible with DeckPlan slide ${slideId}.`);
    this.name = 'UnsupportedTemplateLayoutError';
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
  const body = referenced.flatMap((unit) => {
    if (tableData && unit.kind === 'table-cell') return [];
    const value = textForUnit(unit);
    return value === null || !value.trim() ? [] : [value];
  });
  const mediaRefs = (slide.mediaRefs ?? []).map((id) => byId.get(id)).filter((unit): unit is ContentUnit => unit?.kind === 'media-reference');
  const imageRefs = mediaRefs.flatMap((unit) => {
    const source = sourceById.get(unit.sourceId);
    return source?.kind === 'image' ? [{ contentUnitId: unit.id, sourceId: source.id, sourcePath: source.sourcePath, mediaType: source.mediaType, sha256: source.sha256 }] : [];
  });
  const chartData = slide.semanticVisualType === 'chart' ? chartDataFor(referenced, slide.takeaway) : null;
  const processSteps = slide.semanticVisualType === 'process' ? processStepsFor(referenced) : [];
  const kpi = slide.semanticVisualType === 'kpi' ? kpiFor(referenced) : null;
  const hasNativeVisual = Boolean(tableData || chartData || processSteps.length >= 2 || kpi);
  const layoutCandidates = matchLayouts(slide, template, policy).filter((candidate) => {
    const hasTitle = candidate.evidence.titleElementId !== null;
    const hasBody = candidate.evidence.bodyElementId !== null;
    const hasVisual = candidate.evidence.visualElementId !== null;
    const contentHasSlot = body.length === 0
      ? !hasNativeVisual || hasVisual || hasBody
      : hasBody;
    return hasTitle && contentHasSlot;
  });
  if (layoutCandidates.length === 0) throw new UnsupportedTemplateLayoutError(slide.id);
  const chosen = layoutCandidates[0]!;
  const visualStatus = slide.semanticVisualType === 'none'
    ? 'none'
    : tableData || imageRefs.length || chartData || processSteps.length >= 2 || kpi ? 'referenced' : 'unresolved';
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
    placements: { title: chosen.titleBox, body: chosen.bodyBox, visual: chosen.visualBox },
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
