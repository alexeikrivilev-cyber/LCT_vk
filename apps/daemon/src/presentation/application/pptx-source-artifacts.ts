import path from 'node:path';
import JSZip from 'jszip';

const SOURCE_VISUAL_RELATION_SUFFIXES = ['/relationships/chart', '/relationships/image'];

function decodeXmlAttribute(value: string): string {
  return value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>');
}

function relationshipTargets(xml: string, ownerPart: string): string[] {
  const result: string[] = [];
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/giu)) {
    const attributes = match[1] ?? '';
    const type = /\bType\s*=\s*(["'])(.*?)\1/iu.exec(attributes)?.[2];
    const target = /\bTarget\s*=\s*(["'])(.*?)\1/iu.exec(attributes)?.[2];
    const mode = /\bTargetMode\s*=\s*(["'])(.*?)\1/iu.exec(attributes)?.[2];
    if (!target || mode?.toLowerCase() === 'external') continue;
    let decoded = decodeXmlAttribute(target);
    try { decoded = decodeURIComponent(decoded); } catch { /* Keep literal percent characters if not URI-escaped. */ }
    const withoutQuery = decoded.split(/[?#]/u, 1)[0] ?? '';
    if (!withoutQuery) continue;
    const absolute = withoutQuery.startsWith('/');
    const resolved = absolute
      ? path.posix.normalize(withoutQuery.slice(1))
      : path.posix.normalize(path.posix.join(path.posix.dirname(ownerPart), withoutQuery));
    if (!resolved || resolved === '.' || resolved === '..' || resolved.startsWith('../')) continue;
    result.push(resolved);
  }
  return result;
}

export function relationshipPartFor(ownerPart: string): string {
  if (!ownerPart) return '_rels/.rels';
  return path.posix.join(path.posix.dirname(ownerPart), '_rels', `${path.posix.basename(ownerPart)}.rels`);
}

async function readRelationships(zip: JSZip, ownerPart: string): Promise<string[]> {
  const rels = zip.file(relationshipPartFor(ownerPart));
  if (!rels) return [];
  return relationshipTargets(await rels.async('string'), ownerPart);
}

/**
 * Find charts and images owned by template slides and the package parts reachable from them.
 * This set is used only as the candidate removal set after those source slides are projected out.
 */
export async function collectSourceSlideVisualArtifacts(zip: JSZip): Promise<Set<string>> {
  const visualRoots = new Set<string>();
  for (const [relsPath, entry] of Object.entries(zip.files)) {
    if (entry.dir || !/^ppt\/slides\/_rels\/[^/]+\.xml\.rels$/iu.test(relsPath)) continue;
    const slideName = relsPath.replace(/^ppt\/slides\/_rels\//iu, '').replace(/\.rels$/iu, '');
    const slidePart = `ppt/slides/${slideName}`;
    const xml = await entry.async('string');
    for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/giu)) {
      const attributes = match[1] ?? '';
      const type = /\bType\s*=\s*(["'])(.*?)\1/iu.exec(attributes)?.[2];
      if (!type || !SOURCE_VISUAL_RELATION_SUFFIXES.some((suffix) => type.toLowerCase().endsWith(suffix))) continue;
      for (const target of relationshipTargets(match[0], slidePart)) visualRoots.add(target);
    }
  }

  const artifacts = new Set<string>();
  const pending = [...visualRoots];
  while (pending.length) {
    const part = pending.pop()!;
    if (artifacts.has(part) || !zip.file(part)) continue;
    artifacts.add(part);
    for (const related of await readRelationships(zip, part)) {
      if (!artifacts.has(related)) pending.push(related);
    }
  }
  return artifacts;
}

/**
 * Remove only source visual parts that are unreachable from the generated package root.
 * Office Kit's public package cleanup compacts orphan media, but does not compact chart/workbook parts.
 * WHY_NOT_REUSE=Office Kit 0.21.0 exposes removeSlide/removeSlideNotes and orphan-media compaction,
 * but no general package-part deletion. JSZip is already pinned and used by both renderer paths.
 */
export async function removeUnreachableSourceVisualArtifacts(zip: JSZip, candidates: ReadonlySet<string>): Promise<string[]> {
  const reachable = new Set<string>();
  const pending = await readRelationships(zip, '');
  while (pending.length) {
    const part = pending.pop()!;
    if (reachable.has(part) || !zip.file(part)) continue;
    reachable.add(part);
    pending.push(...await readRelationships(zip, part));
  }

  const removed = [...candidates].filter((part) => !reachable.has(part) && Boolean(zip.file(part)));
  const removedSet = new Set(removed);
  for (const part of removed) {
    zip.remove(part);
    zip.remove(relationshipPartFor(part));
  }
  const contentTypes = zip.file('[Content_Types].xml');
  if (contentTypes && removedSet.size) {
    const xml = await contentTypes.async('string');
    const next = xml.replace(/<Override\b[^>]*\bPartName\s*=\s*(["'])\/([^"']+)\1[^>]*\/?\s*>/giu,
      (tag, _quote: string, part: string) => removedSet.has(part) ? '' : tag);
    zip.file('[Content_Types].xml', next);
  }
  return removed;
}
