import {
  loadPresentation,
  savePresentation,
  validatePresentation,
} from '@office-kit/pptx/node';
import type {
  PptxDocumentAdapter,
  PptxRoundTripResult,
} from './pptx-document-adapter.js';

/**
 * Replaceable Office Kit implementation used only by the isolated renderer
 * spike. Production application flow does not import or construct this class.
 */
export class OfficeKitPptxDocumentAdapter implements PptxDocumentAdapter {
  async roundTrip(source: Uint8Array): Promise<PptxRoundTripResult> {
    const presentation = await loadPresentation(source);
    const validationIssues = validatePresentation(presentation).map((issue) => ({
      severity: issue.severity,
      message: issue.message,
      partName: issue.partName ?? null,
    }));

    return {
      pptx: await savePresentation(presentation),
      validationIssues,
    };
  }
}
