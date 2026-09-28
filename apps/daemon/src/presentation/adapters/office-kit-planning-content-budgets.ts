import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  getParagraphPropertiesEffective,
  getShapeBodyPrEffective,
  getShapeId,
  getShapeParagraphCount,
  getShapeRunCount,
  getShapeRunFormatEffective,
  getShapeSize,
  getSlideShapes,
  getSlides,
  loadPresentation,
} from '@office-kit/pptx/node';
import { buildFontkitMeasurer } from '@office-kit/pptx-preview/node';

import { resolvePresentationFilePath } from '../../presentation-files.js';
import {
  assemblePlanningContentBudgets,
  deriveTextRegionBudget,
  planningContentProfileFingerprint,
  type PlanningContentBudgetFamily,
  type RegionMetrics,
} from '../application/planning-content-budgets.js';
import type { TemplateIR } from '../domain/template-ir.js';
import type { TemplateSemanticProfile } from '../application/template-semantic-profiler.js';

const DEFAULT_TEXT_MARGIN_HORIZONTAL_EMU = 91_440;
const DEFAULT_TEXT_MARGIN_VERTICAL_EMU = 45_720;

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function regionMetricsForShape(
  presentation: Awaited<ReturnType<typeof loadPresentation>>,
  shape: ReturnType<typeof getSlideShapes>[number],
  fallbackFontPt: number | undefined,
  fallbackFontFamily?: string,
): RegionMetrics | null {
  const bounds = getShapeSize(shape);
  const widthEmu = bounds?.w ?? 0;
  const heightEmu = bounds?.h ?? 0;
  let fontFamily = fallbackFontFamily ?? '';
  let fontSizePt = fallbackFontPt ?? 0;
  let bold = false;
  let italic = false;
  let foundRun = false;
  const paragraphProperties: RegionMetrics['paragraphProperties'] = [];

  for (let paragraph = 0; paragraph < Math.max(0, getShapeParagraphCount(shape)); paragraph += 1) {
    try {
      const properties = getParagraphPropertiesEffective(presentation, shape, paragraph);
      paragraphProperties.push({
        marL: typeof properties.marL === 'number' ? properties.marL : 0,
        marR: typeof properties.marR === 'number' ? properties.marR : 0,
        indent: typeof properties.indent === 'number' ? properties.indent : 0,
        lineSpacing: properties.lineSpacing && typeof properties.lineSpacing === 'object'
          ? { kind: String(properties.lineSpacing.kind), value: Number(properties.lineSpacing.value) }
          : null,
        spcBefPts: typeof properties.spcBefPts === 'number' ? properties.spcBefPts : 0,
        spcAftPts: typeof properties.spcAftPts === 'number' ? properties.spcAftPts : 0,
        bullet: String(properties.bullet ?? 'none'),
      });
    } catch {
      paragraphProperties.push({ marL: 0, marR: 0, indent: 0, lineSpacing: null, spcBefPts: 0, spcAftPts: 0, bullet: 'none' });
    }
    for (let run = 0; run < getShapeRunCount(shape, paragraph); run += 1) {
      try {
        const format = getShapeRunFormatEffective(presentation, shape, paragraph, run);
        if (typeof format.font === 'string' && format.font.length > 0) fontFamily = format.font;
        if (positive(format.size)) fontSizePt = Math.max(fontSizePt, format.size);
        bold ||= format.bold === true;
        italic ||= format.italic === true;
        foundRun = true;
      } catch {
        // Unresolved typography is excluded instead of inventing a font size.
      }
    }
  }
  if (!widthEmu || !heightEmu || !fontSizePt || !foundRun) return null;

  let bodyPr: ReturnType<typeof getShapeBodyPrEffective>;
  try { bodyPr = getShapeBodyPrEffective(presentation, shape); }
  catch { return null; }
  const { left, right, top, bottom } = bodyPr.margins;
  return {
    widthEmu,
    heightEmu,
    fontFamily,
    fontSizePt,
    bold,
    italic,
    marginsEmu: {
      left: typeof left === 'number' && Number.isFinite(left) ? left : DEFAULT_TEXT_MARGIN_HORIZONTAL_EMU,
      right: typeof right === 'number' && Number.isFinite(right) ? right : DEFAULT_TEXT_MARGIN_HORIZONTAL_EMU,
      top: typeof top === 'number' && Number.isFinite(top) ? top : DEFAULT_TEXT_MARGIN_VERTICAL_EMU,
      bottom: typeof bottom === 'number' && Number.isFinite(bottom) ? bottom : DEFAULT_TEXT_MARGIN_VERTICAL_EMU,
    },
    paragraphProperties,
  };
}

