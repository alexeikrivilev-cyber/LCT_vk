import { renderNativePptx } from '../application/native-pptx-renderer.js';
import type { PptxRenderInput, PptxRenderResult, PptxRendererPort } from '../application/pptx-backend-port.js';

/** Adapter for the existing deterministic OOXML writer, retained as default until qualification. */
export class CustomPptxRenderer implements PptxRendererPort {
  readonly id = 'custom' as const;

  render(input: PptxRenderInput): Promise<PptxRenderResult> {
    return renderNativePptx(input);
  }
}
