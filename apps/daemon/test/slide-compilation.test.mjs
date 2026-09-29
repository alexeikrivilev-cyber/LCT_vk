import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { link, mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { register } from 'tsx/esm/api';
import JSZip from 'jszip';

import { inspectPptx } from '../src/presentation/adapters/python-inspector.ts';
import { compileContentIR } from '../src/presentation/application/content-compiler.ts';
import { CONTEXTUAL_AUDIT_RULES, CONTEXTUAL_AUDIT_MESSAGE_CODES, CONTEXTUAL_AUDIT_SCHEMA_VERSION, validateContextualDeckAuditResponse } from '../src/presentation/application/contextual-audit-port.ts';
import { auditCompiledPresentation, canonicalDeterministicAuditSha256, repairCompiledPresentationOnce } from '../src/presentation/application/deterministic-audit.ts';
import { buildPresentationQualityReport, presentationQualityBlockers, PRESENTATION_QUALITY_CATEGORIES } from '../src/presentation/application/presentation-quality-report.ts';
import { assessDeckCompositionDistinctness } from '../src/presentation/application/deck-level-review.ts';
import { createTemplateIR } from '../src/presentation/application/template-mapper.ts';
import { runOfflinePresentationMatrix } from '../src/presentation/application/offline-matrix-runner.ts';
import { renderNativePptx } from '../src/presentation/application/native-pptx-renderer.ts';
import { applyNativeLayoutCandidate, compilePresentation, extractCanonicalFactualPayload, VARIANT_POLICIES } from '../src/presentation/application/slide-compilation.ts';
import { fitProcessNodeLayout, fitsProcessLabel } from '../src/presentation/application/process-layout.ts';
import {
  applyVariantCompositionAssignment,
  assignDeckVariantCompositions,
  assignSafeVariantCompositions,
  assessVariantCompositionDistinctness as assessVariantCompositionDistinctnessRaw,
  assessExemplarSelection as assessExemplarSelectionRaw,
  classifyExemplarArchetype,
  createCompositionVisualClassificationCache,
  deriveTemplateTitleBox,
  generatedFallbackCompositionSignature,
  nativePlaceholderFallbackSupported,
  templateDerivedCompositionSupported,
  selectExemplarSlide as selectExemplarSlideRaw,
} from '../src/presentation/application/exemplar-slide-selector.ts';
import { PerformanceDiagnostics } from '../src/presentation/performance-diagnostics.ts';
import { OfficeKitPptxRenderer } from '../src/presentation/adapters/office-kit-pptx-renderer.ts';
import { OfficeKitPreviewAdapter } from '../src/presentation/adapters/office-kit-preview-adapter.ts';
import { addTemplateMediaVisualFingerprints } from '../src/presentation/adapters/office-kit-template-media-fingerprint.ts';
import { isValidTemplateSemanticProfile } from '../src/presentation/application/template-semantic-profiler.ts';
import { findSlideLayoutByPartName, getShapeId, getShapeKind, getShapePlaceholderType, getShapePreset, getShapeStrokeArrow, getShapeText, getShapeRunFormatEffective, getShapeStrokeColor, getSlideCharts, getSlideLayoutPlaceholders, getSlideShapes, getSlides, hasShapeText, isShapePlaceholder, loadPresentation } from '@office-kit/pptx/node';
import { briefHash } from '../src/presentation/domain/brief.ts';
import { canonicalizeDeckPlan } from '../src/presentation/domain/deck-plan.ts';
import { sha256Json, templateIRHashPayload } from '../src/presentation/domain/template-ir.ts';
import { makeSyntheticPptx } from '../python-inspector-test-fixtures.mjs';
import { createHardTemplateCorpus } from './hard-template-corpus.mjs';
import { createOfflineReplayManifest, runOfflineMatrixFromState } from '../../../scripts/run-offline-presentation-matrix.mjs';
import { runPptxCompatibilityHarness } from '../../../scripts/compare-pptx-backends.mjs';
import {
  createDuplicateProjectionExemplarTemplate,
  createCrossLayoutFooterTemplate,
  createExemplarTemplate,
  createFamilyExemplarTemplate,
  createSixRegionGridExemplarTemplate,
  createHybridExemplarTemplate,
  createRoleExemplarTemplate,
  createTwoRegionExemplarTemplate,
} from './exemplar-template-fixtures.mjs';

register();

const require = createRequire(import.meta.url);
const PptxGenJS = require('pptxgenjs');
const inch = (value) => Math.round(value * 914400);
const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Y6sAAAAASUVORK5CYII=', 'base64');
const layoutProfiles = (prefix = 'Unknown') => [
  {
    name: `${prefix} / composition 17`,
    title: { x: inch(0.5), y: inch(0.4), width: inch(11.4), height: inch(0.7) },
    body: { x: inch(0.5), y: inch(1.4), width: inch(8.2), height: inch(2.9) },
  },
  {
    name: `${prefix} / visual composition 4`,
    title: { x: inch(0.5), y: inch(0.4), width: inch(11.4), height: inch(0.7) },
    body: { x: inch(0.5), y: inch(1.4), width: inch(4.5), height: inch(2.5) },
    visual: { x: inch(5.4), y: inch(1.4), width: inch(6.6), height: inch(4.4), type: 'pic' },
  },
  {
    name: `${prefix} / text composition 92`,
    title: { x: inch(0.5), y: inch(0.4), width: inch(11.4), height: inch(0.7) },
    body: { x: inch(0.5), y: inch(1.4), width: inch(11.5), height: inch(4.6) },
  },
  {
    name: `${prefix} / balanced composition 31`,
    title: { x: inch(0.5), y: inch(0.4), width: inch(11.4), height: inch(0.7) },
    body: { x: inch(0.5), y: inch(1.4), width: inch(6.2), height: inch(4.3) },
    visual: { x: inch(7.0), y: inch(1.4), width: inch(5.8), height: inch(4.3), type: 'chart' },
  },
];

async function fixture(root, options = {}) {
  const name = options.fileName ?? 'template.pptx';
  const templatePath = path.join(root, name);
  const selectedProfiles = options.layoutProfiles ?? layoutProfiles(options.namePrefix ?? 'Unknown');
  const bytes = await makeSyntheticPptx({ strict: options.strict ?? false, slideCount: 1, layoutCount: options.layoutCount ?? selectedProfiles.length, layoutProfiles: selectedProfiles });
  await writeFile(templatePath, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const inspection = await inspectPptx(templatePath);
  const templateIR = createTemplateIR(inspection, {
    filePath: name,
    originalName: name,
    sha256,
    compiledAt: '2026-09-25T00:00:00.000Z',
    compilerVersion: 'lct-template-compiler/1',
  });
  return { templatePath, templateIR };
}

async function exemplarFixture(root, fileName, options = {}) {
  const templatePath = path.join(root, fileName);
  const { create = createExemplarTemplate, ...fixtureOptions } = options;
  await create(templatePath, fixtureOptions);
  const bytes = await readFile(templatePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const inspection = await inspectPptx(templatePath);
  const templateIR = createTemplateIR(inspection, {
    filePath: fileName, originalName: fileName, sha256,
    compiledAt: '2026-09-25T00:00:00.000Z', compilerVersion: 'lct-template-compiler/1',
  });
  return { templatePath, templateIR, inspection };
}

async function familyExemplarFixture(root, fileName, options = {}) {
  const templatePath = path.join(root, fileName);
  await createFamilyExemplarTemplate(templatePath, options);
  const bytes = await readFile(templatePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const inspection = await inspectPptx(templatePath);
  const templateIR = createTemplateIR(inspection, {
    filePath: fileName, originalName: fileName, sha256,
    compiledAt: '2026-09-25T00:00:00.000Z', compilerVersion: 'lct-template-compiler/1',
  });
  await addTemplateMediaVisualFingerprints(templateIR, bytes);
  return { templatePath, templateIR, inspection };
}

async function nativePlaceholderFixture(root, { genericBodyPlaceholder = false, masterStaticText = null } = {}) {
  const templatePath = path.join(root, 'native-placeholder-template.pptx');
  const deck = new PptxGenJS();
  deck.layout = 'LAYOUT_WIDE';
  deck.defineSlideMaster({
    title: 'Native placeholder layout',
    background: { color: 'F8FAFC' },
    objects: [
      ...(masterStaticText ? [{ text: { text: masterStaticText, options: { x: 0.7, y: 0.95, w: 5.5, h: 0.35, fontFace: 'Aptos', fontSize: 18, color: '243B53' } } }] : []),
      { placeholder: { options: { name: 'Native title', type: 'title', x: 0.55, y: 0.35, w: 11.9, h: 0.8, fontFace: 'Aptos Display', fontSize: 30, bold: true, color: '183B56', margin: 0 } } },
      { placeholder: { options: { name: 'Native body', type: 'body', x: 0.65, y: 1.45, w: 8.2, h: 4.6, fontFace: 'Aptos', fontSize: 18, color: '243B53', margin: 0.05 } } },
    ],
  });
  const slide = deck.addSlide({ masterName: 'Native placeholder layout' });
  slide.addText('Template title sample', { placeholder: 'Native title' });
  slide.addText('Template body sample', { placeholder: 'Native body' });
  await deck.writeFile({ fileName: templatePath });
  if (genericBodyPlaceholder) {
    const zip = await JSZip.loadAsync(await readFile(templatePath));
    for (const entry of Object.values(zip.files)) {
      if (entry.dir || !entry.name.endsWith('.xml')) continue;
      const xml = await entry.async('string');
      zip.file(entry.name, xml.replace(/type="body"/gu, ''));
    }
    await writeFile(templatePath, await zip.generateAsync({ type: 'nodebuffer' }));
  }
  const bytes = await readFile(templatePath);
  const inspection = await inspectPptx(templatePath);
  const templateIR = createTemplateIR(inspection, {
    filePath: path.basename(templatePath), originalName: path.basename(templatePath),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    compiledAt: '2026-09-25T00:00:00.000Z', compilerVersion: 'lct-template-compiler/1',
  });
  templateIR.slides = [];
  templateIR.hash = sha256Json(templateIRHashPayload(templateIR));
  return { templatePath, templateIR };
}

async function inferredRegionTemplateFixture(root, { masterStaticText = null, masterLogo = false, darkTheme = false, darkBodyBlack = false } = {}) {
  const templatePath = path.join(root, 'inferred-region-template.pptx');
  const deck = new PptxGenJS();
  deck.layout = 'LAYOUT_WIDE';
  deck.theme = { headFontFace: 'Aptos Display', bodyFontFace: 'Aptos', lang: 'ru-RU' };
  deck.defineSlideMaster({
    title: 'Inferred region master',
    background: { color: darkTheme ? '111827' : 'F7F9FC' },
    objects: [
      ...(masterLogo ? [{ rect: { x: 1.1, y: 2.1, w: 0.8, h: 0.55, fill: { color: '1769FF' }, line: { color: '1769FF' } } }] : []),
      ...(masterStaticText ? [{ text: { text: masterStaticText, options: { x: 0.7, y: 0.9, w: 4.5, h: 0.35, fontFace: 'Aptos', fontSize: 12, color: '465569' } } }] : []),
    ],
  });
  for (let index = 0; index < 4; index += 1) {
    const slide = deck.addSlide({ masterName: 'Inferred region master' });
    slide.addText(`Example title ${index + 1}`, {
      x: 0.76, y: 0.55, w: 11.2, h: 0.82, fontFace: 'Aptos Display', fontSize: 30, bold: true, color: darkTheme ? 'F9FAFB' : '172B4D', margin: 0,
    });
    slide.addText(`Example body region ${index + 1}. Repeated geometry provides generic title and body evidence.`, {
      x: 1.04, y: 1.9, w: 10.65, h: 4.8, fontFace: 'Aptos', fontSize: 18,
      color: darkTheme && darkBodyBlack ? '172B4D' : darkTheme ? 'F9FAFB' : '425466', margin: 0.05,
    });
  }
  await deck.writeFile({ fileName: templatePath });
  const bytes = await readFile(templatePath);
  const inspection = await inspectPptx(templatePath);
  const templateIR = createTemplateIR(inspection, {
    filePath: path.basename(templatePath), originalName: path.basename(templatePath),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    compiledAt: '2026-09-28T00:00:00.000Z', compilerVersion: 'lct-template-compiler/1',
  });
  return { templatePath, templateIR };
}

async function semanticVisualSlotFixture(root, { darkTheme = false } = {}) {
  const templatePath = path.join(root, 'semantic-visual-slot-template.pptx');
  const deck = new PptxGenJS();
  deck.layout = 'LAYOUT_WIDE';
  deck.defineSlideMaster({ title: 'Measured visual slot', ...(darkTheme ? { background: { color: '111827' } } : {}), objects: [] });
  for (let index = 0; index < 4; index += 1) {
    const slide = deck.addSlide({ masterName: 'Measured visual slot' });
    slide.addText(`Mapped source title ${index + 1}`, {
      x: 0.62, y: 0.32, w: 11.9, h: 0.72, fontFace: 'Aptos Display', fontSize: 30, bold: true, margin: 0,
      ...(darkTheme ? { color: 'F9FAFB' } : {}),
    });
    slide.addText(`Mapped source body ${index + 1}. This is the measured editable body region.`, {
      x: 0.68, y: 1.35, w: 4.7, h: 5.45, fontFace: 'Aptos', fontSize: 16, margin: 0,
      ...(darkTheme ? { color: 'F9FAFB' } : {}),
    });
    slide.addShape('rect', {
      x: 5.75, y: 1.35, w: 6.0, h: 5.0,
      line: { color: '274C77', width: 1 }, fill: { color: 'E5EEF7' },
    });
  }
  await deck.writeFile({ fileName: templatePath });
  const bytes = await readFile(templatePath);
  const inspection = await inspectPptx(templatePath);
  const templateIR = createTemplateIR(inspection, {
    filePath: path.basename(templatePath), originalName: path.basename(templatePath),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    compiledAt: '2026-09-25T00:00:00.000Z', compilerVersion: 'lct-template-compiler/1',
  });
  const semanticProfile = semanticProfileFor(templateIR);
  for (const profileSlide of semanticProfile.slides) {
    const sourceSlide = templateIR.slides.find((slide) => slide.index === profileSlide.sourceSlideIndex);
    const visualSlot = sourceSlide?.elements.find((element) => {
      const box = element.geometry.resolved ?? element.geometry.direct;
      return element.kind.toLowerCase() === 'shape' && !element.text?.trim() && (box?.x ?? 0) > templateIR.slideSize.width * 0.4;
    });
    assert.ok(visualSlot?.nativeId, 'fixture exposes one source-free editable vector slot per repeated exemplar');
    profileSlide.visualElementIds = [visualSlot.id];
  }
  return { templatePath, templateIR, semanticProfile };
}

function setProfiledVisualSlotBottomOverrun(template, overrunEmu) {
  for (const profileSlide of template.semanticProfile.slides) {
    const sourceSlide = template.templateIR.slides.find((slide) => slide.index === profileSlide.sourceSlideIndex);
    for (const visualId of profileSlide.visualElementIds) {
      const element = sourceSlide?.elements.find((candidate) => candidate.id === visualId);
      if (!element) continue;
      for (const box of [element.geometry.direct, element.geometry.resolved]) {
        if (box) box.y = template.templateIR.slideSize.height - box.height + overrunEmu;
      }
    }
  }
  template.templateIR.hash = sha256Json(templateIRHashPayload(template.templateIR));
  template.semanticProfile.templateIRHash = template.templateIR.hash;
}

function inspectedCompositionSignature(inspectionEnvelope) {
  const { slideSize } = inspectionEnvelope.inspection;
  const q = (value, extent) => Number((value / extent).toFixed(4));
  const slide = inspectionEnvelope.inspection.slides[0];
  const composition = slide.elements
    .filter((element) => element.parentId === null)
    .sort((left, right) => left.sourceOrder - right.sourceOrder)
    .map((element, order) => {
      const box = element.resolvedGeometry ?? element.rawGeometry;
      return {
        order,
        type: element.type,
        geometry: box ? {
          x: q(box.x, slideSize.width), y: q(box.y, slideSize.height),
          width: q(box.width, slideSize.width), height: q(box.height, slideSize.height),
          rotation: q(box.rotation, 360),
        } : null,
        style: {
          fonts: [...(element.style.fonts ?? [])].sort(),
          fontSizesPt: [...(element.style.font_sizes_pt ?? [])].map((value) => Math.round(value)).sort((a, b) => a - b),
          bold: element.style.bold ?? null,
          italic: element.style.italic ?? null,
          fillColor: element.style.fill_color ?? null,
          lineColor: element.style.line_color ?? null,
        },
        hasText: Boolean(element.text.trim()),
        relationshipType: element.relationship?.type ?? null,
      };
    });
  return createHash('sha256').update(JSON.stringify(composition)).digest('hex');
}

function semanticProfileFor(templateIR, archetypeFor = undefined, confidenceFor = () => 0.9) {
  const canvasArea = templateIR.slideSize.width * templateIR.slideSize.height;
  const textByValue = new Map();
  for (const slide of templateIR.slides) for (const element of slide.elements) {
    if (!element.text?.trim()) continue;
    const key = element.text.trim().replace(/\s+/gu, ' ').toLowerCase();
    textByValue.set(key, (textByValue.get(key) ?? 0) + 1);
  }
  return {
    templateIRHash: templateIR.hash,
    slides: templateIR.slides.map((slide) => {
      const text = slide.elements.filter((element) => element.kind.toLowerCase() === 'shape'
        && element.nativeId && element.text?.trim() && (element.geometry.resolved ?? element.geometry.direct));
      const title = [...text].sort((left, right) => Math.max(0, ...(right.directStyles.fontSizesPt ?? []))
        - Math.max(0, ...(left.directStyles.fontSizesPt ?? [])))[0] ?? null;
      const body = text.filter((element) => element.id !== title?.id).sort((left, right) => {
        const leftBox = left.geometry.resolved ?? left.geometry.direct;
        const rightBox = right.geometry.resolved ?? right.geometry.direct;
        return rightBox.width * rightBox.height / canvasArea - leftBox.width * leftBox.height / canvasArea;
      })[0] ?? null;
      const edgeAndRecurring = (element) => {
        const box = element.geometry.resolved ?? element.geometry.direct;
        const atEdge = box.y <= templateIR.slideSize.height * 0.12 || box.y + box.height >= templateIR.slideSize.height * 0.92;
        const font = Math.max(0, ...(element.directStyles.fontSizesPt ?? []));
        const recurring = (textByValue.get(element.text.trim().replace(/\s+/gu, ' ').toLowerCase()) ?? 0)
          >= Math.max(2, Math.ceil(templateIR.slides.length * 0.6));
        return atEdge && font <= 12 && box.height <= templateIR.slideSize.height * 0.06 && recurring;
      };
      const preserved = text.filter((element) => element.id !== title?.id && element.id !== body?.id && edgeAndRecurring(element));
      const preservedIds = new Set(preserved.map((element) => element.id));
      const replaceable = text.filter((element) => element.id !== title?.id && element.id !== body?.id && !preservedIds.has(element.id));
      return {
        sourceSlideIndex: slide.index,
        archetype: archetypeFor?.(slide) ?? (title && body
          ? (() => {
            const inferred = classifyExemplarArchetype(slide, templateIR, title.id, body.id).archetype;
            return inferred === 'hero' ? 'cover' : inferred;
          })() : 'content'),
        supportedContentModes: ['text'],
        titleElementId: title?.id ?? null,
        bodyElementIds: body ? [body.id] : [],
        visualElementIds: [],
        preservedElementIds: preserved.map((element) => element.id),
        replaceableTextElementIds: replaceable.map((element) => element.id),
        confidence: confidenceFor(slide),
        reasonCodes: ['synthetic-test-evidence'],
      };
    }),
  };
}

function semanticProfileForMultiRegion(templateIR, slideIndexes, bodyIdsBySlide) {
  const baseline = semanticProfileFor(templateIR);
  for (const profileSlide of baseline.slides) {
    profileSlide.confidence = slideIndexes.includes(profileSlide.sourceSlideIndex) ? 0.99 : 0.62;
    if (!slideIndexes.includes(profileSlide.sourceSlideIndex)) continue;
    profileSlide.archetype = 'content-split';
    profileSlide.bodyElementIds = bodyIdsBySlide[profileSlide.sourceSlideIndex] ?? profileSlide.bodyElementIds;
    const mapped = new Set([profileSlide.titleElementId, ...profileSlide.bodyElementIds].filter(Boolean));
    profileSlide.replaceableTextElementIds = profileSlide.replaceableTextElementIds.filter((id) => !mapped.has(id));
  }
  return baseline;
}

function resolvedSemanticProfile(templateIR, semanticProfile) {
  const profile = semanticProfile === null ? undefined : semanticProfile ?? semanticProfileFor(templateIR);
  assert.ok(!profile || isValidTemplateSemanticProfile(profile, templateIR), 'synthetic semantic profile uses only validated source element references');
  return profile;
}

function assessExemplarSelection(compiled, templateIR, semanticProfile = undefined) {
  return assessExemplarSelectionRaw(compiled, templateIR, resolvedSemanticProfile(templateIR, semanticProfile));
}

function selectExemplarSlide(compiled, templateIR, semanticProfile = undefined) {
  return selectExemplarSlideRaw(compiled, templateIR, resolvedSemanticProfile(templateIR, semanticProfile));
}

function assessVariantCompositionDistinctness(slides, templateIR, backend, semanticProfile = undefined) {
  return assessVariantCompositionDistinctnessRaw(slides, templateIR, backend,
    semanticProfile === null ? undefined : semanticProfile ?? semanticProfileFor(templateIR));
}

async function corpusTemplates(root, contentRoot) {
  const corpus = await createHardTemplateCorpus(path.join(root, 'hard-template-corpus'));
  return Promise.all(corpus.map(async (item, index) => {
    const sha256 = createHash('sha256').update(item.bytes).digest('hex');
    const inspection = await inspectPptx(item.path);
    const templateIR = createTemplateIR(inspection, {
      filePath: path.basename(item.path), originalName: path.basename(item.path), sha256,
      compiledAt: '2026-09-25T00:00:00.000Z', compilerVersion: 'lct-template-compiler/1',
    });
    return { id: item.id, pptxPath: item.path, templatePath: item.path, templateIR, contentRoot, index };
  }));
}

async function scenario(root, templateCount = 1, visualTypes = ['chart', 'table', 'kpi', 'process', 'image']) {
  const projectsRoot = path.join(root, 'projects');
  const projectDir = path.join(projectsRoot, 'offline-fixture');
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, 'evidence.md'), [
    '# Revenue grew to $120 million in 2025.',
    'Customer retention improved by 18%.',
    'Operating cost fell to $98 million.',
    'The upload service extracts editable template structure.',
    'The renderer writes editable PowerPoint text objects.',
  ].join('\n\n'));
  await writeFile(path.join(projectDir, 'metrics.csv'), 'Metric,2024,2025\nRevenue,100,120\nRetention,72,90\n');
  await writeFile(path.join(projectDir, 'kpi.csv'), 'Metric,Value\nRevenue,120\n');
  await writeFile(path.join(projectDir, 'process.md'), '1. Parse the template\n\n2. Compile editable slides\n\n3. Validate the presentation\n');
  await writeFile(path.join(projectDir, 'source-image.png'), onePixelPng);
  const contentIR = await compileContentIR(projectsRoot, 'offline-fixture', ['evidence.md', 'metrics.csv', 'kpi.csv', 'process.md', 'source-image.png']);
  const evidenceSourceId = contentIR.sources.find((source) => source.sourcePath === 'evidence.md').id;
  const tableSourceId = contentIR.sources.find((source) => source.sourcePath === 'metrics.csv').id;
  const kpiSourceId = contentIR.sources.find((source) => source.sourcePath === 'kpi.csv').id;
  const processSourceId = contentIR.sources.find((source) => source.sourcePath === 'process.md').id;
  const evidenceUnits = contentIR.units.filter((unit) => unit.text && unit.sourceId === evidenceSourceId);
  const tableUnits = contentIR.units.filter((unit) => unit.kind === 'table-cell' && unit.sourceId === tableSourceId);
  const kpiUnits = contentIR.units.filter((unit) => unit.kind === 'table-cell' && unit.sourceId === kpiSourceId);
  const processUnits = contentIR.units.filter((unit) => unit.text && unit.sourceId === processSourceId);
  assert.ok(contentIR.units.some((unit) => unit.kind === 'media-reference'));
  assert.equal(evidenceUnits.length, 5);
  const draft = {
    workingTitle: 'Offline compiler fixture',
    narrativeSummary: 'A synthetic plan used to exercise native slide compilation.',
    slides: Array.from({ length: 5 }, (_unused, index) => ({
      narrativeRole: index === 0 ? 'opening' : index === 4 ? 'closing' : 'content',
      purpose: `Synthetic purpose ${index + 1}`,
      takeaway: ['Revenue and retention have source-backed values.', 'Revenue and retention values are tabulated.', 'Revenue reached 120 in the source table.', 'The pipeline has three explicit steps.', 'Editable slides retain a source-backed visual.'][index],
      contentRefs: index === 0 || index === 1 ? tableUnits.map((cell) => cell.id)
        : index === 2 ? kpiUnits.map((cell) => cell.id)
          : index === 3 ? processUnits.map((unit) => unit.id) : [evidenceUnits[4].id],
      ...((visualTypes[index] ?? 'none') === 'image' && index === 4 && contentIR.units.some((unit) => unit.kind === 'media-reference')
        ? { mediaRefs: [contentIR.units.find((unit) => unit.kind === 'media-reference').id] }
        : { mediaRefs: [] }),
      semanticVisualType: visualTypes[index] ?? 'none',
      targetDensity: 'balanced',
    })),
  };
  const brief = {
    audience: 'Internal product team',
    purpose: 'Validate offline slide compilation.',
    expectedOutcome: 'Produce a synthetic editable presentation.',
    preferences: ['Use source-backed claims'],
    requestedSlideCount: 5,
  };
  const deckPlan = canonicalizeDeckPlan(draft, {
    id: 'offline_fixture_plan',
    version: 1,
    createdAt: '2026-09-25T00:00:00.000Z',
    inputFingerprint: 'a'.repeat(64),
    briefHash: briefHash(brief),
    allowedContentIds: new Set(contentIR.units.filter((unit) => unit.kind !== 'media-reference').map((unit) => unit.id)),
    allowedMediaIds: new Set(contentIR.units.filter((unit) => unit.kind === 'media-reference').map((unit) => unit.id)),
    requestedSlideCount: 5,
  });
  const templates = templateCount === 5 ? await corpusTemplates(root, projectDir) : [];
  for (let index = 0; index < templateCount && templateCount !== 5; index += 1) {
    const created = await fixture(root, { fileName: `unknown-${index + 1}.pptx`, namePrefix: `Mutated organizer family ${index + 1}` });
    templates.push({ ...created, pptxPath: created.templatePath, contentRoot: projectDir });
  }
  return { brief, contentIR, deckPlan, templates };
}

function singleSlidePlan(deckPlan, contentIR, brief, slideIndex = 4) {
  const { id: _id, order: _order, ...sourceSlide } = deckPlan.slides[slideIndex];
  const singleBrief = { ...brief, requestedSlideCount: 1 };
  const singlePlan = canonicalizeDeckPlan({
    workingTitle: deckPlan.workingTitle,
    narrativeSummary: deckPlan.narrativeSummary,
    slides: [sourceSlide],
  }, {
    id: `${deckPlan.id}_single_slide`,
    version: 1,
    createdAt: deckPlan.createdAt,
    inputFingerprint: deckPlan.inputFingerprint,
    briefHash: briefHash(singleBrief),
    allowedContentIds: new Set(contentIR.units.filter((unit) => unit.kind !== 'media-reference').map((unit) => unit.id)),
    allowedMediaIds: new Set(contentIR.units.filter((unit) => unit.kind === 'media-reference').map((unit) => unit.id)),
    requestedSlideCount: 1,
  });
  return { brief: singleBrief, deckPlan: singlePlan };
}

test('process sequence layout adapts orientation without shrinking template typography', () => {
  const horizontal = fitProcessNodeLayout({ x: 100, y: 200, width: 8_000_000, height: 2_000_000 },
    ['Collect input', 'Analyze structure', 'Export result'], 16);
  assert.equal(horizontal?.axis, 'x');
  assert.equal(horizontal?.nodes.length, 3);
  assert.ok(horizontal?.nodes.every((node) => node.x >= 100 && node.x + node.width <= 8_000_100
    && node.y >= 200 && node.y + node.height <= 2_000_200));
  assert.ok(horizontal?.nodes.slice(1).every((node, index) => node.x > horizontal.nodes[index].x + horizontal.nodes[index].width));

  const vertical = fitProcessNodeLayout({ x: 50, y: 70, width: 2_000_000, height: 8_000_000 },
    ['Collect input', 'Analyze structure', 'Export result'], 16);
  assert.equal(vertical?.axis, 'y');
  assert.ok(vertical?.nodes.slice(1).every((node, index) => node.y > vertical.nodes[index].y + vertical.nodes[index].height));
  assert.equal(fitProcessNodeLayout({ x: 0, y: 0, width: 100_000, height: 100_000 },
    ['A long process label that cannot fit', 'Another long process label'], 16), null,
  'an undersized slot is withheld instead of shrinking text below the template role size');
  assert.equal(fitsProcessLabel({ x: 0, y: 0, width: inch(1), height: inch(1) }, 'подтверждённые', 16), false,
    'an over-wide Cyrillic word is not estimated as if PowerPoint can split it at arbitrary characters');
  assert.equal(fitsProcessLabel({ x: 0, y: 0, width: inch(2), height: inch(1) }, 'подтверждённые данные', 16), true,
    'a word-wrapped label remains eligible when the measured native region has sufficient capacity');
});

test('brief/task instructions never become slide copy, source evidence, or process steps', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-brief-task-not-slide-copy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'projects', 'brief-only');
  await mkdir(projectDir, { recursive: true });
  const task = '1. Покажи показатель за 2025 год.\n\n2. Сформулируй следующий шаг.';
  const context = 'Команда поддержки использует единый маршрут обработки обращений.';
  const contentIR = await compileContentIR(root, 'brief-only', [], { task, context });
  const taskSource = contentIR.sources.find((source) => source.kind === 'brief-task');
  const contextSource = contentIR.sources.find((source) => source.kind === 'brief-context');
  const taskUnits = contentIR.units.filter((unit) => unit.sourceId === taskSource.id);
  const contextUnits = contentIR.units.filter((unit) => unit.sourceId === contextSource.id);
  assert.ok(taskUnits.length >= 2, 'fixture task has separately parsed instructions');
  assert.ok(contextUnits.length > 0, 'fixture includes independently supplied context');

  const brief = { audience: 'Команда', purpose: task, expectedOutcome: 'Краткий обзор', preferences: [], requestedSlideCount: 1 };
  const makePlan = (refs, bodyPoints = undefined, takeaway = 'Результат составил 2025 единиц.') => canonicalizeDeckPlan({
    workingTitle: 'Поддержка обращений',
    narrativeSummary: 'Проверка разделения задачи и исходного контекста.',
    slides: [{
      narrativeRole: 'content', purpose: 'Показать подтверждённый контекст.',
      takeaway, contentRefs: refs, ...(bodyPoints ? { bodyPoints } : {}), mediaRefs: [],
      semanticVisualType: 'process', targetDensity: 'balanced',
    }],
  }, {
    id: 'brief_task_projection', version: 1, createdAt: '2026-09-27T00:00:00.000Z',
    inputFingerprint: 'b'.repeat(64), briefHash: briefHash(brief),
    allowedContentIds: new Set(contentIR.units.filter((unit) => unit.kind !== 'media-reference').map((unit) => unit.id)),
    allowedMediaIds: new Set(), requestedSlideCount: 1,
  });

  const { templates } = await scenario(root);
  const template = templates[0].templateIR;
  const taskOnly = compilePresentation(makePlan(taskUnits.map((unit) => unit.id)), contentIR, template, VARIANT_POLICIES[0]).slides[0];
  assert.deepEqual(taskOnly.body, [], 'imperative brief text is not presentation copy');
  assert.deepEqual(taskOnly.visualization.processSteps, [], 'task bullets are not transformed into a process diagram');
  assert.ok(auditCompiledPresentation({ schemaVersion: 1, variantId: 'A', variantPolicyVersion: VARIANT_POLICIES[0].version,
    deckPlanId: 'brief_task_projection', deckPlanHash: taskOnly.deckPlanHash, contentIRHash: contentIR.hash,
    templateIRId: template.id, templateIRHash: template.hash, slides: [taskOnly] }, contentIR, template)
    .findings.some((finding) => finding.ruleId === 'fidelity.unsupported-number'),
  'a year present only in the task cannot support a visible factual claim');

  const withContext = compilePresentation(makePlan([...taskUnits, ...contextUnits].map((unit) => unit.id)), contentIR, template, VARIANT_POLICIES[0]).slides[0];
  assert.deepEqual(withContext.body, [], 'brief context remains an instruction and does not become exported content');
  assert.deepEqual(withContext.provenanceRefs, [], 'brief fields never become source provenance');

  const generatedCopy = 'Сформулировать ключевую мысль и определить следующий шаг.';
  const generatedProcessPoints = [
    { text: generatedCopy, origin: 'generated-from-brief', evidenceRefs: [] },
    { text: 'Проверить результат и согласовать продолжение.', origin: 'generated-from-brief', evidenceRefs: [] },
  ];
  const generatedPlan = makePlan([], generatedProcessPoints, 'Ключевая мысль ведёт к следующему шагу.');
  const generatedSlide = compilePresentation(generatedPlan, contentIR, template, VARIANT_POLICIES[0]).slides[0];
  assert.deepEqual(generatedSlide.body, generatedProcessPoints.map((point) => point.text), 'generated copy fills task-only slides without copying instructions');
  assert.deepEqual(generatedSlide.provenanceRefs, []);
  assert.deepEqual(generatedSlide.visualization.processSteps, generatedProcessPoints.map((point, generatedBodyPointIndex) => ({
    text: point.text, origin: 'generated-from-brief', sourceRef: null, generatedBodyPointIndex,
  })), 'a requested process uses native sequence labels while keeping brief-generated copy separate from source evidence');
  assert.equal(generatedSlide.visualization.status, 'generated');
  const generatedReport = auditCompiledPresentation({ schemaVersion: 1, variantId: 'A', variantPolicyVersion: VARIANT_POLICIES[0].version,
    deckPlanId: generatedPlan.id, deckPlanHash: generatedPlan.hash, contentIRHash: contentIR.hash,
    templateIRId: template.id, templateIRHash: template.hash, slides: [generatedSlide] }, contentIR, template);
  assert.ok(!generatedReport.findings.some((finding) => finding.ruleId === 'integrity.generated-copy-provenance'));
  assert.ok(!generatedReport.findings.some((finding) => finding.ruleId === 'fidelity.unsupported-number'),
    'ordinary qualitative generated narrative is not treated as an unsupported fact');
  assert.ok(!generatedReport.findings.some((finding) => finding.ruleId === 'integrity.process-source-reference'),
    'generated process labels do not require fabricated ContentIR references');

  const unsupportedGeneratedPlan = makePlan([], [{ text: 'Показатель вырос на 2025%.', origin: 'generated-from-brief', evidenceRefs: [] }], 'Показатель заметно вырос.');
  const unsupportedGeneratedSlide = compilePresentation(unsupportedGeneratedPlan, contentIR, template, VARIANT_POLICIES[0]).slides[0];
  const unsupportedGeneratedReport = auditCompiledPresentation({ schemaVersion: 1, variantId: 'A', variantPolicyVersion: VARIANT_POLICIES[0].version,
    deckPlanId: unsupportedGeneratedPlan.id, deckPlanHash: unsupportedGeneratedPlan.hash, contentIRHash: contentIR.hash,
    templateIRId: template.id, templateIRHash: template.hash, slides: [unsupportedGeneratedSlide] }, contentIR, template);
  assert.ok(unsupportedGeneratedReport.findings.some((finding) => finding.ruleId === 'fidelity.unsupported-number'),
    'generated numeric claims remain flagged unless their own evidence refs support them');

  const namedOutcomePlan = makePlan([], [{ text: 'Клиент Север сократил расходы после внедрения решения.', origin: 'generated-from-brief', evidenceRefs: [] }], 'Решение меняет подход к работе.');
  const namedOutcomeSlide = compilePresentation(namedOutcomePlan, contentIR, template, VARIANT_POLICIES[0]).slides[0];
  const namedOutcomeReport = auditCompiledPresentation({ schemaVersion: 1, variantId: 'A', variantPolicyVersion: VARIANT_POLICIES[0].version,
    deckPlanId: namedOutcomePlan.id, deckPlanHash: namedOutcomePlan.hash, contentIRHash: contentIR.hash,
    templateIRId: template.id, templateIRHash: template.hash, slides: [namedOutcomeSlide] }, contentIR, template);
  assert.ok(namedOutcomeReport.findings.some((finding) => finding.ruleId === 'fidelity.unsupported-specific-claim'
    && finding.evidence.claimType === 'customer-outcome'),
  'a concrete customer outcome without source refs remains visible as an audit warning');

  const unrelatedEvidenceIR = structuredClone(contentIR);
  unrelatedEvidenceIR.sources.push({ id: 'source:evidence', kind: 'text' });
  const unrelatedSourceUnit = { id: 'unit:evidence', sourceId: 'source:evidence', kind: 'text', text: 'Процесс включает проверку и согласование следующего шага.' };
  unrelatedEvidenceIR.units.push(unrelatedSourceUnit);
  const unrelatedEvidenceSlide = structuredClone(generatedSlide);
  unrelatedEvidenceSlide.provenanceRefs = [unrelatedSourceUnit.id];
  unrelatedEvidenceSlide.body = ['Клиент Север сократил расходы после внедрения решения.'];
  unrelatedEvidenceSlide.generatedBodyPoints = [{ text: unrelatedEvidenceSlide.body[0], origin: 'generated-from-brief', evidenceRefs: [unrelatedSourceUnit.id] }];
  const unrelatedEvidenceReport = auditCompiledPresentation({ schemaVersion: 1, variantId: 'A', variantPolicyVersion: VARIANT_POLICIES[0].version,
    deckPlanId: generatedPlan.id, deckPlanHash: generatedPlan.hash, contentIRHash: unrelatedEvidenceIR.hash,
    templateIRId: template.id, templateIRHash: template.hash, slides: [unrelatedEvidenceSlide] }, unrelatedEvidenceIR, template);
  assert.ok(unrelatedEvidenceReport.findings.some((finding) => finding.ruleId === 'fidelity.unsupported-specific-claim'
    && finding.evidence.claimType === 'customer-outcome'),
  'an unrelated evidence ref does not substantiate a specific generated customer outcome');

  const supportedEvidenceIR = structuredClone(unrelatedEvidenceIR);
  const supportedSourceUnit = supportedEvidenceIR.units.find((unit) => unit.id === unrelatedSourceUnit.id);
  supportedSourceUnit.text = 'Клиент Север сократил расходы после внедрения решения.';
  const supportedEvidenceReport = auditCompiledPresentation({ schemaVersion: 1, variantId: 'A', variantPolicyVersion: VARIANT_POLICIES[0].version,
    deckPlanId: generatedPlan.id, deckPlanHash: generatedPlan.hash, contentIRHash: supportedEvidenceIR.hash,
    templateIRId: template.id, templateIRHash: template.hash, slides: [unrelatedEvidenceSlide] }, supportedEvidenceIR, template);
  assert.ok(!supportedEvidenceReport.findings.some((finding) => finding.ruleId === 'fidelity.unsupported-specific-claim'
    && finding.evidence.claimType === 'customer-outcome'),
  'matching source text can support the same specific claim category');
});

