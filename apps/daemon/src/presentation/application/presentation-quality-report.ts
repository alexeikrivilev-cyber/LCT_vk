import type { ContentIR } from '../domain/content-ir.js';
import type { TemplateIR } from '../domain/template-ir.js';
import type { PptxRenderResult } from './pptx-backend-port.js';
import type { DeterministicAuditReport } from './deterministic-audit.js';
import type { CompiledPresentation, CompiledSlide, PlacementBox, PresentationVariantId } from './slide-compilation.js';
import { assessDeckCompositionDistinctness } from './deck-level-review.js';

export const PRESENTATION_QUALITY_CATEGORIES = [
  'hierarchy',
  'density',
  'overlap',
  'safe-area',
  'contrast',
  'alignment',
  'text-fit',
  'variant-distinctness',
  'template-consistency',
  'source-content-residue',
  'narrative-repetition',
  'provenance',
] as const;

export type PresentationQualityCategory = typeof PRESENTATION_QUALITY_CATEGORIES[number];
export type PresentationQualitySeverity = 'info' | 'warning' | 'error';
export type PresentationQualityStatus = 'pass' | 'warning' | 'error' | 'unknown' | 'not_applicable';

export interface PresentationQualityFinding {
  id: string;
  category: PresentationQualityCategory;
  severity: PresentationQualitySeverity;
  slideId: string | null;
  ruleId: string;
  message: string;
  evidence: Record<string, string | number | boolean | null>;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
}

export interface PresentationQualityReport {
  schemaVersion: 1;
  reportKind: 'presentation-quality';
  reportVersion: 'presentation-quality.v1';
  presentationId: string;
  variantId: PresentationVariantId;
  templateIRHash: string;
  contentIRHash: string;
  categories: Record<PresentationQualityCategory, {
    status: PresentationQualityStatus;
    severity: PresentationQualitySeverity;
    findingCount: number;
    summary: string;
  }>;
  findings: PresentationQualityFinding[];
  trackStrategy: Record<PresentationVariantId, {
    slideCount: number;
    medianBodyAreaShare: number | null;
    medianVisualAreaShare: number | null;
    visualEvidenceSlides: number;
    selectedCompositionKinds: Record<string, number>;
  }>;
  contextualReview: Array<{
    id: 'takeaway-quality' | 'content-title-alignment' | 'one-sentence-summary' | 'visual-relevance' | 'adjacent-slide-coherence';
    status: 'manual-review-required';
    reason: string;
  }>;
  deterministicSafetyAuditIsSeparate: true;
}

/** Hard qualification blockers; heuristic pre-render capacity estimates remain review evidence. */
export function presentationQualityBlockers(report: PresentationQualityReport): PresentationQualityFinding[] {
  return report.findings.filter((finding) => finding.severity === 'error'
    && !(finding.ruleId === 'text-fit.pre-render-capacity-exceeded' && finding.confidence === 'medium')
    || finding.ruleId === 'template-consistency.track-strategy-not-distinct' && finding.severity === 'warning');
}

export interface PresentationQualityCompositionEvidence {
  signaturesByVariant: Partial<Record<PresentationVariantId, readonly string[]>>;
  kindsByVariant?: Partial<Record<PresentationVariantId, readonly string[]>>;
}

export interface PresentationQualityPreviewEvidence {
  slideIndex?: number;
  textLayoutIssues?: readonly unknown[];
  geometryIssues?: readonly unknown[];
}

export interface BuildPresentationQualityReportInput {
  presentation: CompiledPresentation;
  contentIR: ContentIR;
  templateIR: TemplateIR;
  tracks?: readonly CompiledPresentation[];
  composition?: PresentationQualityCompositionEvidence;
  renderEvidence?: PptxRenderResult['qualityEvidence'];
  previewEvidence?: readonly PresentationQualityPreviewEvidence[];
  safetyAudit?: DeterministicAuditReport;
}

function overlaps(left: PlacementBox, right: PlacementBox): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x
    && left.y < right.y + right.height && left.y + left.height > right.y;
}

