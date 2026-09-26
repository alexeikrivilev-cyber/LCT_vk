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
import { renderSlideToImage } from '@office-kit/pptx-preview/node';

import type { PptxPreviewPort } from '../application/pptx-preview-port.js';

/** Keeps the approximate diagnostic renderer outside application and domain code. */
export class OfficeKitPreviewAdapter implements PptxPreviewPort {
  async preview(pptx: Uint8Array, slideIndex: number, width = 1280) {
    if (!Number.isSafeInteger(slideIndex) || slideIndex < 0 || !Number.isSafeInteger(width) || width < 64 || width > 4096) {
      throw new TypeError('Preview slide index or width is outside its supported range');
    }
    const presentation = await loadPresentation(pptx);
    const slides = getSlides(presentation);
    const slide = slides[slideIndex];
    if (!slide) throw new RangeError('Preview slide index does not exist');
    const svg = renderSlideToSvg(presentation, slide);
    const png = renderSlideToImage(presentation, slide, { width });
    const textLayoutIssues = auditTextLayout(presentation).filter((issue) => {
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
    return {
      slideCount: slides.length,
      svg,
      png,
      textLayoutIssues,
      geometryIssues,
      status: geometryIssues.length || textLayoutIssues.some((issue) => typeof issue === 'object' && issue !== null && 'severity' in issue && issue.severity === 'error')
        ? 'failed' as const : textLayoutIssues.length ? 'warning' as const : 'passed' as const,
      limitations: ['Approximate renderer; PowerPoint is the visual oracle.', 'Approximate text metrics are warnings and do not establish OOXML box overflow.', 'Table-cell text overflow is not audited.'],
    };
  }
}
