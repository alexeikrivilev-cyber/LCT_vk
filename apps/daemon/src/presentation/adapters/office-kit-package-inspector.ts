import {
  getAllCharts,
  getAllImages,
  getAllTables,
  getPresentationTheme,
  getSlideLayoutName,
  getSlideLayoutPlaceholders,
  getSlideLayouts,
  getSlideMasterPartNames,
  getSlideNotes,
  getSlides,
  loadPresentation,
  validatePresentation,
} from '@office-kit/pptx/node';

/** Diagnostic-only package inventory kept behind the Office Kit adapter boundary. */
export async function inspectOfficeKitPackage(bytes: Uint8Array) {
  const presentation = await loadPresentation(bytes);
  const slides = getSlides(presentation);
  const layouts = getSlideLayouts(presentation);
  const issues = validatePresentation(presentation).map((issue) => ({ severity: issue.severity, message: issue.message, partName: issue.partName ?? null }));
  return {
    slideCount: slides.length,
    masterParts: getSlideMasterPartNames(presentation),
    layoutNames: layouts.map((layout) => ({ name: getSlideLayoutName(layout), placeholderCount: getSlideLayoutPlaceholders(layout).length })),
    themeAvailable: Boolean(getPresentationTheme(presentation)),
    mediaCount: getAllImages(presentation).length,
    chartCount: getAllCharts(presentation).length,
    tableCount: getAllTables(presentation).length,
    notesSlideCount: slides.filter((slide) => Boolean(getSlideNotes(slide))).length,
    validationIssues: issues,
  };
}
