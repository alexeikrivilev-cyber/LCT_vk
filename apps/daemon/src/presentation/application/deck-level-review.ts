import type { ContentIR, ContentUnit } from '../domain/content-ir.js';
import { validateContentIR } from '../domain/content-ir.js';
import type { DeckPlan } from '../domain/deck-plan.js';
import type { CompiledPresentation, CompiledSlide, PresentationVariantId } from './slide-compilation.js';
import { extractCanonicalFactualPayload } from './slide-compilation.js';

export type DeckReviewSeverity = 'info' | 'warning' | 'error';
export type DeckReviewStatus = 'pass' | 'warning' | 'error' | 'unknown';

export interface DeckReviewFinding {
  id: string;
  severity: DeckReviewSeverity;
  ruleId: string;
  slideId: string | null;
  message: string;
  evidence: Record<string, string | number | boolean | null>;
}

export interface DeckReviewComposition {
  slideId: string;
  signature: string;
  archetype: string | null;
}

export interface DeckLevelReviewReport {
  schemaVersion: 1;
  reportKind: 'deck-level-review';
  planHash: string;
  contentIRHash: string;
  slideCount: number;
  status: DeckReviewStatus;
  findings: DeckReviewFinding[];
  trackFacts: 'passed' | 'failed' | 'not-checked';
  provenance: 'passed' | 'failed' | 'not-checked';
}

