import { createHash } from 'node:crypto';

import type { DeckPlanDraftSlide } from '../domain/deck-plan.js';
import type { TemplateContentMode, TemplateSemanticProfile, TemplateSlideArchetype } from './template-semantic-profiler.js';

export const PLANNING_CONTENT_BUDGET_VERSION = 'fit-aware-copy-budget.v1';
const EMU_PER_INCH = 914_400;
const PIXELS_PER_INCH = 96;
const MAX_TITLE_CHARACTERS = 40;
const MAX_BODY_POINT_CHARACTERS = 180;

export interface TextRegionBudget {
  maxCharacters: number;
  maxLines: number;
  maxCharactersPerLine: number;
}

export interface PlanningContentBudgetFamily {
  familyKey: string;
  archetype: TemplateSlideArchetype;
  supportedContentModes: TemplateContentMode[];
  titleRegion: TextRegionBudget;
  bodyRegions: TextRegionBudget[];
  body: {
    maxCharacters: number;
    maxPoints: number;
    maxCharactersPerPoint: number;
  };
}

export interface PlanningContentBudgets {
  version: typeof PLANNING_CONTENT_BUDGET_VERSION;
  profileSha256: string;
  candidateFamilies: PlanningContentBudgetFamily[];
  slides: Array<{ order: number; candidateFamilyKeys: string[] }>;
}

export interface BudgetFontSpec {
  family: string;
  sizePx: number;
  bold: boolean;
  italic: boolean;
  letterSpacingPx: number;
}

export type BudgetTextMeasurer = (text: string, spec: BudgetFontSpec) => { widthPx: number; approximate?: boolean };