function inCanvas(box: PlacementBox, width: number, height: number): boolean {
  return box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height;
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').replace(/^\s{0,3}#{1,6}(?:[\t ]+|$)/u, '').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function slotFontSizes(slide: CompiledSlide, role: 'title' | 'body'): number[] {
  const candidate = slide.layoutCandidates[slide.selectedCandidateIndex];
  const slot = role === 'title' ? candidate?.slotEvidence.title : candidate?.slotEvidence.body;
  return (slot?.sourceEvidence ?? []).flatMap((item) => item.fontSizesPt ?? []).filter((size) => Number.isFinite(size) && size > 0);
}

function roleStyles(input: BuildPresentationQualityReportInput, slide: CompiledSlide, role: 'title' | 'body') {
  const rendered = input.renderEvidence?.textObjects.filter((item) => item.slideId === slide.id && item.role === role) ?? [];
  const renderedSizes = rendered.flatMap((item) => item.fontSizePt !== null ? [item.fontSizePt] : []);
  return {
    sizes: renderedSizes.length ? renderedSizes : slotFontSizes(slide, role),
    rendered,
  };
}

function bodyCapacityFit(slide: CompiledSlide, fontPt: number, renderEvidence?: BuildPresentationQualityReportInput['renderEvidence']): number | null {
  const renderedBody = renderEvidence?.textObjects.filter((item) => item.slideId === slide.id && item.role === 'body'
    && item.textLength > 0 && item.bounds && item.bounds.width > 0 && item.bounds.height > 0) ?? [];
  if (renderedBody.length) {
    const ratios = renderedBody.flatMap((item) => {
      const bounds = item.bounds!;
      const actualFontPt = item.fontSizePt ?? fontPt;
      if (actualFontPt <= 0) return [];
      const charsPerLine = Math.max(1, (bounds.width / 12700) / (actualFontPt * 0.58));
      const availableLines = Math.max(0.25, (bounds.height / 12700) / (actualFontPt * 1.2));
      return [Math.max(1, Math.ceil(item.textLength / charsPerLine)) / availableLines];
    });
    return ratios.length ? Math.max(...ratios) : null;
  }
  // A body-hosted process sequence is emitted as native visual nodes rather
  // than a body text region; do not estimate the same copy against an empty
  // compiled body placeholder.
  if (slide.visualization.processSteps.length >= 2) return null;
  const { width, height } = slide.placements.body;
  if (width <= 0 || height <= 0 || fontPt <= 0) return null;
  const widthPt = width / 12700;
  const heightPt = height / 12700;
  const charsPerLine = Math.max(6, widthPt / (fontPt * 0.52));
  const availableLines = Math.max(0.25, heightPt / (fontPt * 1.2));
  const requiredLines = Math.max(1, slide.body.reduce((count, line) => count + Math.max(1, Math.ceil(Array.from(line).length / charsPerLine)), 0));
  return requiredLines / availableLines;
}

function areaShare(box: PlacementBox | null, template: TemplateIR): number | null {
  if (!box || template.slideSize.width <= 0 || template.slideSize.height <= 0) return null;
  return box.width * box.height / (template.slideSize.width * template.slideSize.height);
}

function trackMetrics(input: BuildPresentationQualityReportInput): PresentationQualityReport['trackStrategy'] {
  const variants = ['A', 'B', 'C'] as const;
  const result = {} as PresentationQualityReport['trackStrategy'];
  for (const variant of variants) {
    const track = input.tracks?.find((candidate) => candidate.variantId === variant)
      ?? (input.presentation.variantId === variant ? input.presentation : undefined);
    const slides = track?.slides ?? [];
    const bodyShares = slides.map((slide) => areaShare(slide.placements.body, input.templateIR)).filter((share): share is number => share !== null);
    const hasComposedVisual = (slide: CompiledSlide) => slide.visualization.status === 'referenced'
      || Boolean(slide.visualization.tableData || slide.visualization.chartData || slide.visualization.kpi
        || slide.visualization.processSteps.length >= 2 || slide.imageRefs.length);
    const visualShares = slides.flatMap((slide) => hasComposedVisual(slide)
      ? [areaShare(slide.placements.visual ?? slide.placements.body, input.templateIR)] : []).filter((share): share is number => share !== null);
    const kinds = input.composition?.kindsByVariant?.[variant] ?? [];
    const selectedCompositionKinds: Record<string, number> = {};
    for (const kind of kinds) selectedCompositionKinds[kind] = (selectedCompositionKinds[kind] ?? 0) + 1;
    result[variant] = {
      slideCount: slides.length,
      medianBodyAreaShare: median(bodyShares),
      medianVisualAreaShare: median(visualShares),
      visualEvidenceSlides: visualShares.length,
      selectedCompositionKinds,
    };
  }
  return result;
}

