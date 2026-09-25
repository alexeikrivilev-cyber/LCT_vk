import type { CompiledSlide } from './slide-compilation.js';
import type { TemplateElement, TemplateIR, TemplateSlide } from '../domain/template-ir.js';

const MIN_EXEMPLAR_CONFIDENCE = 0.72;
const VARIANT_FAMILY_INDEX = { A: 0, B: 1, C: 2 } as const;

export interface ExemplarSlideSelection {
  sourceSlideIndex: number;
  sourcePart: string;
  layoutId: string;
  archetype: 'cover' | 'section-divider' | 'content';
  role: CompiledSlide['intent'];
  confidence: number;
  slots: {
    title: { elementId: string; nativeId: string };
    body: { elementId: string; nativeId: string };
    visual: null;
  };
  clearElementNativeIds: string[];
  preserveChromeNativeIds: string[];
  familyKey: string;
  evidence: string[];
  limitations: string[];
}

interface Candidate {
  selection: ExemplarSlideSelection;
  score: number;
}

function area(box: { x: number; y: number; width: number; height: number } | null | undefined): number {
  return box && box.width > 0 && box.height > 0 ? box.width * box.height : 0;
}

function geometryOf(element: TemplateElement) {
  return element.geometry.resolved ?? element.geometry.direct;
}

function maxFont(element: TemplateElement): number {
  return Math.max(0, ...(element.directStyles.fontSizesPt ?? []));
}

function normalizedText(element: TemplateElement): string {
  return (element.text ?? '').trim().replace(/\s+/g, ' ');
}

function topLevelTextShapes(slide: TemplateSlide): TemplateElement[] {
  return slide.elements.filter((element) => element.kind.toLowerCase() === 'shape'
    && element.parentId === null && Boolean(normalizedText(element)));
}

function overlapFraction(box: NonNullable<ReturnType<typeof geometryOf>>, region: { x: number; y: number; width: number; height: number }): number {
  const left = Math.max(box.x, region.x);
  const top = Math.max(box.y, region.y);
  const right = Math.min(box.x + box.width, region.x + region.width);
  const bottom = Math.min(box.y + box.height, region.y + region.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top) / Math.max(1, area(box));
}

function geometryBand(value: number, unit: number): number {
  return Math.round(value / unit);
}

function estimatedLineFit(text: string, element: TemplateElement): number {
  const box = geometryOf(element);
  if (!box) return 0;
  const fontSizePt = Math.max(8, maxFont(element));
  const widthPt = box.width / 12700;
  const heightPt = box.height / 12700;
  const charactersPerLine = Math.max(6, widthPt / (fontSizePt * 0.52));
  const lineHeightPt = fontSizePt * 1.2;
  const requiredLines = Math.max(1, text.split(/\r?\n/).reduce((sum, line) => sum + Math.max(1, Math.ceil(Array.from(line).length / charactersPerLine)), 0));
  const availableLines = Math.max(0.25, heightPt / lineHeightPt);
  return Number(Math.min(1, availableLines / requiredLines).toFixed(4));
}

function familyKey(slide: TemplateSlide, title: TemplateElement, body: TemplateElement, template: TemplateIR): string {
  const titleBox = geometryOf(title)!;
  const bodyBox = geometryOf(body)!;
  const textCount = topLevelTextShapes(slide).length;
  const shapeCount = slide.elements.filter((element) => element.kind.toLowerCase() === 'shape' && !normalizedText(element)).length;
  const connectorCount = slide.elements.filter((element) => element.kind.toLowerCase() === 'connector').length;
  const bucket = (box: typeof titleBox) => [
    geometryBand(box.x / template.slideSize.width, 0.1),
    geometryBand(box.y / template.slideSize.height, 0.1),
    geometryBand(box.width / template.slideSize.width, 0.15),
    geometryBand(box.height / template.slideSize.height, 0.08),
  ].join(',');
  return [slide.layoutId, bucket(titleBox), bucket(bodyBox),
    geometryBand(maxFont(title), 8), geometryBand(maxFont(body), 4),
    Math.floor(textCount / 5), Math.floor(shapeCount / 3), Math.floor(connectorCount / 4)].join('|');
}

