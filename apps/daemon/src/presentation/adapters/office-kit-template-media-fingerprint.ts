import JSZip from 'jszip';
import sharp from 'sharp';
import { sha256Json, templateIRHashPayload } from '../domain/template-ir.js';
import type { TemplateElement, TemplateIR } from '../domain/template-ir.js';

const fullCanvasTolerance = 0.005;

function localAttribute(tag: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const value = tag.match(new RegExp(`(?:^|\\s)(?:[A-Za-z_][\\w.-]*:)?${escapedName}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1];
  return value ?? null;
}

function hasUnsupportedPictureTransform(pictureBody: string): boolean {
  const presetGeometry = [...pictureBody.matchAll(/<(?:[A-Za-z_][\w.-]*:)?prstGeom\b[^>]*>/gi)];
  if (presetGeometry.length !== 1 || localAttribute(presetGeometry[0]![0], 'prst')?.toLowerCase() !== 'rect'
      || /<(?:[A-Za-z_][\w.-]*:)?custGeom\b/i.test(pictureBody)) return true;
  if (/<(?:[A-Za-z_][\w.-]*:)?(?:effectLst|effectDag|sp3d|scene3d|style|ln)\b/i.test(pictureBody)) return true;
  if (/<(?:[A-Za-z_][\w.-]*:)?tile\b/i.test(pictureBody)) return true;
  const fillRectInsets = [...pictureBody.matchAll(/<(?:[A-Za-z_][\w.-]*:)?fillRect\b[^>]*>/gi)];
  if (fillRectInsets.some((match) => ['l', 't', 'r', 'b'].some((side) => {
    const raw = localAttribute(match[0], side);
    if (raw === null) return false;
    const value = Number(raw);
    return !Number.isFinite(value) || value !== 0;
  }))) return true;
  return [...pictureBody.matchAll(/<(?:[A-Za-z_][\w.-]*:)?blipFill\b[^>]*>/gi)].some((match) =>
    ['1', 'true'].includes((localAttribute(match[0], 'rotWithShape') ?? '').toLowerCase()));
}

function pictureRelationshipTransforms(slideXml: string): { seen: Set<string>; transformed: Set<string> } {
  const seen = new Set<string>();
  const transformed = new Set<string>();
  const pictures = /<([A-Za-z_][\w.-]*:)?pic\b[^>]*>([\s\S]*?)<\/\1pic\s*>/gi;
  for (const picture of slideXml.matchAll(pictures)) {
    const body = picture[2] ?? '';
    let hasBlip = false;
    for (const blip of body.matchAll(/<(?:[A-Za-z_][\w.-]*:)?blip\b[^>]*>/gi)) {
      hasBlip = true;
      const tag = blip[0];
      const relationshipId = localAttribute(tag, 'embed') ?? localAttribute(tag, 'link');
      if (!relationshipId) continue;
      seen.add(relationshipId);
      const selfClosing = /\/\s*>$/.test(tag);
      const remainder = body.slice((blip.index ?? 0) + tag.length);
      const nestedBlipContent = !selfClosing && /<(?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*\b/.test(remainder.split(/<\/(?:[A-Za-z_][\w.-]*:)?blip\s*>/i, 1)[0] ?? '');
      const cropTags = [...body.matchAll(/<(?:[A-Za-z_][\w.-]*:)?srcRect\b[^>]*>/gi)];
      const hasCrop = cropTags.some((crop) => ['l', 't', 'r', 'b'].some((side) => {
        const raw = localAttribute(crop[0], side);
        if (raw === null) return false;
        const value = Number(raw);
        return !Number.isFinite(value) || value !== 0;
      }));
      const hasFlip = [...body.matchAll(/<(?:[A-Za-z_][\w.-]*:)?xfrm\b[^>]*>/gi)].some((transform) =>
        ['flipH', 'flipV'].some((flip) => ['1', 'true'].includes((localAttribute(transform[0], flip) ?? '').toLowerCase())));
      if (nestedBlipContent || hasCrop || hasFlip || hasUnsupportedPictureTransform(body)) transformed.add(relationshipId);
    }
    if (!hasBlip) {
      // The image node was not recognized; the caller will fail closed for any
      // expected media relationship on this slide that could not be matched.
      continue;
    }
  }
  return { seen, transformed };
}

function isFullCanvasImage(element: TemplateElement, template: TemplateIR): boolean {
  // A child's direct geometry is expressed in its group's coordinate space.
  // Unsupported ancestor transforms (rotation/reflection) deliberately leave
  // resolved geometry unknown, so nested or unresolved pictures fail closed.
  if (element.parentId !== null || element.geometry.resolved === null) return false;
  const box = element.geometry.resolved;
  if (!box || Math.abs(box.rotation) > 0.01) return false;
  const toleranceX = template.slideSize.width * fullCanvasTolerance;
  const toleranceY = template.slideSize.height * fullCanvasTolerance;
  return Math.abs(box.x) <= toleranceX && Math.abs(box.y) <= toleranceY
    && Math.abs(box.width - template.slideSize.width) <= toleranceX
    && Math.abs(box.height - template.slideSize.height) <= toleranceY;
}

function hasEditableTextAbove(element: TemplateElement, slide: TemplateIR['slides'][number]): boolean {
  return slide.elements.filter((candidate) => candidate.kind.toLowerCase() === 'shape'
    && candidate.parentId === null && candidate.nativeId !== null && candidate.order > element.order
    && Boolean(candidate.text?.trim()) && (candidate.geometry.resolved ?? candidate.geometry.direct) !== null).length >= 3;
}

/** Adds bounded, low-resolution RGB samples to media that could serve as a repeated slide shell. */
export async function addTemplateMediaVisualFingerprints(template: TemplateIR, sourceBytes: Uint8Array): Promise<void> {
  const candidateRelationships = new Map<string, Map<string, string>>();
  for (const slide of template.slides) {
    const fullCanvasImages = slide.elements.filter((element) => ['picture', 'image'].includes(element.kind.toLowerCase())
      && isFullCanvasImage(element, template));
    if (!slide.layoutId || fullCanvasImages.length !== 1 || !hasEditableTextAbove(fullCanvasImages[0]!, slide)) continue;
    const image = fullCanvasImages[0]!;
    for (const relation of slide.relationships) {
      if (image.relationshipIds.includes(relation.id) && relation.mode === 'internal' && relation.targetPart) {
        const byId = candidateRelationships.get(slide.sourcePart) ?? new Map<string, string>();
        // IR relationship ids are stable content-derived IDs; OOXML refers to
        // the native rId stored separately on the relationship.
        byId.set(relation.nativeId ?? relation.id, relation.targetPart);
        candidateRelationships.set(slide.sourcePart, byId);
      }
    }
  }
  if (!candidateRelationships.size) return;

  const archive = await JSZip.loadAsync(sourceBytes, { checkCRC32: false, createFolders: false });
  const unsupportedParts = new Set<string>();
  for (const [slidePart, relationships] of candidateRelationships) {
    const slideEntry = archive.file(slidePart);
    if (!slideEntry) {
      for (const targetPart of relationships.values()) unsupportedParts.add(targetPart);
      continue;
    }
    try {
      const transforms = pictureRelationshipTransforms(await slideEntry.async('string'));
      for (const [relationshipId, targetPart] of relationships) {
        if (!transforms.seen.has(relationshipId) || transforms.transformed.has(relationshipId)) unsupportedParts.add(targetPart);
      }
    } catch {
      for (const targetPart of relationships.values()) unsupportedParts.add(targetPart);
    }
  }
  let changed = false;
  for (const asset of template.assets) {
    if (unsupportedParts.has(asset.part) && asset.visualFingerprint) {
      delete asset.visualFingerprint;
      changed = true;
    }
  }
  const candidateParts = new Set([...candidateRelationships.values()].flatMap((relationships) => [...relationships.values()]));
  for (const asset of template.assets) {
    if (!candidateParts.has(asset.part) || unsupportedParts.has(asset.part)) continue;
    const entry = archive.file(asset.part);
    if (!entry) continue;
    try {
      const bytes = await entry.async('nodebuffer');
      const sample = await sharp(bytes, { limitInputPixels: 100_000_000, failOn: 'error' })
        .rotate()
        .resize(16, 9, { fit: 'fill', kernel: 'lanczos3' })
        .removeAlpha()
        .toColourspace('srgb')
        .raw()
        .toBuffer();
      if (sample.length !== 16 * 9 * 3) continue;
      asset.visualFingerprint = `rgb16x9-v1:${sample.toString('base64')}`;
      changed = true;
    } catch {
      // Unsupported or malformed images remain unclassified and therefore fail closed.
    }
  }
  if (changed) template.hash = sha256Json(templateIRHashPayload(template));
}