test('inherited title sizing is estimated relative to body typography and rejects overflowing headings', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-inherited-title-fit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { contentIR } = await scenario(root);
  const { templateIR: template, semanticProfile: profile } = await semanticVisualSlotFixture(root);
  const reference = contentIR.units.find((unit) => unit.text?.includes('Revenue grew'));
  assert.ok(reference);
  const brief = { audience: 'Команда', purpose: 'Проверить текстовую вместимость.', expectedOutcome: 'Короткий заголовок', preferences: [], requestedSlideCount: 1 };
  const makePlan = (takeaway) => canonicalizeDeckPlan({
    workingTitle: 'Проверка текста', narrativeSummary: 'Тест оценки унаследованной типографики.',
    slides: [{ narrativeRole: 'content', purpose: 'Проверить вместимость заголовка.', takeaway,
      contentRefs: [reference.id], mediaRefs: [], semanticVisualType: 'none', targetDensity: 'compact' }],
  }, {
    id: 'inherited_title_fit', version: 1, createdAt: '2026-09-27T00:00:00.000Z',
    inputFingerprint: 'c'.repeat(64), briefHash: briefHash(brief),
    allowedContentIds: new Set(contentIR.units.filter((unit) => unit.kind !== 'media-reference').map((unit) => unit.id)),
    allowedMediaIds: new Set(), requestedSlideCount: 1,
  });
  const longTitle = 'Платформа корпоративной поддержки последовательно объединяет интеллектуальные ассистенты, маршрутизацию обращений и контроль качества работы команды';
  const shortCompiled = compilePresentation(makePlan('Поддержка обращений.'), contentIR, template, VARIANT_POLICIES[0]);
  for (const slide of template.slides) {
    const titleId = profile.slides.find((item) => item.sourceSlideIndex === slide.index)?.titleElementId;
    const title = slide.elements.find((element) => element.id === titleId);
    assert.ok(title);
    title.directStyles.fontSizesPt = null;
    const inheritedTitleBox = title.geometry.resolved ?? title.geometry.direct;
    assert.ok(inheritedTitleBox);
    inheritedTitleBox.height = Math.round(inheritedTitleBox.height * 1.2);
  }
  template.hash = sha256Json(templateIRHashPayload(template));
  profile.templateIRHash = template.hash;
  // Isolate selector text-fit estimation from the earlier layout-ranker gate.
  const longSlide = structuredClone(shortCompiled.slides[0]);
  longSlide.title = longTitle;
  const longAssessment = assessExemplarSelectionRaw(longSlide, template, profile);
  const titleFitDiagnostics = longAssessment.candidateDiagnostics.filter((item) => item.gate === 'projected-text-fit');
  assert.ok(titleFitDiagnostics.length > 0, 'long title is rejected by the bounded projection fit gate');
  assert.ok(titleFitDiagnostics.every((item) => item.projectedFit.title < 0.72), 'unknown direct title size is not treated as an 8 pt font');

  let borderlineAssessment = null;
  for (let wordCount = 2; wordCount <= 80 && !borderlineAssessment; wordCount += 1) {
    const borderlineSlide = structuredClone(shortCompiled.slides[0]);
    borderlineSlide.title = Array(wordCount).fill('Заголовок').join(' ');
    const assessment = assessExemplarSelectionRaw(borderlineSlide, template, profile);
    const borderlineCandidates = assessment.candidateDiagnostics.filter((item) => item.projectedFit.title >= 0.72
      && item.projectedFit.title < 0.9);
    if (borderlineCandidates.length) borderlineAssessment = { assessment, borderlineCandidates };
  }
  assert.ok(borderlineAssessment, 'fixture exposes a title whose estimated fit is between the old and conservative thresholds');
  assert.ok(borderlineAssessment.borderlineCandidates.every((item) => item.gate === 'projected-text-fit'),
    'titles with unknown inherited size and less than 0.9 fit are rejected before projection');

  const shortAssessment = assessExemplarSelectionRaw(shortCompiled.slides[0], template, profile);
  assert.ok(shortAssessment.safeSelections.length > 0, 'short takeaways remain eligible on the same template');
});

test('one plan compiles deterministically into three layout variants without changing text or provenance', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-slide-compile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { contentIR, deckPlan, templates } = await scenario(root);
  const template = templates[0].templateIR;
  const variants = VARIANT_POLICIES.map((policy) => compilePresentation(deckPlan, contentIR, template, policy));
  const repeated = compilePresentation(deckPlan, contentIR, template, VARIANT_POLICIES[0]);
  assert.deepEqual(repeated, variants[0]);
  assert.equal(new Set(variants.map((variant) => variant.id)).size, 3);
  assert.equal(new Set(variants.map((variant) => variant.slides.map((slide) => slide.layoutSourcePart).join('|'))).size, 3,
    'whole-deck layout tracks should differ when the template offers compatible alternatives');
  for (const slideIndex of deckPlan.slides.map((_slide, index) => index)) {
    const slides = variants.map((variant) => variant.slides[slideIndex]);
    assert.ok(slides.every((slide) => slide.title === deckPlan.slides[slideIndex].takeaway));
    assert.ok(slides.every((slide) => JSON.stringify(slide.provenanceRefs) === JSON.stringify(deckPlan.slides[slideIndex].contentRefs)));
  assert.deepEqual(slides[0].body, slides[1].body);
    assert.deepEqual(slides[1].body, slides[2].body);
    assert.deepEqual(slides[0].imageRefs, slides[2].imageRefs);
  }
  assert.deepEqual(variants[0].slides[1].visualization.tableData, [
    ['Metric', '2024', '2025'],
    ['Revenue', '100', '120'],
    ['Retention', '72', '90'],
  ]);
  assert.equal(auditCompiledPresentation(variants[0], contentIR, template).checks.find((item) => item.ruleId === 'density.table').status, 'checked');
  assert.deepEqual(variants[0].slides[1].body, [], 'table cells are rendered as one native table, not repeated as body copy');
  assert.ok(variants.every((variant) => variant.slides[4].imageRefs.length === 1), 'image media refs remain separate from factual citations');
  assert.ok(variants.every((variant) => variant.slides[0].visualization.chartData?.series.length === 2));
  assert.ok(variants.every((variant) => variant.slides[2].visualization.kpi?.value === '120'));
  assert.equal(variants[0].slides[3].visualization.processSteps.length, 3);
  assert.deepEqual(extractCanonicalFactualPayload(variants[0]), extractCanonicalFactualPayload(variants[1]));
  assert.deepEqual(extractCanonicalFactualPayload(variants[1]), extractCanonicalFactualPayload(variants[2]));
});

test('Markdown heading syntax is removed only for display and an exact takeaway duplicate is not repeated in the body', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-markdown-heading-projection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { brief, contentIR, templates } = await scenario(root, 1, Array(5).fill('none'));
  const heading = contentIR.units.find((unit) => unit.kind === 'heading' && unit.text === '# Revenue grew to $120 million in 2025.');
  assert.ok(heading);
  const takeaway = 'Revenue grew to $120 million in 2025.';
  const deckPlan = canonicalizeDeckPlan({
    workingTitle: 'Heading projection check',
    narrativeSummary: 'One source-backed synthetic claim.',
    slides: [{ narrativeRole: 'opening', purpose: 'State the result.', takeaway, contentRefs: [heading.id], semanticVisualType: 'none', targetDensity: 'balanced' }],
  }, {
    id: 'markdown_heading_projection', version: 1, createdAt: '2026-09-26T00:00:00.000Z', inputFingerprint: 'b'.repeat(64),
    briefHash: briefHash({ ...brief, requestedSlideCount: 1 }),
    allowedContentIds: new Set(contentIR.units.filter((unit) => unit.kind !== 'media-reference').map((unit) => unit.id)),
    allowedMediaIds: new Set(contentIR.units.filter((unit) => unit.kind === 'media-reference').map((unit) => unit.id)),
    requestedSlideCount: 1,
  });
  const compiled = compilePresentation(deckPlan, contentIR, templates[0].templateIR, VARIANT_POLICIES[0]);
  assert.equal(heading.text, '# Revenue grew to $120 million in 2025.', 'ContentIR remains source-faithful');
  assert.equal(compiled.slides[0].title, takeaway);
  assert.deepEqual(compiled.slides[0].body, [], 'the title already carries the exact source claim');
  assert.deepEqual(compiled.slides[0].provenanceRefs, [heading.id], 'removing presentation copy does not remove provenance');
});

test('PresentationQualityReport keeps the safety audit separate, flags tiny body text and source residue, and reports unknown contrast honestly', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-quality-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { contentIR, deckPlan, templates } = await scenario(root, 1, ['chart', 'none', 'none', 'none', 'none']);
  const templateIR = templates[0].templateIR;
  const tracks = VARIANT_POLICIES.map((policy) => compilePresentation(deckPlan, contentIR, templateIR, policy));
  const presentation = tracks[0];
  const slide = presentation.slides[1];
  const report = buildPresentationQualityReport({
    presentation,
    tracks,
    contentIR,
    templateIR,
    composition: {
      signaturesByVariant: {
        A: deckPlan.slides.map((_item, index) => index === 0 ? 'shared-slide-composition' : `A-${index}`),
        B: deckPlan.slides.map((_item, index) => index === 0 ? 'shared-slide-composition' : `B-${index}`),
        C: deckPlan.slides.map((_item, index) => index === 0 ? 'shared-slide-composition' : `C-${index}`),
      },
      kindsByVariant: { A: ['layout-placeholder-backed'], B: ['exemplar-backed'], C: ['layout-placeholder-backed'] },
    },
    renderEvidence: {
      textObjects: [
        { slideId: slide.id, shapeId: 'title', role: 'title', textSha256: 'a'.repeat(64), textLength: 20, fontSizePt: 24, color: '#111111', autoFitScale: null, bounds: slide.placements.title },
        { slideId: slide.id, shapeId: 'body', role: 'body', textSha256: 'b'.repeat(64), textLength: 20, fontSizePt: 8, color: '#111111', autoFitScale: 0.65, bounds: slide.placements.body },
      ],
      sourceContentResidue: { status: 'checked', findings: [{ slideId: slide.id, sourceSlideIndex: 1, sourceElementId: 'donor-copy', textSha256: 'c'.repeat(64), outputShapeId: '42' }] },
    },
    previewEvidence: [{ slideIndex: 1, textLayoutIssues: [{ slideIndex: 1, kind: 'line-wrap', approximate: true,
      severity: 'warning', source: '@office-kit/pptx-preview.auditTextLayout', classification: 'PREVIEW_TEXT_METRIC_APPROXIMATION' }], geometryIssues: [] }],
    safetyAudit: auditCompiledPresentation(presentation, contentIR, templateIR),
  });
  assert.deepEqual(Object.keys(report.categories).sort(), [...PRESENTATION_QUALITY_CATEGORIES].sort());
  assert.equal(report.deterministicSafetyAuditIsSeparate, true);
  assert.equal(report.categories.hierarchy.status, 'error', '8pt output is rejected relative to the observed body typography band');
  assert.equal(report.categories['source-content-residue'].status, 'error');
  assert.equal(report.categories['variant-distinctness'].status, 'pass');
  const deckDistinctness = report.findings.find((finding) => finding.ruleId === 'variant-distinctness.deck-signatures-distinct');
  assert.ok(deckDistinctness, 'a repeated corresponding slide is allowed when the ordered decks remain distinct');
  assert.deepEqual({ AB: deckDistinctness.evidence.slidesDifferAB, AC: deckDistinctness.evidence.slidesDifferAC, BC: deckDistinctness.evidence.slidesDifferBC },
    { AB: deckPlan.slides.length - 1, AC: deckPlan.slides.length - 1, BC: deckPlan.slides.length - 1 });
  assert.ok(report.trackStrategy.A.visualEvidenceSlides > 0, 'table/chart/KPI/process content contributes to track strategy evidence');
  assert.equal(report.categories.contrast.status, 'unknown', 'foreground alone does not prove contrast without the resolved background');
  assert.equal(report.categories['text-fit'].status, 'warning');
  assert.ok(report.findings.some((finding) => finding.ruleId === 'text-fit.approximate-metric-warning'
    && finding.confidence === 'low' && finding.evidence.source === 'office-kit-render-evidence'));
  assert.ok(report.contextualReview.every((item) => item.reason.includes('stored separately')));
  assert.ok(report.findings.some((finding) => finding.ruleId === 'hierarchy.autofit-too-small'));
  assert.ok(report.findings.some((finding) => finding.ruleId === 'source-content-residue.unprojected-donor-text'));

  const selectedGeometryTracks = tracks.map((track, variantIndex) => {
    const bodyAreaShare = [0.12, 0.24, 0.36][variantIndex];
    const visualWidthShare = [0.2, 0.3, 0.4][variantIndex];
    return {
      ...track,
      slides: track.slides.map((compiledSlide) => ({
        ...compiledSlide,
        // Deliberately leave the compile-time body placement unchanged. The
        // renderer uses the assigned exemplar's measured geometry instead.
        exemplarSelection: {
          designFeatures: { bodyAreaShare, visualAreaShare: 0.01 },
          slots: { visual: { geometry: {
            x: 0,
            y: 0,
            width: templateIR.slideSize.width * visualWidthShare,
            height: templateIR.slideSize.height * 0.5,
          } } },
        },
      })),
    };
  });
  const assignedGeometryReport = buildPresentationQualityReport({
    presentation: selectedGeometryTracks[0],
    tracks: selectedGeometryTracks,
    contentIR,
    templateIR,
  });
  assert.equal(assignedGeometryReport.trackStrategy.A.medianBodyAreaShare, 0.12);
  assert.equal(assignedGeometryReport.trackStrategy.B.medianBodyAreaShare, 0.24);
  assert.equal(assignedGeometryReport.trackStrategy.C.medianBodyAreaShare, 0.36);
  assert.equal(assignedGeometryReport.trackStrategy.A.medianVisualAreaShare, 0.1);
  assert.equal(assignedGeometryReport.trackStrategy.B.medianVisualAreaShare, 0.15);
  assert.equal(assignedGeometryReport.trackStrategy.C.medianVisualAreaShare, 0.2);

  const spaciousBTracks = selectedGeometryTracks.map((track, variantIndex) => ({
    ...track,
    slides: track.slides.map((compiledSlide) => ({
      ...compiledSlide,
      exemplarSelection: {
        designFeatures: { bodyAreaShare: [0.12, 0.05, 0.18][variantIndex], visualAreaShare: 0.01 },
        slots: { visual: { geometry: {
          x: 0, y: 0, width: templateIR.slideSize.width * 0.1, height: templateIR.slideSize.height * 0.1,
        } } },
      },
    })),
  }));
  const spaciousBReport = buildPresentationQualityReport({
    presentation: spaciousBTracks[0], tracks: spaciousBTracks, contentIR, templateIR,
  });
  assert.ok(!spaciousBReport.findings.some((finding) => finding.ruleId === 'template-consistency.track-strategy-not-distinct'),
    'B can distinguish the track through a materially smaller body allocation when the template offers no larger safe visual region');

  const exactOverflowReport = buildPresentationQualityReport({
    presentation, tracks, contentIR, templateIR,
    previewEvidence: [{ slideIndex: 1, textLayoutIssues: [{ slideIndex: 1, kind: 'overflow-x', overflowPx: 5,
      approximate: false, severity: 'error', source: '@office-kit/pptx-preview.auditTextLayout', classification: 'PREVIEW_TEXT_OVERFLOW' }], geometryIssues: [] }],
  });
  assert.equal(exactOverflowReport.categories['text-fit'].status, 'error', 'exact Office Kit overflow stays blocking');
  assert.ok(presentationQualityBlockers(exactOverflowReport).some((finding) => finding.ruleId === 'text-fit.rendered-layout-issue'));

  assert.equal(presentationQualityBlockers({ ...report, findings: [
    { category: 'text-fit', severity: 'error', ruleId: 'text-fit.pre-render-capacity-exceeded', confidence: 'medium' },
  ] }).length, 0, 'a heuristic capacity estimate alone is review evidence, not a false hard blocker');
  const exactOverflow = presentationQualityBlockers({ ...report, findings: [
    { category: 'text-fit', severity: 'error', ruleId: 'text-fit.rendered-layout-issue', confidence: 'high' },
  ] });
  assert.equal(exactOverflow.length, 1, 'exact rendered text overflow blocks qualification');
  assert.equal(presentationQualityBlockers({ ...report, findings: [
    { category: 'template-consistency', severity: 'warning', ruleId: 'template-consistency.track-strategy-not-distinct', confidence: 'medium' },
  ] }).length, 1, 'hash-distinct tracks without directional strategy evidence cannot qualify as design strategies');
});

