export function includeUploadedContentFiles(
  currentPaths: readonly string[],
  uploadedPaths: readonly string[],
  limit = 12,
): string[] {
  const selected = [...new Set(currentPaths.filter(Boolean))].slice(0, limit);
  for (const path of uploadedPaths) {
    if (!path || selected.includes(path)) continue;
    if (selected.length >= limit) break;
    selected.push(path);
  }
  return selected;
}