export interface RegionMetrics {
  widthEmu: number;
  heightEmu: number;
  fontFamily: string;
  fontSizePt: number;
  bold: boolean;
  italic: boolean;
  marginsEmu: { left: number; right: number; top: number; bottom: number };
  paragraphProperties: Array<{
    marL: number;
    marR: number;
    indent: number;
    lineSpacing: { kind: string; value: number } | null;
    spcBefPts: number;
    spcAftPts: number;
    bullet: string;
  }>;
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function pointsToPixels(value: number): number {
  return value * PIXELS_PER_INCH / 72;
}

function emuToPixels(value: number): number {
  return value * PIXELS_PER_INCH / EMU_PER_INCH;
}

function sampleAverageWidth(measurer: BudgetTextMeasurer, spec: BudgetFontSpec): { width: number; approximate: boolean } {
  const samples = [
    'абвгдежзийклмнопрстуфхцчшщъыьэюя',
    'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ',
    'abcdefghijklmnopqrstuvwxyz',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789 .,;:!?—–()/%',
  ];
  const results = samples.map((sample) => {
    const result = measurer(sample, spec);
    return { average: result.widthPx / Array.from(sample).length, approximate: result.approximate === true };
  });
  return {
    width: Math.max(...results.map((result) => result.average)),
    approximate: results.some((result) => result.approximate),
  };
}

/**
 * Derive a deliberately conservative character budget from the same effective
 * shape style inputs used by Office Kit. The preview text-layout audit remains
 * the final authority; these values only constrain planning copy.
 */
export function deriveTextRegionBudget(
  metrics: RegionMetrics,
  region: 'title' | 'body',
  measureText: BudgetTextMeasurer,
): TextRegionBudget | null {
  if (!isPositive(metrics.widthEmu) || !isPositive(metrics.heightEmu) || !isPositive(metrics.fontSizePt)) return null;
  const sizePx = pointsToPixels(metrics.fontSizePt);
  const spec: BudgetFontSpec = {
    family: metrics.fontFamily || 'Arial',
    sizePx,
    bold: metrics.bold,
    italic: metrics.italic,
    letterSpacingPx: 0,
  };
  const measured = sampleAverageWidth(measureText, spec);
  const approximate = measured.approximate || !metrics.fontFamily;
  // Keep a larger reserve when Fontkit had to substitute/estimate a face.
  const glyphWidthPx = measured.width * (approximate ? 1.55 : 1.3);
  if (!isPositive(glyphWidthPx)) return null;

  const leftInset = Math.max(0, metrics.marginsEmu.left, ...metrics.paragraphProperties.map((item) => item.marL + Math.max(0, item.indent)))
    + Math.max(0, ...metrics.paragraphProperties.map((item) => item.bullet === 'none' ? 0 : metrics.fontSizePt * 12_700 * 0.8));
  const rightInset = Math.max(0, metrics.marginsEmu.right, ...metrics.paragraphProperties.map((item) => item.marR));
  const textWidthPx = emuToPixels(metrics.widthEmu) - emuToPixels(leftInset) - emuToPixels(rightInset);
  const topBottomMarginsPx = emuToPixels(Math.max(0, metrics.marginsEmu.top) + Math.max(0, metrics.marginsEmu.bottom));
  const spacingPx = Math.max(0, ...metrics.paragraphProperties.map((item) => pointsToPixels(item.spcBefPts + item.spcAftPts)));
  const lineHeightPx = Math.max(sizePx * 1.2, ...metrics.paragraphProperties.map((item) => {
    const spacing = item.lineSpacing;
    if (!spacing || !Number.isFinite(spacing.value)) return sizePx * 1.2;
    if (spacing.kind === 'pct') return sizePx * Math.max(1.05, Math.min(1.6, spacing.value));
    if (spacing.kind === 'pts') return Math.max(sizePx * 1.05, pointsToPixels(spacing.value));
    return sizePx * 1.2;
  }));
  if (textWidthPx < glyphWidthPx || textWidthPx <= 0) return null;
  const maxCharactersPerLine = Math.max(1, Math.floor(textWidthPx / glyphWidthPx));
  const availableHeightPx = emuToPixels(metrics.heightEmu) - topBottomMarginsPx;
  const paragraphReserve = region === 'body' ? spacingPx * 2 : spacingPx;
  const maxLines = Math.max(0, Math.floor((availableHeightPx - paragraphReserve) / lineHeightPx));
  if (maxLines < 1) return null;
  const safety = approximate ? 0.5 : 0.62;
  const maxCharacters = Math.max(1, Math.floor(maxLines * maxCharactersPerLine * safety));
  return {
    maxCharacters: region === 'title' ? Math.min(MAX_TITLE_CHARACTERS, maxCharacters) : Math.min(MAX_BODY_POINT_CHARACTERS * 4, maxCharacters),
    maxLines,
    maxCharactersPerLine,
  };
}

function profileHash(profile: TemplateSemanticProfile | null): string {
  return createHash('sha256').update(JSON.stringify(profile ?? { basis: 'native-placeholder-roles' })).digest('hex');
}

export function planningContentProfileFingerprint(profile: TemplateSemanticProfile | null): string {
  return profileHash(profile);
}

function contentModesFor(visualType: DeckPlanDraftSlide['semanticVisualType']): TemplateContentMode[] {
  if (visualType === 'table' || visualType === 'comparison') return ['table', 'mixed'];
  if (visualType === 'chart' || visualType === 'kpi') return ['chart', 'metrics', 'mixed'];
  if (visualType === 'diagram' || visualType === 'process' || visualType === 'timeline') return ['diagram', 'mixed'];
  if (visualType === 'image') return ['image', 'mixed'];
  return ['text', 'mixed'];
}

function compatibleArchetypes(role: DeckPlanDraftSlide['narrativeRole']): TemplateSlideArchetype[] {
  if (role === 'opening') return ['cover', 'visual-led', 'content'];
  if (role === 'closing') return ['closing', 'section-divider', 'content', 'visual-led'];
  if (role === 'section-divider') return ['section-divider', 'content'];
  if (role === 'agenda') return ['content', 'content-split', 'content-dense', 'section-divider'];
  return ['content', 'content-split', 'content-dense', 'metric-evidence', 'table-data', 'visual-led'];
}

function familyFitsSlide(family: PlanningContentBudgetFamily, slide: DeckPlanDraftSlide): boolean {
  if (!compatibleArchetypes(slide.narrativeRole).includes(family.archetype)) return false;
  return contentModesFor(slide.semanticVisualType).some((mode) => family.supportedContentModes.includes(mode));
}

function familyFitsCopy(family: PlanningContentBudgetFamily, slide: DeckPlanDraftSlide): boolean {
  const titleLength = Array.from(slide.takeaway.trim()).length;
  const bodyLength = (slide.bodyPoints ?? []).reduce((sum, point) => sum + Array.from(point.text.trim()).length, 0);
  const largestRegion = Math.max(0, ...family.bodyRegions.map((region) => region.maxCharacters));
  return titleLength <= family.titleRegion.maxCharacters
    && (slide.bodyPoints?.length ?? 0) <= family.body.maxPoints
    && bodyLength <= family.body.maxCharacters
    && (slide.bodyPoints ?? []).every((point) => Array.from(point.text.trim()).length <= Math.min(MAX_BODY_POINT_CHARACTERS, family.body.maxCharactersPerPoint, largestRegion));
}

export function validateDraftAgainstContentBudgets(
  slides: readonly DeckPlanDraftSlide[],
  budgets: PlanningContentBudgets,
): void {
  for (let index = 0; index < slides.length; index += 1) {
    const slide = slides[index]!;
    const row = budgets.slides.find((item) => item.order === index + 1);
    const rowFamilies = new Set(row?.candidateFamilyKeys ?? []);
    const available = budgets.candidateFamilies.filter((family) => rowFamilies.has(family.familyKey));
    const candidates = available.filter((family) => familyFitsSlide(family, slide));
    const applicable = candidates.length ? candidates : available;
    if (!applicable.some((family) => familyFitsCopy(family, slide))) {
      throw new RangeError(`PLANNED_COPY_EXCEEDS_TEMPLATE_BUDGET at slide ${index + 1}`);
    }
  }
}

/** Assemble renderer-measured regions into a stable planner contract. */
export function assemblePlanningContentBudgets(input: {
  profileSha256: string;
  requestedSlideCount: number;
  families: Array<Omit<PlanningContentBudgetFamily, 'familyKey'>>;
}): PlanningContentBudgets {
  const byFamily = new Map<string, Omit<PlanningContentBudgetFamily, 'familyKey'>>();
  for (const family of input.families) {
    const normalized = { ...family, supportedContentModes: [...family.supportedContentModes].sort() };
    const key = JSON.stringify(normalized);
    if (!byFamily.has(key)) byFamily.set(key, normalized);
  }
  const candidateFamilies = [...byFamily.values()].sort((a, b) => a.archetype.localeCompare(b.archetype)
    || a.supportedContentModes.join(',').localeCompare(b.supportedContentModes.join(','))
    || a.titleRegion.maxCharacters - b.titleRegion.maxCharacters
    || a.body.maxCharacters - b.body.maxCharacters)
    .map((family, index) => ({ ...family, familyKey: `family-${index + 1}` }));
  if (!candidateFamilies.length) throw new TypeError('No qualified title/body text regions are available for planning budgets.');
  const slides = Array.from({ length: input.requestedSlideCount }, (_, index) => ({
    order: index + 1,
    candidateFamilyKeys: candidateFamilies.map((family) => family.familyKey),
  }));
  return { version: PLANNING_CONTENT_BUDGET_VERSION, profileSha256: input.profileSha256, candidateFamilies, slides };
}