test('layout matching uses geometry and placeholder roles, not declared layout names', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-layout-generalization-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await fixture(root, { fileName: 'layout-family-alpha.pptx', namePrefix: 'Alpha / title left' });
  const second = await fixture(root, { fileName: 'layout-family-omega.pptx', namePrefix: 'Omega / slide 9000' });
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const firstResult = compilePresentation(deckPlan, contentIR, first.templateIR, VARIANT_POLICIES[0]);
  const secondResult = compilePresentation(deckPlan, contentIR, second.templateIR, VARIANT_POLICIES[0]);
  assert.deepEqual(firstResult.slides[0].layoutCandidates.map(({ score, reasons, sourcePart }) => ({ score, reasons, sourcePart })),
    secondResult.slides[0].layoutCandidates.map(({ score, reasons, sourcePart }) => ({ score, reasons, sourcePart })));
  assert.ok(firstResult.slides[0].layoutCandidates[0].reasons.length > 0);
});

test('repeated ordinary text and picture exemplars infer title, body, and split visual slots', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-slots-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exemplar = await exemplarFixture(root, 'ordinary-box-layout.pptx', { masterName: 'Donor name 17' });
  assert.equal(exemplar.templateIR.layouts.reduce((count, layout) => count + layout.elements.filter((element) => element.placeholder !== null).length, 0), 0);
  assert.equal(exemplar.templateIR.slides.length, 4);
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const compiled = compilePresentation(deckPlan, contentIR, exemplar.templateIR, VARIANT_POLICIES[0]);
  const slots = compiled.slides[0].layoutCandidates[0].slotEvidence;
  for (const role of ['title', 'body', 'visual']) {
    assert.ok(slots[role], `missing inferred ${role} slot: ${JSON.stringify(slots)}`);
    assert.equal(slots[role].provenance, 'inferred_exemplar');
    assert.ok(slots[role].confidence >= 0.72);
    assert.ok(slots[role].sampleCount >= 3);
    assert.ok(new Set(slots[role].sourceEvidence.map((source) => source.slideIndex)).size >= 3);
  }
  assert.ok(slots.body.geometry.x < slots.visual.geometry.x, 'body and actual picture evidence form separate columns');
  assert.deepEqual(compiled.slides[0].placements.title, slots.title.geometry);
  assert.deepEqual(compiled.slides[0].placements.body, slots.body.geometry);
  assert.deepEqual(compiled.slides[0].placements.visual, slots.visual.geometry);
});

test('body evidence uses slide-local title bounds, excludes headings and footer furniture, and samples across slides', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-body-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exemplar = await exemplarFixture(root, 'body-evidence.pptx', {
    masterName: 'Body evidence source', evidenceFragments: 20, addLargeFooter: true, addSmallFooter: true,
  });
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const slots = compilePresentation(deckPlan, contentIR, exemplar.templateIR, VARIANT_POLICIES[0]).slides[0].layoutCandidates[0].slotEvidence;
  assert.ok(slots.body);
  assert.ok(slots.body.sourceEvidence.every((source) => Math.max(0, ...(source.fontSizesPt ?? [])) <= 24));
  assert.ok(new Set(slots.body.sourceEvidence.map((source) => source.slideIndex)).size >= 3);
  assert.ok(slots.body.geometry.y + slots.body.geometry.height < inch(6.85), 'large headings and thin footer text are outside the inferred body region');
});

test('requested source images require a measured visual slot with or without body text', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-missing-visual-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exemplar = await exemplarFixture(root, 'text-only-layout.pptx', { masterName: 'Text only', includePicture: false });
  const { contentIR, deckPlan } = await scenario(root, 1, ['none', 'none', 'none', 'none', 'image']);
  const imageUnit = contentIR.units.find((unit) => unit.kind === 'media-reference');
  assert.ok(imageUnit);
  const assertNoVisualSlot = (plan) => assert.throws(() => compilePresentation(plan, contentIR, exemplar.templateIR, VARIANT_POLICIES[0]), (error) => {
    assert.equal(error.code, 'UNSUPPORTED_TEMPLATE_LAYOUT');
    assert.ok(error.candidates.every((candidate) => candidate.slots.visual === null));
    return true;
  });
  assertNoVisualSlot(deckPlan);
  const imageOnlyDraft = {
    workingTitle: deckPlan.workingTitle,
    narrativeSummary: deckPlan.narrativeSummary,
    slides: deckPlan.slides.map(({ id, order, ...slide }, index) => index === 4 ? { ...slide, contentRefs: [] } : slide),
  };
  const imageOnlyPlan = canonicalizeDeckPlan(imageOnlyDraft, {
    id: deckPlan.id, version: deckPlan.version, createdAt: deckPlan.createdAt,
    inputFingerprint: deckPlan.inputFingerprint, briefHash: deckPlan.briefHash,
    allowedContentIds: new Set(contentIR.units.filter((unit) => unit.kind !== 'media-reference').map((unit) => unit.id)),
    allowedMediaIds: new Set(contentIR.units.filter((unit) => unit.kind === 'media-reference').map((unit) => unit.id)),
    requestedSlideCount: deckPlan.slides.length,
  });
  assertNoVisualSlot(imageOnlyPlan);
});

test('multiple repeated visual regions remain ambiguous instead of selecting the last image', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-visual-ambiguity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exemplar = await exemplarFixture(root, 'two-repeated-images.pptx', {
    masterName: 'Two visual regions', pictureCopies: 2,
  });
  const { contentIR, deckPlan } = await scenario(root, 1, ['none', 'none', 'none', 'none', 'image']);
  assert.throws(() => compilePresentation(deckPlan, contentIR, exemplar.templateIR, VARIANT_POLICIES[0]), (error) => {
    assert.equal(error.code, 'UNSUPPORTED_TEMPLATE_LAYOUT');
    assert.ok(error.candidates.every((candidate) => candidate.slots.visual === null));
    return true;
  });
});

test('visual exemplar search fails closed above its bounded geometry candidate budget', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-visual-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exemplar = await exemplarFixture(root, 'many-visuals.pptx', {
    masterName: 'Dense visual source', pictureCopies: 33,
  });
  const { contentIR, deckPlan } = await scenario(root, 1, ['none', 'none', 'none', 'none', 'image']);
  assert.throws(() => compilePresentation(deckPlan, contentIR, exemplar.templateIR, VARIANT_POLICIES[0]), (error) => {
    assert.equal(error.code, 'UNSUPPORTED_TEMPLATE_LAYOUT');
    assert.ok(error.candidates.every((candidate) => candidate.slots.visual === null));
    return true;
  });
});

test('exemplar slot inference is independent of donor/template names', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-name-independence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await exemplarFixture(root, 'first.pptx', { masterName: 'ALPHA title-zone package' });
  const second = await exemplarFixture(root, 'second.pptx', { masterName: 'OMEGA closing-slide package' });
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const evidence = (templateIR) => compilePresentation(deckPlan, contentIR, templateIR, VARIANT_POLICIES[0]).slides[0].layoutCandidates[0].slotEvidence;
  const comparable = (value) => Object.fromEntries(['title', 'body', 'visual'].map((role) => [role, {
    geometry: value[role].geometry, provenance: value[role].provenance, confidence: value[role].confidence, sampleCount: value[role].sampleCount,
  }]));
  assert.deepEqual(comparable(evidence(first.templateIR)), comparable(evidence(second.templateIR)));
});

test('exemplar selection maps exact donor shapes, ranks three supported families, and ignores names', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-families-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await familyExemplarFixture(root, 'first-family.pptx', { masterName: 'Alpha family' });
  const second = await familyExemplarFixture(root, 'renamed-family.pptx', { masterName: 'Omega unrelated name' });
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const selectTracks = (template) => VARIANT_POLICIES.map((policy) => {
    const compiled = compilePresentation(deckPlan, contentIR, template, policy).slides[0];
    return { compiled, selected: selectExemplarSlide(compiled, template) };
  });
  const tracks = selectTracks(first.templateIR);
  const selections = tracks.map((track) => track.selected);
  assert.ok(selections.every(Boolean), 'the source deck contains a safe composition for each track');
  const profile = semanticProfileFor(first.templateIR);
  const distinctness = assessVariantCompositionDistinctnessRaw(tracks.map((track) => track.compiled), first.templateIR, 'office-kit', profile);
  assert.equal(distinctness.distinct, true);
  assert.equal(distinctness.availableDistinctFamilies, 3);
  assert.equal(new Set(distinctness.assignments.map((assignment) => assignment.projectedCompositionSignature)).size, 3,
    'the joint resolver assigns three distinct compositions when all three safe families are available');
  const previousAssignment = distinctness.assignments.find((assignment) => assignment.exemplarSelection);
  assert.ok(previousAssignment?.exemplarSelection);
  const historyAware = assessVariantCompositionDistinctnessRaw(tracks.map((track) => track.compiled), first.templateIR, 'office-kit', profile,
    undefined, undefined, { [previousAssignment.variantId]: [{
      sourcePart: previousAssignment.exemplarSelection.sourcePart,
      sourceSlideIndex: previousAssignment.exemplarSelection.sourceSlideIndex,
    }] });
  const historyChoice = historyAware.assignments.find((assignment) => assignment.variantId === previousAssignment.variantId);
  assert.ok(historyChoice);
  assert.ok(!historyChoice.exemplarSelection
    || historyChoice.exemplarSelection.sourceSlideIndex !== previousAssignment.exemplarSelection.sourceSlideIndex,
  'a safe unused donor or measured native layout is preferred on later slides within the same track');
  for (const selection of selections) {
    const donor = first.templateIR.slides.find((slide) => slide.sourcePart === selection.sourcePart);
    assert.ok(donor?.elements.some((element) => element.id === selection.slots.title.elementId && element.nativeId === selection.slots.title.nativeId));
    assert.ok(donor?.elements.some((element) => element.id === selection.slots.body.elementId && element.nativeId === selection.slots.body.nativeId));
    assert.ok(selection.confidence >= 0.72);
    assert.ok(selection.textProjection.cleared.length + selection.textProjection.removed.length > 0,
      'validated source-only text is either cleared while retaining its style or removed as an unused object');
    assert.ok(selection.preserveChromeNativeIds.length > 0);
  }
  const renamed = selectTracks(second.templateIR).map((track) => track.selected);
  assert.deepEqual(renamed.map((selection) => selection?.sourceSlideIndex), selections.map((selection) => selection?.sourceSlideIndex));
  const uncertain = structuredClone(tracks[0].compiled);
  uncertain.layoutCandidates[0].slotEvidence.body.confidence = 0.71;
  assert.equal(selectExemplarSlide(uncertain, first.templateIR, null), null, 'low-confidence donor geometry fails closed without semantic mapping');
});

test('trusted profiles may classify more than four body regions while projection stays bounded and removes unused panels', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-many-profile-bodies-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await exemplarFixture(root, 'many-profile-bodies.pptx', {
    includePicture: false,
    evidenceFragments: 5,
  });
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const profile = semanticProfileFor(template.templateIR);
  const donor = template.templateIR.slides.find((slide) => slide.index === 1);
  const profileSlide = profile.slides.find((slide) => slide.sourceSlideIndex === 1);
  assert.ok(donor && profileSlide);
  const sourceTextElements = donor.elements.filter((element) => element.kind.toLowerCase() === 'shape'
    && element.nativeId && element.text?.trim() && (element.geometry.resolved ?? element.geometry.direct));
  profileSlide.bodyElementIds = sourceTextElements.filter((element) => element.id !== profileSlide.titleElementId).map((element) => element.id);
  profileSlide.replaceableTextElementIds = profileSlide.replaceableTextElementIds
    .filter((id) => !profileSlide.bodyElementIds.includes(id));
  assert.ok(profileSlide.bodyElementIds.length > 4, 'fixture reproduces a valid profile with more source body regions than the projector fills');
  assert.ok(isValidTemplateSemanticProfile(profile, template.templateIR));

  const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]).slides[1];
  assert.ok(compiled);
  const assessment = assessExemplarSelection(compiled, template.templateIR, profile);
  const donorDiagnostic = assessment.candidateDiagnostics.find((item) => item.sourceSlideIndex === 1);
  assert.equal(donorDiagnostic?.gate, 'passed', JSON.stringify(donorDiagnostic));
  assert.ok(donorDiagnostic.bodyRegionCount <= 4, 'projected body-region search remains bounded at four');
  assert.deepEqual(donorDiagnostic.blockedTextElementIds, [], 'every non-projected meaningful source text region is accounted for');

  const selectedElementIds = new Set(donorDiagnostic.replacedTextElementIds);
  for (const elementId of profileSlide.bodyElementIds) {
    const element = donor.elements.find((candidate) => candidate.id === elementId);
    assert.ok(element?.nativeId);
    if (!selectedElementIds.has(element.id)) {
      assert.ok(donorDiagnostic.removedTextElementIds.includes(element.id)
        || donorDiagnostic.clearedTextElementIds.includes(element.id),
      'unused profile-mapped body sample is removed when it is a safe top-level shape, otherwise its text is cleared');
    }
  }
});

test('sparse copy selects an aligned compact subset from a larger body grid', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-grid-coherence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await exemplarFixture(root, 'six-region-grid.pptx', { create: createSixRegionGridExemplarTemplate });
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const compiledDeck = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]);
  const compiled = compiledDeck.slides[1];
  assert.ok(compiled);
  const bodyIdsBySlide = Object.fromEntries(template.templateIR.slides.map((slide) => [slide.index,
    slide.elements.filter((element) => element.kind.toLowerCase() === 'shape'
      && element.text?.startsWith('Source panel')).map((element) => element.id)]));
  assert.ok(Object.values(bodyIdsBySlide).every((ids) => ids.length === 6));
  const semanticProfile = semanticProfileForMultiRegion(template.templateIR,
    template.templateIR.slides.map((slide) => slide.index), bodyIdsBySlide);
  const sparseCopy = {
    ...compiled,
    body: ['Первый короткий тезис.', 'Второй короткий тезис.', 'Третий короткий тезис.'],
    visualization: { ...compiled.visualization, type: 'none', status: 'none', tableData: null, tableCellRefs: null, chartData: null, processSteps: [], kpi: null },
    imageRefs: [],
  };
  const assessment = assessExemplarSelection(sparseCopy, template.templateIR, semanticProfile);
  assert.ok(assessment.selection, JSON.stringify(assessment.candidateDiagnostics.filter((candidate) => candidate.projectionSafe === true)));
  assert.ok(assessment.selection.slots.bodySlots.length >= 2 && assessment.selection.slots.bodySlots.length <= 3);
  assert.ok(assessment.selection.designFeatures.bodyArrangementScore >= 0.8,
    `selected body regions should form a compact row or column; score=${assessment.selection.designFeatures.bodyArrangementScore}`);
  const boxes = assessment.selection.slots.bodySlots.map((slot) => {
    const element = template.templateIR.slides.find((slide) => slide.sourcePart === assessment.selection.sourcePart)
      ?.elements.find((candidate) => candidate.id === slot.elementId);
    return element?.geometry.resolved ?? element?.geometry.direct;
  });
  assert.ok(boxes.every(Boolean));
  const sameRow = Math.max(...boxes.map((box) => box.y)) - Math.min(...boxes.map((box) => box.y)) < boxes[0].height * 0.1;
  const sameColumn = Math.max(...boxes.map((box) => box.x)) - Math.min(...boxes.map((box) => box.x)) < boxes[0].width * 0.1;
  assert.ok(sameRow || sameColumn, 'three cards should share one geometric row/column instead of leaving irregular holes');

  const qualitativeKpi = {
    ...sparseCopy,
    visualization: { ...sparseCopy.visualization, type: 'kpi', status: 'generated', kpi: null },
  };
  const renderPath = path.join(root, 'rendered', 'qualitative-kpi-downgrade.pptx');
  await mkdir(path.dirname(renderPath), { recursive: true });
  const rendered = await new OfficeKitPptxRenderer().render({
    compiledPresentation: { ...compiledDeck, id: `${compiledDeck.id}_qualitative_kpi_downgrade`, slides: [qualitativeKpi] },
    contentIR, templateIR: template.templateIR, semanticProfile,
    templatePath: template.templatePath, outputPath: renderPath,
  });
  assert.deepEqual(rendered.visualIntents, [{
    slideId: qualitativeKpi.id,
    requestedType: 'kpi',
    realizedType: 'comparison',
    fallbackReason: 'No source-backed numeric value was available; the safe visual slot was removed and qualitative copy uses measured side-by-side body regions.',
  }], 'a qualitative KPI is downgraded to a measured editable layout, never a fabricated number');
  assert.deepEqual(rendered.unresolvedVisualTypes, []);
});

test('Office Kit renderer preserves distinct projected A/B/C composition signatures', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-rendered-variant-signatures-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await familyExemplarFixture(root, 'rendered-variants-template.pptx');
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const renderedSignatures = [];
  const inspectedSignatures = [];
  for (const policy of VARIANT_POLICIES) {
    const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, policy);
    const slide = compiled.slides[0];
    assert.ok(slide);
    const semanticProfile = semanticProfileFor(template.templateIR);
    const selection = selectExemplarSlide(slide, template.templateIR, semanticProfile);
    assert.ok(selection);
    const outputPath = path.join(root, 'rendered', `${policy.id}.pptx`);
    await mkdir(path.dirname(outputPath), { recursive: true });
    const result = await new OfficeKitPptxRenderer().render({
      compiledPresentation: { ...compiled, id: `${compiled.id}_rendered_${policy.id}`, slides: [slide] },
      contentIR, templateIR: template.templateIR, semanticProfile, templatePath: template.templatePath, outputPath,
    });
    assert.equal(result.validationStatus, 'passed');
    assert.equal(result.reopenStatus, 'passed');
    assert.equal(result.projectedCompositions[0].projectedCompositionSignature, selection.projectedCompositionSignature);
    assert.equal(result.projectedCompositions[0].sourceSlideIndex, selection.sourceSlideIndex);
    renderedSignatures.push(result.projectedCompositions[0].projectedCompositionSignature);
    inspectedSignatures.push(inspectedCompositionSignature(await inspectPptx(outputPath)));
  }
  assert.equal(new Set(renderedSignatures).size, 3,
    'the renderer emits three materially distinct composition signatures instead of trusting source family labels');
  assert.equal(new Set(inspectedSignatures).size, 3,
    'the reopened rendered PPTX files also retain three distinct native compositions');
});

test('Office Kit duplicates an exemplar, preserves donor text style and decoration, and clears source content', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-render-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await familyExemplarFixture(root, 'family-template.pptx', { varyingFooter: true });
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]);
  const compiledSlide = compiled.slides.at(-1);
  assert.ok(compiledSlide);
  const semanticProfile = semanticProfileFor(template.templateIR);
  const selection = selectExemplarSlide(compiledSlide, template.templateIR, semanticProfile);
  assert.ok(selection);
  const sourceHash = createHash('sha256').update(await readFile(template.templatePath)).digest('hex');
  const outputPath = path.join(root, 'output', 'exemplar-probe.pptx');
  await mkdir(path.dirname(outputPath), { recursive: true });
  const oneSlide = { ...compiled, id: `${compiled.id}_single`, slides: [compiledSlide] };
  const result = await new OfficeKitPptxRenderer().render({
    compiledPresentation: oneSlide, contentIR, templateIR: template.templateIR, semanticProfile,
    templatePath: template.templatePath, outputPath,
  });
  assert.equal(result.slideCount, 1);
  assert.equal(result.reopenStatus, 'passed');
  assert.equal(result.validationStatus, 'passed');
  assert.equal(result.templatePreservationStatus, 'passed');
  assert.equal(result.projectedCompositions.length, 1);
  assert.equal(result.projectedCompositions[0].projectedCompositionSignature, selection.projectedCompositionSignature);
  assert.ok(result.nativeShapeCount >= 1, 'the donor slide keeps its native vector decoration');
  assert.ok(result.nativeTextShapeCount >= 3, 'mapped text and repeated brand text remain native/editable');
  const reopened = await inspectPptx(outputPath);
  const outputSlide = reopened.inspection.slides[0];
  const title = outputSlide.elements.find((element) => element.text.trim() === compiledSlide.title);
  const bodyText = compiledSlide.body.join('\n');
  const body = outputSlide.elements.find((element) => element.text.trim() === bodyText.trim());
  const donorSlide = template.templateIR.slides.find((slide) => slide.sourcePart === selection.sourcePart);
  const titleDonor = donorSlide.elements.find((element) => element.id === selection.slots.title.elementId);
  const bodyDonor = donorSlide.elements.find((element) => element.id === selection.slots.body.elementId);
  assert.equal(title?.type, 'shape');
  assert.equal(body?.type, 'shape');
  assert.ok(result.validationIssues.filter((issue) => issue.message.includes('paragraph-end formatting may not be retained')).length >= 2,
    'every replaced donor records the paragraph-end formatting limitation');
  assert.ok(title.style.font_sizes_pt?.[0] <= titleDonor.directStyles.fontSizesPt[0],
    'the donor title style can shrink to fit the generated title');
  assert.ok(title.style.font_sizes_pt?.[0] >= titleDonor.directStyles.fontSizesPt[0] * 0.9,
    'title fitting keeps at least 90% of the donor size');
  assert.equal(title.style.bold ?? null, titleDonor.directStyles.bold);
  assert.deepEqual(body.style.font_sizes_pt, bodyDonor.directStyles.fontSizesPt);
  assert.equal(body.style.bold ?? null, bodyDonor.directStyles.bold);
  assert.deepEqual(title.resolvedGeometry, titleDonor.geometry.resolved);
  assert.deepEqual(body.resolvedGeometry, bodyDonor.geometry.resolved);
  assert.ok(outputSlide.elements.some((element) => element.text.trim() === 'SYNTHETIC BRAND'));
  const packageZip = await (await import('jszip')).default.loadAsync(await readFile(outputPath));
  const packageText = (await Promise.all(Object.values(packageZip.files)
    .filter((entry) => !entry.dir).map((entry) => entry.async('string').catch(() => '')))).join('\n');
  assert.ok(!packageText.includes('Original source headline'));
  assert.ok(!packageText.includes('Original source body'));
  assert.ok(!packageText.includes('Source only detail'));
  assert.ok(!packageText.includes('Source only note'));
  assert.ok(!packageText.includes('Source page'), 'a repeated-position footer with changing source text is cleared');
  assert.equal(Object.keys(packageZip.files).some((name) => /^ppt\/notesSlides\/[^/]+\.xml$/i.test(name)), false);
  assert.equal(createHash('sha256').update(await readFile(template.templatePath)).digest('hex'), sourceHash);
  const preview = await new OfficeKitPreviewAdapter().preview(new Uint8Array(await readFile(outputPath)), 0, 960);
  assert.equal(preview.slideCount, 1);
  assert.ok(preview.png.length > 0);
  assert.match(preview.svg, /Editable slides retain a source-backed visual/);
});

