import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { register } from 'tsx/esm/api';

import { inspectPptx } from '../src/presentation/adapters/python-inspector.ts';
import { compileContentIR } from '../src/presentation/application/content-compiler.ts';
import { CONTEXTUAL_AUDIT_GATES, validateContextualSlideAuditResponse } from '../src/presentation/application/contextual-audit-port.ts';
import { auditCompiledPresentation, repairCompiledPresentationOnce } from '../src/presentation/application/deterministic-audit.ts';
import { createTemplateIR } from '../src/presentation/application/template-mapper.ts';
import { runOfflinePresentationMatrix } from '../src/presentation/application/offline-matrix-runner.ts';
import { renderNativePptx } from '../src/presentation/application/native-pptx-renderer.ts';
import { compilePresentation, extractCanonicalFactualPayload, VARIANT_POLICIES } from '../src/presentation/application/slide-compilation.ts';
import { OfficeKitPptxRenderer } from '../src/presentation/adapters/office-kit-pptx-renderer.ts';
import { OfficeKitPreviewAdapter } from '../src/presentation/adapters/office-kit-preview-adapter.ts';
import { briefHash } from '../src/presentation/domain/brief.ts';
import { canonicalizeDeckPlan } from '../src/presentation/domain/deck-plan.ts';
import { sha256Json, templateIRHashPayload } from '../src/presentation/domain/template-ir.ts';
import { makeSyntheticPptx } from '../python-inspector-test-fixtures.mjs';
import { createHardTemplateCorpus } from './hard-template-corpus.mjs';
import { createOfflineReplayManifest, runOfflineMatrixFromState } from '../../../scripts/run-offline-presentation-matrix.mjs';
import { runPptxCompatibilityHarness } from '../../../scripts/compare-pptx-backends.mjs';

register();

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
    visual: { x: inch(5.4), y: inch(1.4), width: inch(6.6), height: inch(4.4), type: 'chart' },
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
  longBullet.body = ['- one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'];
  assert.ok(findings(longBullet).some((finding) => finding.ruleId === 'density.long-bullet-copy' && finding.evidence.wordCount === 20));

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
  const { contentIR, deckPlan } = await scenario(root, 1);
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

test('offline matrix produces fifteen validated Office Kit outputs and previews from one plan with zero inference', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-matrix-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { contentIR, deckPlan, templates } = await scenario(root, 5);
  const outputRoot = path.join(root, 'matrix');
  const result = await runOfflinePresentationMatrix({ deckPlan, contentIR, templates, outputRoot, backend: 'office-kit', previewAdapter: new OfficeKitPreviewAdapter() });
  assert.equal(result.inferenceRequests, 0);
  assert.equal(result.templateCount, 5);
  assert.equal(result.variantCount, 3);
  assert.equal(result.outputCount, 15);
  assert.ok(result.timingsMs.preview > 0, 'preview duration is measured separately');
  for (const output of result.outputs) {
    await stat(output.pptxPath);
    assert.equal(output.renderStatus, 'passed');
    assert.equal(output.reopenStatus, 'passed');
    assert.equal(output.factualEquivalenceStatus, 'passed');
    assert.equal(output.templatePreservationStatus, 'passed');
    assert.equal(output.validationStatus, 'passed');
    assert.equal(output.previewStatus, 'passed');
    const report = JSON.parse(await readFile(output.auditPath, 'utf8'));
    assert.equal(report.planHash, deckPlan.hash);
    assert.equal(report.compiledPresentationId, output.compiledPresentationId);
    assert.equal(report.render.backend, 'office-kit');
    assert.equal(report.render.reopenStatus, 'passed');
    assert.equal(output.findingCount, report.render.auditFindingCount);
    assert.ok(Object.hasOwn(report, 'preview'));
  }
  assert.ok(result.outputs.some((output) => output.nativeObjectCounts.images > 0), 'source-backed images render as native images when the selected layout has a picture slot');
  assert.ok(result.outputs.some((output) => output.nativeObjectCounts.charts > 0), 'source-backed numeric data renders as native charts when a chart slot exists');
  assert.ok(result.outputs.some((output) => output.nativeObjectCounts.tables > 0), 'rectangular table cells render as native tables');
  assert.ok(result.outputs.some((output) => output.nativeObjectCounts.shapes >= 2 && output.nativeObjectCounts.connectors >= 1), 'KPI and process slides use native editable shapes/connectors');
  assert.equal(JSON.parse(await readFile(path.join(outputRoot, 'matrix.json'), 'utf8')).outputs.length, 15);
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
  assert.equal(report.outputs.generatedMutation.preview.status, 'passed');
  assert.equal(report.safeForOfficeKitBackend, 'no', 'external Office open/save and held-out real PPTX remain required');
  assert.equal(createHash('sha256').update(await readFile(source.path)).digest('hex'), originalHash);
  await stat(reportPath);
  const mutation = await inspectPptx(path.join(root, 'reports', report.outputs.generatedMutation.path));
  assert.equal(mutation.inspection.slides.length, 1);
  assert.ok(!mutation.inspection.slides.some((slide) => slide.elements.some((element) => element.text.includes('Source sample content'))));
});

