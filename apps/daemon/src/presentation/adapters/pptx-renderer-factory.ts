import { parsePptxBackend, type PptxBackendId, type PptxRenderInput, type PptxRenderResult, type PptxRendererPort } from '../application/pptx-backend-port.js';
import { CustomPptxRenderer } from '../adapters/custom-pptx-renderer.js';
import { OfficeKitPptxRenderer } from '../adapters/office-kit-pptx-renderer.js';

export function resolvePptxBackend(value: unknown = process.env.LCT_PPTX_BACKEND): PptxBackendId {
  return parsePptxBackend(value);
}

export function createPptxRenderer(backend: PptxBackendId = resolvePptxBackend()): PptxRendererPort {
  return backend === 'office-kit' ? new OfficeKitPptxRenderer() : new CustomPptxRenderer();
}

/** Shared selection boundary; compilation and product decisions are backend-neutral. */
export function renderPresentation(input: PptxRenderInput, backend?: PptxBackendId): Promise<PptxRenderResult> {
  return createPptxRenderer(backend).render(input);
}