test('Office Kit preserves a full-canvas background shell while replacing the editable source copy', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-full-background-shell-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await familyExemplarFixture(root, 'background-shell-template.pptx', { includeFullCanvasBackground: true });
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]);
  const compiledSlide = compiled.slides.at(-1);
  assert.ok(compiledSlide);
  const assessment = assessExemplarSelection(compiledSlide, template.templateIR);
  assert.ok(assessment.selection, JSON.stringify(assessment.candidateDiagnostics.map(({ sourceSlideIndex, gate, rejectReason, visualClassification }) => ({ sourceSlideIndex, gate, rejectReason, visualClassification }))));
  assert.ok(assessment.candidateDiagnostics.some((candidate) => candidate.visualClassification.some((item) => item.includes(':template-decoration:full-canvas image role recurs across the layout family'))));
  const backgroundDonor = template.templateIR.slides.find((slide) => slide.sourcePart === assessment.selection.sourcePart);
  assert.ok(backgroundDonor);
  const backgroundDonorTitle = backgroundDonor.elements.find((element) => element.id === assessment.selection.slots.title.elementId);
  const backgroundDonorBody = backgroundDonor.elements.find((element) => element.id === assessment.selection.slots.body.elementId);
  assert.ok(backgroundDonorTitle && backgroundDonorBody);
  assert.ok(classifyExemplarArchetype(backgroundDonor, template.templateIR, backgroundDonorTitle.id, backgroundDonorBody.id).visualAreaShare < 0.01,
    'a preserved shell does not make a content composition appear visual-led');
  const profileWithShellVisual = semanticProfileFor(template.templateIR);
  const backgroundImage = backgroundDonor.elements.find((element) => ['image', 'picture'].includes(element.kind.toLowerCase()));
  assert.ok(backgroundImage);
  profileWithShellVisual.slides.find((profileSlide) => profileSlide.sourceSlideIndex === backgroundDonor.index).visualElementIds = [backgroundImage.id];
  const profileConflictAssessment = assessExemplarSelection(compiledSlide, template.templateIR, profileWithShellVisual);
  const profileConflict = profileConflictAssessment.candidateDiagnostics.find((candidate) => candidate.sourceSlideIndex === backgroundDonor.index);
  assert.ok(profileConflict?.evidence.some((item) => item.includes('semantic profile lists') && item.includes('background shell evidence')),
    'a profile visual-element overlap remains visible in candidate diagnostics');

  const oneOffFullBleedTemplate = structuredClone(template.templateIR);
  const familySource = oneOffFullBleedTemplate.slides[0];
  assert.ok(familySource);
  const repeatedFamily = Array.from({ length: 10 }, (_, index) => {
    const clone = structuredClone(familySource);
    clone.index = index + 1;
    clone.id = `${familySource.id}_repeat_${index + 1}`;
    clone.sourcePart = `ppt/slides/repeated-family-${index + 1}.xml`;
    for (const relation of clone.relationships) relation.sourcePart = clone.sourcePart;
    for (const element of clone.elements) element.id = `${element.id}_repeat_${index + 1}`;
    return clone;
  });
  const outlierSlide = repeatedFamily.at(-1);
  assert.ok(outlierSlide);
  const outlierImage = outlierSlide.elements.find((element) => ['image', 'picture'].includes(element.kind.toLowerCase()));
  assert.ok(outlierImage);
  const outlierRelationship = outlierSlide.relationships.find((relationship) => outlierImage.relationshipIds.includes(relationship.id));
  assert.ok(outlierRelationship?.targetPart);
  const previousAsset = oneOffFullBleedTemplate.assets.find((asset) => asset.part === outlierRelationship.targetPart);
  assert.ok(previousAsset?.visualFingerprint);
  const newRelationshipId = `${outlierRelationship.id}_customer_photo`;
  outlierImage.relationshipIds = outlierImage.relationshipIds.map((id) => id === outlierRelationship.id ? newRelationshipId : id);
  outlierRelationship.id = newRelationshipId;
  outlierRelationship.nativeId = `${outlierRelationship.nativeId}_customer_photo`;
  outlierRelationship.target = '../media/customer-photo.png';
  outlierRelationship.targetPart = 'ppt/media/customer-photo.png';
  oneOffFullBleedTemplate.assets.push({
    ...structuredClone(previousAsset), id: `${previousAsset.id}_customer_photo`, part: outlierRelationship.targetPart,
    relationshipIds: [newRelationshipId], visualFingerprint: `rgb16x9-v1:${Buffer.alloc(16 * 9 * 3, 220).toString('base64')}`,
  });
  oneOffFullBleedTemplate.slides = repeatedFamily;
  oneOffFullBleedTemplate.hash = sha256Json(templateIRHashPayload(oneOffFullBleedTemplate));
  const oneOffAssessment = assessExemplarSelection(compiledSlide, oneOffFullBleedTemplate);
  const oneOffCandidate = oneOffAssessment.candidateDiagnostics.find((candidate) => candidate.sourceSlideIndex === 10);
  assert.equal(oneOffCandidate?.gate, 'visual-safety', 'a one-off full-slide image with different sampled appearance remains source-specific inside a recurring layout family');
  assert.ok(oneOffCandidate?.visualClassification.some((item) => item.includes(':source-specific-content:')));
  assert.ok(oneOffAssessment.candidateDiagnostics.filter((candidate) => candidate.sourceSlideIndex < 10)
    .every((candidate) => candidate.visualClassification.some((item) => item.includes(':template-decoration:'))),
  'the nine recurring sampled backgrounds still qualify as a shell');

  const groupedBackgroundTemplate = structuredClone(template.templateIR);
  const groupedBackgroundSlide = groupedBackgroundTemplate.slides[0];
  assert.ok(groupedBackgroundSlide);
  const groupedBackground = groupedBackgroundSlide.elements.find((element) => ['image', 'picture'].includes(element.kind.toLowerCase()));
  assert.ok(groupedBackground);
  groupedBackground.parentId = 'rotated-or-reflected-group';
  groupedBackground.geometry.resolved = null;
  groupedBackground.geometry.provenance = 'unknown';
  groupedBackgroundTemplate.slides = [groupedBackgroundSlide];
  for (const asset of groupedBackgroundTemplate.assets) delete asset.visualFingerprint;
  await addTemplateMediaVisualFingerprints(groupedBackgroundTemplate, new Uint8Array(await readFile(template.templatePath)));
  assert.ok(groupedBackgroundTemplate.assets.every((asset) => !asset.visualFingerprint),
    'a full-canvas local picture with an unresolved ancestor group transform is never fingerprinted as a repeated shell');

  const cropFixture = await familyExemplarFixture(root, 'crop-transform-background-template.pptx', { includeFullCanvasBackground: true });
  const cropArchive = await JSZip.loadAsync(await readFile(cropFixture.templatePath));
  const cropSlidePart = cropFixture.templateIR.slides[1]?.sourcePart;
  assert.ok(cropSlidePart);
  const cropSlideXml = await cropArchive.file(cropSlidePart)?.async('string');
  assert.ok(cropSlideXml);
  const croppedSlideXml = cropSlideXml.replace(/(<a:blip\b[^>]*>[\s\S]*?<\/a:blip>)/i, '$1<a:srcRect l="20000"/>');
  assert.notEqual(croppedSlideXml, cropSlideXml, 'the fixture adds a visible source-rectangle crop to one background instance');
  cropArchive.file(cropSlidePart, croppedSlideXml);
  const croppedPptxPath = path.join(root, 'crop-transform-background-template-cropped.pptx');
  const croppedPptxBytes = await cropArchive.generateAsync({ type: 'nodebuffer' });
  await writeFile(croppedPptxPath, croppedPptxBytes);
  const croppedInspection = await inspectPptx(croppedPptxPath);
  const croppedTemplateIR = createTemplateIR(croppedInspection, {
    filePath: path.basename(croppedPptxPath), originalName: path.basename(croppedPptxPath),
    sha256: createHash('sha256').update(croppedPptxBytes).digest('hex'),
    compiledAt: '2026-09-29T00:00:00.000Z', compilerVersion: 'lct-template-compiler/2',
  });
  await addTemplateMediaVisualFingerprints(croppedTemplateIR, croppedPptxBytes);
  const croppedImage = croppedTemplateIR.slides[1]?.elements.find((element) => ['image', 'picture'].includes(element.kind.toLowerCase()));
  const croppedRelationship = croppedTemplateIR.slides[1]?.relationships.find((relationship) => croppedImage?.relationshipIds.includes(relationship.id));
  const croppedAsset = croppedTemplateIR.assets.find((asset) => asset.part === croppedRelationship?.targetPart);
  assert.equal(croppedAsset?.visualFingerprint, undefined, 'an unmodeled per-picture crop makes raw-image fingerprints unavailable');
  const cropCompiled = compilePresentation(deckPlan, contentIR, croppedTemplateIR, VARIANT_POLICIES[0]);
  const cropAssessment = assessExemplarSelection(cropCompiled.slides.at(-1), croppedTemplateIR);
  const croppedCandidate = cropAssessment.candidateDiagnostics.find((candidate) => candidate.sourceSlideIndex === 2);
  assert.ok(croppedCandidate);
  assert.ok(!croppedCandidate.visualClassification.some((item) =>
    item.includes(':template-decoration:full-canvas image role recurs across the layout family')),
  'a picture with a per-instance crop cannot inherit the repeated background-shell role');

  // Reuse one media part with different DrawingML fill modes across slides.
  // The raw asset pixels match, but a tiled instance must make that part
  // ineligible as a repeated shell for every slide that references it.
  const tiledArchive = await JSZip.loadAsync(await readFile(cropFixture.templatePath));
  const firstBackgroundSlide = cropFixture.templateIR.slides[0];
  const secondBackgroundSlide = cropFixture.templateIR.slides[1];
  assert.ok(firstBackgroundSlide && secondBackgroundSlide);
  const pictureRelationship = (slide) => {
    const picture = slide.elements.find((element) => ['image', 'picture'].includes(element.kind.toLowerCase()));
    return slide.relationships.find((relationship) => picture?.relationshipIds.includes(relationship.id));
  };
  const firstBackgroundRelationship = pictureRelationship(firstBackgroundSlide);
  const secondBackgroundRelationship = pictureRelationship(secondBackgroundSlide);
  assert.ok(firstBackgroundRelationship?.targetPart && secondBackgroundRelationship?.targetPart
    && secondBackgroundRelationship.nativeId);
  const secondRelsPart = `${path.posix.dirname(secondBackgroundSlide.sourcePart)}/_rels/${path.posix.basename(secondBackgroundSlide.sourcePart)}.rels`;
  const secondRels = await tiledArchive.file(secondRelsPart)?.async('string');
  const secondSlideXml = await tiledArchive.file(secondBackgroundSlide.sourcePart)?.async('string');
  assert.ok(secondRels && secondSlideXml);
  const escapedNativeId = secondBackgroundRelationship.nativeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const relTagPattern = new RegExp(`<Relationship\\b(?=[^>]*\\bId=["']${escapedNativeId}["'])[^>]*\\/>`, 'i');
  const originalRelTag = secondRels.match(relTagPattern)?.[0];
  assert.ok(originalRelTag);
  const sharedMediaTarget = path.posix.relative(path.posix.dirname(secondBackgroundSlide.sourcePart), firstBackgroundRelationship.targetPart);
  const updatedRelTag = originalRelTag.replace(/(\bTarget=["'])[^"']+(["'])/i, `$1${sharedMediaTarget}$2`);
  tiledArchive.file(secondRelsPart, secondRels.replace(originalRelTag, updatedRelTag));
  const tiledSlideXml = secondSlideXml.replace(/<a:stretch\b[^>]*>[\s\S]*?<\/a:stretch>/i, '<a:tile/>');
  assert.notEqual(tiledSlideXml, secondSlideXml, 'the second background uses tile while the first retains stretch');
  tiledArchive.file(secondBackgroundSlide.sourcePart, tiledSlideXml);
  const tiledPptxPath = path.join(root, 'same-media-tile-versus-stretch.pptx');
  const tiledPptxBytes = await tiledArchive.generateAsync({ type: 'nodebuffer' });
  await writeFile(tiledPptxPath, tiledPptxBytes);
  const tiledInspection = await inspectPptx(tiledPptxPath);
  const tiledTemplateIR = createTemplateIR(tiledInspection, {
    filePath: path.basename(tiledPptxPath), originalName: path.basename(tiledPptxPath),
    sha256: createHash('sha256').update(tiledPptxBytes).digest('hex'),
    compiledAt: '2026-09-29T00:00:00.000Z', compilerVersion: 'lct-template-compiler/2',
  });
  await addTemplateMediaVisualFingerprints(tiledTemplateIR, tiledPptxBytes);
  const sharedBackgroundAsset = tiledTemplateIR.assets.find((asset) => asset.part === firstBackgroundRelationship.targetPart);
  assert.equal(sharedBackgroundAsset?.visualFingerprint, undefined,
    'a tiled instance invalidates raw-image equivalence for every reference to the shared media part');
  for (const [variantName, transform] of [
    ['nonzero-fill-rect', (xml) => xml.replace(/<a:tile\s*\/>/i, '<a:stretch><a:fillRect l="10000"/></a:stretch>')],
    ['rot-with-shape', (xml) => xml.replace(/<a:tile\s*\/>/i, '<a:stretch><a:fillRect/></a:stretch>')
      .replace(/(<(?:[A-Za-z_][\w.-]*:)?blipFill\b[^>]*)(>)/i, '$1 rotWithShape="1"$2')],
    ['nonrectangular-picture-mask', (xml) => xml.replace(/(<(?:[A-Za-z_][\w.-]*:)?prstGeom\b[^>]*\bprst=["'])rect(["'])/i, '$1ellipse$2')],
    ['custom-picture-mask', (xml) => xml.replace(/<a:prstGeom\b[^>]*>[\s\S]*?<\/a:prstGeom>/i,
      '<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="0" b="0"/><a:pathLst><a:path w="100" h="100"><a:moveTo><a:pt x="50" y="0"/></a:moveTo><a:lnTo><a:pt x="100" y="100"/></a:lnTo><a:lnTo><a:pt x="0" y="100"/></a:lnTo><a:close/></a:path></a:pathLst></a:custGeom>')],
    ['picture-shape-effect', (xml) => xml.replace(/<a:tile\s*\/>/i, '<a:stretch><a:fillRect/></a:stretch>')
      .replace(/<\/p:spPr>/i, '<a:effectLst><a:softEdge rad="100000"/></a:effectLst></p:spPr>')],
  ]) {
    const transformedArchive = await JSZip.loadAsync(tiledPptxBytes);
    const currentXml = await transformedArchive.file(secondBackgroundSlide.sourcePart)?.async('string');
    assert.ok(currentXml);
    const transformedXml = transform(currentXml);
    assert.notEqual(transformedXml, currentXml, `${variantName} fixture adds an unsupported picture fill transform`);
    transformedArchive.file(secondBackgroundSlide.sourcePart, transformedXml);
    const transformedBytes = await transformedArchive.generateAsync({ type: 'nodebuffer' });
    const transformedPath = path.join(root, `${variantName}-same-media.pptx`);
    await writeFile(transformedPath, transformedBytes);
    const transformedIR = createTemplateIR(await inspectPptx(transformedPath), {
      filePath: path.basename(transformedPath), originalName: path.basename(transformedPath),
      sha256: createHash('sha256').update(transformedBytes).digest('hex'),
      compiledAt: '2026-09-29T00:00:00.000Z', compilerVersion: 'lct-template-compiler/2',
    });
    await addTemplateMediaVisualFingerprints(transformedIR, transformedBytes);
    const transformedAsset = transformedIR.assets.find((asset) => asset.part === firstBackgroundRelationship.targetPart);
    assert.equal(transformedAsset?.visualFingerprint, undefined,
      `${variantName} cannot share an untransformed raw-media fingerprint`);
  }
  const tiledAssessment = assessExemplarSelection(compiledSlide, tiledTemplateIR);
  assert.ok(tiledAssessment.candidateDiagnostics.filter((candidate) => [1, 2].includes(candidate.sourceSlideIndex))
    .every((candidate) => !candidate.visualClassification.some((item) =>
      item.includes(':template-decoration:full-canvas image role recurs across the layout family'))),
  'neither stretch nor tile may be promoted from shared raw pixels alone');

  const underdocumentedTemplate = structuredClone(template.templateIR);
  for (const sourceSlide of underdocumentedTemplate.slides) {
    const editableText = sourceSlide.elements.filter((element) => element.kind.toLowerCase() === 'shape' && (element.text ?? '').trim().length > 0);
    const keep = new Set(editableText.slice(0, 2).map((element) => element.id));
    sourceSlide.elements = sourceSlide.elements.filter((element) => ['image', 'picture'].includes(element.kind.toLowerCase()) || keep.has(element.id));
  }
  underdocumentedTemplate.hash = sha256Json(templateIRHashPayload(underdocumentedTemplate));
  const conservativeAssessment = assessExemplarSelection(compiledSlide, underdocumentedTemplate);
  assert.equal(conservativeAssessment.selection, null, 'a full-bleed source image without enough independent editable copy remains fail-closed');
  const underdocumentedCandidate = conservativeAssessment.candidateDiagnostics.find((candidate) => candidate.sourceSlideIndex === 1);
  assert.equal(underdocumentedCandidate?.gate, 'visual-safety');
  assert.ok(underdocumentedCandidate.visualClassification.some((item) => item.includes(':source-specific-content:')));

  compiledSlide.title = 'Generated title designed to wrap across two lines in the narrow donor title box';
  const sourceHash = createHash('sha256').update(await readFile(template.templatePath)).digest('hex');
  const outputPath = path.join(root, 'output', 'background-shell-probe.pptx');
  await mkdir(path.dirname(outputPath), { recursive: true });
  const semanticProfile = semanticProfileFor(template.templateIR);
  const result = await new OfficeKitPptxRenderer().render({
    compiledPresentation: { ...compiled, id: `${compiled.id}_background_shell`, slides: [compiledSlide] },
    contentIR, templateIR: template.templateIR, semanticProfile, templatePath: template.templatePath, outputPath,
  });
  assert.equal(result.reopenStatus, 'passed');
  const reopened = await inspectPptx(outputPath);
  const outputSlide = reopened.inspection.slides[0];
  assert.ok(outputSlide.elements.some((element) => ['image', 'picture'].includes(String(element.type).toLowerCase())), 'the cloned donor retains its native full-canvas background image');
  assert.ok(outputSlide.elements.some((element) => element.text.trim() === compiledSlide.title), 'generated title remains editable native text');
  assert.ok(outputSlide.elements.some((element) => element.text.trim() === compiledSlide.body.join('\n').trim()), 'generated body remains editable native text');
  assert.ok(outputSlide.elements.some((element) => element.text.trim() === 'SYNTHETIC BRAND'), 'independent repeated brand text remains intact');
  const packageZip = await JSZip.loadAsync(await readFile(outputPath));
  const outputMedia = await Promise.all(Object.values(packageZip.files)
    .filter((entry) => !entry.dir && /^ppt\/media\//i.test(entry.name)).map((entry) => entry.async('nodebuffer')));
  assert.ok(outputMedia.some((asset) => asset.equals(onePixelPng)), 'the exact source background asset survives unchanged');
  const packageText = (await Promise.all(Object.values(packageZip.files)
    .filter((entry) => !entry.dir).map((entry) => entry.async('string').catch(() => '')))).join('\n');
  assert.ok(!packageText.includes('Original source headline'));
  assert.ok(!packageText.includes('Original source body'));
  assert.ok(!packageText.includes('Source only detail'));
  assert.equal(createHash('sha256').update(await readFile(template.templatePath)).digest('hex'), sourceHash, 'the immutable source file is not changed');
  const renderedPresentation = await loadPresentation(await readFile(outputPath));
  const renderedSlide = getSlides(renderedPresentation)[0];
  assert.ok(renderedSlide);
  const renderedTitle = getSlideShapes(renderedSlide).find((shape) => getShapeText(shape).trim() === compiledSlide.title);
  assert.ok(renderedTitle);
  assert.ok(getShapeRunFormatEffective(renderedPresentation, renderedTitle, 0, 0).size < 30,
    'a multi-line generated title gets a smaller native run size in its donor box');
  const preview = await new OfficeKitPreviewAdapter().preview(new Uint8Array(await readFile(outputPath)), 0, 960);
  assert.equal(preview.status, 'passed');
  assert.equal(preview.textLayoutIssues.length, 0, 'the fitted long title passes the native text layout preview audit');
});

test('A/B/C selection deduplicates donor families after source text cleanup', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-post-projection-dedup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await exemplarFixture(root, 'duplicate-projection-template.pptx', { create: createDuplicateProjectionExemplarTemplate });
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const assessments = VARIANT_POLICIES.map((policy) => {
    const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, policy).slides[1];
    assert.ok(compiled);
    return assessExemplarSelection(compiled, template.templateIR);
  });
  assert.equal(assessments[0].availableDistinctFamilies, 1,
    'source slides that differ only by removable source text collapse to one distinct family');
  assert.equal(assessments[0].distinctSourceFamilyKeys.length, 3,
    'the original source families were technically different before cleanup');
  assert.ok(assessments[0].selection);
  assert.equal(assessments[1].selection, null);
  assert.equal(assessments[2].selection, null);
  const compiledTracks = VARIANT_POLICIES.map((policy) => compilePresentation(deckPlan, contentIR, template.templateIR, policy).slides[1]);
  assert.ok(compiledTracks.every(Boolean));
  const distinctness = assessVariantCompositionDistinctness(compiledTracks, template.templateIR, 'office-kit');
  assert.equal(distinctness.distinct, true,
    'generic template-derived strategies recover A/B/C after source-only donor differences collapse');
  assert.ok(distinctness.assignments.some((item) => item.compositionKind === 'template-derived-fallback'),
    'collapsed donor families do not masquerade as distinct; a last-resort native composition supplies a needed strategy');
  assert.equal(new Set(distinctness.assignments.map((item) => item.projectedCompositionSignature)).size, 3);
  const visibleClearedBox = structuredClone(template.templateIR);
  const styledChrome = visibleClearedBox.slides.find((slide) => slide.index === 9)?.elements.find((element) => element.text === 'REPEATED BRAND');
  assert.ok(styledChrome);
  styledChrome.directStyles.fillColor = 'FF00AA';
  const visibleBoxAssessment = assessExemplarSelection(compiledTracks[0], visibleClearedBox);
  const ordinaryFamily = visibleBoxAssessment.candidateDiagnostics.find((item) => item.sourceSlideIndex === 1);
  const styledFamily = visibleBoxAssessment.candidateDiagnostics.find((item) => item.sourceSlideIndex === 9);
  assert.ok(ordinaryFamily && styledFamily);
  assert.notEqual(ordinaryFamily.projectedCompositionSignature, styledFamily.projectedCompositionSignature,
    'cleared source copy stays excluded while retained template-chrome style remains in the projected signature');
  assert.equal(assessments[0].evidence[0], `availableDistinctFamilies=${assessments[0].availableDistinctFamilies}`,
    'unavailable variant ranks expose an explicit distinct-family count');
  assert.ok(assessments[0].selection.projectedCompositionSignature.startsWith('sha256:'));
  assert.equal(assessments[0].selection.availableDistinctFamilies, 1,
    'the selected A track carries the explicit post-projection family count');
});

test('content intent prefers safe content donors over a text-fitting hero and titles can still use a hero', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-semantic-role-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await exemplarFixture(root, 'role-template.pptx', { create: createRoleExemplarTemplate });
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]);
  const contentSlide = compiled.slides[1];
  const titleSlide = compiled.slides[0];
  assert.ok(contentSlide && titleSlide);
  const contentAssessment = assessExemplarSelection(contentSlide, template.templateIR);
  assert.ok(contentAssessment.selection);
  assert.equal(contentAssessment.selection.semanticArchetype, 'content');
  assert.ok(!['cover', 'section-divider', 'hero'].includes(contentAssessment.selection.semanticArchetype),
    'a content slide does not select the structurally obvious hero while safe content donors exist');
  const selectedContentDonor = template.templateIR.slides.find((slide) => slide.index === contentAssessment.selection.sourceSlideIndex);
  assert.ok(selectedContentDonor);
  const titleElement = selectedContentDonor.elements.find((element) => element.id === contentAssessment.selection.slots.title.elementId);
  const bodyElement = selectedContentDonor.elements.find((element) => element.id === contentAssessment.selection.slots.body.elementId);
  assert.ok(titleElement && bodyElement);
  assert.ok(classifyExemplarArchetype(selectedContentDonor, template.templateIR, titleElement.id, bodyElement.id).evidence.length >= 3);
  const titleSelection = selectExemplarSlide({ ...titleSlide, title: 'Annual Review' }, template.templateIR, null);
  assert.ok(titleSelection);
  assert.equal(titleSelection.semanticArchetype, 'hero', 'title intent keeps the high-typography hero eligible');

  const sourceUnits = contentIR.units.filter((unit) => unit.text).map((unit) => unit.id);
  const sectionBrief = { audience: 'Reviewers', purpose: 'Introduce one section', expectedOutcome: 'Start a new section', preferences: [], requestedSlideCount: 1 };
  const sectionPlan = canonicalizeDeckPlan({
    workingTitle: 'Section plan', narrativeSummary: 'One synthetic section divider.',
    slides: [{ narrativeRole: 'section-divider', purpose: 'Introduce this section', takeaway: 'New section', contentRefs: [sourceUnits[0]], semanticVisualType: 'none', targetDensity: 'balanced' }],
  }, {
    id: 'synthetic_section_plan', version: 1, createdAt: '2026-09-25T00:00:00.000Z', inputFingerprint: contentIR.hash,
    briefHash: briefHash(sectionBrief), allowedContentIds: new Set(contentIR.units.map((unit) => unit.id)), requestedSlideCount: 1,
  });
  const sectionSlide = compilePresentation(sectionPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]).slides[0];
  assert.ok(sectionSlide);
  const sectionSelection = selectExemplarSlide(sectionSlide, template.templateIR, null);
  assert.ok(sectionSelection);
  assert.equal(sectionSelection.semanticArchetype, 'hero', 'section intent keeps the high-typography hero eligible');

  const splitSlide = template.templateIR.slides.find((slide) => slide.elements.filter((element) =>
    element.kind.toLowerCase() === 'shape' && (element.text ?? '').includes('Second source column')).length === 1);
  assert.ok(splitSlide);
  const splitText = splitSlide.elements.filter((element) => element.kind.toLowerCase() === 'shape' && (element.text ?? '').trim());
  const splitTitle = splitText.find((element) => (element.text ?? '').startsWith('Source headline'));
  const splitBody = splitText.find((element) => (element.text ?? '').startsWith('Source body'));
  assert.ok(splitTitle && splitBody);
  assert.equal(classifyExemplarArchetype(splitSlide, template.templateIR, splitTitle.id, splitBody.id).archetype, 'content-split');
});

test('validated semantic archetypes change donor ranking and structural conflicts remain visible', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-semantic-ranking-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await familyExemplarFixture(root, 'semantic-ranking-template.pptx');
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[2]).slides[1];
  assert.ok(compiled);
  const structural = assessExemplarSelection(compiled, template.templateIR);
  const semanticProfile = semanticProfileFor(template.templateIR,
    (slide) => slide.index <= 4 ? 'content' : slide.index <= 8 ? 'content-dense' : 'table-data',
    (slide) => slide.index <= 4 ? 0.72 : slide.index <= 8 ? 0.9 : 0.99);
  const semantic = assessExemplarSelection(compiled, template.templateIR, semanticProfile);
  assert.ok(structural.selection);
  assert.ok(semantic.selection);
  assert.equal(structural.selection.semanticArchetype, 'content');
  assert.equal(semantic.selection.semanticArchetype, 'content-dense', JSON.stringify(semantic.safeSelections.slice(0, 10).map((item) => ({
    sourceSlideIndex: item.sourceSlideIndex, archetype: item.semanticArchetype, structural: item.designFeatures.structuralArchetype,
    confidence: item.confidence, unused: item.designFeatures.unusedMappedBodyRegionCount, evidence: item.evidence.slice(0, 2),
  }))));
  assert.ok(semantic.selection.sourceSlideIndex >= 5 && semantic.selection.sourceSlideIndex <= 8,
    'the profile ranking selects its higher-confidence variant-preferred family');
  assert.notEqual(semantic.selection.projectedCompositionSignature, structural.selection.projectedCompositionSignature,
    'semantic archetypes change which safe projected composition is selected');
  assert.ok(semantic.candidateDiagnostics.some((candidate) => candidate.structuralArchetype !== candidate.semanticArchetype
    && candidate.evidence.some((item) => item.includes('semantic/structural conflict'))),
  'conflicting semantic and structural classifications are retained as diagnostic evidence');
});

