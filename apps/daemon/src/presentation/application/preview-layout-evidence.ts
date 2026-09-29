import type { TemplateIR } from '../domain/template-ir.js';
import type { ExemplarSlideSelection } from './exemplar-slide-selector.js';
import type { CompiledSlide } from './slide-compilation.js';
import type { PptxPreviewResult } from './pptx-preview-port.js';

export type PreviewLayoutIssueCategory = 'blocking' | 'warning' | 'approximate';

export interface PreviewLayoutIssueDetail {
  category: PreviewLayoutIssueCategory;
  classification: string;
  severity: string;
  source: string | null;
  confidence: string | null;
  approximate: boolean;
  slideIndex: number | null;
  kind: string | null;
  overflowPx?: number | null;
  shapeName: string | null;
  message: string | null;
}

export interface PreviewLayoutIssueSummary {
  total: number;
  blocking: number;
  warnings: number;
  approximate: number;
  details: PreviewLayoutIssueDetail[];
}

export function isPreviewLayoutIssueSummary(value: unknown): value is PreviewLayoutIssueSummary {
  if (!isRecord(value) || ![value.total, value.blocking, value.warnings, value.approximate].every((item) => Number.isSafeInteger(item) && Number(item) >= 0)
      || !Array.isArray(value.details)) return false;
  if (Number(value.total) !== Number(value.blocking) + Number(value.warnings) + Number(value.approximate)
      || value.details.length !== Number(value.total)) return false;
  return value.details.every((item) => isRecord(item)
    && ['blocking', 'warning', 'approximate'].includes(String(item.category))
    && typeof item.classification === 'string' && item.classification.length > 0 && item.classification.length <= 120
    && typeof item.severity === 'string' && item.severity.length <= 40
    && (item.source === null || typeof item.source === 'string' && item.source.length <= 500)
    && (item.confidence === null || typeof item.confidence === 'string' && item.confidence.length <= 40)
    && typeof item.approximate === 'boolean'
    && (item.slideIndex === null || Number.isSafeInteger(item.slideIndex))
    && (item.kind === null || typeof item.kind === 'string' && item.kind.length <= 120)
    && (item.overflowPx === undefined || item.overflowPx === null || typeof item.overflowPx === 'number' && Number.isFinite(item.overflowPx) && item.overflowPx >= 0)
    && (item.shapeName === null || typeof item.shapeName === 'string' && item.shapeName.length <= 500)
    && (item.message === null || typeof item.message === 'string' && item.message.length <= 2000));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Downgrade only a unique exact geometry match to the selected source template; retain it as a warning. */
export function classifySourceTemplateBleed(
  issue: unknown,
  template: TemplateIR,
  selection: ExemplarSlideSelection | null | undefined,
): unknown {
  if (!selection || !isRecord(issue) || issue.classification !== 'GENERATED_OBJECT_OUT_OF_BOUNDS'
      || issue.severity !== 'error' || !isRecord(issue.bounds)) return issue;
  const bounds = issue.bounds;
  if (!['x', 'y', 'width', 'height'].every((key) => typeof bounds[key] === 'number')) return issue;

  const sourceSlide = template.slides.find((slide) => slide.index === selection.sourceSlideIndex && slide.sourcePart === selection.sourcePart);
  const layout = template.layouts.find((candidate) => candidate.id === selection.layoutId);
  const master = layout?.masterId ? template.masters.find((candidate) => candidate.id === layout.masterId) : null;
  const candidates = [...(sourceSlide?.elements ?? []), ...(layout?.elements ?? []), ...(master?.elements ?? [])].filter((element) => {
    const geometry = element.geometry.resolved ?? element.geometry.direct;
    return geometry
      && Math.abs(geometry.x - Number(bounds.x)) <= 1 && Math.abs(geometry.y - Number(bounds.y)) <= 1
      && Math.abs(geometry.width - Number(bounds.width)) <= 1 && Math.abs(geometry.height - Number(bounds.height)) <= 1;
  });
  if (candidates.length !== 1) return issue;

  const origin = sourceSlide?.elements.includes(candidates[0]!) ? sourceSlide.sourcePart : layout?.sourcePart ?? master?.sourcePart ?? null;
  return {
    ...issue,
    classification: 'SOURCE_TEMPLATE_BLEED',
    severity: 'warning',
    source: origin ? `TemplateIR:${origin}` : 'TemplateIR source geometry',
    confidence: 'high',
    message: 'The exact out-of-canvas object is inherited from the selected source template; retained as a visible template-bleed warning.',
  };
}

function classifyIssue(issue: unknown): PreviewLayoutIssueDetail {
  const record = isRecord(issue) ? issue : {};
  const severity = text(record.severity) ?? 'unknown';
  const classification = text(record.classification) ?? 'UNCLASSIFIED_PREVIEW_ISSUE';
  const approximate = record.approximate === true;
  const category: PreviewLayoutIssueCategory = severity === 'error'
    ? 'blocking'
    : classification === 'PREVIEW_TEXT_METRIC_APPROXIMATION' && approximate && severity === 'warning'
      ? 'approximate'
      : severity === 'warning' || severity === 'info' ? 'warning' : 'blocking';
  return {
    category,
    classification,
    severity,
    source: text(record.source),
    confidence: text(record.confidence),
    approximate,
    slideIndex: typeof record.slideIndex === 'number' ? record.slideIndex : null,
    kind: text(record.kind),
    overflowPx: typeof record.overflowPx === 'number' && Number.isFinite(record.overflowPx) ? record.overflowPx : null,
    shapeName: text(record.shapeName),
    message: text(record.message),
  };
}

export function summarizePreviewLayoutEvidence(
  preview: PptxPreviewResult,
  template: TemplateIR,
  slide: CompiledSlide,
): PreviewLayoutIssueSummary {
  const issues = [
    ...preview.textLayoutIssues,
    ...preview.geometryIssues.map((issue) => classifySourceTemplateBleed(issue, template, slide.exemplarSelection)),
  ].map(classifyIssue);
  const summary: PreviewLayoutIssueSummary = {
    total: issues.length,
    blocking: issues.filter((issue) => issue.category === 'blocking').length,
    warnings: issues.filter((issue) => issue.category === 'warning').length,
    approximate: issues.filter((issue) => issue.category === 'approximate').length,
    details: issues,
  };
  return summary;
}