export function reviewDeckLevel(input: {
  deckPlan: DeckPlan;
  contentIR: ContentIR;
  compiledTracks?: readonly CompiledPresentation[];
  compositionsByVariant?: Partial<Record<PresentationVariantId, readonly DeckReviewComposition[]>>;
}): DeckLevelReviewReport {
  const plan = input.deckPlan;
  const contentIR = validateContentIR(input.contentIR);
  const units = new Map(contentIR.units.map((unit) => [unit.id, unit]));
  const sources = new Map(contentIR.sources.map((source) => [source.id, source]));
  const findings: DeckReviewFinding[] = [];
  const add = (finding: Omit<DeckReviewFinding, 'id'>) => findings.push({ ...finding, id: `deck_review_${findings.length + 1}` });
  const titleOwners = new Map<string, string>();
  const bodyClaimOwners = new Map<string, string>();
  const refOwners = new Map<string, string>();
  const slideById = new Map(plan.slides.map((slide) => [slide.id, slide]));

  for (let index = 0; index < plan.slides.length; index += 1) {
    const slide = plan.slides[index]!;
    const titleKey = normalizedText(slide.takeaway);
    const previousTitle = titleOwners.get(titleKey);
    if (previousTitle) add({ severity: 'warning', ruleId: 'deck.repeated-title', slideId: slide.id,
      message: 'This slide repeats a normalized title from an earlier slide.', evidence: { previousSlideId: previousTitle } });
    else if (titleKey) titleOwners.set(titleKey, slide.id);

    for (const ref of slide.contentRefs) {
      const unit = units.get(ref);
      if (!unit || !sources.has(unit.sourceId)) {
        add({ severity: 'error', ruleId: 'deck.provenance-dangling-content-ref', slideId: slide.id,
          message: 'A plan content reference does not resolve through ContentIR to a source file.', evidence: { contentRef: ref } });
        continue;
      }
      if (unit.kind === 'media-reference') {
        add({ severity: 'error', ruleId: 'deck.provenance-media-used-as-fact', slideId: slide.id,
          message: 'A visual-only media reference is used as factual slide content.', evidence: { contentRef: ref } });
        continue;
      }
      const previousRef = refOwners.get(ref);
      if (previousRef && previousRef !== slide.id) add({ severity: 'warning', ruleId: 'deck.repeated-content-ref', slideId: slide.id,
        message: 'The same source unit is referenced by more than one slide.', evidence: { contentRef: ref, previousSlideId: previousRef } });
      else refOwners.set(ref, slide.id);

      const claim = sourceUnitText(unit);
      const claimKey = claim ? normalizedText(claim) : '';
      if (!claimKey || claimKey === titleKey) continue;
      const previousClaim = bodyClaimOwners.get(claimKey);
      if (previousClaim && previousClaim !== slide.id) add({ severity: 'warning', ruleId: 'deck.repeated-message', slideId: slide.id,
        message: 'The same normalized source claim is repeated on another slide.', evidence: { previousSlideId: previousClaim, contentRef: ref } });
      else bodyClaimOwners.set(claimKey, slide.id);
    }

    for (const ref of slide.mediaRefs ?? []) {
      const unit = units.get(ref);
      if (!unit || unit.kind !== 'media-reference' || !sources.has(unit.sourceId)) {
        add({ severity: 'error', ruleId: 'deck.provenance-dangling-media-ref', slideId: slide.id,
          message: 'A visual media reference does not resolve through ContentIR to a source file.', evidence: { mediaRef: ref } });
      }
    }
  }

  const openingIndexes = plan.slides.flatMap((slide, index) => slide.narrativeRole === 'opening' ? [index] : []);
  if (openingIndexes.length === 0) add({ severity: 'warning', ruleId: 'deck.cover-role-missing', slideId: plan.slides[0]?.id ?? null,
    message: 'The plan does not explicitly mark a cover slide.', evidence: { firstSlideRole: plan.slides[0]?.narrativeRole ?? null } });
  else if (openingIndexes[0] !== 0) add({ severity: 'warning', ruleId: 'deck.cover-not-first', slideId: plan.slides[openingIndexes[0]!]!.id,
    message: 'The opening slide is not first in the deck.', evidence: { openingPosition: openingIndexes[0]! + 1 } });
  if (openingIndexes.length > 1) add({ severity: 'warning', ruleId: 'deck.multiple-covers', slideId: null,
    message: 'The plan marks more than one slide as the cover.', evidence: { openingCount: openingIndexes.length } });

  const closingIndexes = plan.slides.flatMap((slide, index) => slide.narrativeRole === 'closing' ? [index] : []);
  for (const index of closingIndexes.filter((value) => value !== plan.slides.length - 1)) {
    add({ severity: 'error', ruleId: 'deck.closing-in-middle', slideId: plan.slides[index]!.id,
      message: 'A closing slide appears before the end of the deck.', evidence: { position: index + 1, slideCount: plan.slides.length } });
  }
  if (closingIndexes.length > 1) add({ severity: 'warning', ruleId: 'deck.multiple-closings', slideId: null,
    message: 'The plan marks more than one slide as the closing slide.', evidence: { closingCount: closingIndexes.length } });

  const compiledTracks = input.compiledTracks ?? [];
  let trackFacts: DeckLevelReviewReport['trackFacts'] = 'not-checked';
  let provenance: DeckLevelReviewReport['provenance'] = findings.some((finding) => finding.ruleId.startsWith('deck.provenance-')) ? 'failed' : 'not-checked';
  if (compiledTracks.length) {
    const expectedIds = plan.slides.map((slide) => slide.id);
    const variants = new Set(compiledTracks.map((track) => track.variantId));
    const commonPlan = compiledTracks.every((track) => track.deckPlanHash === plan.hash && track.contentIRHash === contentIR.hash
      && track.slides.map((slide) => slide.sourceDeckPlanSlideId).join('\0') === expectedIds.join('\0'));
    if (!commonPlan || variants.size !== compiledTracks.length) {
      add({ severity: 'error', ruleId: 'deck.track-input-divergence', slideId: null,
        message: 'Compiled tracks do not share the same plan, source content, order, or unique track identities.', evidence: { trackCount: compiledTracks.length, uniqueVariantCount: variants.size } });
      provenance = 'failed';
      trackFacts = 'failed';
    } else if (['A', 'B', 'C'].every((variant) => variants.has(variant as PresentationVariantId))) {
      const payloads = compiledTracks.map((track) => JSON.stringify(extractCanonicalFactualPayload(track)));
      trackFacts = payloads.every((payload) => payload === payloads[0]) ? 'passed' : 'failed';
      if (trackFacts === 'failed') add({ severity: 'error', ruleId: 'deck.track-factual-divergence', slideId: null,
        message: 'A/B/C tracks do not preserve the same factual content and provenance.', evidence: { trackCount: compiledTracks.length } });
    }

    for (const track of compiledTracks) for (const compiled of track.slides) {
      const planned = slideById.get(compiled.sourceDeckPlanSlideId);
      if (!planned) continue;
      verifyCompiledProvenance(compiled, planned.contentRefs, planned.mediaRefs ?? [], units, sources, add);
    }
    if (findings.some((finding) => finding.severity === 'error')) provenance = 'failed';
    else provenance = 'passed';
  }

  let compositionEvidenceAvailable = false;
  for (const variant of ['A', 'B', 'C'] as const) {
    const evidence = input.compositionsByVariant?.[variant];
    if (!evidence || evidence.length !== plan.slides.length || evidence.some((item, index) => item.slideId !== plan.slides[index]?.id)) continue;
    compositionEvidenceAvailable = true;
    const signatures = evidence.map((item) => item.signature).filter(Boolean);
    if (signatures.length === plan.slides.length && new Set(signatures).size === 1 && signatures.length > 1) {
      add({ severity: 'warning', ruleId: 'deck.track-single-composition', slideId: null,
        message: `Track ${variant} uses one exact projected composition for every slide.`, evidence: { variant, slideCount: signatures.length, uniqueCompositionCount: 1 } });
    }
    for (let index = 0; index <= evidence.length - 3; index += 1) {
      const archetypes = evidence.slice(index, index + 3).map((item) => item.archetype);
      if (archetypes[0] && archetypes.every((archetype) => archetype === archetypes[0])) {
        add({ severity: 'warning', ruleId: 'deck.three-adjacent-same-archetype', slideId: evidence[index + 2]!.slideId,
          message: `Track ${variant} repeats one template archetype across three adjacent slides.`, evidence: { variant, startPosition: index + 1, archetype: archetypes[0] } });
      }
    }
  }
  if (!compositionEvidenceAvailable) add({ severity: 'info', ruleId: 'deck.composition-unknown', slideId: null,
    message: 'Rendered whole-track composition evidence was not supplied; repeated compositions remain unverified.', evidence: {} });

  const hasError = findings.some((finding) => finding.severity === 'error');
  const hasWarning = findings.some((finding) => finding.severity === 'warning');
  const hasUnknown = findings.some((finding) => finding.severity === 'info');
  return {
    schemaVersion: 1,
    reportKind: 'deck-level-review',
    planHash: plan.hash,
    contentIRHash: contentIR.hash,
    slideCount: plan.slides.length,
    status: hasError ? 'error' : hasWarning ? 'warning' : hasUnknown ? 'unknown' : 'pass',
    findings,
    trackFacts,
    provenance,
  };
}

