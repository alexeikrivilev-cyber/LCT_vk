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
import { compilePresentation, VARIANT_POLICIES } from '../src/presentation/application/slide-compilation.ts';
import { briefHash } from '../src/presentation/domain/brief.ts';
import { canonicalizeDeckPlan } from '../src/presentation/domain/deck-plan.ts';
import { makeSyntheticPptx } from '../python-inspector-test-fixtures.mjs';
import { createOfflineReplayManifest, runOfflineMatrixFromState } from '../../../scripts/run-offline-presentation-matrix.mjs';

register();

const inch = (value) => Math.round(value * 914400);
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
];

async function fixture(root, options = {}) {
  const name = options.fileName ?? 'template.pptx';
  const templatePath = path.join(root, name);
  const bytes = await makeSyntheticPptx({ strict: options.strict ?? false, slideCount: 1, layoutCount: 3, layoutProfiles: options.layoutProfiles ?? layoutProfiles(options.namePrefix ?? 'Unknown') });
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
  await writeFile(path.join(projectDir, 'metrics.csv'), 'Metric,2024,2025\nRevenue,$100 million,$120 million\nRetention,72%,90%\n');
  await writeFile(path.join(projectDir, 'source-image.png'), Buffer.from('synthetic image reference bytes'));
  const contentIR = await compileContentIR(projectsRoot, 'offline-fixture', ['evidence.md', 'metrics.csv', 'source-image.png']);
  const textUnits = contentIR.units.filter((unit) => unit.text);
  const tableUnits = contentIR.units.filter((unit) => unit.kind === 'table-cell');
  assert.ok(contentIR.units.some((unit) => unit.kind === 'media-reference'));
  assert.equal(textUnits.length, 5);
  const draft = {
    workingTitle: 'Offline compiler fixture',
    narrativeSummary: 'A synthetic plan used to exercise native slide compilation.',
    slides: textUnits.map((unit, index) => ({
      narrativeRole: index === 0 ? 'opening' : index === 4 ? 'closing' : 'content',
      purpose: `Synthetic purpose ${index + 1}`,
      takeaway: index === 1 ? 'Revenue and customer retention both improved in the sample.' : unit.text.replace(/^#\s*/, ''),
      contentRefs: index === 1 ? tableUnits.map((cell) => cell.id) : [unit.id],
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
    allowedContentIds: new Set(contentIR.units.map((unit) => unit.id)),
    requestedSlideCount: 5,
  });
  const templates = [];
  for (let index = 0; index < templateCount; index += 1) {
    const created = await fixture(root, { fileName: `unknown-${index + 1}.pptx`, namePrefix: `Mutated organizer family ${index + 1}` });
    templates.push({ ...created, pptxPath: created.templatePath });
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
    ['Revenue', '$100 million', '$120 million'],
    ['Retention', '72%', '90%'],
  ]);
  assert.equal(auditCompiledPresentation(variants[0], contentIR, template).checks.find((item) => item.ruleId === 'density.table').status, 'checked');
  assert.deepEqual(variants[0].slides[1].body, [], 'table cells are rendered as one native table, not repeated as body copy');
  assert.ok(variants.every((variant) => variant.slides.every((slide) => slide.imageRefs.length === 0)), 'the current planning contract does not cite image units, so the compiler does not guess image placement');
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
  assert.ok(report.findings.some((finding) => finding.ruleId === 'fidelity.unsupported-number' && finding.evidence.numericToken === '$999'));
  assert.ok(report.findings.some((finding) => finding.ruleId === 'integrity.broken-provenance'));
  assert.equal(report.checks.find((item) => item.ruleId === 'fidelity.semantic').status, 'unknown');
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
  assert.ok(reopened.inspection.slides.some((slide) => slide.elements.some((element) => element.text.includes('$120 million'))));
  assert.ok(reopened.inspection.slides.every((slide) => slide.layoutPart?.startsWith('ppt/slideLayouts/')));

  const strictTemplate = await fixture(root, { fileName: 'strict-template.pptx', strict: true });
  const strictCompiled = compilePresentation(deckPlan, contentIR, strictTemplate.templateIR, VARIANT_POLICIES[0]);
  const strictOutput = path.join(root, 'output', 'strict-variant-a.pptx');
  await renderNativePptx({ compiledPresentation: strictCompiled, contentIR, templateIR: strictTemplate.templateIR, templatePath: strictTemplate.templatePath, outputPath: strictOutput });
  assert.equal((await inspectPptx(strictOutput)).inspection.slides.length, 5, 'Strict OOXML remains parseable after adding generated slide relationships');
});

test('offline matrix produces nine PPTX and audit outputs from one plan with no inference port', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-matrix-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { contentIR, deckPlan, templates } = await scenario(root, 3);
  const outputRoot = path.join(root, 'matrix');
  const result = await runOfflinePresentationMatrix({ deckPlan, contentIR, templates, outputRoot });
  assert.equal(result.inferenceRequests, 0);
  assert.equal(result.templateCount, 3);
  assert.equal(result.variantCount, 3);
  assert.equal(result.outputCount, 9);
  for (const output of result.outputs) {
    await stat(output.pptxPath);
    const report = JSON.parse(await readFile(output.auditPath, 'utf8'));
    assert.equal(report.planHash, deckPlan.hash);
    assert.equal(report.compiledPresentationId, output.compiledPresentationId);
  }
  assert.equal(JSON.parse(await readFile(path.join(outputRoot, 'matrix.json'), 'utf8')).outputs.length, 9);
});

test('persisted planning state replays offline and the manifest omits endpoint URLs and credentials', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-replay-matrix-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { brief, contentIR, deckPlan, templates } = await scenario(root, 3);
  const timestamp = '2026-09-25T00:00:00.000Z';
  const successful = {
    contentFiles: ['evidence.md', 'metrics.csv', 'source-image.png'],
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
    promptVersions: { worker: 'worker-deck-plan.v1', supervisor: 'supervisor-plan-review.v1' },
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
  const result = await runOfflineMatrixFromState({ state: statePath, out: outputRoot, templates: templates.map((item) => item.templatePath), runmetadata: metadataPath });
  assert.equal(result.matrix.outputCount, 9);
  assert.equal(result.manifest.requestSchema.worker, 'deck_plan_draft_v1');
  assert.equal(result.manifest.worker.temperature, 0.2);
  assert.equal(result.manifest.worker.maxOutputTokens, 4096);
  assert.equal(result.manifest.worker.finishReason, 'stop');
  assert.equal(result.manifest.supervisor.thinkingEnabled, false);
  assert.equal(result.manifest.supervisor.finishReason, 'stop');
  assert.equal(result.manifest.output.inferenceRequests, 0);
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
