import {
  getShapeId,
  getShapeParagraphCount,
  getShapeRunCount,
  getShapeRunFormatEffective,
  getSlideShapes,
  getSlides,
  loadPresentation,
} from '@office-kit/pptx/node';

import type { TemplateIR } from '../domain/template-ir.js';

/** Resolve inherited placeholder fonts through the pinned Office Kit text-style cascade. */
export async function addEffectivePlaceholderTypography(templateIR: TemplateIR, bytes: Uint8Array): Promise<void> {
  const presentation = await loadPresentation(bytes);
  const sourceSlides = getSlides(presentation);
  let unresolvedShapeCount = 0;
  for (const templateSlide of templateIR.slides) {
    const sourceSlide = sourceSlides[templateSlide.index - 1];
    if (!sourceSlide) continue;
    const shapesById = new Map(getSlideShapes(sourceSlide).map((shape) => [String(getShapeId(shape)), shape]));
    for (const element of templateSlide.elements) {
      if (element.kind.toLowerCase() !== 'shape' || !element.placeholder || !element.nativeId) continue;
      const shape = shapesById.get(element.nativeId);
      if (!shape) continue;
      const sizes = new Set<number>();
      try {
        for (let paragraph = 0; paragraph < getShapeParagraphCount(shape); paragraph += 1) {
          for (let run = 0; run < getShapeRunCount(shape, paragraph); run += 1) {
            const size = getShapeRunFormatEffective(presentation, shape, paragraph, run).size;
            if (typeof size === 'number' && Number.isFinite(size) && size > 0 && size <= 1000) sizes.add(size);
          }
        }
      } catch {
        // Unknown inherited style keeps the selector's conservative fit gate active.
        unresolvedShapeCount += 1;
        continue;
      }
      if (sizes.size) element.effectiveFontSizesPt = [...sizes].sort((left, right) => left - right);
    }
  }
  if (unresolvedShapeCount) {
    console.warn(`Template typography resolution left ${unresolvedShapeCount} placeholder(s) unknown; conservative fit gates remain active.`);
  }
}