function verifyCompiledProvenance(
  slide: CompiledSlide,
  contentRefs: readonly string[],
  mediaRefs: readonly string[],
  units: ReadonlyMap<string, ContentUnit>,
  sources: ReadonlyMap<string, ContentIR['sources'][number]>,
  add: (finding: Omit<DeckReviewFinding, 'id'>) => void,
): void {
  const content = new Set(contentRefs);
  const media = new Set(mediaRefs);
  const checkRef = (ref: string, channel: 'fact' | 'media') => {
    const unit = units.get(ref);
    const source = unit ? sources.get(unit.sourceId) : null;
    if (!unit || !source || (channel === 'fact' && (unit.kind === 'media-reference' || !content.has(ref)))
        || (channel === 'media' && (unit.kind !== 'media-reference' || !media.has(ref) || source.kind !== 'image'))) {
      add({ severity: 'error', ruleId: 'deck.provenance-compiled-visual-ref', slideId: slide.sourceDeckPlanSlideId,
        message: 'A rendered visualization reference is not linked to the planned source unit and original source file.', evidence: { contentRef: ref, channel } });
    }
  };
  for (const ref of slide.provenanceRefs) checkRef(ref, 'fact');
  for (const ref of slide.visualization.sourceRefs) checkRef(ref, 'fact');
  for (const ref of slide.visualization.tableCellRefs?.flat() ?? []) checkRef(ref, 'fact');
  for (const ref of slide.visualization.chartData?.provenanceRefs ?? []) checkRef(ref, 'fact');
  for (const ref of slide.visualization.kpi?.sourceRefs ?? []) checkRef(ref, 'fact');
  for (const step of slide.visualization.processSteps) checkRef(step.sourceRef, 'fact');
  for (const image of slide.imageRefs) checkRef(image.contentUnitId, 'media');

  for (let row = 0; row < (slide.visualization.tableData?.length ?? 0); row += 1) {
    for (let column = 0; column < (slide.visualization.tableData?.[row]?.length ?? 0); column += 1) {
      const ref = slide.visualization.tableCellRefs?.[row]?.[column];
      const unit = ref ? units.get(ref) : null;
      if (!unit || unit.kind !== 'table-cell' || unit.cellValue !== slide.visualization.tableData![row]![column]) {
        add({ severity: 'error', ruleId: 'deck.provenance-table-value-mismatch', slideId: slide.sourceDeckPlanSlideId,
          message: 'A rendered table value differs from its exact ContentIR source cell.', evidence: { row, column, contentRef: ref ?? null } });
      }
    }
  }
  const chartData = slide.visualization.chartData;
  for (let index = 0; index < (chartData?.categories.length ?? 0); index += 1) {
    const ref = chartData?.categorySourceRefs[index];
    const unit = ref ? units.get(ref) : null;
    if (!unit || unit.kind !== 'table-cell' || unit.cellValue !== chartData!.categories[index]) {
      add({ severity: 'error', ruleId: 'deck.provenance-chart-category-mismatch', slideId: slide.sourceDeckPlanSlideId,
        message: 'A rendered chart category differs from its cited source cell.', evidence: { categoryIndex: index, contentRef: ref ?? null } });
    }
  }
  for (const series of chartData?.series ?? []) {
    const nameUnit = units.get(series.nameSourceRef);
    if (!nameUnit || nameUnit.kind !== 'table-cell' || nameUnit.cellValue !== series.name) {
      add({ severity: 'error', ruleId: 'deck.provenance-chart-series-name-mismatch', slideId: slide.sourceDeckPlanSlideId,
        message: 'A rendered chart series label differs from its cited source header.', evidence: { series: series.name, contentRef: series.nameSourceRef } });
    }
    for (let index = 0; index < series.values.length; index += 1) {
      const ref = series.sourceRefs[index];
      const unit = ref ? units.get(ref) : null;
      const value = unit?.numericLexeme === undefined ? NaN : Number(unit.numericLexeme);
      if (!unit || unit.kind !== 'table-cell' || !Number.isFinite(value) || value !== series.values[index]) {
        add({ severity: 'error', ruleId: 'deck.provenance-chart-value-mismatch', slideId: slide.sourceDeckPlanSlideId,
          message: 'A rendered chart value does not match its cited numeric source cell.', evidence: { series: series.name, valueIndex: index, contentRef: ref ?? null } });
      }
    }
  }
  for (const step of slide.visualization.processSteps) {
    const unit = units.get(step.sourceRef);
    const expected = unit?.text?.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, '').trim();
    if (!unit || expected !== step.text) add({ severity: 'error', ruleId: 'deck.provenance-process-label-mismatch', slideId: slide.sourceDeckPlanSlideId,
      message: 'A diagram/process label differs from its cited source text.', evidence: { contentRef: step.sourceRef } });
  }
  for (const image of slide.imageRefs) {
    const source = sources.get(image.sourceId);
    if (!source || source.kind !== 'image' || source.sha256 !== image.sha256) add({ severity: 'error', ruleId: 'deck.provenance-image-source-mismatch', slideId: slide.sourceDeckPlanSlideId,
      message: 'A placed image does not match the source media hash recorded in ContentIR.', evidence: { contentUnitId: image.contentUnitId } });
  }
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').replace(/^\s{0,3}#{1,6}(?:[\t ]+|$)/u, '').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function sourceUnitText(unit: ContentUnit): string | null {
  if (typeof unit.text === 'string') return unit.text;
  if (typeof unit.cellValue === 'string') return unit.cellValue;
  return null;
}