test('donor ranking measures wrapped copy density and recurring source shell', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-density-shell-ranking-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await familyExemplarFixture(root, 'density-shell-template.pptx');
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]).slides[1];
  assert.ok(compiled);
  const semanticProfile = semanticProfileFor(template.templateIR, () => 'content', () => 0.99);
  const shortCopy = {
    ...compiled,
    body: ['Короткий тезис.', 'Ещё один тезис.'],
    targetDensity: 'detailed',
    visualization: { ...compiled.visualization, type: 'none', status: 'none', tableData: null, tableCellRefs: null, chartData: null, processSteps: [], kpi: null },
    imageRefs: [],
  };
  const longCopy = {
    ...shortCopy,
    body: [
      'Первый развернутый вывод занимает несколько строк и показывает, как согласовать роли команды с этапами работы над единым пользовательским сценарием.',
      'Второй развернутый вывод объясняет, какие контрольные точки помогают обнаруживать ошибки, сохранять ответственность и поддерживать качество результата.',
    ],
  };
  const shortAssessment = assessExemplarSelection(shortCopy, template.templateIR, semanticProfile);
  const longAssessment = assessExemplarSelection(longCopy, template.templateIR, semanticProfile);
  assert.ok(shortAssessment.selection && longAssessment.selection);
  assert.ok(longAssessment.selection.designFeatures.textDensity > shortAssessment.selection.designFeatures.textDensity,
    `wrapped copy should occupy more measured capacity: short=${shortAssessment.selection.designFeatures.textDensity}, long=${longAssessment.selection.designFeatures.textDensity}`);

  const firstFamily = shortAssessment.safeSelections.find((selection) => selection.sourceSlideIndex === 1);
  const richestFamily = shortAssessment.safeSelections.find((selection) => selection.sourceSlideIndex === 9);
  assert.ok(firstFamily && richestFamily);
  assert.ok((richestFamily.designFeatures.shellRichnessScore ?? 0) > (firstFamily.designFeatures.shellRichnessScore ?? 0),
    'the safe-shell score should recognize more recurring template decoration without inspecting template names');
  assert.ok(richestFamily.evidence.some((item) => item.includes('safe recurring shell richness=')));
});

test('semantic role hints cannot bypass source-specific projection safety', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-semantic-safety-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await exemplarFixture(root, 'unsafe-semantic-template.pptx', { addLargeFooter: true, includePicture: false });
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]).slides[1];
  assert.ok(compiled);
  const semanticProfile = semanticProfileFor(template.templateIR);
  for (const profileSlide of semanticProfile.slides) {
    const donor = template.templateIR.slides.find((slide) => slide.index === profileSlide.sourceSlideIndex);
    const sourceHeading = donor.elements.find((element) => element.text?.startsWith('Large secondary heading'));
    assert.ok(sourceHeading);
    profileSlide.replaceableTextElementIds = profileSlide.replaceableTextElementIds.filter((id) => id !== sourceHeading.id);
  }
  const assessment = assessExemplarSelection(compiled, template.templateIR, semanticProfile);
  assert.equal(assessment.selection, null, 'unclassified meaningful source text blocks projection instead of being erased');
  assert.ok(assessment.candidateDiagnostics.some((candidate) => candidate.projectionSafe === false && candidate.roleCompatible === false
    && candidate.blockedTextElementIds.length > 0 && candidate.evidence.some((item) => item.includes('ambiguous meaningful'))),
  'an unmapped meaningful source region stays blocked even when other roles are mapped');
});

test('semantic projection assigns complete body blocks across two native regions without losing source provenance', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-multi-region-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await exemplarFixture(root, 'multi-region-template.pptx', { create: createTwoRegionExemplarTemplate });
  const splitDonor = template.templateIR.slides[0];
  assert.ok(splitDonor);
  const sourceShapes = splitDonor.elements.filter((element) => element.kind.toLowerCase() === 'shape' && element.text?.trim());
  const sourceBody = sourceShapes.find((element) => element.text?.startsWith('Left source region'));
  const secondBody = sourceShapes.find((element) => element.text?.startsWith('Right source region'));
  assert.ok(sourceBody && secondBody);
  const profileBodyIds = Object.fromEntries(template.templateIR.slides.map((slide) => {
    const elements = slide.elements.filter((element) => element.kind.toLowerCase() === 'shape' && element.text?.trim());
    return [slide.index, [elements.find((element) => element.text?.startsWith('Left source region')).id,
      elements.find((element) => element.text?.startsWith('Right source region')).id]];
  }));
  const semanticProfile = semanticProfileForMultiRegion(template.templateIR,
    template.templateIR.slides.map((slide) => slide.index), profileBodyIds);
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]);
  const slide = compiled.slides[1];
  assert.ok(slide);
  const assessment = assessExemplarSelection(slide, template.templateIR, semanticProfile);
  const selection = assessment.selection;
  assert.ok(selection, JSON.stringify(assessment.candidateDiagnostics.filter((candidate) => candidate.sourceSlideIndex === splitDonor.index)));
  assert.ok(template.templateIR.slides.some((source) => source.index === selection.sourceSlideIndex));
  assert.equal(selection.slots.bodySlots.length, 2);
  assert.equal(selection.bodyContentRanges.length, 2);
  assert.equal(selection.bodyContentRanges[0]?.start, 0);
  assert.equal(selection.bodyContentRanges.at(-1)?.end, selection.bodySegmentation.fragmentCount);
  const expectedBlocks = selection.bodyContentSegments;
  assert.equal(expectedBlocks.join(''), slide.body.join('\n'), 'region assignment preserves every source-backed body byte in order');
  assert.equal(selection.bodySegmentation.sourceTextSha256, createHash('sha256').update(slide.body.join('\n')).digest('hex'));

  const outputPath = path.join(root, 'output', 'multi-region.pptx');
  await mkdir(path.dirname(outputPath), { recursive: true });
  const result = await new OfficeKitPptxRenderer().render({
    compiledPresentation: { ...compiled, id: `${compiled.id}_multi_region`, slides: [slide] },
    contentIR, templateIR: template.templateIR, semanticProfile, templatePath: template.templatePath, outputPath,
  });
  assert.equal(result.reopenStatus, 'passed');
  const reopened = await inspectPptx(outputPath);
  const renderedBodies = reopened.inspection.slides[0].elements.map((element) => element.text.trim());
  for (const expected of expectedBlocks) assert.ok(renderedBodies.includes(expected.trim()), `native body region retains complete assigned block: ${expected}`);
  assert.ok(!renderedBodies.some((text) => text.startsWith('Left source region') || text.startsWith('Right source region')),
    'sample body claims from the donor template do not survive projection');

  assert.ok(slide.body[0]);
  const oneBlockSlide = { ...slide, body: [slide.body[0]] };
  const oneBlockAssessment = assessExemplarSelection(oneBlockSlide, template.templateIR, semanticProfile);
  assert.ok(oneBlockAssessment.selection, JSON.stringify(oneBlockAssessment.candidateDiagnostics));
  assert.equal(oneBlockAssessment.selection.slots.bodySlots.length, 1);
  const selectedBodyIds = new Set(oneBlockAssessment.selection.slots.bodySlots.map((slot) => slot.elementId));
  const mappedProfileSlide = semanticProfile.slides.find((item) => item.sourceSlideIndex === oneBlockAssessment.selection.sourceSlideIndex);
  const unusedMappedBodyId = mappedProfileSlide?.bodyElementIds.find((id) => !selectedBodyIds.has(id));
  const unusedMappedBody = template.templateIR.slides.find((item) => item.sourcePart === oneBlockAssessment.selection.sourcePart)
    ?.elements.find((element) => element.id === unusedMappedBodyId);
  assert.ok(unusedMappedBody?.nativeId && oneBlockAssessment.selection.removeElementNativeIds.includes(unusedMappedBody.nativeId),
    'a validated donor body panel with no assigned source block is removed as a whole shape');

  const multiSentenceBlock = {
    ...oneBlockSlide,
    body: ['The first supported point is retained. The second supported point stays in order.'],
  };
  const segmentedAssessment = assessExemplarSelection(multiSentenceBlock, template.templateIR, semanticProfile);
  assert.ok(segmentedAssessment.selection, JSON.stringify(segmentedAssessment.candidateDiagnostics));
  assert.equal(segmentedAssessment.selection.slots.bodySlots.length, 2,
    'one worker body block can use two explicitly mapped native card regions when sentence boundaries fit');
  assert.equal(segmentedAssessment.selection.bodyContentSegments.join(''), multiSentenceBlock.body.join('\n'));
  assert.equal(segmentedAssessment.selection.bodySegmentation.method, 'sentences');
  const emptyBodyAssessment = assessExemplarSelection({ ...oneBlockSlide, body: [] }, template.templateIR, semanticProfile);
  const mappedSourcePart = template.templateIR.slides.find((source) => source.index === segmentedAssessment.selection.sourceSlideIndex)?.sourcePart;
  const emptyMappedSignatures = emptyBodyAssessment.safeSelections
    .filter((selection) => selection.sourcePart === mappedSourcePart)
    .map((selection) => selection.projectedCompositionSignature);
  assert.equal(new Set(emptyMappedSignatures).size, 1,
    'assigning empty body regions cannot manufacture multiple projected compositions from the same donor slide');
  const oneBlockPath = path.join(root, 'output', 'multi-region-one-block.pptx');
  const oneBlockPresentation = { ...compiled, id: `${compiled.id}_one_body_block`, slides: [oneBlockSlide] };
  const oneBlockRender = await new OfficeKitPptxRenderer().render({
    compiledPresentation: oneBlockPresentation, contentIR, templateIR: template.templateIR,
    semanticProfile, templatePath: template.templatePath, outputPath: oneBlockPath,
  });
  assert.equal(oneBlockRender.reopenStatus, 'passed');
  const oneBlockReopened = await inspectPptx(oneBlockPath);
  const oneBlockOfficeKit = await loadPresentation(await readFile(oneBlockPath));
  const oneBlockOfficeKitSlide = getSlides(oneBlockOfficeKit)[0];
  assert.ok(oneBlockOfficeKitSlide);
  const remainingNativeIds = new Set(getSlideShapes(oneBlockOfficeKitSlide).map((shape) => String(getShapeId(shape))));
  for (const nativeId of oneBlockAssessment.selection.removeElementNativeIds) {
    assert.ok(!remainingNativeIds.has(nativeId), `unused mapped card shape ${nativeId} is absent from the reopened PPTX`);
  }
  assert.ok(!oneBlockReopened.inspection.slides[0]?.elements.some((element) => /Left source region|Right source region/.test(element.text)),
    'unused mapped sample text cannot leak from the source template when the projected content has fewer blocks');
});

test('joint A/B/C assignments preserve the exact qualified composition kind in renderer and matrix', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-hybrid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await exemplarFixture(root, 'hybrid-template.pptx', { create: createHybridExemplarTemplate });
  const semanticProfile = semanticProfileFor(template.templateIR);
  const nativeSlide = template.templateIR.slides.find((slide) => slide.elements.some((element) => element.text === 'Native source title sample'));
  assert.ok(nativeSlide);
  const nativeProfile = semanticProfile.slides.find((item) => item.sourceSlideIndex === nativeSlide.index);
  assert.ok(nativeProfile);
  nativeProfile.confidence = 0.2;
  nativeProfile.titleElementId = null;
  nativeProfile.bodyElementIds = [];
  nativeProfile.preservedElementIds = [];
  nativeProfile.replaceableTextElementIds = [];

  const { brief, contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const single = singleSlidePlan(deckPlan, contentIR, brief);
  const compiled = VARIANT_POLICIES.map((policy) => compilePresentation(single.deckPlan, contentIR, template.templateIR, policy));
  const slides = compiled.map((presentation) => presentation.slides[0]);
  assert.ok(slides.every(Boolean));
  const distinctness = assessVariantCompositionDistinctnessRaw(
    slides, template.templateIR, 'office-kit', semanticProfile);
  const classificationCache = createCompositionVisualClassificationCache();
  const cacheDiagnostics = new PerformanceDiagnostics();
  const cachedFirst = assessVariantCompositionDistinctnessRaw(
    slides, template.templateIR, 'office-kit', semanticProfile, cacheDiagnostics, classificationCache);
  assert.deepEqual(cachedFirst, distinctness, 'memoizing immutable template visual classification cannot change A/B/C assignment');
  const missesAfterFirst = cacheDiagnostics.snapshot().counts['composition.visualClassificationCacheMiss'];
  const hitsAfterFirst = cacheDiagnostics.snapshot().counts['composition.visualClassificationCacheHit'] ?? 0;
  assert.ok((missesAfterFirst ?? 0) > 0, 'the first resolver pass builds scoped classifications');
  const cachedSecond = assessVariantCompositionDistinctnessRaw(
    slides, template.templateIR, 'office-kit', semanticProfile, cacheDiagnostics, classificationCache);
  assert.deepEqual(cachedSecond, distinctness, 'cache reuse retains identical qualification evidence and composition identity');
  assert.equal(cacheDiagnostics.snapshot().counts['composition.visualClassificationCacheMiss'], missesAfterFirst,
    'repeated track assessment does not rescan already classified template slides');
  assert.ok((cacheDiagnostics.snapshot().counts['composition.visualClassificationCacheHit'] ?? 0) > hitsAfterFirst,
    'subsequent A/B/C resolver passes reuse bounded generation-scoped classifications');
  assert.equal(distinctness.distinct, true, JSON.stringify(distinctness));
  assert.equal(new Set(distinctness.signatures).size, 3);
  const assessments = slides.map((slide) => assessExemplarSelectionRaw(slide, template.templateIR, semanticProfile));
  assert.ok(assessments.some((assessment) => assessment.safeSelections.length > 1),
    'the joint resolver receives all qualified distinct exemplar options, not only the per-track preferred rank');
  assert.ok(distinctness.candidateCounts.safeExemplarOptions >= 2);
  assert.ok(distinctness.candidateCounts.distinctSafeSignatures >= 3);
  const assignedSlides = slides.map((slide) => {
    const assignment = distinctness.assignments.find((candidate) => candidate.variantId === slide.variantId);
    assert.ok(assignment);
    return applyVariantCompositionAssignment(slide, assignment, template.templateIR, semanticProfile,
      distinctness.safeOptionsByVariant[slide.variantId]);
  });
  assert.ok(distinctness.assignments.every((assignment) =>
    ['exemplar-backed', 'layout-placeholder-backed'].includes(assignment.compositionKind)));
  for (const assigned of assignedSlides.slice(0, 2)) {
    const exact = distinctness.assignments.find((assignment) => assignment.variantId === assigned.variantId)?.exemplarSelection;
    assert.equal(assigned.exemplarSelection?.projectedCompositionSignature, exact?.projectedCompositionSignature,
      'the compiled track retains the exact jointly assigned donor for renderer revalidation');
    assert.deepEqual(assigned.exemplarSelectionValidation, {
      templateIRHash: template.templateIR.hash,
      signature: exact?.projectedCompositionSignature,
    }, 'the in-memory renderer proof is bound to the exact qualified template and donor signature');
  }
  const nativeTrack = assignedSlides[2];
  assert.ok(assessExemplarSelectionRaw(assignedSlides[0], template.templateIR, semanticProfile).selection);
  assert.ok(assessExemplarSelectionRaw(assignedSlides[1], template.templateIR, semanticProfile).selection);
  const thirdTrackAssignment = distinctness.assignments.find((assignment) => assignment.variantId === 'C');
  assert.ok(thirdTrackAssignment);
  if (thirdTrackAssignment.compositionKind === 'layout-placeholder-backed') {
    assert.equal(assessExemplarSelectionRaw(nativeTrack, template.templateIR, semanticProfile).selection, null,
      'a layout-backed track cannot claim exemplar proof');
    assert.equal(nativeTrack.nativeLayoutFallback, true);
    assert.equal(distinctness.signatures[2], generatedFallbackCompositionSignature(nativeTrack, template.templateIR));
  } else {
    assert.ok(assessExemplarSelectionRaw(nativeTrack, template.templateIR, semanticProfile).selection,
      'the third track may use a genuinely safe exemplar when the joint deck optimizer selects it');
    assert.equal(nativeTrack.exemplarSelection?.projectedCompositionSignature, distinctness.signatures[2]);
  }

  for (const [index, slide] of assignedSlides.entries()) {
    const presentation = { ...compiled[index], slides: [slide] };
    const outputPath = path.join(root, 'output', `hybrid-${index}.pptx`);
    await mkdir(path.dirname(outputPath), { recursive: true });
    const rendered = await new OfficeKitPptxRenderer().render({
      compiledPresentation: presentation, contentIR, templateIR: template.templateIR, semanticProfile,
      templatePath: template.templatePath, outputPath,
    });
    assert.equal(rendered.reopenStatus, 'passed');
    assert.equal(rendered.validationStatus, 'passed');
    assert.equal(rendered.projectedCompositions[0].projectedCompositionSignature, distinctness.signatures[index]);
  }

  const matrix = await runOfflinePresentationMatrix({
    deckPlan: single.deckPlan,
    contentIR,
    templates: [{ ...template, pptxPath: template.templatePath }],
    outputRoot: path.join(root, 'matrix'),
    backend: 'office-kit',
    profileTemplate: async () => structuredClone(semanticProfile),
    previewAdapter: {
      async preview() {
        return { slideCount: 1, svg: '<svg/>', png: new Uint8Array([1]), textLayoutIssues: [], geometryIssues: [], status: 'passed', limitations: [] };
      },
    },
  });
  const fallbackReport = matrix.templateQualifications[0]?.slides[0]?.variants.find((variant) => variant.variantId === 'C');
  assert.ok(['exemplar-backed', 'layout-placeholder-backed'].includes(fallbackReport?.compositionKind));
  assert.ok(fallbackReport?.projectedCompositionSignature?.startsWith('sha256:'),
    'the matrix only reports a renderer-qualified native composition signature');
  assert.equal(fallbackReport?.candidateDiagnostics.length, template.templateIR.slides.length,
    'layout assignment retains the pre-assignment donor candidate inventory in its qualification report');
});

test('cross-layout semantic donors preserve recurring chrome from the donor layout', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-cross-layout-chrome-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await exemplarFixture(root, 'cross-layout-footer-template.pptx', { create: createCrossLayoutFooterTemplate });
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]).slides[1];
  assert.ok(compiled);
  const semanticProfile = semanticProfileFor(template.templateIR, () => 'content', (slide) => slide.layoutId === compiled.layoutId ? 0.7 : 0.99);
  const assessment = assessExemplarSelection(compiled, template.templateIR, semanticProfile);
  assert.ok(assessment.selection);
  assert.notEqual(assessment.selection.layoutId, compiled.layoutId, 'high-confidence semantic evidence permits a safe donor from another native layout');
  const donor = template.templateIR.slides.find((slide) => slide.index === assessment.selection.sourceSlideIndex);
  const footer = donor.elements.find((element) => element.text === 'REPEATED LAYOUT BRAND');
  assert.ok(footer?.nativeId);
  assert.ok(assessment.selection.preserveChromeNativeIds.includes(footer.nativeId), 'recurring footer ids are classified in the donor layout scope');
  assert.ok(!assessment.selection.clearElementNativeIds.includes(footer.nativeId), 'donor chrome is not cleared as source-specific text');
});

test('Office Kit preserves recurring chrome when projecting a cross-layout semantic donor', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-cross-layout-render-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await exemplarFixture(root, 'cross-layout-render-template.pptx', { create: createCrossLayoutFooterTemplate });
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]);
  const slide = compiled.slides[1];
  assert.ok(slide);
  const semanticProfile = semanticProfileFor(template.templateIR, () => 'content',
    (source) => source.layoutId === slide.layoutId ? 0.7 : 0.99);
  const selection = selectExemplarSlide(slide, template.templateIR, semanticProfile);
  assert.ok(selection);
  assert.notEqual(selection.layoutId, slide.layoutId);
  const sourceHash = createHash('sha256').update(await readFile(template.templatePath)).digest('hex');
  const outputPath = path.join(root, 'rendered', 'cross-layout.pptx');
  await mkdir(path.dirname(outputPath), { recursive: true });
  const result = await new OfficeKitPptxRenderer().render({
    compiledPresentation: { ...compiled, id: `${compiled.id}_cross_layout`, slides: [slide] },
    contentIR, templateIR: template.templateIR, semanticProfile,
    templatePath: template.templatePath, outputPath,
  });
  assert.equal(result.validationStatus, 'passed');
  assert.equal(result.reopenStatus, 'passed');
  assert.equal(result.qualityEvidence.sourceContentResidue.status, 'checked');
  assert.deepEqual(result.qualityEvidence.sourceContentResidue.findings, [], 'only the explicitly validated recurring layout brand remains');
  assert.equal(result.projectedCompositions[0].sourceSlideIndex, selection.sourceSlideIndex);
  const reopened = await inspectPptx(outputPath);
  assert.ok(reopened.inspection.slides[0].elements.some((element) => element.text.trim() === 'REPEATED LAYOUT BRAND'),
    'the donor layout footer remains visible/editable after duplicate-slide projection');
  assert.equal(createHash('sha256').update(await readFile(template.templatePath)).digest('hex'), sourceHash);
});

test('source-specific visual content remains blocked unless a safe replacement slot is explicitly mapped', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-visual-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await exemplarFixture(root, 'visual-diagnostics-template.pptx');
  const { contentIR, deckPlan } = await scenario(root, 1, ['none', 'none', 'none', 'none', 'image']);
  const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]).slides.at(-1);
  assert.ok(compiled);
  const assessment = assessExemplarSelection(compiled, template.templateIR, semanticProfileFor(template.templateIR));
  assert.equal(assessment.selection, null);
  assert.equal(assessment.candidateDiagnostics.length, template.templateIR.slides.length);
  assert.ok(assessment.candidateDiagnostics.every((candidate) => candidate.gate === 'visual-safety'));
  assert.ok(assessment.candidateDiagnostics.some((candidate) => candidate.visualClassification.some((item) => item.includes(':source-specific-content:'))));
});

test('a mapped source-free visual slot is replaced by a source-backed native chart', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-safe-visual-slot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await semanticVisualSlotFixture(root);
  const { contentIR, deckPlan } = await scenario(root, 1, ['chart', 'none', 'none', 'none', 'none']);
  const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]);
  const slide = compiled.slides[0];
  assert.ok(slide?.visualization.chartData);
  const assessment = assessExemplarSelection(slide, template.templateIR, template.semanticProfile);
  assert.ok(assessment.selection?.slots.visual, JSON.stringify(assessment.candidateDiagnostics));
  const replacedNativeId = assessment.selection.slots.visual.nativeId;
  const outputPath = path.join(root, 'output', 'replaced-visual-slot.pptx');
  await mkdir(path.dirname(outputPath), { recursive: true });
  const result = await new OfficeKitPptxRenderer().render({
    compiledPresentation: { ...compiled, id: `${compiled.id}_safe_visual_slot`, slides: [slide] },
    contentIR, templateIR: template.templateIR, semanticProfile: template.semanticProfile,
    templatePath: template.templatePath, outputPath,
  });
  assert.equal(result.reopenStatus, 'passed');
  assert.equal(result.validationStatus, 'passed');
  const reopened = await loadPresentation(await readFile(outputPath));
  const outputSlide = getSlides(reopened)[0];
  assert.equal(getSlideCharts(outputSlide).length, 1, 'the native chart is rendered into the measured slot');
  assert.ok(!getSlideShapes(outputSlide).some((shape) => String(getShapeId(shape)) === replacedNativeId && getShapeKind(shape) === 'shape'),
    `the source rectangle is removed rather than retained behind the generated chart: ${JSON.stringify(getSlideShapes(outputSlide).map((shape) => ({ id: String(getShapeId(shape)), text: getShapeText(shape), kind: getShapeKind(shape) })))}`);
});

test('a large empty profiled visual slot is removed for text-only content', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-empty-visual-slot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await semanticVisualSlotFixture(root);
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]);
  const slide = compiled.slides[1];
  assert.ok(slide);
  assert.equal(slide.visualization.type, 'none');
  const selection = assessExemplarSelection(slide, template.templateIR, template.semanticProfile).selection;
  assert.ok(selection);
  assert.equal(selection.slots.visual, null);
  const donor = template.templateIR.slides.find((source) => source.sourcePart === selection.sourcePart);
  assert.ok(donor);
  const profiledVisualId = template.semanticProfile.slides.find((item) => item.sourceSlideIndex === donor.index)?.visualElementIds[0];
  const sourcePanel = donor.elements.find((element) => element.id === profiledVisualId);
  assert.ok(sourcePanel?.nativeId);
  assert.ok(selection.removeElementNativeIds.includes(sourcePanel.nativeId), 'only the trusted empty visual role is removed');

  const sourceHash = createHash('sha256').update(await readFile(template.templatePath)).digest('hex');
  const outputPath = path.join(root, 'output', 'text-only-without-empty-panel.pptx');
  await mkdir(path.dirname(outputPath), { recursive: true });
  const result = await new OfficeKitPptxRenderer().render({
    compiledPresentation: { ...compiled, id: `${compiled.id}_without_empty_visual`, slides: [slide] },
    contentIR, templateIR: template.templateIR, semanticProfile: template.semanticProfile,
    templatePath: template.templatePath, outputPath,
  });
  assert.equal(result.reopenStatus, 'passed');
  assert.equal(result.validationStatus, 'passed');
  const reopened = await loadPresentation(await readFile(outputPath));
  assert.ok(!getSlideShapes(getSlides(reopened)[0]).some((shape) => String(getShapeId(shape)) === sourcePanel.nativeId),
    'the empty vector panel is absent after reopening the PPTX');
  assert.equal(createHash('sha256').update(await readFile(template.templatePath)).digest('hex'), sourceHash,
    'projection never mutates the source template');
});

test('an empty profiled visual panel with one-EMU edge rounding is removable, while larger overflow stays protected', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-visual-edge-rounding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await semanticVisualSlotFixture(root);
  setProfiledVisualSlotBottomOverrun(template, 1);
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]);
  const slide = compiled.slides[1];
  assert.ok(slide);
  const selection = assessExemplarSelection(slide, template.templateIR, template.semanticProfile).selection;
  assert.ok(selection);
  const donor = template.templateIR.slides.find((source) => source.sourcePart === selection.sourcePart);
  assert.ok(donor);
  const visualId = template.semanticProfile.slides.find((item) => item.sourceSlideIndex === donor.index)?.visualElementIds[0];
  const visual = donor.elements.find((element) => element.id === visualId);
  assert.ok(visual?.nativeId);
  assert.ok(selection.removeElementNativeIds.includes(visual.nativeId), 'one-EMU roundoff must not leave the empty band behind');

  const protectedTemplate = await semanticVisualSlotFixture(root);
  setProfiledVisualSlotBottomOverrun(protectedTemplate, 2);
  const protectedCompiled = compilePresentation(deckPlan, contentIR, protectedTemplate.templateIR, VARIANT_POLICIES[0]);
  const protectedSlide = protectedCompiled.slides[1];
  assert.ok(protectedSlide);
  const protectedSelection = assessExemplarSelection(protectedSlide, protectedTemplate.templateIR,
    protectedTemplate.semanticProfile).selection;
  assert.ok(protectedSelection);
  const protectedDonor = protectedTemplate.templateIR.slides.find((source) => source.sourcePart === protectedSelection.sourcePart);
  assert.ok(protectedDonor);
  const protectedVisualId = protectedTemplate.semanticProfile.slides.find((item) => item.sourceSlideIndex === protectedDonor.index)?.visualElementIds[0];
  const protectedVisual = protectedDonor.elements.find((element) => element.id === protectedVisualId);
  assert.ok(protectedVisual?.nativeId);
  assert.ok(!protectedSelection.removeElementNativeIds.includes(protectedVisual.nativeId), 'more than one EMU outside remains fail-closed');
});

