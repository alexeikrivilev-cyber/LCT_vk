/** Internal replaceable diagnostic capability; preview pixels are not a PowerPoint oracle. */
export interface PptxPreviewResult {
  slideCount: number;
  svg: string;
  png: Uint8Array;
  textLayoutIssues: readonly unknown[];
  geometryIssues: readonly unknown[];
  status: 'passed' | 'warning' | 'failed';
  limitations: readonly string[];
}

export interface PptxPreviewPort {
  preview(pptx: Uint8Array, slideIndex: number, width?: number): Promise<PptxPreviewResult>;
  /** Optional Office Kit batch path: load one deck once and render the requested slides. */
  previewDeck?(pptx: Uint8Array, slideIndexes: readonly number[], width?: number): Promise<Array<{ slideIndex: number; result: PptxPreviewResult }>>;
}
