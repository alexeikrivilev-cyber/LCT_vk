/** Replaceable package-level document capability used by presentation backends. */
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