test('chart intent over prose stays unresolved and never synthesizes chart data', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-chart-prose-no-fabrication-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { brief, contentIR, deckPlan, templates } = await scenario(root, 1, Array(5).fill('none'));
  const proseRefs = contentIR.units.filter((unit) => unit.kind === 'text').map((unit) => unit.id);
  assert.ok(proseRefs.length > 0);
  const textOnlyPlan = canonicalizeDeckPlan({
    workingTitle: deckPlan.workingTitle,
    narrativeSummary: deckPlan.narrativeSummary,
    slides: deckPlan.slides.map((slide, index) => {
      const { id: _id, order: _order, ...draftSlide } = slide;
      return index === 0
        ? { ...draftSlide, contentRefs: proseRefs.slice(0, 2), semanticVisualType: 'chart' }
        : draftSlide;
    }),
  }, {
    id: `${deckPlan.id}_chart_prose_only`,
    version: 1,
    createdAt: deckPlan.createdAt,
    inputFingerprint: deckPlan.inputFingerprint,
    briefHash: briefHash(brief),
    allowedContentIds: new Set(contentIR.units.filter((unit) => unit.kind !== 'media-reference').map((unit) => unit.id)),
    allowedMediaIds: new Set(contentIR.units.filter((unit) => unit.kind === 'media-reference').map((unit) => unit.id)),
    requestedSlideCount: 5,
  });
  const compiled = compilePresentation(textOnlyPlan, contentIR, templates[0].templateIR, VARIANT_POLICIES[0]);
  assert.equal(compiled.slides[0].visualization.chartData, null);
  assert.equal(compiled.slides[0].visualization.status, 'unresolved');
});

test('dark template keeps native title/body styling and derives generated process text color and size from template roles', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-dark-template-text-style-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await semanticVisualSlotFixture(root, { darkTheme: true });
  const { contentIR, deckPlan } = await scenario(root, 1, ['none', 'none', 'none', 'process', 'none']);
  const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]);
  const slide = compiled.slides[3];
  assert.equal(slide?.visualization.processSteps.length, 3);
  const selection = assessExemplarSelection(slide, template.templateIR, template.semanticProfile).selection;
  assert.ok(selection);
  const outputPath = path.join(root, 'output', 'dark-process.pptx');
  await mkdir(path.dirname(outputPath), { recursive: true });
  const result = await new OfficeKitPptxRenderer().render({
    compiledPresentation: { ...compiled, id: `${compiled.id}_dark_text_style`, slides: [slide] },
    contentIR, templateIR: template.templateIR, semanticProfile: template.semanticProfile,
    templatePath: template.templatePath, outputPath,
  });
  assert.equal(result.reopenStatus, 'passed');
  assert.equal(result.nativeConnectorCount, 2, 'the body-hosted process is connected after using a measured native body region');
  assert.deepEqual(result.unresolvedVisualTypes, [], 'process intent is not reported as realized unless its nodes/connectors were rendered');
  assert.deepEqual(result.visualIntents, [{
    slideId: slide.id,
    requestedType: 'process',
    realizedType: 'process',
    fallbackReason: 'Sequence labels reuse measured native body geometry because no separate safe visual slot was selected.',
  }], 'the diagnostic records the concrete native realization without exposing model content');
  const generatedText = result.qualityEvidence.textObjects.filter((item) => item.slideId === slide.id && item.role === 'other');
  assert.equal(generatedText.length, 3, 'each native process node is inspected after the PPTX was reopened');
  assert.ok(generatedText.every((item) => item.color === '#F9FAFB'), JSON.stringify(generatedText));
  assert.ok(generatedText.every((item) => item.fontSizePt === 16), JSON.stringify(generatedText));
  const reopened = await loadPresentation(await readFile(outputPath));
  const outputSlide = getSlides(reopened)[0];
  const reopenedShapes = getSlideShapes(outputSlide);
  const connectors = reopenedShapes.filter((shape) => getShapeKind(shape) === 'connector');
  assert.equal(connectors.length, 2, 'reopened PPTX contains two editable native connectors');
  assert.ok(connectors.every((shape) => getShapeStrokeColor(shape) === '#F9FAFB'),
    'connectors use the dark template body role color rather than an invisible default black stroke');
  assert.ok(connectors.every((shape) => getShapeStrokeArrow(shape, 'tail')?.type === 'triangle'),
    'process connectors have visible directional arrowheads');
  const processNodes = reopenedShapes.filter((shape) => ['Parse the template', 'Compile editable slides', 'Validate the presentation'].includes(getShapeText(shape)));
  assert.equal(processNodes.length, 3);
  assert.ok(processNodes.every((shape) => getShapePreset(shape) === 'roundRect'),
    'process labels are editable, outlined native nodes rather than ungrouped text and dash marks');
  assert.ok(!reopenedShapes.some((shape) => hasShapeText(shape) && /Mapped source body/u.test(getShapeText(shape))),
    'source-specific body sample text is removed before generated sequence labels are placed');
  const processShape = getSlideShapes(outputSlide).find((shape) => getShapeText(shape) === 'Parse the template');
  assert.ok(processShape);
  assert.equal(getShapeRunFormatEffective(reopened, processShape, 0, 0).color, '#F9FAFB');
});

test('recurring small template pictures are preservable while large source pictures stay unsafe', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-small-visual-safety-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await exemplarFixture(root, 'repeated-small-picture-template.pptx');
  const commonPicturePart = 'ppt/media/repeated-template-mark.png';
  for (const slide of template.templateIR.slides) for (const element of slide.elements.filter((candidate) => ['picture', 'image'].includes(candidate.kind.toLowerCase()))) {
    const geometry = element.geometry.resolved ?? element.geometry.direct;
    assert.ok(geometry);
    element.geometry.direct = { ...geometry, x: 100_000, y: 100_000, width: 100_000, height: 100_000 };
    element.geometry.resolved = { ...geometry, x: 100_000, y: 100_000, width: 100_000, height: 100_000 };
    for (const relationship of slide.relationships.filter((candidate) => element.relationshipIds.includes(candidate.id))) {
      relationship.target = '../media/repeated-template-mark.png';
      relationship.targetPart = commonPicturePart;
      for (const asset of template.templateIR.assets.filter((candidate) => candidate.relationshipIds.includes(relationship.id))) asset.part = commonPicturePart;
    }
  }
  template.templateIR.hash = sha256Json(templateIRHashPayload(template.templateIR));
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]).slides[1];
  assert.ok(compiled);
  const assessment = assessExemplarSelection(compiled, template.templateIR);
  assert.ok(assessment.selection, 'repeated, small decorative pictures do not automatically disqualify a text donor');
  assert.ok(assessment.candidateDiagnostics.some((candidate) => candidate.visualClassification.some((item) => item.includes(':template-decoration:'))),
    JSON.stringify(assessment.candidateDiagnostics.map(({ sourceSlideIndex, gate, rejectReason, visualClassification }) => ({ sourceSlideIndex, gate, rejectReason, visualClassification }))));

  const largeTemplate = await exemplarFixture(root, 'large-source-picture-template.pptx');
  const largeCompiled = compilePresentation(deckPlan, contentIR, largeTemplate.templateIR, VARIANT_POLICIES[0]).slides[1];
  assert.ok(largeCompiled);
  const largeAssessment = assessExemplarSelection(largeCompiled, largeTemplate.templateIR);
  assert.equal(largeAssessment.selection, null, 'large source-specific photos remain fail-closed');
  assert.ok(largeAssessment.candidateDiagnostics.some((candidate) => candidate.gate === 'visual-safety'));
});

test('Office Kit reports when replacing a mixed-run exemplar donor may collapse secondary run styling', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-mixed-style-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await familyExemplarFixture(root, 'mixed-style-template.pptx', { mixedStyleBody: true });
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]);
  const compiledSlide = compiled.slides.at(-1);
  assert.ok(compiledSlide);
  const semanticProfile = semanticProfileFor(template.templateIR);
  const selection = selectExemplarSlide(compiledSlide, template.templateIR, semanticProfile);
  assert.ok(selection);
  const donor = template.templateIR.slides.find((slide) => slide.sourcePart === selection.sourcePart);
  const bodyDonor = donor?.elements.find((element) => element.id === selection.slots.body.elementId);
  assert.ok(bodyDonor?.directStyles.fontSizesPt && new Set(bodyDonor.directStyles.fontSizesPt).size > 0);
  const outputPath = path.join(root, 'output', 'mixed-style-probe.pptx');
  await mkdir(path.dirname(outputPath), { recursive: true });
  const result = await new OfficeKitPptxRenderer().render({
    compiledPresentation: { ...compiled, id: `${compiled.id}_mixed`, slides: [compiledSlide] },
    contentIR, templateIR: template.templateIR, semanticProfile, templatePath: template.templatePath, outputPath,
  });
  assert.ok(result.validationIssues.some((issue) => issue.severity === 'warning'
    && issue.message.includes('secondary mixed-run styling may be collapsed')));
});

test('Office Kit fallback fills native title and body placeholders without duplicate text boxes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-native-placeholder-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await nativePlaceholderFixture(root);
  const { brief, contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]);
  const slide = compiled.slides[0];
  assert.ok(slide);
  const outputPath = path.join(root, 'output', 'fallback.pptx');
  await mkdir(path.dirname(outputPath), { recursive: true });
  const result = await new OfficeKitPptxRenderer().render({
    compiledPresentation: { ...compiled, id: `${compiled.id}_placeholder_fallback`, slides: [slide] },
    contentIR, templateIR: template.templateIR, templatePath: template.templatePath, outputPath,
  });
  assert.equal(result.reopenStatus, 'passed');
  assert.equal(result.validationStatus, 'passed');
  assert.equal(result.projectedCompositions[0].sourceSlideIndex, null, 'an empty TemplateIR slide index exercises the native-layout fallback');
  const reopened = await loadPresentation(await readFile(outputPath));
  const shapes = getSlideShapes(getSlides(reopened)[0]);
  const textShapes = shapes.filter((shape) => hasShapeText(shape) && getShapeText(shape).trim());
  assert.equal(textShapes.length, 2, 'filling the native slots must not overlay them with generic boxes');
  assert.ok(textShapes.some((shape) => isShapePlaceholder(shape) && getShapePlaceholderType(shape) === 'title' && getShapeText(shape) === slide.title));
  assert.ok(textShapes.some((shape) => isShapePlaceholder(shape) && getShapePlaceholderType(shape) === 'body' && getShapeText(shape) === slide.body.join('\n')));

  const single = singleSlidePlan(deckPlan, contentIR, brief);
  const nativeTracks = VARIANT_POLICIES.map((policy) => compilePresentation(single.deckPlan, contentIR, template.templateIR, policy).slides[0]);
  const nativeDistinctness = assessVariantCompositionDistinctnessRaw(nativeTracks, template.templateIR, 'office-kit');
  assert.equal(nativeDistinctness.distinct, true,
    'a single native layout is not the limit when template-derived compositions can safely express deck strategies');
  assert.ok(nativeDistinctness.assignments.some((item) => item.compositionKind === 'template-derived-fallback'));
  const matrix = await runOfflinePresentationMatrix({
    deckPlan: single.deckPlan,
    contentIR,
    templates: [{ ...template, pptxPath: template.templatePath }],
    outputRoot: path.join(root, 'matrix'),
    backend: 'office-kit',
    continueOnBlocked: true,
  });
  const qualification = matrix.templateQualifications[0];
  assert.equal(qualification?.status, 'passed', `tier 3 supplies safe A/B/C compositions without relying on generated textbox estimates: ${JSON.stringify(qualification)}`);
  assert.equal(qualification?.slides[0]?.status, 'passed');
  assert.equal(new Set(qualification?.slides[0]?.signatures ?? []).size, 3);
  assert.equal(qualification?.deckCompositionDistinctness?.distinct, true);
  assert.ok(qualification?.slides[0]?.variants.some((variant) => variant.compositionKind === 'template-derived-fallback'));
  assert.equal(matrix.outputCount, 3, 'the one-slide fixture exports one editable PPTX per A/B/C track');
});

test('native placeholder fit estimates nominate candidates for renderer measurement instead of preemptive rejection', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-native-fit-measurement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await nativePlaceholderFixture(root);
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const slide = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]).slides[0];
  assert.ok(slide);
  const candidate = slide.layoutCandidates.find((item) => item.layoutId === slide.layoutId
    && item.sourcePart === slide.layoutSourcePart);
  assert.ok(candidate);
  const layout = template.templateIR.layouts.find((item) => item.id === candidate.layoutId && item.sourcePart === candidate.sourcePart);
  assert.ok(layout);
  for (const evidence of [candidate.slotEvidence.title, candidate.slotEvidence.body]) {
    const id = evidence.sourceEvidence[0]?.elementId;
    const element = layout.elements.find((item) => item.id === id);
    assert.ok(element?.placeholder, 'candidate is backed by a native title/body placeholder');
    for (const box of [element.geometry.direct, element.geometry.resolved]) {
      if (box) box.height = 1_000;
    }
  }
  template.templateIR.hash = sha256Json(templateIRHashPayload(template.templateIR));
  slide.title = 'A compact takeaway for the presentation audience';
  slide.body = Array(8).fill('Generated presentation copy with enough words to require accurate renderer measurement.');
  assert.equal(nativePlaceholderFallbackSupported(slide, template.templateIR, candidate), true,
    'small estimated boxes remain candidates for a real rendered-preview decision; they are not published without passing that gate');
});

test('native layout assignment clips a slightly out-of-canvas visual slot and rejects an empty one', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-native-layout-visual-bounds-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await nativePlaceholderFixture(root);
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const slide = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]).slides[0];
  assert.ok(slide);
  const candidateIndex = slide.layoutCandidates.findIndex((candidate) => candidate.layoutId === slide.layoutId);
  assert.ok(candidateIndex >= 0);
  const canvas = template.templateIR.slideSize;
  const overrun = 7_815;
  const height = inch(0.1);
  const candidate = slide.layoutCandidates[candidateIndex];
  assert.ok(candidate);
  slide.layoutCandidates[candidateIndex] = {
    ...candidate,
    visualBox: { x: canvas.width - inch(1), y: canvas.height - height + overrun,
      width: inch(1), height, unit: 'EMU' },
  };
  const restored = applyNativeLayoutCandidate(slide, slide.layoutCandidates[candidateIndex], candidateIndex, template.templateIR);
  assert.deepEqual(restored.placements.visual, {
    x: canvas.width - inch(1), y: canvas.height - height + overrun,
    width: inch(1), height: height - overrun, unit: 'EMU',
  }, 'persisted native-layout restoration uses the same bounded visual geometry as initial assignment');
  const assignment = {
    variantId: slide.variantId,
    compositionKind: 'layout-placeholder-backed',
    layoutCandidateIndex: candidateIndex,
    projectedCompositionSignature: 'native-layout-visual-bounds-regression',
  };
  const assigned = applyVariantCompositionAssignment(slide, assignment, template.templateIR);
  assert.deepEqual(assigned.placements.visual, {
    x: canvas.width - inch(1), y: canvas.height - height + overrun,
    width: inch(1), height: height - overrun, unit: 'EMU',
  });
  assert.ok(assigned.placements.visual.y + assigned.placements.visual.height <= canvas.height);

  slide.layoutCandidates[candidateIndex] = {
    ...slide.layoutCandidates[candidateIndex],
    visualBox: { x: 0, y: canvas.height + 1, width: inch(1), height, unit: 'EMU' },
  };
  assert.throws(() => applyNativeLayoutCandidate(slide, slide.layoutCandidates[candidateIndex], candidateIndex, template.templateIR),
    /visual slot no longer intersects the template canvas/u,
    'a persisted candidate wholly outside the canvas remains fail-closed');
  assert.throws(() => applyVariantCompositionAssignment(slide, assignment, template.templateIR),
    /visual slot no longer intersects the template canvas/u,
    'a wholly off-canvas slot remains fail-closed instead of being silently discarded');
});

test('native layout fallback is withheld when inherited master text could carry sample content into exports', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-native-fallback-master-residue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await nativePlaceholderFixture(root, { masterStaticText: 'SAMPLE COPY FROM TEMPLATE' });
  assert.ok([...template.templateIR.masters, ...template.templateIR.layouts]
    .some((part) => part.elements.some((element) => element.text === 'SAMPLE COPY FROM TEMPLATE')));
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const tracks = VARIANT_POLICIES.map((policy) => compilePresentation(deckPlan, contentIR, template.templateIR, policy).slides[0]);
  assert.ok(tracks.every(Boolean));
  const assessment = assessVariantCompositionDistinctnessRaw(tracks, template.templateIR, 'office-kit');
  assert.equal(assessment.distinct, false);
  assert.equal(assessment.assignments.length, 0, 'no inherited sample-text composition is selected for export');
});

test('generic inferred-region fallback is the last resort and produces distinct editable A/B/C previews', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-derived-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await inferredRegionTemplateFixture(root);
  const sourceHash = createHash('sha256').update(await readFile(template.templatePath)).digest('hex');
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const compiledTracks = VARIANT_POLICIES.map((policy) => compilePresentation(deckPlan, contentIR, template.templateIR, policy));
  const tracks = compiledTracks.map((presentation) => {
    const slide = presentation.slides[0];
    assert.ok(slide);
    slide.title = 'Цель задаёт план';
    slide.body = ['Уточнить цель.', 'Проверить условия.', 'Определить следующий шаг.'];
    slide.generatedBodyPoints = slide.body.map((text) => ({ text, origin: 'generated-from-brief', evidenceRefs: [] }));
    return slide;
  });
  const adjacent = tracks[0]?.layoutCandidates[0];
  assert.ok(adjacent?.titleBox && adjacent.bodyBox);
  const roundingOverlap = {
    ...adjacent,
    titleBox: { ...adjacent.titleBox, height: adjacent.bodyBox.y - adjacent.titleBox.y + 1 },
  };
  const adjustedTitle = deriveTemplateTitleBox(roundingOverlap);
  assert.equal(adjustedTitle?.y + adjustedTitle.height, roundingOverlap.bodyBox.y,
    'exact placeholder intersection is removed from generated title geometry');
  assert.equal(templateDerivedCompositionSupported({ ...tracks[0], layoutCandidates: [roundingOverlap] }, template.templateIR, roundingOverlap), true,
    'a one-EMU rounding overlap is repaired from measured boundaries and still goes through rendered-preview validation');
  const assessment = assessVariantCompositionDistinctnessRaw(tracks, template.templateIR, 'office-kit');
  assert.equal(assessment.hasSafeAssignments, true);
  assert.equal(assessment.distinct, true, JSON.stringify({
    message: 'strategy-derived signatures distinguish complete one-slide A/B/C tracks',
    counts: assessment.candidateCounts, evidence: assessment.evidence,
    candidates: tracks[0]?.layoutCandidates.map((candidate) => ({ unknownReasons: candidate.unknownReasons,
      title: candidate.slotEvidence.title, body: candidate.slotEvidence.body, titleBox: candidate.titleBox, bodyBox: candidate.bodyBox })),
  }));
  const deckAssignments = assignDeckVariantCompositions([assessment.safeOptionsByVariant]);
  assert.ok(deckAssignments, 'tier 3 rescues the safe but composition-identical donor when needed for distinct complete tracks');
  const chosen = ['A', 'B', 'C'].map((variant) => deckAssignments[variant][0]);
  assert.equal(new Set(chosen.map((item) => item.projectedCompositionSignature)).size, 3);
  assert.ok(chosen.some((item) => item.compositionKind === 'exemplar-backed'),
    'the safe semantic donor remains preferred for one track');
  assert.ok(chosen.some((item) => item.compositionKind === 'template-derived-fallback'),
    'generic compositions are used only where the higher-tier donor cannot provide deck-level distinction');

  for (const [index, compiled] of compiledTracks.entries()) {
    const assignment = chosen.find((item) => item.variantId === tracks[index]?.variantId);
    assert.ok(assignment);
    const assigned = applyVariantCompositionAssignment(tracks[index], assignment, template.templateIR);
    if (assignment.compositionKind === 'template-derived-fallback') {
      assert.equal(assigned.templateDerivedCompositionStrategy, { A: 'balanced', B: 'visual-first', C: 'structured-dense' }[assigned.variantId]);
    }
    const outputPath = path.join(root, 'output', `template-derived-${assigned.variantId}.pptx`);
    await mkdir(path.dirname(outputPath), { recursive: true });
    const rendered = await new OfficeKitPptxRenderer().render({
      compiledPresentation: { ...compiled, slides: [assigned] },
      contentIR, templateIR: template.templateIR, templatePath: template.templatePath, outputPath,
    });
    assert.equal(rendered.validationStatus, 'passed');
    assert.equal(rendered.reopenStatus, 'passed');
    assert.equal(rendered.projectedCompositions[0]?.projectedCompositionSignature, assignment.projectedCompositionSignature);
    const preview = await new OfficeKitPreviewAdapter().preview(await readFile(outputPath), 0);
    assert.equal(preview.status, 'passed', JSON.stringify({ variant: assigned.variantId, text: preview.textLayoutIssues, geometry: preview.geometryIssues }));
    assert.equal(preview.textLayoutIssues.length, 0);
    assert.equal(preview.geometryIssues.length, 0);
    const reopened = await inspectPptx(outputPath);
    const visible = reopened.inspection.slides[0]?.elements.map((element) => element.text).join('\n') ?? '';
    assert.match(visible, /Цель задаёт план/u);
    assert.match(visible, /Определить следующий шаг/u);
    assert.doesNotMatch(visible, /Example (?:title|body) region/u, 'source exemplar copy is not retained');
    assert.ok(reopened.inspection.slides[0]?.elements.filter((element) => element.text.trim()).length >= 2,
      'the generated slide contains editable native title/body text');
  }
  assert.equal(createHash('sha256').update(await readFile(template.templatePath)).digest('hex'), sourceHash,
    'the unknown template source remains immutable');
});

test('generic fallback derives readable text color from a dark template background', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-derived-dark-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await inferredRegionTemplateFixture(root, { darkTheme: true, darkBodyBlack: true });
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const compiledTracks = VARIANT_POLICIES.map((policy) => compilePresentation(deckPlan, contentIR, template.templateIR, policy));
  const tracks = compiledTracks.map((presentation) => {
    const slide = presentation.slides[0];
    assert.ok(slide);
    slide.title = 'Цель задаёт план';
    slide.body = ['Уточнить цель.', 'Проверить условия.', 'Определить следующий шаг.'];
    slide.generatedBodyPoints = slide.body.map((text) => ({ text, origin: 'generated-from-brief', evidenceRefs: [] }));
    return slide;
  });
  const assessment = assessVariantCompositionDistinctnessRaw(tracks, template.templateIR, 'office-kit');
  const assignments = assignDeckVariantCompositions([assessment.safeOptionsByVariant]);
  assert.ok(assignments);
  const fallback = ['A', 'B', 'C'].map((variant) => assignments[variant][0]).find((item) => item.compositionKind === 'template-derived-fallback');
  assert.ok(fallback, 'the regression exercises the generic last-resort renderer path');
  const index = VARIANT_POLICIES.findIndex((policy) => policy.id === fallback.variantId);
  const selectedTrack = tracks[index];
  const compiledTrack = compiledTracks[index];
  assert.ok(selectedTrack);
  assert.ok(compiledTrack);
  const assigned = applyVariantCompositionAssignment(selectedTrack, fallback, template.templateIR);
  const outputPath = path.join(root, 'output', 'dark-template-derived.pptx');
  await mkdir(path.dirname(outputPath), { recursive: true });
  const rendered = await new OfficeKitPptxRenderer().render({
    compiledPresentation: { ...compiledTrack, slides: [assigned] },
    contentIR, templateIR: template.templateIR, templatePath: template.templatePath, outputPath,
  });
  assert.equal(rendered.validationStatus, 'passed');
  const preview = await new OfficeKitPreviewAdapter().preview(await readFile(outputPath), 0);
  assert.equal(preview.status, 'passed');
  const reopened = await loadPresentation(await readFile(outputPath));
  const reopenedSlide = getSlides(reopened)[0];
  assert.ok(reopenedSlide);
  const title = getSlideShapes(reopenedSlide).find((shape) => getShapeText(shape) === selectedTrack.title);
  const body = getSlideShapes(reopenedSlide).find((shape) => getShapeText(shape).includes('Проверить условия.'));
  assert.ok(title, 'the title remains a native editable shape');
  assert.ok(body);
  const titleForeground = getShapeRunFormatEffective(reopened, title, 0, 0).color?.toUpperCase();
  const foreground = getShapeRunFormatEffective(reopened, body, 0, 0).color?.toUpperCase();
  assert.ok(titleForeground);
  assert.ok(foreground);
  assert.equal(titleForeground, foreground,
    'the title uses the contrast-checked theme foreground for its own measured dark region');
  assert.notEqual(foreground, '#172B4D', 'dark source body typography is not carried onto a dark template background');
  assert.ok([`#${template.templateIR.theme?.colors.lt1}`, '#F9FAFB'].some((color) => color.toUpperCase() === foreground),
    `foreground remains a template-derived light token for the measured dark backdrop, received ${foreground}`);
});

test('generic inferred-region fallback remains fail-closed around master text, preserved visuals, and missing role evidence', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-template-derived-fallback-safety-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const tracksFor = (template) => VARIANT_POLICIES.map((policy) => compilePresentation(deckPlan, contentIR, template.templateIR, policy).slides[0]);

  const textMaster = await inferredRegionTemplateFixture(root, { masterStaticText: 'Inherited organizer instructions' });
  const textAssessment = assessVariantCompositionDistinctnessRaw(tracksFor(textMaster), textMaster.templateIR, 'office-kit');
  assert.equal(textAssessment.assignments.length, 0, 'inherited master copy is never overlapped or silently retained');

  const logoMaster = await inferredRegionTemplateFixture(root, { masterLogo: true });
  const logoTracks = tracksFor(logoMaster);
  const logoCandidate = logoTracks[0]?.layoutCandidates[logoTracks[0].selectedCandidateIndex];
  assert.ok(logoCandidate);
  assert.equal(templateDerivedCompositionSupported(logoTracks[0], logoMaster.templateIR, logoCandidate), false,
    'a measured body region colliding with preserved master artwork is rejected');

  const plainTemplate = await inferredRegionTemplateFixture(root);
  const missingEvidence = tracksFor(plainTemplate);
  for (const slide of missingEvidence) slide.layoutCandidates = slide.layoutCandidates.map((candidate) => ({
    ...candidate,
    slotEvidence: {
      ...candidate.slotEvidence,
      title: candidate.slotEvidence.title ? { ...candidate.slotEvidence.title, confidence: 0 } : null,
      body: candidate.slotEvidence.body ? { ...candidate.slotEvidence.body, confidence: 0 } : null,
    },
  }));
  const missingAssessment = assessVariantCompositionDistinctnessRaw(missingEvidence, plainTemplate.templateIR, 'office-kit');
  assert.equal(missingAssessment.assignments.length, 0, 'without title/body region evidence, generic shapes are not fabricated');
});

test('exemplar projection is withheld when static sample text is inherited from its layout/master', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-master-residue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await familyExemplarFixture(root, 'master-residue-template.pptx', { masterStaticText: 'REPEATED SAMPLE COPY' });
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]).slides[1];
  assert.ok(compiled);
  const assessment = assessExemplarSelectionRaw(compiled, template.templateIR);
  assert.equal(assessment.selection, null);
  assert.ok(assessment.candidateDiagnostics.some((candidate) => candidate.gate === 'inherited-source-text'),
    'a donor cannot preserve static text from a layout/master that the slide projection cannot edit');
});