/** Measure the uploaded PPTX with Office Kit, without inference or application-layer renderer imports. */
export async function derivePlanningContentBudgets(input: {
  projectsRoot: string;
  projectId: string;
  template: TemplateIR;
  semanticProfile: TemplateSemanticProfile | null;
  requestedSlideCount: number;
}) {
  const profile = input.semanticProfile;
  if (!profile) return null;
  if (profile.templateIRHash !== input.template.hash) throw new TypeError('Planning budget profile belongs to a different TemplateIR.');
  const source = await resolvePresentationFilePath(input.projectsRoot, input.projectId, input.template.source.filePath, { requireExisting: true });
  const bytes = await readFile(source.absolute);
  const sourceHash = createHash('sha256').update(bytes).digest('hex');
  if (sourceHash !== input.template.source.sha256) throw new TypeError('Planning budget source changed after template compilation.');
  const presentation = await loadPresentation(bytes);
  const nativeSlides = getSlides(presentation);
  const measureText = buildFontkitMeasurer();
  const families: Array<Omit<PlanningContentBudgetFamily, 'familyKey'>> = [];

  for (const profileSlide of profile.slides) {
    const sourceSlide = nativeSlides[profileSlide.sourceSlideIndex - 1];
    const templateSlide = input.template.slides.find((slide) => slide.index === profileSlide.sourceSlideIndex);
    if (!sourceSlide || !templateSlide || !profileSlide.titleElementId || profileSlide.bodyElementIds.length === 0) continue;
    const elements = new Map(templateSlide.elements.map((element) => [element.id, element]));
    const shapes = new Map(getSlideShapes(sourceSlide).map((shape) => [String(getShapeId(shape)), shape]));
    const titleElement = elements.get(profileSlide.titleElementId);
    const titleShape = titleElement?.nativeId ? shapes.get(titleElement.nativeId) : undefined;
    if (!titleElement || !titleShape) continue;
    const titleMetrics = regionMetricsForShape(presentation, titleShape,
      Math.max(0, ...(titleElement.effectiveFontSizesPt ?? titleElement.directStyles.fontSizesPt ?? [])) || undefined,
      titleElement.directStyles.fonts?.[0]);
    const titleRegion = titleMetrics ? deriveTextRegionBudget(titleMetrics, 'title', measureText) : null;
    if (!titleRegion) continue;

    const bodyRegions = [];
    for (const elementId of profileSlide.bodyElementIds) {
      const element = elements.get(elementId);
      const shape = element?.nativeId ? shapes.get(element.nativeId) : undefined;
      if (!element || !shape) continue;
      const metrics = regionMetricsForShape(presentation, shape,
        Math.max(0, ...(element.effectiveFontSizesPt ?? element.directStyles.fontSizesPt ?? [])) || undefined,
        element.directStyles.fonts?.[0]);
      const budget = metrics ? deriveTextRegionBudget(metrics, 'body', measureText) : null;
      if (budget) bodyRegions.push(budget);
    }
    if (!bodyRegions.length) continue;
    families.push({
      archetype: profileSlide.archetype,
      supportedContentModes: [...profileSlide.supportedContentModes],
      titleRegion,
      bodyRegions,
      body: {
        maxCharacters: Math.min(600, bodyRegions.reduce((sum, region) => sum + region.maxCharacters, 0)),
        maxPoints: Math.min(4, Math.max(1, bodyRegions.reduce((sum, region) => sum + region.maxLines, 0))),
        maxCharactersPerPoint: Math.min(180, Math.max(...bodyRegions.map((region) => region.maxCharacters))),
      },
    });
  }

  return assemblePlanningContentBudgets({
    profileSha256: planningContentProfileFingerprint(profile),
    requestedSlideCount: input.requestedSlideCount,
    families,
  });
}