function chromeIds(template: TemplateIR, layoutId: string): Set<string> {
  const slides = template.slides.filter((slide) => slide.layoutId === layoutId);
  const occurrences = new Map<string, Set<string>>();
  for (const slide of slides) for (const element of topLevelTextShapes(slide)) {
    const text = normalizedText(element);
    if (!text || !element.nativeId) continue;
    const seen = occurrences.get(text) ?? new Set<string>();
    seen.add(slide.sourcePart);
    occurrences.set(text, seen);
  }
  const minimum = Math.ceil(slides.length * 0.6);
  const ids = new Set<string>();
  for (const slide of slides) for (const element of topLevelTextShapes(slide)) {
    const box = geometryOf(element);
    if (!box || !element.nativeId || maxFont(element) > 12 || box.height > template.slideSize.height * 0.06) continue;
    const atEdge = box.y <= template.slideSize.height * 0.12
      || box.y + box.height >= template.slideSize.height * 0.92;
    if (atEdge && (occurrences.get(normalizedText(element))?.size ?? 0) >= minimum) ids.add(element.id);
  }
  return ids;
}

function titleForSlide(slide: TemplateSlide, evidence: NonNullable<CompiledSlide['layoutCandidates'][number]['slotEvidence']['title']>) {
  const sample = evidence.sourceEvidence.find((item) => item.sourcePart === slide.sourcePart && item.slideIndex === slide.index);
  if (sample) return slide.elements.find((element) => element.id === sample.elementId) ?? null;
  const placeholders = slide.elements.filter((element) => {
    const identity = `${element.placeholder?.type ?? ''} ${element.placeholder?.role ?? ''}`.toLowerCase();
    return /title|subtitle/.test(identity) && normalizedText(element).length > 0;
  });
  return placeholders.length === 1 ? placeholders[0]! : null;
}

function candidateFor(
  compiled: CompiledSlide,
  template: TemplateIR,
  slide: TemplateSlide,
  titleEvidence: NonNullable<CompiledSlide['layoutCandidates'][number]['slotEvidence']['title']>,
  bodyEvidence: NonNullable<CompiledSlide['layoutCandidates'][number]['slotEvidence']['body']>,
  preservedChromeIds: ReadonlySet<string>,
): Candidate | null {
  if (slide.layoutId !== compiled.layoutId || !slide.sourcePart || slide.elements.some((element) => element.parentId !== null)) return null;
  if (slide.relationships.some((relationship) => {
    const type = relationship.type.toLowerCase();
    return type.endsWith('/slide') || type.endsWith('/hyperlink');
  })) return null;
  const unsupportedVisual = slide.elements.some((element) => ['picture', 'image', 'table', 'chart', 'graphicframe', 'group']
    .includes(element.kind.toLowerCase().replaceAll('_', '').replaceAll('-', '')));
  if (unsupportedVisual) return null;

  const title = titleForSlide(slide, titleEvidence);
  const titleBox = title ? geometryOf(title) : null;
  if (!title || !title.nativeId || !titleBox) return null;
  const bodySamples = bodyEvidence.sourceEvidence.filter((item) => item.sourcePart === slide.sourcePart && item.slideIndex === slide.index);
  const bodyCandidates = bodySamples.map((sample) => slide.elements.find((element) => element.id === sample.elementId))
    .filter((element): element is TemplateElement => Boolean(element && element.id !== title.id && element.nativeId
      && element.kind.toLowerCase() === 'shape' && element.parentId === null && normalizedText(element)
      && geometryOf(element) && maxFont(element) >= 7.5 && maxFont(element) <= 24))
    .map((element) => ({
      element,
      overlap: overlapFraction(geometryOf(element)!, bodyEvidence.geometry),
      areaRatio: area(geometryOf(element)) / Math.max(1, area(bodyEvidence.geometry)),
    }))
    .filter((item) => item.overlap >= 0.65)
    .sort((left, right) => right.areaRatio - left.areaRatio || left.element.order - right.element.order);
  const selectedBody = bodyCandidates[0];
  if (!selectedBody || selectedBody.element.id === title.id) return null;
  const body = selectedBody.element;
  const bodyBox = geometryOf(body)!;
  const overlapArea = Math.max(0, Math.min(titleBox.x + titleBox.width, bodyBox.x + bodyBox.width) - Math.max(titleBox.x, bodyBox.x))
    * Math.max(0, Math.min(titleBox.y + titleBox.height, bodyBox.y + bodyBox.height) - Math.max(titleBox.y, bodyBox.y));
  if (overlapArea / Math.max(1, Math.min(area(titleBox), area(bodyBox))) > 0.08) return null;
  const textShapes = topLevelTextShapes(slide);
  if (textShapes.length < 2 || textShapes.some((element) => !element.nativeId)) return null;
  const titleSupport = titleEvidence.sourceEvidence.filter((item) => item.sourcePart === slide.sourcePart).length;
  const bodySupport = bodyEvidence.sourceEvidence.filter((item) => item.sourcePart === slide.sourcePart).length;
  const styleHierarchy = maxFont(title) > maxFont(body) ? 1 : 0.55;
  const geometryFit = selectedBody.overlap;
  const titleFit = estimatedLineFit(compiled.title, title);
  const bodyFit = estimatedLineFit(compiled.body.join('\n'), body);
  const contentFit = Math.min(titleFit, bodyFit);
  if (contentFit < 0.55) return null;
  const confidence = Number((0.36 * titleEvidence.confidence + 0.36 * bodyEvidence.confidence
    + 0.16 * geometryFit + 0.12 * styleHierarchy).toFixed(4));
  if (confidence < MIN_EXEMPLAR_CONFIDENCE) return null;

  const clearElementNativeIds = textShapes.filter((element) => element.id !== title.id && element.id !== body.id
    && !preservedChromeIds.has(element.id)).map((element) => element.nativeId!);
  const preserveChromeNativeIds = textShapes.filter((element) => preservedChromeIds.has(element.id)
    && element.id !== title.id && element.id !== body.id).map((element) => element.nativeId!);
  const evidence = [
    `title donor repeats across ${titleEvidence.sampleCount} slides in the selected layout`,
    `body donor region repeats across ${bodyEvidence.sampleCount} slides in the selected layout`,
    `mapped body shape overlaps ${Math.round(geometryFit * 100)}% of its inferred body region`,
    `title/body font hierarchy ${maxFont(title)}pt > ${maxFont(body)}pt`,
    `approximate text-height fit title=${titleFit} body=${bodyFit}; visual preview remains required`,
    `${textShapes.length} text shapes inspected; ${clearElementNativeIds.length} source-specific shapes will be cleared`,
    `${slide.elements.filter((element) => element.kind.toLowerCase() === 'connector').length} native connectors and ${slide.elements.filter((element) => element.kind.toLowerCase() === 'shape' && !normalizedText(element)).length} unlabelled shapes retained`,
    `${titleSupport} title evidence records and ${bodySupport} body evidence records refer to this source slide`,
  ];
  const role = compiled.intent;
  const archetype: ExemplarSlideSelection['archetype'] = role === 'title' ? 'cover'
    : role === 'section' ? 'section-divider' : 'content';
  return {
    score: 0.32 * confidence + 0.23 * geometryFit + 0.15 * styleHierarchy + 0.3 * contentFit,
    selection: {
      sourceSlideIndex: slide.index,
      sourcePart: slide.sourcePart,
      layoutId: slide.layoutId!,
      archetype,
      role,
      confidence,
      slots: {
        title: { elementId: title.id, nativeId: title.nativeId },
        body: { elementId: body.id, nativeId: body.nativeId! },
        visual: null,
      },
      clearElementNativeIds,
      preserveChromeNativeIds,
      familyKey: familyKey(slide, title, body, template),
      evidence,
      limitations: ['The compiled text body is projected into one donor text shape; richer multi-slot narrative mapping is not inferred.'],
    },
  };
}

