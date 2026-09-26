import { PDFDocument } from 'pdf-lib';
import { getSlides, loadPresentation } from '@office-kit/pptx/node';
import { renderSlideToImage } from '@office-kit/pptx-preview/node';

import type { TemplateIR } from '../domain/template-ir.js';

/** Replaceable PDF path. It renders the generated PPTX with the existing Office Kit preview renderer. */
export class OfficeKitPdfExportAdapter {
  async export(pptx: Uint8Array, expectedSlideCount: number, slideSize: TemplateIR['slideSize']): Promise<Buffer> {
    if (!Number.isSafeInteger(expectedSlideCount) || expectedSlideCount < 1
        || !Number.isFinite(slideSize.width) || !Number.isFinite(slideSize.height)
        || slideSize.width <= 0 || slideSize.height <= 0) {
      throw new TypeError('PDF export requires a valid slide count and canvas size');
    }
    const presentation = await loadPresentation(pptx);
    const slides = getSlides(presentation);
    if (slides.length !== expectedSlideCount) throw new Error('Generated PPTX slide count changed before PDF export');

    const pageWidth = slideSize.width / 914400 * 72;
    const pageHeight = slideSize.height / 914400 * 72;
    const pdf = await PDFDocument.create();
    pdf.setCreator('LCT Presentation Compiler');
    pdf.setProducer('LCT Presentation Compiler · Office Kit preview adapter');
    for (const slide of slides) {
      const png = renderSlideToImage(presentation, slide, { width: 1600 });
      const image = await pdf.embedPng(png);
      const page = pdf.addPage([pageWidth, pageHeight]);
      page.drawImage(image, { x: 0, y: 0, width: pageWidth, height: pageHeight });
    }
    const bytes = Buffer.from(await pdf.save({ useObjectStreams: true }));
    const reopened = await PDFDocument.load(bytes, { updateMetadata: false });
    if (reopened.getPageCount() !== expectedSlideCount) throw new Error('Generated PDF did not pass page-count reopen validation');
    return bytes;
  }
}
