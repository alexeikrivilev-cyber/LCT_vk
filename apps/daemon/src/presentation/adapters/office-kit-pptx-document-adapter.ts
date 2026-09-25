import {
  loadPresentation,
  savePresentation,
  validatePresentation,
} from '@office-kit/pptx/node';
import type {
  PptxDocumentAdapter,
  PptxRoundTripResult,
} from '../application/pptx-document-port.js';

/**
 * Replaceable Office Kit document implementation. Office Kit types stay
 * behind this adapter and the application-owned document port.
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