/**
 * Replaceable, deterministic presentation-quality report. It complements the
 * deterministic safety audit and keeps unavailable visual/contextual evidence unknown.
 */
export function buildPresentationQualityReport(input: BuildPresentationQualityReportInput): PresentationQualityReport {
  const findings: PresentationQualityFinding[] = [];
  const add = (finding: Omit<PresentationQualityFinding, 'id'>) => findings.push({ ...finding, id: `quality_${finding.category}_${findings.length + 1}` });
  const reportCategories = Object.fromEntries(PRESENTATION_QUALITY_CATEGORIES.map((category) => [category, {
    status: 'unknown' as PresentationQualityStatus,
    severity: 'info' as PresentationQualitySeverity,
    findingCount: 0,
    summary: 'Evidence was not available for this category.',
  }])) as PresentationQualityReport['categories'];
  const trackStrategy = trackMetrics(input);

  for (const slide of input.presentation.slides) {
    const titleStyles = roleStyles(input, slide, 'title');
    const bodyStyles = roleStyles(input, slide, 'body');
    const titlePt = median(titleStyles.sizes);
    const bodyPt = median(bodyStyles.sizes);
    const templateBodyPt = median(slotFontSizes(slide, 'body'));
    if (titlePt !== null && bodyPt !== null) {
      const ratio = titlePt / bodyPt;
      if (ratio <= 1) add({ category: 'hierarchy', severity: 'error', slideId: slide.id, ruleId: 'hierarchy.title-not-prominent',
        message: 'Measured title typography is not larger than body typography.', evidence: { titlePt, bodyPt, ratio: Number(ratio.toFixed(3)) }, confidence: 'high' });
      else if (ratio < 1.15) add({ category: 'hierarchy', severity: 'warning', slideId: slide.id, ruleId: 'hierarchy.weak-title-emphasis',
        message: 'Title and body typography have only a narrow size difference.', evidence: { titlePt, bodyPt, ratio: Number(ratio.toFixed(3)) }, confidence: 'medium' });
      if (templateBodyPt !== null && bodyPt < templateBodyPt * 0.7) add({ category: 'hierarchy', severity: 'error', slideId: slide.id, ruleId: 'hierarchy.body-below-template-band',
        message: 'Rendered body text fell below the measured template body typography band.', evidence: { bodyPt, templateBodyReferencePt: templateBodyPt, relativeScale: Number((bodyPt / templateBodyPt).toFixed(3)) }, confidence: 'high' });
      if (bodyStyles.rendered.some((item) => item.autoFitScale !== null && item.autoFitScale < 0.7)) add({ category: 'hierarchy', severity: 'error', slideId: slide.id, ruleId: 'hierarchy.autofit-too-small',
        message: 'Template autofit reduced body text below 70% of its authored size.', evidence: { minimumScale: Math.min(...bodyStyles.rendered.flatMap((item) => item.autoFitScale !== null ? [item.autoFitScale] : [])) }, confidence: 'high' });
    }

    if (bodyPt !== null && slide.body.length) {
      const fitRatio = bodyCapacityFit(slide, bodyPt, input.renderEvidence);
      if (fitRatio !== null) {
        if (fitRatio > 1) add({ category: 'text-fit', severity: 'error', slideId: slide.id, ruleId: 'text-fit.pre-render-capacity-exceeded',
          message: 'Estimated body text exceeds measured template slot capacity.', evidence: { requiredToAvailableLineRatio: Number(fitRatio.toFixed(3)), bodyFontPt: bodyPt }, confidence: 'medium' });
        else if (fitRatio > 0.82) add({ category: 'text-fit', severity: 'warning', slideId: slide.id, ruleId: 'text-fit.pre-render-capacity-tight',
          message: 'Estimated body text uses nearly all measured template slot capacity.', evidence: { requiredToAvailableLineRatio: Number(fitRatio.toFixed(3)), bodyFontPt: bodyPt }, confidence: 'medium' });
        const utilization = fitRatio;
        if (utilization < 0.08 && !['title', 'summary'].includes(slide.intent) && slide.visualization.status !== 'referenced') {
          add({ category: 'density', severity: 'warning', slideId: slide.id, ruleId: 'density.sparse-body-region',
            message: 'The measured body region is mostly unused and the slide has no source-backed visual.', evidence: { estimatedSlotUtilization: Number(utilization.toFixed(4)), bodyCharacters: Array.from(slide.body.join(' ')).length }, confidence: 'low' });
        }
      }
    }

    const boxes = [slide.placements.title, slide.placements.body,
      ...(slide.visualization.status === 'referenced' && slide.placements.visual ? [slide.placements.visual] : [])];
    if (boxes.some((box) => !inCanvas(box, input.templateIR.slideSize.width, input.templateIR.slideSize.height))) {
      add({ category: 'safe-area', severity: 'error', slideId: slide.id, ruleId: 'safe-area.compiled-slot-outside-canvas',
        message: 'A generated content slot extends outside the template canvas.', evidence: { canvasWidth: input.templateIR.slideSize.width, canvasHeight: input.templateIR.slideSize.height }, confidence: 'high' });
    }
    if (overlaps(slide.placements.title, slide.placements.body)) add({ category: 'overlap', severity: 'error', slideId: slide.id, ruleId: 'overlap.title-body',
      message: 'Measured title and body regions overlap.', evidence: { titleBodyOverlap: true }, confidence: 'high' });
    if (slide.visualization.status === 'referenced' && slide.placements.visual
        && (overlaps(slide.placements.title, slide.placements.visual) || overlaps(slide.placements.body, slide.placements.visual))) {
      add({ category: 'overlap', severity: 'warning', slideId: slide.id, ruleId: 'overlap.content-visual',
        message: 'A source-backed visual region overlaps a text region.', evidence: { visualTextOverlap: true }, confidence: 'high' });
    }

    const expectedBoxes = { title: slide.placements.title, body: slide.placements.body };
    for (const role of ['title', 'body'] as const) {
      const actual = input.renderEvidence?.textObjects.filter((item) => item.slideId === slide.id && item.role === role && item.bounds) ?? [];
      if (!actual.length) continue;
      const expected = expectedBoxes[role];
      const outsideExpected = actual.filter((item) => {
        const box = item.bounds!;
        const toleranceX = expected.width * 0.015;
        const toleranceY = expected.height * 0.015;
        return box.x < expected.x - toleranceX || box.y < expected.y - toleranceY
          || box.x + box.width > expected.x + expected.width + toleranceX
          || box.y + box.height > expected.y + expected.height + toleranceY;
      });
      if (outsideExpected.length) add({ category: 'alignment', severity: 'warning', slideId: slide.id, ruleId: 'alignment.rendered-role-drift',
        message: 'Rendered text geometry drifted outside its compiled template role region.', evidence: { role, driftedShapeCount: outsideExpected.length }, confidence: 'medium' });
    }
  }

  const textIssues = input.previewEvidence?.flatMap((preview) => (preview.textLayoutIssues ?? []).filter((issue) => {
    if (preview.slideIndex === undefined || typeof issue !== 'object' || issue === null || !('slideIndex' in issue)
        || typeof issue.slideIndex !== 'number') return true;
    return issue.slideIndex === preview.slideIndex;
  })) ?? [];
  for (const issue of textIssues) {
    const record = typeof issue === 'object' && issue !== null ? issue as Record<string, unknown> : {};
    const officeKitEvidence = typeof record.source === 'string' && record.source.startsWith('@office-kit/');
    const approximate = record.approximate === true || record.confidence === 'low'
      || officeKitEvidence && record.classification === 'PREVIEW_TEXT_METRIC_APPROXIMATION';
    const severity = approximate ? 'warning' as const
      : record.severity === 'error' ? 'error' as const : 'warning' as const;
    add({ category: 'text-fit', severity, slideId: typeof record.slideIndex === 'number'
      ? input.presentation.slides[record.slideIndex]?.id ?? null : null,
    ruleId: approximate ? 'text-fit.approximate-metric-warning' : 'text-fit.rendered-layout-issue',
    message: approximate ? 'Rendered text-fit estimate is approximate; inspect the preview manually.' : 'Rendered text layout reports a potential overflow or unexpected wrap.',
    evidence: { source: officeKitEvidence ? 'office-kit-render-evidence' : 'preview-render-evidence',
      reportedSource: typeof record.source === 'string' ? record.source : null,
      classification: typeof record.classification === 'string' ? record.classification : 'unknown',
      kind: typeof record.kind === 'string' ? record.kind : 'unknown', approximate,
      overflowPx: typeof record.overflowPx === 'number' ? record.overflowPx : null,
      extraLines: typeof record.extraLines === 'number' ? record.extraLines : null },
      confidence: approximate ? 'low' : record.severity === 'error' ? 'high' : 'medium' });
  }

  if (input.safetyAudit) {
    const sourceRules = new Set(['integrity.broken-provenance', 'fidelity.unsupported-number', 'fidelity.table-source-reference',
      'fidelity.chart-source-reference', 'fidelity.chart-label-provenance']);
    for (const finding of input.safetyAudit.findings.filter((candidate) => sourceRules.has(candidate.ruleId))) {
      add({ category: 'provenance', severity: finding.severity, slideId: finding.slideId, ruleId: `provenance.${finding.ruleId}`,
        message: finding.message, evidence: finding.evidence, confidence: finding.severity === 'error' ? 'high' : 'medium' });
    }
  } else add({ category: 'provenance', severity: 'info', slideId: null, ruleId: 'provenance.safety-audit-unavailable',
    message: 'Source trace checks were not supplied; consult the deterministic safety audit.', evidence: {}, confidence: 'unknown' });

  const allSlides = input.tracks?.length ? input.tracks : [input.presentation];
  const titleOwners = new Map<string, string>();
  const bodyOwners = new Map<string, string>();
  for (const slide of input.presentation.slides) {
    const titleKey = normalizedText(slide.title);
    if (titleKey && titleOwners.has(titleKey)) add({ category: 'narrative-repetition', severity: 'warning', slideId: slide.id, ruleId: 'narrative-repetition.repeated-title',
      message: 'The presentation repeats an exact normalized title.', evidence: { previousSlideId: titleOwners.get(titleKey)! }, confidence: 'high' });
    else if (titleKey) titleOwners.set(titleKey, slide.id);
    for (const line of slide.body) {
      const key = normalizedText(line);
      if (!key || key === titleKey) continue;
      if (bodyOwners.has(key)) add({ category: 'narrative-repetition', severity: 'warning', slideId: slide.id, ruleId: 'narrative-repetition.repeated-body-claim',
        message: 'The presentation repeats an exact normalized body claim.', evidence: { previousSlideId: bodyOwners.get(key)! }, confidence: 'high' });
      else bodyOwners.set(key, slide.id);
    }
  }

  const signatures = input.composition?.signaturesByVariant;
  if (signatures) {
    const variants = ['A', 'B', 'C'] as const;
    const complete = variants.every((variant) => signatures[variant]?.length === input.presentation.slides.length
      && signatures[variant]!.every((signature) => typeof signature === 'string' && signature.length > 0));
    if (complete) {
      const deckDistinctness = assessDeckCompositionDistinctness({ A: signatures.A!, B: signatures.B!, C: signatures.C! });
      add({ category: 'variant-distinctness', severity: deckDistinctness.distinct ? 'info' : 'error', slideId: null,
        ruleId: deckDistinctness.distinct ? 'variant-distinctness.deck-signatures-distinct' : 'variant-distinctness.deck-signature-collision',
        message: deckDistinctness.distinct
          ? 'A/B/C have pairwise distinct ordered whole-deck projected composition signatures.'
          : 'At least two tracks have the same ordered whole-deck projected composition signature.',
        evidence: {
          deckSignatureA: deckDistinctness.deckSignatures.A,
          deckSignatureB: deckDistinctness.deckSignatures.B,
          deckSignatureC: deckDistinctness.deckSignatures.C,
          slidesDifferAB: deckDistinctness.differingSlideCounts.AB,
          slidesDifferAC: deckDistinctness.differingSlideCounts.AC,
          slidesDifferBC: deckDistinctness.differingSlideCounts.BC,
        }, confidence: 'high' });
    } else add({ category: 'variant-distinctness', severity: 'info', slideId: null, ruleId: 'variant-distinctness.no-composition-evidence',
      message: 'No complete A/B/C whole-deck composition signature set was supplied.', evidence: {}, confidence: 'unknown' });
  } else if (allSlides.length < 3) {
    add({ category: 'variant-distinctness', severity: 'info', slideId: null, ruleId: 'variant-distinctness.tracks-not-supplied',
      message: 'A/B/C track signatures were not supplied for this report.', evidence: {}, confidence: 'unknown' });
  }

  const trackDecks = input.tracks ?? [input.presentation];
  const commonTemplate = trackDecks.every((deck) => deck.templateIRHash === input.presentation.templateIRHash);
  if (!commonTemplate) add({ category: 'template-consistency', severity: 'error', slideId: null, ruleId: 'template-consistency.mixed-template-source',
    message: 'A/B/C tracks were compiled from different template sources.', evidence: { templateHashCount: new Set(trackDecks.map((deck) => deck.templateIRHash)).size }, confidence: 'high' });
  else if (trackDecks.length < 3) add({ category: 'template-consistency', severity: 'info', slideId: null, ruleId: 'template-consistency.incomplete-track-evidence',
    message: 'Whole-track composition consistency cannot be compared without all A/B/C tracks.', evidence: { suppliedTrackCount: trackDecks.length }, confidence: 'unknown' });
  else {
    const strategy = trackStrategy;
    const visualEvidenceCount = Math.min(strategy.A.visualEvidenceSlides, strategy.B.visualEvidenceSlides, strategy.C.visualEvidenceSlides);
    const hasDirectionalEvidence = visualEvidenceCount > 0
      && strategy.B.medianVisualAreaShare !== null && strategy.A.medianVisualAreaShare !== null
      && strategy.C.medianBodyAreaShare !== null && strategy.A.medianBodyAreaShare !== null;
    if (!hasDirectionalEvidence) add({ category: 'template-consistency', severity: 'info', slideId: null, ruleId: 'template-consistency.strategy-unknown',
      message: 'The current plan does not provide enough repeated visual/data evidence to verify whole-track composition strategy.',
      evidence: { visualEvidenceSlidesAcrossTracks: visualEvidenceCount }, confidence: 'unknown' });
    else {
      const visualLed = strategy.B.medianVisualAreaShare! > strategy.A.medianVisualAreaShare!;
      const evidenceDense = strategy.C.medianBodyAreaShare! >= strategy.A.medianBodyAreaShare!;
      if (!visualLed || !evidenceDense) add({ category: 'template-consistency', severity: 'warning', slideId: null, ruleId: 'template-consistency.track-strategy-not-distinct',
        message: 'Track-level geometry does not consistently distinguish the visual-led B and evidence-dense C strategies.',
        evidence: { visualLedB: visualLed, evidenceDenseC: evidenceDense,
          bodyAreaA: strategy.A.medianBodyAreaShare, bodyAreaC: strategy.C.medianBodyAreaShare,
          visualAreaA: strategy.A.medianVisualAreaShare, visualAreaB: strategy.B.medianVisualAreaShare }, confidence: 'medium' });
    }
  }

  const residue = input.renderEvidence?.sourceContentResidue;
  if (residue?.status === 'checked') {
    for (const finding of residue.findings) add({ category: 'source-content-residue', severity: 'error', slideId: finding.slideId,
      ruleId: 'source-content-residue.unprojected-donor-text', message: 'Source-specific donor text remains visible after exemplar projection.',
      evidence: { sourceSlideIndex: finding.sourceSlideIndex, sourceElementId: finding.sourceElementId, textSha256: finding.textSha256, outputShapeId: finding.outputShapeId }, confidence: 'high' });
  } else if (!residue || residue.status === 'not-applicable') {
    add({ category: 'source-content-residue', severity: 'info', slideId: null, ruleId: 'source-content-residue.no-exemplar-projection',
      message: residue?.status === 'not-applicable' ? 'No exemplar projection occurred in this deck.' : 'Post-reopen source-residue evidence is unavailable.',
      evidence: {}, confidence: 'unknown' });
  }

  if (!input.renderEvidence?.textObjects.length) add({ category: 'alignment', severity: 'info', slideId: null, ruleId: 'alignment.rendered-geometry-unavailable',
    message: 'Post-reopen text object geometry was not supplied.', evidence: {}, confidence: 'unknown' });
  if (!input.renderEvidence?.textObjects.some((item) => item.color)) add({ category: 'contrast', severity: 'info', slideId: null, ruleId: 'contrast.effective-color-unavailable',
    message: 'Effective foreground color evidence is unavailable; contrast remains unverified.', evidence: {}, confidence: 'unknown' });
  else add({ category: 'contrast', severity: 'info', slideId: null, ruleId: 'contrast.background-resolution-required',
    message: 'Foreground colors were resolved, but a complete per-shape rendered background map is unavailable; contrast remains unverified.', evidence: { coloredTextObjectCount: input.renderEvidence.textObjects.filter((item) => item.color).length }, confidence: 'unknown' });

  for (const issue of input.previewEvidence?.flatMap((preview) => preview.geometryIssues ?? []) ?? []) {
    const record = typeof issue === 'object' && issue !== null ? issue as Record<string, unknown> : {};
    const severity = record.severity === 'warning' ? 'warning' as const : 'error' as const;
    add({ category: 'safe-area', severity, slideId: typeof record.slideId === 'string' ? record.slideId : null,
      ruleId: 'safe-area.rendered-object-boundary', message: severity === 'warning' ? 'A template object extends past the canvas; review whether it is intended furniture.' : 'A rendered object extends past the canvas.',
      evidence: { classification: typeof record.classification === 'string' ? record.classification : 'unknown', confidence: typeof record.confidence === 'string' ? record.confidence : 'unknown' },
      confidence: severity === 'warning' ? 'medium' : 'high' });
  }

  for (const category of PRESENTATION_QUALITY_CATEGORIES) {
    const categoryFindings = findings.filter((finding) => finding.category === category);
    const highestSeverity = categoryFindings.some((finding) => finding.severity === 'error') ? 'error'
      : categoryFindings.some((finding) => finding.severity === 'warning') ? 'warning' : 'info';
    let status: PresentationQualityStatus = categoryFindings.some((finding) => finding.severity === 'error') ? 'error'
      : categoryFindings.some((finding) => finding.severity === 'warning') ? 'warning' : 'pass';
    if (status === 'pass' && categoryFindings.some((finding) => finding.confidence === 'unknown')) status = 'unknown';
    if (category === 'contrast') status = 'unknown';
    if (category === 'source-content-residue' && residue?.status === 'not-applicable') status = 'not_applicable';
    if (category === 'source-content-residue' && !residue) status = 'unknown';
    if (category === 'variant-distinctness' && !signatures) status = 'unknown';
    if (category === 'template-consistency' && trackDecks.length < 3) status = 'unknown';
    if (category === 'alignment' && !input.renderEvidence?.textObjects.length) status = 'unknown';
    if (category === 'text-fit' && !input.previewEvidence?.length) status = 'unknown';
    const messages = categoryFindings.map((finding) => finding.message);
    reportCategories[category] = {
      status,
      severity: status === 'error' ? 'error' : status === 'warning' ? 'warning' : highestSeverity,
      findingCount: categoryFindings.length,
      summary: messages[0] ?? (status === 'pass' ? 'No deterministic quality issue was found within the available evidence.'
        : status === 'unknown' ? 'The check remains unknown until the required evidence is available.'
          : status === 'not_applicable' ? 'This check did not apply to the generated deck.' : 'Quality evidence is available.'),
    };
  }

  return {
    schemaVersion: 1,
    reportKind: 'presentation-quality',
    reportVersion: 'presentation-quality.v1',
    presentationId: input.presentation.id,
    variantId: input.presentation.variantId,
    templateIRHash: input.templateIR.hash,
    contentIRHash: input.contentIR.hash,
    categories: reportCategories,
    findings,
    trackStrategy,
    contextualReview: [
      { id: 'takeaway-quality', status: 'manual-review-required', reason: 'Runtime contextual audit evidence is stored separately; consult the ProductWorkflow contextualAudit state. Real model judgment is not implied by this report.' },
      { id: 'content-title-alignment', status: 'manual-review-required', reason: 'Runtime contextual audit evidence is stored separately; this report does not merge model judgments with deterministic findings.' },
      { id: 'one-sentence-summary', status: 'manual-review-required', reason: 'Runtime contextual audit evidence is stored separately; verify its current version and selected-deck fingerprint.' },
      { id: 'visual-relevance', status: 'manual-review-required', reason: 'Runtime contextual audit is metadata/text based and stored separately; this report does not inspect pixels.' },
      { id: 'adjacent-slide-coherence', status: 'manual-review-required', reason: 'Runtime contextual audit evidence is stored separately; this report does not merge its narrative judgment.' },
    ],
    deterministicSafetyAuditIsSeparate: true,
  };
}