test('A/B/C composition uniqueness is enforced across complete decks, allowing safe per-slide reuse', () => {
  const option = (variantId, signature, layoutCandidateIndex = 0) => ({
    variantId,
    compositionKind: 'layout-placeholder-backed',
    layoutCandidateIndex,
    projectedCompositionSignature: signature,
  });

  const oneSafeSlide = assignSafeVariantCompositions([
    [option('A', 'shared')], [option('B', 'shared')], [option('C', 'shared')],
  ]);
  assert.equal(oneSafeSlide.length, 3, 'a single safe choice is assigned to every variant without weakening projection safety');
  assert.deepEqual(oneSafeSlide.map((assignment) => assignment.projectedCompositionSignature), ['shared', 'shared', 'shared']);
  const oneSharedSlideDecks = assessDeckCompositionDistinctness({
    A: ['shared', 'a-layout', 'a-ending'],
    B: ['shared', 'b-layout', 'b-ending'],
    C: ['shared', 'c-layout', 'c-ending'],
  });
  assert.equal(oneSharedSlideDecks.distinct, true, 'other slide compositions make all three complete tracks distinguishable');
  assert.deepEqual(oneSharedSlideDecks.differingSlideCounts, { AB: 2, AC: 2, BC: 2 });

  const twoSafeSlide = assignSafeVariantCompositions([
    [option('A', 'one'), option('A', 'two', 1)],
    [option('B', 'one'), option('B', 'two', 1)],
    [option('C', 'one'), option('C', 'two', 1)],
  ]);
  assert.equal(twoSafeSlide.length, 3);
  assert.equal(new Set(twoSafeSlide.map((assignment) => assignment.projectedCompositionSignature)).size, 2,
    'three variants reuse one of two safe choices while maximizing available differences');
  const twoChoiceDecks = assessDeckCompositionDistinctness({
    A: [twoSafeSlide[0].projectedCompositionSignature, 'a-track'],
    B: [twoSafeSlide[1].projectedCompositionSignature, 'b-track'],
    C: [twoSafeSlide[2].projectedCompositionSignature, 'c-track'],
  });
  assert.equal(twoChoiceDecks.distinct, true);

  const donorOption = (variantId, sourceSlideIndex, signature) => ({
    ...option(variantId, signature),
    compositionKind: 'exemplar-backed',
    exemplarSelection: { sourcePart: `ppt/slides/slide${sourceSlideIndex}.xml`, sourceSlideIndex },
  });
  const visuallyDiverseTracks = assignSafeVariantCompositions([
    [donorOption('A', 1, 'a-1'), donorOption('A', 2, 'a-2'), donorOption('A', 3, 'a-3')],
    [donorOption('B', 1, 'b-1'), donorOption('B', 2, 'b-2'), donorOption('B', 3, 'b-3')],
    [donorOption('C', 1, 'c-1'), donorOption('C', 2, 'c-2'), donorOption('C', 3, 'c-3')],
  ]);
  assert.equal(new Set(visuallyDiverseTracks.map((item) => item.exemplarSelection.sourceSlideIndex)).size, 3,
    'when safe donor alternatives exist, A/B/C prefer different native template compositions over card-position-only differences');

  assert.deepEqual(assignSafeVariantCompositions([
    [option('A', 'one')], [], [option('C', 'two')],
  ]), [], 'a track with no safe option prevents the complete slide assignment');

  const sameDeck = assessDeckCompositionDistinctness({ A: ['same', 'same'], B: ['same', 'same'], C: ['same', 'same'] });
  assert.equal(sameDeck.distinct, false, 'one possible ordered composition sequence fails closed');
  assert.deepEqual(sameDeck.differingSlideCounts, { AB: 0, AC: 0, BC: 0 });

  const distinctDecks = assessDeckCompositionDistinctness({ A: ['a-1', 'a-2'], B: ['b-1', 'b-2'], C: ['c-1', 'c-2'] });
  assert.equal(distinctDecks.distinct, true);
  assert.equal(new Set(Object.values(distinctDecks.deckSignatures)).size, 3);
});

test('Office Kit fallback fills a measured generic native body placeholder by index', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-native-generic-body-placeholder-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await nativePlaceholderFixture(root, { genericBodyPlaceholder: true });
  const rawPresentation = await loadPresentation(await readFile(template.templatePath));
  const sourceLayoutPart = template.templateIR.layouts.find((layout) => layout.elements.some((element) => element.placeholder?.role === 'body'))?.sourcePart;
  assert.ok(sourceLayoutPart);
  const sourceLayout = findSlideLayoutByPartName(rawPresentation, sourceLayoutPart.startsWith('/') ? sourceLayoutPart : `/${sourceLayoutPart}`);
  assert.ok(sourceLayout);
  assert.ok(getSlideLayoutPlaceholders(sourceLayout).some((placeholder) => placeholder.type === null
    && Number.isSafeInteger(placeholder.idx)), 'the input contains a measured generic layout placeholder identified by index');
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]);
  const slide = compiled.slides[0];
  assert.ok(slide);
  const outputPath = path.join(root, 'output', 'generic-body-fallback.pptx');
  await mkdir(path.dirname(outputPath), { recursive: true });
  const result = await new OfficeKitPptxRenderer().render({
    compiledPresentation: { ...compiled, id: `${compiled.id}_generic_body_placeholder`, slides: [slide] },
    contentIR, templateIR: template.templateIR, templatePath: template.templatePath, outputPath,
  });
  assert.equal(result.reopenStatus, 'passed');
  assert.equal(result.validationStatus, 'passed');
  const reopened = await loadPresentation(await readFile(outputPath));
  const textShapes = getSlideShapes(getSlides(reopened)[0]).filter((shape) => hasShapeText(shape) && getShapeText(shape).trim());
  assert.equal(textShapes.length, 2);
  assert.ok(textShapes.some((shape) => getShapePlaceholderType(shape) === 'title' && getShapeText(shape) === slide.title));
  assert.ok(textShapes.some((shape) => isShapePlaceholder(shape) && getShapeText(shape) === slide.body.join('\n')),
    'the indexed generic placeholder retains its measured content even if Office Kit resolves an inherited body role');
});

test('hyperlinked exemplar slides fail closed when no safe native layout fallback exists', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-hyperlink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await familyExemplarFixture(root, 'hyperlinked-template.pptx', { hyperlinkBody: true });
  assert.ok(template.templateIR.slides[0].relationships.some((relationship) => relationship.type.toLowerCase().endsWith('/hyperlink')));
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]);
  const compiledSlide = compiled.slides.at(-1);
  assert.ok(compiledSlide);
  assert.equal(selectExemplarSlide(compiledSlide, template.templateIR), null,
    'the text donor must not carry a source hyperlink into generated content');
  const outputPath = path.join(root, 'output', 'hyperlink-probe.pptx');
  await mkdir(path.dirname(outputPath), { recursive: true });
  await assert.rejects(new OfficeKitPptxRenderer().render({
    compiledPresentation: { ...compiled, id: `${compiled.id}_hyperlink`, slides: [compiledSlide] },
    contentIR, templateIR: template.templateIR, templatePath: template.templatePath, outputPath,
  }), (error) => error.code === 'NATIVE_TITLE_PLACEHOLDER_REQUIRED');
  await assert.rejects(stat(outputPath), { code: 'ENOENT' }, 'unsafe generic text-box fallback is withheld');
});

test('ambiguous exemplar geometry fails closed with typed evidence', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-exemplar-ambiguous-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exemplar = await exemplarFixture(root, 'ambiguous.pptx', { masterName: 'Unrelated donor name', ambiguous: true });
  const { contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  assert.throws(() => compilePresentation(deckPlan, contentIR, exemplar.templateIR, VARIANT_POLICIES[0]), (error) => {
    assert.equal(error.code, 'UNSUPPORTED_TEMPLATE_LAYOUT');
    assert.ok(Array.isArray(error.candidates));
    assert.ok(error.candidates.every((candidate) => candidate.slots.title === null || candidate.slots.body === null));
    return true;
  });
});

test('compatibility harness writes partial staged evidence when exemplar generation fails', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-harness-partial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  await mkdir(source, { recursive: true });
  const exemplar = await exemplarFixture(source, 'ambiguous-held-out.pptx', { masterName: 'No useful name', ambiguous: true });
  await mkdir(output, { recursive: true });
  const originalHash = createHash('sha256').update(await readFile(exemplar.templatePath)).digest('hex');
  await link(exemplar.templatePath, path.join(output, 'backend-compatibility-report.json'));
  const result = await runPptxCompatibilityHarness(exemplar.templatePath, output);
  const saved = JSON.parse(await readFile(result.reportPath, 'utf8'));
  assert.equal(createHash('sha256').update(await readFile(exemplar.templatePath)).digest('hex'), originalHash,
    'replacing a pre-existing hard-linked report path must not modify the source presentation');
  assert.equal(saved.capabilities.inputSafety.status, 'PASS');
  assert.equal(saved.capabilities.lctInspection.status, 'PASS');
  assert.equal(saved.capabilities.officeKitLoad.status, 'PASS');
  assert.equal(saved.capabilities.noOpRoundTrip.status, 'PASS');
  assert.equal(saved.capabilities.templatePartPreservation.status, 'PASS');
  assert.equal(saved.capabilities.generationCompatibility.status, 'FAIL');
  assert.equal(saved.capabilities.generationCompatibility.reason.code, 'UNSUPPORTED_TEMPLATE_LAYOUT');
  assert.equal(saved.capabilities.generatedMutation.status, 'UNKNOWN');
  assert.equal(saved.capabilities.sourceByteIdentity.status, 'PASS');
  assert.equal(saved.source.immutable, 'PASS');
  assert.ok(Array.isArray(saved.lctInventory.inferredSlotEvidence));
  assert.equal(saved.outputs.generatedMutation, undefined);
});

test('compatibility harness reports unsafe or unavailable input when the report directory is available', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-harness-input-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  await mkdir(source, { recursive: true });
  const result = await runPptxCompatibilityHarness(path.join(source, 'missing.pptx'), output);
  const saved = JSON.parse(await readFile(result.reportPath, 'utf8'));
  assert.equal(saved.capabilities.inputSafety.status, 'FAIL');
  assert.equal(saved.capabilities.lctInspection.status, 'UNKNOWN');
  assert.equal(saved.capabilities.generationCompatibility.status, 'UNKNOWN');
  assert.ok((await stat(result.reportPath)).isFile());
});

test('compiler rejects templates without measured title/content slots instead of publishing fallback geometry', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-missing-template-slots-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { contentIR, deckPlan, templates } = await scenario(root, 1, Array(5).fill('none'));
  for (const missingRole of ['title', 'body']) {
    const template = structuredClone(templates[0].templateIR);
    for (const layout of template.layouts) {
      for (const element of layout.elements) {
        if (element.placeholder?.role === missingRole) {
          element.placeholder.role = `vendor-${missingRole}`;
          element.placeholder.type = `vendor-${missingRole}`;
        }
      }
    }
    template.hash = sha256Json(templateIRHashPayload(template));
    assert.throws(
      () => compilePresentation(deckPlan, contentIR, template, VARIANT_POLICIES[0]),
      (error) => error.code === 'UNSUPPORTED_TEMPLATE_LAYOUT' && error.message.includes('measured'),
      `missing ${missingRole} slots should fail explicitly`,
    );
  }
});

test('deterministic audit finds bad geometry, unsupported numbers, and broken provenance', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { contentIR, deckPlan, templates } = await scenario(root, 1, Array(5).fill('none'));
  const template = templates[0].templateIR;
  const compiled = compilePresentation(deckPlan, contentIR, template, VARIANT_POLICIES[0]);
  const bad = structuredClone(compiled);
  bad.slides[0].title = 'Revenue reached $999 million.';
  bad.slides[0].placements.title.x = -1;
  bad.slides[0].provenanceRefs = ['missing_content_reference'];
  const report = auditCompiledPresentation(bad, contentIR, template);
  assert.ok(report.findings.some((finding) => finding.ruleId === 'geometry.out-of-bounds'));
  assert.ok(report.findings.some((finding) => finding.ruleId === 'fidelity.unsupported-number' && finding.evidence.numericToken === 'currency-symbol:$999'));
  assert.ok(report.findings.some((finding) => finding.ruleId === 'integrity.broken-provenance'));
  assert.equal(report.checks.find((item) => item.ruleId === 'fidelity.semantic').status, 'unknown');
});

test('deterministic audit is pure, repeatable, canonical across cloned inputs, and changes with blocking geometry', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-audit-determinism-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { contentIR, deckPlan, templates } = await scenario(root, 1, Array(5).fill('none'));
  const template = templates[0].templateIR;
  const compiled = compilePresentation(deckPlan, contentIR, template, VARIANT_POLICIES[0]);
  const before = structuredClone({ compiled, contentIR, template });

  const first = auditCompiledPresentation(compiled, contentIR, template);
  const second = auditCompiledPresentation(compiled, contentIR, template);
  const cloned = auditCompiledPresentation(structuredClone(compiled), structuredClone(contentIR), structuredClone(template));
  assert.deepEqual(first, second);
  assert.deepEqual(first, cloned);
  assert.equal(canonicalDeterministicAuditSha256(first), canonicalDeterministicAuditSha256(second));
  assert.equal(canonicalDeterministicAuditSha256(first), canonicalDeterministicAuditSha256(cloned));
  assert.deepEqual({ compiled, contentIR, template }, before, 'audit must not mutate any supplied IR');

  const movedOutsideCanvas = structuredClone(compiled);
  movedOutsideCanvas.slides[0].placements.title.x = -1;
  const changed = auditCompiledPresentation(movedOutsideCanvas, contentIR, template);
  assert.ok(changed.findings.some((finding) => finding.ruleId === 'geometry.out-of-bounds' && finding.severity === 'error'));
  assert.notEqual(canonicalDeterministicAuditSha256(first), canonicalDeterministicAuditSha256(changed));
});

test('reserved visual geometry may bleed when unused, while generated visual placements remain strictly in bounds', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-audit-reserved-visual-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const unused = await scenario(root, 1, Array(5).fill('none'));
  const unusedTemplate = unused.templates[0].templateIR;
  const unusedCompiled = compilePresentation(unused.deckPlan, unused.contentIR, unusedTemplate, VARIANT_POLICIES[0]);
  const withUnusedBleed = structuredClone(unusedCompiled.slides[0]);
  withUnusedBleed.placements.visual = { x: -7800, y: 0, width: 1000, height: 1000, unit: 'EMU' };
  const unusedAudit = auditCompiledPresentation({ ...unusedCompiled, slides: [withUnusedBleed] }, unused.contentIR, unusedTemplate);
  assert.ok(!unusedAudit.findings.some((finding) => finding.ruleId === 'geometry.out-of-bounds'),
    'an unused reserved image placeholder does not count as generated content');

  const activeSlide = structuredClone(unusedCompiled.slides[0]);
  const activeUnitId = unused.contentIR.units.find((unit) => unit.text)?.id;
  assert.ok(activeUnitId);
  activeSlide.visualization.type = 'process';
  activeSlide.visualization.status = 'referenced';
  activeSlide.visualization.processSteps = [
    { text: 'Parse source', sourceRef: activeUnitId },
    { text: 'Validate output', sourceRef: activeUnitId },
  ];
  activeSlide.placements.visual = { x: -1, y: 0, width: 1000, height: 1000, unit: 'EMU' };
  const activeAudit = auditCompiledPresentation({ ...unusedCompiled, slides: [activeSlide] }, unused.contentIR, unusedTemplate);
  assert.ok(activeAudit.findings.some((finding) => finding.ruleId === 'geometry.out-of-bounds' && finding.message.includes('visual')),
    'a requested/generated visual remains subject to strict canvas bounds');
});

test('deterministic audit keeps currencies, percentages, and dates attached to their values', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-audit-facts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { contentIR: originalContentIR, deckPlan, templates } = await scenario(root, 1, Array(5).fill('none'));
  const contentIR = structuredClone(originalContentIR);
  const template = templates[0].templateIR;
  const compiled = compilePresentation(deckPlan, contentIR, template, VARIANT_POLICIES[0]);
  const slide = structuredClone(compiled.slides[4]);
  const sourceUnit = contentIR.units.find((unit) => unit.id === slide.provenanceRefs[0]);
  assert.ok(sourceUnit?.text);
  sourceUnit.text = 'Revenue was 90 USD on 2025-04-03 and improved by 18%.';
  slide.title = 'Revenue was 90 EUR on 2025-03-04 and improved by 18%.';
  const report = auditCompiledPresentation({ ...compiled, slides: [slide] }, contentIR, template);
  const unsupported = report.findings.filter((finding) => finding.ruleId === 'fidelity.unsupported-number');
  assert.ok(unsupported.some((finding) => finding.evidence.numericToken === 'currency:90EUR'));
  assert.ok(unsupported.some((finding) => finding.evidence.numericToken === 'date:2025-03-04'));
  assert.ok(!unsupported.some((finding) => finding.evidence.numericToken === 'number-unit:18%'));
});

test('deterministic audit reports injected density and integrity defects and leaves overflow unknown', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-audit-density-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { contentIR, deckPlan, templates } = await scenario(root);
  const template = templates[0].templateIR;
  const compiled = compilePresentation(deckPlan, contentIR, template, VARIANT_POLICIES[0]);
  const findings = (slide) => auditCompiledPresentation({ ...compiled, slides: [slide] }, contentIR, template).findings;

  const sevenBullets = structuredClone(compiled.slides[4]);
  sevenBullets.body = Array.from({ length: 7 }, (_value, index) => `- item ${index + 1}`);
  assert.ok(findings(sevenBullets).some((finding) => finding.ruleId === 'density.excessive-bullets'));

  const longBullet = structuredClone(compiled.slides[4]);
  longBullet.body = ['- one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen'];
  assert.ok(findings(longBullet).some((finding) => finding.ruleId === 'density.long-bullet-copy' && finding.evidence.wordCount === 16));

  const titleOnly = structuredClone(compiled.slides[4]);
  titleOnly.body = [];
  titleOnly.imageRefs = [];
  titleOnly.visualization = { type: 'none', sourceRefs: [], status: 'none', tableData: null, tableCellRefs: null, chartData: null, processSteps: [], kpi: null };
  assert.ok(findings(titleOnly).some((finding) => finding.ruleId === 'integrity.title-only-slide'));

  const wideTable = structuredClone(compiled.slides[1]);
  wideTable.visualization.tableData = Array.from({ length: 8 }, () => Array(6).fill('x'));
  assert.ok(findings(wideTable).some((finding) => finding.ruleId === 'density.table-limits'));

  const manySeries = structuredClone(compiled.slides[0]);
  while (manySeries.visualization.chartData.series.length < 6) {
    manySeries.visualization.chartData.series.push(structuredClone(manySeries.visualization.chartData.series[0]));
  }
  assert.ok(findings(manySeries).some((finding) => finding.ruleId === 'density.chart-series'));

  const overlap = structuredClone(compiled.slides[4]);
  overlap.placements.body = structuredClone(overlap.placements.title);
  assert.ok(findings(overlap).some((finding) => finding.ruleId === 'geometry.text-slots-overlap'));

  const empty = structuredClone(compiled.slides[4]);
  empty.title = '';
  empty.body = [];
  assert.ok(findings(empty).some((finding) => finding.ruleId === 'integrity.blank-slide'));

  const placeholder = structuredClone(compiled.slides[4]);
  placeholder.title = 'TODO: confirm the business result';
  assert.ok(findings(placeholder).some((finding) => finding.ruleId === 'integrity.placeholder-text'));

  const duplicateA = structuredClone(compiled.slides[0]);
  const duplicateB = structuredClone(compiled.slides[1]);
  duplicateB.title = duplicateA.title;
  duplicateB.body = [...duplicateA.body];
  const duplicateReport = auditCompiledPresentation({ ...compiled, slides: [duplicateA, duplicateB] }, contentIR, template);
  assert.ok(duplicateReport.findings.some((finding) => finding.ruleId === 'integrity.duplicate-slide-content'));
  assert.equal(duplicateReport.checks.find((check) => check.ruleId === 'rendered-overflow').status, 'unknown');
});

test('chart and table audit blocks values that do not match cited source cells', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-visual-provenance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { contentIR, deckPlan, templates } = await scenario(root);
  const template = templates[0].templateIR;
  const compiled = compilePresentation(deckPlan, contentIR, template, VARIANT_POLICIES[0]);
  const badChart = structuredClone(compiled);
  badChart.slides[0].visualization.chartData.series[0].values[0] = 999;
  assert.ok(auditCompiledPresentation(badChart, contentIR, template).findings.some((finding) => finding.ruleId === 'fidelity.chart-numeric-provenance' && finding.severity === 'error'));
  const badChartLabels = structuredClone(compiled);
  badChartLabels.slides[0].visualization.chartData.categories[0] = '2026';
  badChartLabels.slides[0].visualization.chartData.series[0].name = 'Expenses';
  assert.ok(auditCompiledPresentation(badChartLabels, contentIR, template).findings.some((finding) => finding.ruleId === 'fidelity.chart-label-provenance' && finding.severity === 'error'));
  const unrelatedChartRef = structuredClone(compiled);
  unrelatedChartRef.slides[0].visualization.chartData.provenanceRefs.push(contentIR.units.find((unit) => unit.sourceId !== unrelatedChartRef.slides[0].visualization.chartData.provenanceRefs[0]).id);
  assert.ok(auditCompiledPresentation(unrelatedChartRef, contentIR, template).findings.some((finding) => finding.ruleId === 'fidelity.chart-source-reference' && finding.severity === 'error'));
  const unlabeledChart = structuredClone(compiled);
  unlabeledChart.slides[0].visualization.chartData.title = '';
  unlabeledChart.slides[0].visualization.chartData.series[0].name = '';
  assert.ok(auditCompiledPresentation(unlabeledChart, contentIR, template).findings.some((finding) => finding.ruleId === 'integrity.chart-labels-legend' && finding.severity === 'error'));
  const badTable = structuredClone(compiled);
  badTable.slides[1].visualization.tableData[1][1] = '999';
  assert.ok(auditCompiledPresentation(badTable, contentIR, template).findings.some((finding) => finding.ruleId === 'fidelity.table-source-reference' && finding.severity === 'error'));
});

test('Office Kit reports missing and changed source images as typed failures with findings', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-image-failures-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { contentIR, deckPlan, templates } = await scenario(root, 5);
  const template = templates[1];
  const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]);
  const pictureLayout = template.templateIR.layouts.find((layout) => layout.elements.some((element) => element.placeholder?.type === 'pic'));
  assert.ok(pictureLayout, 'T2 exposes a measured picture placeholder');
  const pictureElement = pictureLayout.elements.find((element) => element.placeholder?.type === 'pic');
  const pictureGeometry = pictureElement.geometry.resolved ?? pictureElement.geometry.direct;
  const imageSlide = compiled.slides[4];
  imageSlide.layoutId = pictureLayout.id;
  imageSlide.layoutSourcePart = pictureLayout.sourcePart;
  imageSlide.placements.visual = { x: pictureGeometry.x, y: pictureGeometry.y, width: pictureGeometry.width, height: pictureGeometry.height, unit: 'EMU' };
  const imagePath = path.join(template.contentRoot, 'source-image.png');
  await rm(imagePath);
  await assert.rejects(
    new OfficeKitPptxRenderer().render({ compiledPresentation: compiled, contentIR, templateIR: template.templateIR, templatePath: template.templatePath, outputPath: path.join(root, 'missing-image.pptx'), contentRoot: template.contentRoot }),
    (error) => error.code === 'MISSING_ASSET' && error.finding.ruleId === 'visual.missing-asset',
  );
  await writeFile(imagePath, Buffer.from('corrupt image bytes'));
  await assert.rejects(
    new OfficeKitPptxRenderer().render({ compiledPresentation: compiled, contentIR, templateIR: template.templateIR, templatePath: template.templatePath, outputPath: path.join(root, 'changed-image.pptx'), contentRoot: template.contentRoot }),
    (error) => error.code === 'ASSET_HASH_MISMATCH' && error.finding.severity === 'error',
  );
  await writeFile(imagePath, onePixelPng);
  const rendered = await new OfficeKitPptxRenderer().render({
    compiledPresentation: compiled, contentIR, templateIR: template.templateIR,
    templatePath: template.templatePath, outputPath: path.join(root, 'valid-image.pptx'), contentRoot: template.contentRoot,
  });
  assert.equal(rendered.nativeImageCount, 1, 'the measured picture slot receives the source-backed image');
});

test('repair switches at most one layout then audits once more', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-repair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { contentIR, deckPlan, templates } = await scenario(root, 1, Array(5).fill('none'));
  const template = templates[0].templateIR;
  const compiled = compilePresentation(deckPlan, contentIR, template, VARIANT_POLICIES[0]);
  const bad = structuredClone(compiled);
  bad.slides[0].placements.title.x = -1;
  const firstLayout = bad.slides[0].layoutId;
  const repaired = repairCompiledPresentationOnce(bad, contentIR, template);
  assert.equal(repaired.repairCount, 1);
  assert.notEqual(repaired.presentation.slides[0].layoutId, firstLayout);
  assert.ok(!repaired.report.findings.some((finding) => finding.slideId === bad.slides[0].id && finding.ruleId === 'geometry.out-of-bounds'));
});

test('native PPTX renderer preserves template masters/layouts and emits editable text shapes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-native-pptx-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { contentIR, deckPlan, templates } = await scenario(root);
  const template = templates[0];
  const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]);
  const outputPath = path.join(root, 'output', 'variant-a.pptx');
  await mkdir(path.dirname(outputPath), { recursive: true });
  const result = await renderNativePptx({ compiledPresentation: compiled, contentIR, templateIR: template.templateIR, templatePath: template.templatePath, outputPath });
  assert.equal(result.slideCount, 5);
  assert.equal(result.nativeTextShapeCount, 10);
  assert.equal(result.nativeTableCount, 1);
  assert.equal(result.rasterSlideCount, 0);
  assert.ok(result.unresolvedVisualTypes.includes('image'), 'custom fallback reports source-backed image media it does not render');
  const imageWithoutVisualIntent = structuredClone(compiled);
  imageWithoutVisualIntent.slides[4].visualization.type = 'none';
  imageWithoutVisualIntent.slides[4].visualization.status = 'none';
  const noVisualIntentResult = await renderNativePptx({
    compiledPresentation: imageWithoutVisualIntent,
    contentIR,
    templateIR: template.templateIR,
    templatePath: template.templatePath,
    outputPath: path.join(root, 'output', 'image-reference-without-visual-intent.pptx'),
  });
  assert.ok(noVisualIntentResult.unresolvedVisualTypes.includes('image'), 'mediaRefs remain reported even without a semantic visual type');
  const bytes = await readFile(outputPath);
  const zip = await (await import('jszip')).default.loadAsync(bytes);
  const presentationXml = await zip.file('ppt/presentation.xml').async('string');
  assert.equal((presentationXml.match(/<p:sldId\b/g) ?? []).length, 5);
  const generatedSlideParts = Object.keys(zip.files).filter((name) => /^ppt\/slides\/lct_[^/]+_slide_\d+\.xml$/.test(name));
  assert.equal(generatedSlideParts.length, 5);
  for (const part of generatedSlideParts) {
    const xml = await zip.file(part).async('string');
    assert.equal((xml.match(/<p:sp>/g) ?? []).length, 2, 'each generated slide contains native editable text boxes');
    assert.equal((xml.match(/<p:pic>/g) ?? []).length, 0, 'no slide-wide raster is emitted');
  }
  const tableSlideXml = await zip.file(generatedSlideParts[1]).async('string');
  assert.ok(tableSlideXml.includes('<a:tbl>'), 'the table is a native editable DrawingML table');
  assert.equal((tableSlideXml.match(/<a:tr\b/g) ?? []).length, 3);
  const reopened = await inspectPptx(outputPath);
  assert.equal(reopened.inspection.slides.length, 5);
  assert.ok(reopened.inspection.slides.some((slide) => slide.elements.some((element) => element.text.includes('120'))));
  assert.ok(reopened.inspection.slides.every((slide) => slide.layoutPart?.startsWith('ppt/slideLayouts/')));

  const strictTemplate = await fixture(root, { fileName: 'strict-template.pptx', strict: true });
  const strictCompiled = compilePresentation(deckPlan, contentIR, strictTemplate.templateIR, VARIANT_POLICIES[0]);
  const strictOutput = path.join(root, 'output', 'strict-variant-a.pptx');
  await renderNativePptx({ compiledPresentation: strictCompiled, contentIR, templateIR: strictTemplate.templateIR, templatePath: strictTemplate.templatePath, outputPath: strictOutput });
  assert.equal((await inspectPptx(strictOutput)).inspection.slides.length, 5, 'Strict OOXML remains parseable after adding generated slide relationships');
});