test('persisted planning state replays offline and the manifest omits endpoint URLs and credentials', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-replay-matrix-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { brief, contentIR, deckPlan, templates } = await scenario(root, 5);
  const timestamp = '2026-09-25T00:00:00.000Z';
  const successful = {
    contentFiles: ['evidence.md', 'metrics.csv', 'kpi.csv', 'process.md', 'source-image.png'],
    brief,
    contentIR,
    inputFingerprint: deckPlan.inputFingerprint,
    checkpoint: deckPlan,
    deckPlan,
    review: { checkpointVersion: deckPlan.version, outcome: 'pass', findings: [], operations: [] },
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
    currentCheckpoint: deckPlan,
    inputs: { contentFiles: successful.contentFiles, brief, contentIR, inputFingerprint: deckPlan.inputFingerprint },
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
    templates: templates.map((item) => item.templatePath),
    runmetadata: metadataPath,
    contentroot: path.join(root, 'projects', 'offline-fixture'),
  });
  assert.equal(result.matrix.outputCount, 15);
  assert.equal(result.manifest.requestSchema.worker, 'deck_plan_draft_v1');
  assert.equal(result.manifest.worker.temperature, 0.2);
  assert.equal(result.manifest.worker.maxOutputTokens, 4096);
  assert.equal(result.manifest.worker.finishReason, 'stop');
  assert.equal(result.manifest.supervisor.thinkingEnabled, false);
  assert.equal(result.manifest.supervisor.finishReason, 'stop');
  assert.equal(result.manifest.output.inferenceRequests, 0);
  assert.equal(result.matrix.timingsMs.preview, null);
  const diagnostics = JSON.parse(await readFile(path.join(outputRoot, 'diagnostics.json'), 'utf8'));
  assert.equal(diagnostics.stageMs.contentParsing, null);
  assert.equal(diagnostics.stageMs.worker, 18000);
  assert.equal(diagnostics.stageMs.supervisor, 4000);
  assert.equal(diagnostics.stageMs.preview, null);
  assert.equal(diagnostics.stageMs.repair, null);
  assert.equal(diagnostics.stageMs.export, null);
  assert.equal(diagnostics.stageMs.productEndToEndTotal, null);
  assert.match(diagnostics.stageStatus.preview, /not run/i);
  assert.match(diagnostics.stageStatus.export, /not run/i);
  const serialized = await readFile(path.join(outputRoot, 'replay.json'), 'utf8');
  assert.ok(!serialized.includes('private.example'));
  assert.ok(!serialized.includes('never-copy-this'));
  assert.ok(serialized.includes('deck_plan_draft_v1'));
});

test('contextual audit port validates all eight gates through a local fake Supervisor capability', async () => {
  const response = {
    schemaVersion: 1,
    slideId: 'slide-fake-1',
    findings: CONTEXTUAL_AUDIT_GATES.map((gate) => ({ gate, result: 'unknown', rationale: 'Synthetic fake response; no model call was made.', evidenceRefs: [] })),
  };
  let calls = 0;
  const fakeSupervisorCapability = {
    async review(request) {
      calls += 1;
      assert.equal(request.slideId, 'slide-fake-1');
      return validateContextualSlideAuditResponse(response, request.slideId);
    },
  };
  const reviewed = await fakeSupervisorCapability.review({
    slideId: 'slide-fake-1',
    renderedSlide: { mediaType: 'image/png', base64: 'c3ludGhldGlj' },
    title: 'Synthetic title',
    body: ['Synthetic evidence line'],
    provenanceEvidence: [{ contentRef: 'unit_fixture', text: 'Synthetic source evidence' }],
    previousSlideSummary: null,
    nextSlideSummary: null,
  });
  assert.equal(calls, 1);
  assert.equal(reviewed.findings.length, 8);
  const incomplete = structuredClone(response);
  incomplete.findings.pop();
  assert.throws(() => validateContextualSlideAuditResponse(incomplete, 'slide-fake-1'), /invalid shape/);
});
