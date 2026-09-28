import {
  findShapesOutsideCanvas,
  getShapeBounds,
  getShapeId,
  getShapeKind,
  getShapeName,
  loadPresentation,
  getSlides,
} from '@office-kit/pptx/node';
import { auditTextLayout, renderSlideToSvg } from '@office-kit/pptx-preview';
import { buildFontkitMeasurer, renderSlideToImage } from '@office-kit/pptx-preview/node';

import type { PptxPreviewPort, PptxPreviewResult } from '../application/pptx-preview-port.js';
import { recordElapsed, type PerformanceDiagnosticsPort } from '../performance-diagnostics.js';

/** Keeps the approximate diagnostic renderer outside application and domain code. */
export class OfficeKitPreviewAdapter implements PptxPreviewPort {
  constructor(private readonly diagnostics?: PerformanceDiagnosticsPort) {}

  async preview(pptx: Uint8Array, slideIndex: number, width = 1280): Promise<PptxPreviewResult> {
    const batch = await this.previewDeck(pptx, [slideIndex], width);
    const result = batch[0]?.result;
    if (!result) throw new RangeError('Preview slide index does not exist');
    return result;
  }

  async previewDeck(pptx: Uint8Array, slideIndexes: readonly number[], width = 1280): Promise<Array<{ slideIndex: number; result: PptxPreviewResult }>> {
    const totalStartedAt = performance.now();
    this.diagnostics?.increment('previewDeckCallCount');
    this.diagnostics?.increment('previewCallCount', slideIndexes.length);
    if (!Array.isArray(slideIndexes) || slideIndexes.length < 1 || slideIndexes.length > 500
        || !Number.isSafeInteger(width) || width < 64 || width > 4096
        || slideIndexes.some((index) => !Number.isSafeInteger(index) || index < 0)
        || new Set(slideIndexes).size !== slideIndexes.length) {
      throw new TypeError('Preview slide indexes or width are outside the supported range');
    }
    const loadStartedAt = performance.now();
    const presentation = await loadPresentation(pptx);
    recordElapsed(this.diagnostics, 'preview.loadPresentation', loadStartedAt);
    recordElapsed(this.diagnostics, 'preview.decodeOrLoad', loadStartedAt);
    this.diagnostics?.increment('previewDeckLoadCount');
    const slides = getSlides(presentation);
    if (slideIndexes.some((index) => !slides[index])) throw new RangeError('Preview slide index does not exist');
    const auditStartedAt = performance.now();
    // Use the dependency's Node glyph measurer. The default browser-safe
    // heuristic marks every Office Kit issue approximate, hiding exact OOXML
    // text-box overflow from offline qualification.
    const allTextLayoutIssues = auditTextLayout(presentation, { measureText: buildFontkitMeasurer() });
    recordElapsed(this.diagnostics, 'preview.auditTextLayout', auditStartedAt);
    const results: Array<{ slideIndex: number; result: PptxPreviewResult }> = [];
    const renderStartedAt = performance.now();
    for (const slideIndex of slideIndexes) {
      const slide = slides[slideIndex]!;
      const svgStartedAt = performance.now();
      const svg = renderSlideToSvg(presentation, slide);
      recordElapsed(this.diagnostics, 'preview.renderSvg', svgStartedAt);
      const pngStartedAt = performance.now();
      const png = renderSlideToImage(presentation, slide, { width });
      recordElapsed(this.diagnostics, 'preview.renderPng', pngStartedAt);
      const textLayoutIssues = allTextLayoutIssues.filter((issue) => {
        if (typeof issue !== 'object' || issue === null || !('slideIndex' in issue) || typeof issue.slideIndex !== 'number') return true;
        return issue.slideIndex === slideIndex;
      }).map((issue) => {
        const approximate = typeof issue === 'object' && issue !== null && 'approximate' in issue && issue.approximate === true;
        return {
          ...(typeof issue === 'object' && issue !== null ? issue : { message: String(issue) }),
          classification: approximate ? 'PREVIEW_TEXT_METRIC_APPROXIMATION' : 'PREVIEW_TEXT_OVERFLOW',
          severity: approximate ? 'warning' as const : 'error' as const,
          source: '@office-kit/pptx-preview.auditTextLayout',
          confidence: approximate ? 'low' as const : 'unknown' as const,
        };
      });
      const geometryIssues = findShapesOutsideCanvas(slide, presentation).map((shape) => {
        const bounds = getShapeBounds(shape);
        return {
          classification: 'GENERATED_OBJECT_OUT_OF_BOUNDS',
          severity: 'error' as const,
          source: 'Office Kit native shape bounds',
          confidence: 'high' as const,
          shapeId: String(getShapeId(shape)),
          shapeName: getShapeName(shape),
          shapeKind: getShapeKind(shape),
          bounds: bounds ? { x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h } : null,
        };
      });
      results.push({ slideIndex, result: {
        slideCount: slides.length,
        svg,
        png,
        textLayoutIssues,
        geometryIssues,
        status: geometryIssues.length || textLayoutIssues.some((issue) => typeof issue === 'object' && issue !== null && 'severity' in issue && issue.severity === 'error')
          ? 'failed' as const : textLayoutIssues.length ? 'warning' as const : 'passed' as const,
        limitations: ['Approximate renderer; PowerPoint is the visual oracle.', 'Approximate text metrics are warnings and do not establish OOXML box overflow.', 'Table-cell text overflow is not audited.'],
      } });
    }
    const renderElapsed = performance.now() - renderStartedAt;
    this.diagnostics?.recordDuration('preview.render', renderElapsed);
    this.diagnostics?.recordDuration('preview.perSlide', renderElapsed / slideIndexes.length);
    recordElapsed(this.diagnostics, 'preview.total', totalStartedAt);
    this.diagnostics?.increment('previewSlideCount', slideIndexes.length);
    return results;
  }
}