test('both backends remove inactive source slides and speaker notes from generated packages', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-source-content-purge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { contentIR, deckPlan } = await scenario(root, 1, ['chart', 'table', 'kpi', 'process', 'none']);
  const templates = await corpusTemplates(root, path.join(root, 'projects', 'offline-fixture'));
  for (const template of [templates[0], templates[4]]) {
    const compiled = compilePresentation(deckPlan, contentIR, template.templateIR, VARIANT_POLICIES[0]);
    for (const slide of compiled.slides) slide.imageRefs = [];
    for (const backend of ['custom', 'office-kit']) {
      const outputPath = path.join(root, 'output', `${template.id}-${backend}.pptx`);
      await mkdir(path.dirname(outputPath), { recursive: true });
      if (backend === 'office-kit') {
        await new OfficeKitPptxRenderer().render({
          compiledPresentation: compiled, contentIR, templateIR: template.templateIR,
          templatePath: template.templatePath, outputPath, contentRoot: template.contentRoot,
        });
      } else {
        await renderNativePptx({ compiledPresentation: compiled, contentIR, templateIR: template.templateIR, templatePath: template.templatePath, outputPath });
      }
      const zip = await (await import('jszip')).default.loadAsync(await readFile(outputPath));
      const packageText = await Promise.all(Object.entries(zip.files)
        .filter(([, entry]) => !entry.dir)
        .map(([, entry]) => entry.async('string').catch(() => '')));
      assert.ok(!packageText.join('\n').includes('Source sample content is removed from generated output.'), `${template.id} ${backend} must not retain source slide text`);
      assert.ok(!packageText.join('\n').includes('T5 source-only speaker note'), `${template.id} ${backend} must not retain source speaker notes`);
      assert.ok(!packageText.join('\n').includes('Synthetic sample'), `${template.id} ${backend} must not retain source chart/table sample data`);
      assert.ok(!packageText.join('\n').includes('Sample'), `${template.id} ${backend} must not retain a source-only chart series name`);
      assert.equal(Object.keys(zip.files).some((name) => /^ppt\/notesSlides\/[^/]+\.xml$/i.test(name)), false, `${template.id} ${backend} should not retain notes slide parts`);
      assert.equal(Object.keys(zip.files).some((name) => /^ppt\/media\/[^/]+$/i.test(name)), false, `${template.id} ${backend} should not retain source-only images when generated slides do not use media`);
      const inspection = await inspectPptx(outputPath);
      assert.equal(inspection.inspection.slides.length, compiled.slides.length);
    }
  }
});

test('offline matrix emits three validated distinct Office Kit tracks with injected semantic evidence', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-matrix-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { brief, contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const single = singleSlidePlan(deckPlan, contentIR, brief);
  const exemplar = await familyExemplarFixture(root, 'matrix-family-template.pptx');
  const templates = [{ ...exemplar, pptxPath: exemplar.templatePath }];
  const outputRoot = path.join(root, 'matrix');
  const result = await runOfflinePresentationMatrix({
    deckPlan: single.deckPlan, contentIR, templates, outputRoot, backend: 'office-kit', previewAdapter: new OfficeKitPreviewAdapter(),
    profileTemplate: async (template) => semanticProfileFor(template.templateIR),
  });
  assert.equal(result.inferenceRequests, 1, 'the injected fixture profiler is counted; no external inference endpoint is used');
  assert.equal(result.templateCount, 1);
  assert.equal(result.variantCount, 3);
  assert.equal(result.outputCount, 3);
  assert.ok(result.timingsMs.preview > 0, 'preview duration is measured separately');
  const signatures = [];
  const qualification = result.templateQualifications[0];
  assert.ok(qualification);
  assert.equal(qualification.deckReviewStatus, 'warning', 'the one-slide matrix slice has no explicit cover role, so it is not a complete deck-level pass');
  assert.ok(qualification.deckReviewPath);
  const deckReview = JSON.parse(await readFile(qualification.deckReviewPath, 'utf8'));
  assert.equal(deckReview.trackFacts, 'passed');
  assert.equal(deckReview.provenance, 'passed');
  assert.equal(deckReview.status, 'warning');
  assert.ok(deckReview.findings.some((finding) => finding.ruleId === 'deck.cover-role-missing'));
  for (const output of result.outputs) {
    await stat(output.pptxPath);
    assert.equal(output.renderStatus, 'passed');
    assert.equal(output.reopenStatus, 'passed');
    assert.equal(output.factualEquivalenceStatus, 'passed');
    assert.equal(output.templatePreservationStatus, 'passed');
    assert.equal(output.validationStatus, 'passed');
    assert.equal(output.previewStatus, 'passed');
    const report = JSON.parse(await readFile(output.auditPath, 'utf8'));
    assert.equal(report.planHash, single.deckPlan.hash);
    assert.equal(report.compiledPresentationId, output.compiledPresentationId);
    assert.equal(report.render.backend, 'office-kit');
    assert.equal(report.render.reopenStatus, 'passed');
    assert.deepEqual(output.visualIntents, report.render.visualIntents,
      'matrix outputs and full audit records expose the same realized/downgraded visual intent');
    const projected = report.render.projectedCompositions[0];
    const qualifiedVariant = qualification.slides[0].variants.find((variant) => variant.variantId === output.variantId);
    assert.equal(projected.projectedCompositionSignature, qualifiedVariant?.projectedCompositionSignature,
      'the render must use the exact composition signature that passed qualification');
    signatures.push(projected.projectedCompositionSignature);
    assert.equal(output.findingCount, report.render.auditFindingCount);
    assert.ok(Object.hasOwn(report, 'preview'));
  }
  assert.equal(new Set(signatures).size, 3, 'matrix artifacts only include distinct projected A/B/C compositions');
  assert.equal(JSON.parse(await readFile(path.join(outputRoot, 'matrix.json'), 'utf8')).outputs.length, 3);
});

test('deck-level composition assignment reuses only safe options and distinguishes complete tracks', () => {
  const option = (variantId, signature, rank = 0) => ({
    variantId,
    compositionKind: 'exemplar-backed',
    layoutCandidateIndex: rank,
    projectedCompositionSignature: signature,
    compositionFamilyKey: `family:${signature}`,
  });
  const slides = [
    { A: [option('A', 'slide-1-shared')], B: [option('B', 'slide-1-shared')], C: [option('C', 'slide-1-shared')] },
    { A: [option('A', 'slide-2-balanced')], B: [option('B', 'slide-2-visual')], C: [option('C', 'slide-2-dense')] },
    { A: [option('A', 'slide-3-shared')], B: [option('B', 'slide-3-shared')], C: [option('C', 'slide-3-shared')] },
  ];
  const assigned = assignDeckVariantCompositions(slides);
  assert.ok(assigned, 'one-slide local reuse is allowed when the ordered decks remain distinct');
  assert.deepEqual(Object.fromEntries(['A', 'B', 'C'].map((variant) => [variant, assigned[variant].map((item) => item.projectedCompositionSignature)])), {
    A: ['slide-1-shared', 'slide-2-balanced', 'slide-3-shared'],
    B: ['slide-1-shared', 'slide-2-visual', 'slide-3-shared'],
    C: ['slide-1-shared', 'slide-2-dense', 'slide-3-shared'],
  });
  for (const variant of ['A', 'B', 'C']) for (const item of assigned[variant]) {
    assert.ok(slides.some((slide) => slide[variant].includes(item)), 'assignment must select an existing exact safe option');
  }
});

test('deck-level composition assignment can choose among two safe slide compositions without fabricating a third', () => {
  const option = (variantId, signature) => ({
    variantId, compositionKind: 'exemplar-backed', layoutCandidateIndex: 0,
    projectedCompositionSignature: signature, compositionFamilyKey: `family:${signature}`,
  });
  const firstSlide = {
    A: [option('A', 's1-x'), option('A', 's1-y')],
    B: [option('B', 's1-x'), option('B', 's1-y')],
    C: [option('C', 's1-x'), option('C', 's1-y')],
  };
  const secondSlide = {
    A: [option('A', 's2-a')], B: [option('B', 's2-b')], C: [option('C', 's2-c')],
  };
  const assigned = assignDeckVariantCompositions([firstSlide, secondSlide]);
  assert.ok(assigned);
  assert.deepEqual(new Set(['A', 'B', 'C'].map((variant) => assigned[variant].map((item) => item.projectedCompositionSignature).join('|'))).size, 3);
  for (const variant of ['A', 'B', 'C']) assert.ok(firstSlide[variant].includes(assigned[variant][0]));
});

test('deck-level composition assignment maximizes track differences before rank cost', () => {
  const option = (variantId, signature, rank) => ({
    variantId, compositionKind: 'exemplar-backed', layoutCandidateIndex: rank,
    projectedCompositionSignature: signature, compositionFamilyKey: `family:${signature}`,
  });
  const slides = Array.from({ length: 4 }, (_, slideIndex) => Object.fromEntries(['A', 'B', 'C'].map((variant) => [
    variant,
    ['one', 'two', 'three'].map((suffix, rank) => option(variant, `slide-${slideIndex}-${suffix}`, rank)),
  ])));
  const assigned = assignDeckVariantCompositions(slides);
  assert.ok(assigned);
  const signatures = Object.fromEntries(['A', 'B', 'C'].map((variant) => [
    variant, assigned[variant].map((item) => item.projectedCompositionSignature),
  ]));
  const distance = (left, right) => left.reduce((count, signature, index) => count + Number(signature !== right[index]), 0);
  assert.equal(distance(signatures.A, signatures.B), 4);
  assert.equal(distance(signatures.A, signatures.C), 4);
  assert.equal(distance(signatures.B, signatures.C), 4);
  for (const variant of ['A', 'B', 'C']) for (const item of assigned[variant]) {
    assert.ok(slides.some((slide) => slide[variant].includes(item)), 'every assigned option remains an exact qualified choice');
  }
});

test('deck-level composition assignment fails closed when no safe choice or no distinct sequence exists', () => {
  const option = (variantId, signature) => ({
    variantId, compositionKind: 'exemplar-backed', layoutCandidateIndex: 0,
    projectedCompositionSignature: signature,
  });
  assert.equal(assignDeckVariantCompositions([{
    A: [], B: [option('B', 'b')], C: [option('C', 'c')],
  }]), null, 'zero safe compositions remain fail-closed');
  assert.equal(assignDeckVariantCompositions([
    { A: [option('A', 'same')], B: [option('B', 'same')], C: [option('C', 'same')] },
    { A: [option('A', 'same-2')], B: [option('B', 'same-2')], C: [option('C', 'same-2')] },
  ]), null, 'identical complete safe sequences remain blocked');
});

test('offline matrix uses generic native compositions when donor families collapse to one', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-matrix-withheld-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { brief, contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const single = singleSlidePlan(deckPlan, contentIR, brief);
  const exemplar = await exemplarFixture(root, 'duplicate-projection-matrix-template.pptx', { create: createDuplicateProjectionExemplarTemplate });
  const outputRoot = path.join(root, 'matrix');
  const matrix = await runOfflinePresentationMatrix({
    deckPlan: single.deckPlan,
    contentIR,
    templates: [{ ...exemplar, pptxPath: exemplar.templatePath }],
    outputRoot,
    backend: 'office-kit',
  });
  const qualification = matrix.templateQualifications[0];
  assert.equal(qualification?.status, 'passed');
  assert.equal(qualification?.deckCompositionDistinctness?.distinct, true);
  assert.ok(qualification?.slides[0]?.variants.some((variant) => variant.compositionKind === 'template-derived-fallback'));
  assert.equal(matrix.outputCount, 3, 'the last-resort layer produces all three native editable tracks');
  assert.ok((await stat(path.join(outputRoot, 'template-1'))).isDirectory());
});

test('local qualification continues across blocked templates and records selector candidate evidence without rendering them', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-matrix-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { brief, contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const single = singleSlidePlan(deckPlan, contentIR, brief);
  const exemplar = await exemplarFixture(root, 'duplicate-projection-diagnostics-template.pptx', { create: createDuplicateProjectionExemplarTemplate });
  const outputRoot = path.join(root, 'matrix');
  let profileAttempts = 0;
  const result = await runOfflinePresentationMatrix({
    deckPlan: single.deckPlan,
    contentIR,
    templates: [
      { ...exemplar, pptxPath: exemplar.templatePath },
      { ...exemplar, pptxPath: exemplar.templatePath },
    ],
    outputRoot,
    backend: 'office-kit',
    continueOnBlocked: true,
    profileTemplate: async () => {
      profileAttempts += 1;
      throw new Error('synthetic invalid profile');
    },
  });
  assert.equal(profileAttempts, 2, 'one profile attempt is made per template hash when the profile is invalid');
  assert.equal(result.templateQualifications.length, 2);
  assert.ok(result.templateQualifications.every((item) => item.status === 'blocked'));
  assert.ok(result.templateQualifications.every((item) => item.semanticProfileStatus === 'failed'));
  assert.ok(result.templateQualifications.every((item) => item.profileFailure === 'synthetic invalid profile'));
  assert.ok(result.templateQualifications.every((item) => item.slides[0].variants.every((variant) => Array.isArray(variant.candidateDiagnostics))));
  assert.equal(result.outputCount, 0, 'blocked templates do not produce partial A/B/C artifacts');
  await assert.rejects(stat(path.join(outputRoot, 'template-1')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(outputRoot, 'template-2')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(path.join(outputRoot, 'matrix.json'), 'utf8')).templateQualifications.length, 2);
});

test('matrix keeps preview-failed artifacts diagnostic-only and reports the blocking preview stage', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-matrix-preview-blocked-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { brief, contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const single = singleSlidePlan(deckPlan, contentIR, brief);
  const exemplar = await familyExemplarFixture(root, 'preview-blocked-template.pptx');
  const outputRoot = path.join(root, 'matrix');
  const result = await runOfflinePresentationMatrix({
    deckPlan: single.deckPlan,
    contentIR,
    templates: [{ ...exemplar, pptxPath: exemplar.templatePath }],
    outputRoot,
    backend: 'office-kit',
    continueOnBlocked: true,
    profileTemplate: async (template) => semanticProfileFor(template.templateIR),
    previewAdapter: {
      async preview() {
        return { slideCount: 1, svg: '<svg/>', png: new Uint8Array([1]), textLayoutIssues: [{ severity: 'error', approximate: false, classification: 'PREVIEW_TEXT_OVERFLOW', code: 'synthetic-overflow' }], status: 'warning', limitations: [] };
      },
    },
  });
  const qualification = result.templateQualifications[0];
  assert.equal(qualification.status, 'blocked');
  assert.equal(qualification.renderStatus, 'passed');
  assert.equal(qualification.previewStatus, 'failed');
  assert.ok(qualification.previewIssueCounts.every((item) => item.issueCount === 1));
  assert.deepEqual(qualification.previewIssueCounts[0]?.issues, [{ severity: 'error', approximate: false, classification: 'PREVIEW_TEXT_OVERFLOW', code: 'synthetic-overflow' }]);
  assert.ok(qualification.diagnosticArtifactPath);
  assert.equal(result.outputCount, 0, 'preview-failed A/B/C files are not listed as qualified outputs');
  await stat(qualification.diagnosticArtifactPath);
  await assert.rejects(stat(path.join(outputRoot, 'template-1')), { code: 'ENOENT' });
});

test('compatibility harness preserves source bytes, compares package parts, reopens mutation and writes previews', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-compat-harness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = (await createHardTemplateCorpus(path.join(root, 'source-templates')))[4];
  const originalHash = createHash('sha256').update(await readFile(source.path)).digest('hex');
  const unsafeOutput = path.join(path.dirname(source.path), 'reports-inside-source');
  await assert.rejects(runPptxCompatibilityHarness(source.path, unsafeOutput), /separate output directory/);
  await assert.rejects(stat(unsafeOutput), { code: 'ENOENT' }, 'an unsafe output path is rejected before it creates a directory');
  const { report, reportPath } = await runPptxCompatibilityHarness(source.path, path.join(root, 'reports'));
  assert.equal(report.source.immutable, 'PASS');
  assert.equal(report.capabilities.noOpRoundTrip.status, 'PASS');
  assert.equal(report.outputs.noOp.preservation.status, 'PASS');
  assert.equal(report.capabilities.generatedSlideProjection.status, 'PASS');
  assert.equal(report.capabilities.templatePartPreservation.status, 'PASS');
  const generatedProbePath = path.join(root, 'reports', report.outputs.generatedMutation.path);
  const generatedPreview = await new OfficeKitPreviewAdapter().preview(await readFile(generatedProbePath), 0);
  assert.equal(report.outputs.generatedMutation.preview.status, 'failed', JSON.stringify({ report: report.outputs.generatedMutation, issues: generatedPreview.textLayoutIssues }));
  assert.equal(report.safeForOfficeKitBackend, 'no', 'external Office open/save and held-out real PPTX remain required');
  assert.equal(createHash('sha256').update(await readFile(source.path)).digest('hex'), originalHash);
  await stat(reportPath);
  const mutation = await inspectPptx(path.join(root, 'reports', report.outputs.generatedMutation.path));
  assert.equal(mutation.inspection.slides.length, 1);
  assert.ok(!mutation.inspection.slides.some((slide) => slide.elements.some((element) => element.text.includes('Source sample content'))));
});

test('Office Kit preview uses Node font metrics to block exact text overflow and keeps exact out-of-canvas geometry as errors', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-preview-confidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const measuredDeck = new PptxGenJS();
  measuredDeck.layout = 'LAYOUT_WIDE';
  const measuredSlide = measuredDeck.addSlide();
  measuredSlide.addText('A long synthetic line intended to expose measured glyph-metric overflow in this narrow text frame.', {
    x: 0.6, y: 0.5, w: 1.05, h: 0.22, fontFace: 'Aptos', fontSize: 20, margin: 0,
  });
  const cleanSlide = measuredDeck.addSlide();
  cleanSlide.addText('Short text with ample room.', { x: 0.6, y: 0.5, w: 5, h: 0.5, fontFace: 'Aptos', fontSize: 16, margin: 0 });
  const measuredPath = path.join(root, 'measured-text.pptx');
  await measuredDeck.writeFile({ fileName: measuredPath });
  const measured = await new OfficeKitPreviewAdapter().preview(await readFile(measuredPath), 0);
  assert.ok(measured.textLayoutIssues.length > 0, 'the probe creates a font-metric text-layout issue');
  assert.ok(measured.textLayoutIssues.some((issue) => issue.classification === 'PREVIEW_TEXT_OVERFLOW'
    && issue.severity === 'error' && issue.approximate === false), JSON.stringify(measured.textLayoutIssues));
  assert.ok(measured.textLayoutIssues.every((issue) => issue.slideIndex === 0), 'per-slide preview excludes diagnostics belonging to other slides');
  const clean = await new OfficeKitPreviewAdapter().preview(await readFile(measuredPath), 1);
  assert.equal(clean.textLayoutIssues.length, 0, 'another slide’s overflow cannot make this slide preview appear unsafe');
  assert.equal(measured.status, 'failed', 'an exact output-box overflow blocks qualification');

  const geometryDeck = new PptxGenJS();
  geometryDeck.layout = 'LAYOUT_WIDE';
  const geometrySlide = geometryDeck.addSlide();
  geometrySlide.addShape('rect', {
    x: 15, y: 1, w: 1, h: 0.5, line: { color: '183B56' }, fill: { color: '183B56' },
  });
  const geometryPath = path.join(root, 'generated-out-of-canvas.pptx');
  await geometryDeck.writeFile({ fileName: geometryPath });
  const geometry = await new OfficeKitPreviewAdapter().preview(await readFile(geometryPath), 0);
  assert.equal(geometry.status, 'failed');
  assert.ok(geometry.geometryIssues.some((issue) => issue.classification === 'GENERATED_OBJECT_OUT_OF_BOUNDS'
    && issue.severity === 'error' && issue.confidence === 'high'));
});

test('persisted planning state replays offline and the manifest omits endpoint URLs and credentials', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-replay-matrix-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { brief, contentIR, deckPlan } = await scenario(root, 1, Array(5).fill('none'));
  const single = singleSlidePlan(deckPlan, contentIR, brief);
  const exemplar = await familyExemplarFixture(root, 'replay-family-template.pptx');
  const timestamp = '2026-09-25T00:00:00.000Z';
  const successful = {
    contentFiles: ['evidence.md', 'metrics.csv', 'kpi.csv', 'process.md', 'source-image.png'],
    brief: single.brief,
    contentIR,
    inputFingerprint: single.deckPlan.inputFingerprint,
    checkpoint: single.deckPlan,
    deckPlan: single.deckPlan,
    review: { checkpointVersion: single.deckPlan.version, outcome: 'pass', findings: [], operations: [] },
    telemetry: {
      worker: { model: 'Qwen/Qwen3.8-27B', requestId: 'worker-1', providerRequestId: null, startedAt: timestamp, finishedAt: timestamp, wallTimeMs: 18000, promptTokens: 1000, completionTokens: 400, finishReason: 'stop' },
      supervisor: { model: 'Qwen/Qwen3.8-27B', requestId: 'supervisor-1', providerRequestId: null, startedAt: timestamp, finishedAt: timestamp, wallTimeMs: 4000, promptTokens: 800, completionTokens: 100, finishReason: 'stop' },
      totalWallTimeMs: 23000,
    },
    promptVersions: { worker: 'worker-deck-plan.v2', supervisor: 'supervisor-plan-review.v1' },
    model: 'Qwen/Qwen3.8-27B',
    createdAt: timestamp,
  };
  const state = {
    schemaVersion: 1,
    status: 'ready',
    currentCheckpoint: single.deckPlan,
    inputs: { contentFiles: successful.contentFiles, brief: single.brief, contentIR, inputFingerprint: single.deckPlan.inputFingerprint },
    failure: null,
    lastSuccessful: successful,
  };
  const statePath = path.join(root, 'saved-state.json');
  const metadataPath = path.join(root, 'run-metadata.json');
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(metadataPath, JSON.stringify({ providerKind: 'runpod', profile: 'A100_BF16', thinkingEnabled: false, baseUrl: 'https://private.example', apiKey: 'never-copy-this' }));
  const outputRoot = path.join(root, 'matrix-from-state');
  const result = await runOfflineMatrixFromState({
    state: statePath,
    out: outputRoot,
    templates: [exemplar.templatePath],
    runmetadata: metadataPath,
    contentroot: path.join(root, 'projects', 'offline-fixture'),
    backend: 'office-kit',
    localSemantic: true,
  });
  assert.equal(result.matrix.outputCount, 3);
  assert.equal(result.manifest.requestSchema.worker, 'deck_plan_draft_v4');
  assert.equal(result.manifest.worker.temperature, 0.2);
  assert.equal(result.manifest.worker.maxOutputTokens, 4096);
  assert.equal(result.manifest.worker.finishReason, 'stop');
  assert.equal(result.manifest.supervisor.thinkingEnabled, false);
  assert.equal(result.manifest.supervisor.finishReason, 'stop');
  assert.equal(result.manifest.output.inferenceRequests, 1, 'only the local fake semantic profiler runs; no Worker/Supervisor/generation request is made');
  assert.ok(result.matrix.timingsMs.preview > 0);
  const diagnostics = JSON.parse(await readFile(path.join(outputRoot, 'diagnostics.json'), 'utf8'));
  assert.equal(diagnostics.stageMs.contentParsing, null);
  assert.equal(diagnostics.stageMs.worker, 18000);
  assert.equal(diagnostics.stageMs.supervisor, 4000);
  assert.ok(diagnostics.stageMs.preview > 0);
  assert.equal(diagnostics.stageMs.repair, null);
  assert.equal(diagnostics.stageMs.export, result.matrix.timingsMs.render);
  assert.equal(diagnostics.stageMs.productEndToEndTotal, null);
  assert.equal(diagnostics.stageMs.semanticProfile, result.matrix.timingsMs.semanticProfile);
  assert.match(diagnostics.stageStatus.preview, /measured/i);
  assert.match(diagnostics.stageStatus.export, /part of render/i);
  const serialized = await readFile(path.join(outputRoot, 'replay.json'), 'utf8');
  assert.ok(!serialized.includes('private.example'));
  assert.ok(!serialized.includes('never-copy-this'));
  assert.ok(serialized.includes('deck_plan_draft_v4'));
});

test('contextual deck audit validates all eleven text-only checks and rejects invalid slide/evidence references', () => {
  const context = {
    slideContentRefs: new Map([['slide-fake-1', new Set(['unit_fixture'])]]),
    knownEvidenceRefs: new Set(['unit_fixture']),
  };
  const response = {
    schemaVersion: CONTEXTUAL_AUDIT_SCHEMA_VERSION,
    findings: CONTEXTUAL_AUDIT_RULES.map((ruleId) => ({
      ruleId,
      slideId: 'slide-fake-1',
      severity: 'info',
      messageCode: CONTEXTUAL_AUDIT_MESSAGE_CODES[ruleId][0],
      evidenceRefs: ['unit_fixture'],
      repairable: false,
      suggestedActionCode: null,
    })),
  };
  const reviewed = validateContextualDeckAuditResponse(response, context);
  assert.equal(reviewed.findings.length, 11);
  const incomplete = structuredClone(response);
  incomplete.findings.pop();
  assert.throws(() => validateContextualDeckAuditResponse(incomplete, context), /invalid shape/);
  const unknownSlide = structuredClone(response);
  unknownSlide.findings[0].slideId = 'slide-not-in-deck';
  assert.throws(() => validateContextualDeckAuditResponse(unknownSlide, context), /unknown slide/);
  const unrelatedEvidence = structuredClone(response);
  unrelatedEvidence.findings[0].evidenceRefs = ['unit_not_in_content'];
  assert.throws(() => validateContextualDeckAuditResponse(unrelatedEvidence, context), /unknown or duplicate evidence/);
});