/** Select the ranked real source-slide family for this variant; return null when that rank has no safe candidate. */
export function selectExemplarSlide(compiled: CompiledSlide, template: TemplateIR): ExemplarSlideSelection | null {
  if (compiled.visualization.type !== 'none' || compiled.visualization.status !== 'none' || compiled.imageRefs.length) return null;
  const layout = compiled.layoutCandidates.find((candidate) => candidate.layoutId === compiled.layoutId
    && candidate.sourcePart === compiled.layoutSourcePart);
  const titleEvidence = layout?.slotEvidence.title;
  const bodyEvidence = layout?.slotEvidence.body;
  if (!titleEvidence || !bodyEvidence || titleEvidence.confidence < MIN_EXEMPLAR_CONFIDENCE
      || bodyEvidence.confidence < MIN_EXEMPLAR_CONFIDENCE) return null;
  const chrome = chromeIds(template, layout.layoutId);
  const candidates = template.slides.map((slide) => candidateFor(compiled, template, slide, titleEvidence, bodyEvidence, chrome))
    .filter((candidate): candidate is Candidate => candidate !== null);
  const byFamily = new Map<string, Candidate>();
  for (const candidate of candidates.sort((left, right) => right.score - left.score
    || left.selection.sourceSlideIndex - right.selection.sourceSlideIndex)) {
    if (!byFamily.has(candidate.selection.familyKey)) byFamily.set(candidate.selection.familyKey, candidate);
  }
  const families = [...byFamily.values()].sort((left, right) => right.score - left.score
    || left.selection.sourceSlideIndex - right.selection.sourceSlideIndex);
  const familyIndex = VARIANT_FAMILY_INDEX[compiled.variantId];
  const chosen = families[familyIndex];
  if (!chosen) return null;
  return {
    ...chosen.selection,
    evidence: [...chosen.selection.evidence, `selected family rank ${familyIndex + 1} of ${families.length} supported composition families for variant ${compiled.variantId}`],
  };
}
