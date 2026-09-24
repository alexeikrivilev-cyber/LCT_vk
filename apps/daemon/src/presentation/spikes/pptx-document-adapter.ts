/**
 * Replaceable byte-in/byte-out document adapter boundary for renderer reuse
 * experiments. This is not an application or domain contract.
 */
export interface PptxDocumentAdapter {
  roundTrip(source: Uint8Array): Promise<PptxRoundTripResult>;
}

export interface PptxRoundTripResult {
  readonly pptx: Uint8Array;
  readonly validationIssues: readonly PptxValidationIssue[];
}

export interface PptxValidationIssue {
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly partName: string | null;
}
