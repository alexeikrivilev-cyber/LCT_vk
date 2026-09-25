/** Internal replaceable diagnostic capability; preview pixels are not a PowerPoint oracle. */
export interface PptxPreviewPort {
  preview(pptx: Uint8Array, slideIndex: number, width?: number): Promise<{
    slideCount: number;
    svg: string;
    png: Uint8Array;
    textLayoutIssues: readonly unknown[];
    status: 'passed' | 'failed';
    limitations: readonly string[];
  }>;
}
