import { loadPresentation, getSlides } from '@office-kit/pptx/node';
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
    const textLayoutIssues = auditTextLayout(presentation);
    return {
      slideCount: slides.length,
      svg,
      png,
      textLayoutIssues,
      status: textLayoutIssues.length === 0 ? 'passed' as const : 'failed' as const,
      limitations: ['Approximate renderer; PowerPoint is the visual oracle.', 'Table-cell text overflow is not audited.'],
    };
  }
}
