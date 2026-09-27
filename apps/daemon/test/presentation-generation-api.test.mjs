import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { register } from 'tsx/esm/api';
import Database from 'better-sqlite3';

register();
const require = createRequire(import.meta.url);
const PptxGenJS = require('pptxgenjs');
const JSZip = require('jszip');
const { startServer } = await import('../src/server.ts');
const { PDFDocument } = await import('pdf-lib');
const { compileContentIR } = await import('../src/presentation/application/content-compiler.ts');
const { planningInputFingerprint, validatePlanReview } = await import('../src/presentation/application/planning-service.ts');
const { canonicalizeDeckPlan } = await import('../src/presentation/domain/deck-plan.ts');
const { briefHash } = await import('../src/presentation/domain/brief.ts');
const { OfficeKitPptxRenderer } = await import('../src/presentation/adapters/office-kit-pptx-renderer.ts');
const { inspectOfficeKitPackage } = await import('../src/presentation/adapters/office-kit-package-inspector.ts');
const { PresentationGenerationService } = await import('../src/presentation/application/generation-service.ts');
const { createPresentationProject, openPresentationStore } = await import('../src/presentation-store.ts');
const { getPresentationGeneration, startPresentationGeneration } = await import('../src/presentation-generation-store.ts');
const { startFakeSemanticEndpoint } = await import('../../../scripts/lib/fake-openai-compatible-endpoint.mjs');

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const variants = ['A', 'B', 'C'];

async function makeValidSyntheticPptx(directory) {
  await mkdir(directory, { recursive: true });
  const deck = new PptxGenJS();
  deck.layout = 'LAYOUT_WIDE';
  deck.author = 'LCT offline generation integration test';
  const title = { x: 0.55, y: 0.3, w: 12.1, h: 0.7, fontFace: 'Aptos Display', fontSize: 25, bold: true };
  const master = (name, bodyBox, visualBox) => deck.defineSlideMaster({
    title: name,
    background: { color: 'FFFFFF' },
    objects: [
      { placeholder: { options: { name: `${name}_TITLE`, type: 'title', ...title } } },
      { placeholder: { options: { name: `${name}_BODY`, type: 'body', ...bodyBox, fontFace: 'Aptos', fontSize: 17 } } },
      { placeholder: { options: { name: `${name}_VISUAL`, type: 'chart', ...visualBox } } },
    ],
  });
  const textHeavy = 'LCT_TEXT_HEAVY';
  master(textHeavy,
    { x: 0.65, y: 1.3, w: 6.15, h: 3.3 },
    { x: 7.25, y: 1.3, w: 4.0, h: 2.75 });
  master('LCT_VISUAL_HEAVY',
    { x: 0.65, y: 1.3, w: 4.3, h: 2.95 },
    { x: 0.65, y: 1.3, w: 6.25, h: 4.15 });
  master('LCT_BALANCED',
    { x: 0.65, y: 1.3, w: 5.35, h: 3.0 },
    { x: 6.4, y: 1.3, w: 5.65, h: 3.65 });
  const slide = deck.addSlide({ masterName: textHeavy });
  slide.addText('Source sample title', { placeholder: `${textHeavy}_TITLE` });
  slide.addText('Source sample body', { placeholder: `${textHeavy}_BODY` });
  const filePath = path.join(directory, 'synthetic-template.pptx');
  await deck.writeFile({ fileName: filePath });
  return readFile(filePath);
}

async function closeStartedServer(started) {
  started.server.closeAllConnections?.();
  await new Promise((resolve, reject) => started.server.close((error) => error ? reject(error) : resolve()));
  await started.shutdown();
}

async function removeTempDirectory(directory) {
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
}

async function json(response) { return response.json(); }

async function waitFor(operation, predicate, label, timeoutMs = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await operation();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function createProject(server, projectId) {
  const response = await fetch(`${server.url}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: projectId, name: 'Generation test' }),
  });
  assert.equal(response.status, 201);
}

async function upload(server, projectId, name, bytes) {
  const form = new FormData();
  form.append('files', new Blob([bytes]), name);
  const response = await fetch(`${server.url}/api/projects/${projectId}/upload`, { method: 'POST', body: form });
  assert.equal(response.status, 200, await response.clone().text());
}

async function seedReadyPlanningState(server, dataDir, projectId, sourceText = 'Evidence points to a retention constraint for sustained growth.', includeChartSource = false) {
  const pptx = await makeValidSyntheticPptx(path.join(dataDir, 'fixture'));
  await upload(server, projectId, 'template.pptx', pptx);
  const compiled = await fetch(`${server.url}/api/projects/${projectId}/template/compile`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filePath: 'template.pptx' }),
  });
  if (compiled.status === 503) {
    const body = await json(compiled);
    if (body.failure?.code === 'INSPECTOR_UNAVAILABLE') return false;
  }
  assert.equal(compiled.status, 200, await compiled.clone().text());
  const template = await json(compiled);
  const sourceFile = includeChartSource ? 'metrics.csv' : 'source.md';
  const sourceBytes = includeChartSource
    ? Buffer.from('Quarter,Retention\nQ1,10\nQ2,12\nQ3,13\n', 'utf8')
    : Buffer.from(sourceText, 'utf8');
  await upload(server, projectId, sourceFile, sourceBytes);

  const projectsRoot = path.join(dataDir, 'projects');
  const brief = {
    audience: 'Executive team',
    purpose: 'Choose a retention investment',
    expectedOutcome: 'Agree on one bounded pilot',
    preferences: ['Use supplied evidence'],
    requestedSlideCount: 3,
  };
  const contentIR = await compileContentIR(projectsRoot, projectId, [sourceFile], { task: brief.purpose });
  const [workerPrompt, supervisorPrompt] = await Promise.all([
    readFile(path.join(repoRoot, 'apps/daemon/prompts/worker-deck-plan.v2.md'), 'utf8'),
    readFile(path.join(repoRoot, 'apps/daemon/prompts/supervisor-plan-review.v1.md'), 'utf8'),
  ]);
  const fingerprint = planningInputFingerprint({
    templateIRHash: template.templateIR.hash,
    presentationDesignSystemHash: template.presentationDesignSystem.hash,
    contentIRHash: contentIR.hash,
    briefHash: briefHash(brief),
    workerPromptSha256: createHash('sha256').update(workerPrompt).digest('hex'),
    supervisorPromptSha256: createHash('sha256').update(supervisorPrompt).digest('hex'),
  });
  const contentIds = includeChartSource
    ? contentIR.units.filter((unit) => unit.kind === 'table-cell').map((unit) => unit.id)
    : [contentIR.units.find((unit) => unit.kind !== 'media-reference')?.id].filter((id) => id !== undefined);
  assert.ok(contentIds.length);
  const now = new Date().toISOString();
  const plan = canonicalizeDeckPlan({
    workingTitle: 'Retention is the growth constraint',
    narrativeSummary: 'Show the supplied retention evidence and one decision.',
    slides: [
      { narrativeRole: 'opening', purpose: 'Frame the decision.', takeaway: 'Growth requires a retention decision.', contentRefs: includeChartSource ? contentIds : [], semanticVisualType: 'chart', targetDensity: 'compact' },
      { narrativeRole: 'content', purpose: 'Show the evidence.', takeaway: 'The source identifies retention as a constraint.', contentRefs: contentIds, semanticVisualType: 'chart', targetDensity: 'balanced' },
      { narrativeRole: 'closing', purpose: 'State the next step.', takeaway: 'Run a bounded retention pilot.', contentRefs: contentIds, semanticVisualType: 'chart', targetDensity: 'compact' },
    ],
  }, {
    id: 'offline-ready-plan',
    version: 1,
    createdAt: now,
    inputFingerprint: fingerprint,
    briefHash: briefHash(brief),
    allowedContentIds: new Set(contentIR.units.filter((unit) => unit.kind !== 'media-reference').map((unit) => unit.id)),
    allowedMediaIds: new Set(contentIR.units.filter((unit) => unit.kind === 'media-reference').map((unit) => unit.id)),
    requestedSlideCount: 3,
  });
  const review = validatePlanReview({ checkpointVersion: 1, outcome: 'pass', findings: [], operations: [] }, plan, contentIR);
  const telemetrySummary = {
    model: 'offline-replay', requestId: 'offline-worker', providerRequestId: null,
    startedAt: now, finishedAt: now, wallTimeMs: 0, promptTokens: null, completionTokens: null, finishReason: 'stop',
  };
  await mkdir(path.join(projectsRoot, projectId, '.planning'), { recursive: true });
  await writeFile(path.join(projectsRoot, projectId, '.planning', 'state.json'), JSON.stringify({
    schemaVersion: 1,
    updatedAt: now,
    status: 'ready',
    inputs: { contentFiles: [sourceFile], brief, contentIR, inputFingerprint: fingerprint },
    lastSuccessful: {
      contentFiles: [sourceFile], brief, contentIR, inputFingerprint: fingerprint,
      checkpoint: plan, deckPlan: plan, review,
      telemetry: { worker: telemetrySummary, supervisor: { ...telemetrySummary, requestId: 'offline-supervisor' }, totalWallTimeMs: 0 },
      promptVersions: { worker: 'worker-deck-plan.v2', supervisor: 'supervisor-plan-review.v1' },
      model: 'offline-replay', createdAt: now,
    },
    failure: null,
    currentCheckpoint: plan,
  }, null, 2));
  return { contentIR, plan };
}

function gateRenderer(targetSlideId = null) {
  const renderer = new OfficeKitPptxRenderer();
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let blocked = false;
  const errors = [];
  const renderSlideCounts = [];
  const renderAssignments = [];
  return {
    entered,
    errors,
    renderSlideCounts,
    renderAssignments,
    release: () => release(),
    renderer: {
      id: 'office-kit',
      async render(input) {
        renderSlideCounts.push(input.compiledPresentation.slides.length);
        if (!blocked && (targetSlideId === null || input.compiledPresentation.slides[0]?.sourceDeckPlanSlideId === targetSlideId)) {
          blocked = true;
          enter();
          await gate;
        }
        try {
          const result = await renderer.render(input);
          renderAssignments.push({
            slides: input.compiledPresentation.slides.map((slide) => ({
              planSlideId: slide.sourceDeckPlanSlideId,
              variantId: slide.variantId,
              layoutCandidateIndex: slide.selectedCandidateIndex,
              exemplar: slide.exemplarSelection ? {
                sourcePart: slide.exemplarSelection.sourcePart,
                sourceSlideIndex: slide.exemplarSelection.sourceSlideIndex,
                projectedCompositionSignature: slide.exemplarSelection.projectedCompositionSignature,
              } : null,
            })),
            projectedCompositions: result.projectedCompositions.map((item) => ({
              variantId: item.variantId,
              projectedCompositionSignature: item.projectedCompositionSignature,
            })),
          });
          return result;
        }
        catch (error) { errors.push(error); throw error; }
      },
    },
  };
}

async function getGeneration(server, projectId) {
  const response = await fetch(`${server.url}/api/projects/${projectId}/generation`, { cache: 'no-store' });
  assert.equal(response.status, 200);
  return (await json(response)).generation;
}

async function mutate(server, projectId, pathName, body, method = 'PUT') {
  return fetch(`${server.url}/api/projects/${projectId}/generation${pathName}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('generation API publishes ordered A/B/C packs, merges concurrent edits, repairs locally, exports, and reloads without inference', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-generation-api-'));
  t.after(() => removeTempDirectory(temp));
  const dataDir = path.join(temp, 'data');
  const projectId = 'progressive-generation';
  const inferenceCalls = [];
  const inferenceAdapter = { async infer(request) { inferenceCalls.push(request); throw new Error('generation must not call inference'); } };
  const secondSlideId = 'slide_offline-ready-plan_3';
  const gate = gateRenderer(secondSlideId);
  const options = {
    host: '127.0.0.1', port: 0, dataDir, projectRoot: repoRoot, serveWeb: false, returnServer: true,
    semanticInferenceAdapter: inferenceAdapter,
    presentationRenderer: gate.renderer,
  };
  const priorBackend = process.env.LCT_PPTX_BACKEND;
  process.env.LCT_PPTX_BACKEND = 'office-kit';
  let started = await startServer(options);
  try {
    await createProject(started, projectId);
    const seeded = await seedReadyPlanningState(started, dataDir, projectId, undefined, true);
    if (!seeded) { t.skip('Python 3.12 unavailable: synthetic PPTX template cannot be compiled'); return; }
    const planView = await json(await fetch(`${started.url}/api/projects/${projectId}/planning`));
    assert.equal(planView.status, 'ready');
    assert.equal(planView.deckPlan.hash, seeded.plan.hash);
    assert.equal(inferenceCalls.length, 0);

    const startResponse = await fetch(`${started.url}/api/projects/${projectId}/generation`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'offline-generation-v1' }, body: '{}',
    });
    assert.equal(startResponse.status, 202, await startResponse.clone().text());
    const initial = (await json(startResponse)).generation;
    assert.equal(initial.totalSlides, 3);
    assert.equal(initial.status, 'generating');
    assert.equal(initial.slides[0].status, 'pending');

    let lastReady = 0;
    const progress = [];
    const reachedGate = await Promise.race([
      gate.entered.then(() => true),
      waitFor(() => getGeneration(started, projectId), (state) => state.status === 'failed', 'early renderer failure', 12000).then(() => false),
    ]);
    if (!reachedGate) throw new Error(JSON.stringify({ failure: (await getGeneration(started, projectId)).failure, rendererError: String(gate.errors.at(-1)) }));
    let atSecondSlide = await waitFor(async () => {
      const state = await getGeneration(started, projectId);
      progress.push(state.readySlides);
      assert.ok(state.readySlides >= lastReady, 'persisted ready count must be monotonic');
      lastReady = state.readySlides;
      return state;
    }, (state) => state.readySlides === 2 && state.currentSlideId === secondSlideId, 'first two ordered packs');
    assert.deepEqual(atSecondSlide.slides.slice(0, 2).map((pack) => pack.status), ['ready', 'ready']);
    assert.deepEqual(atSecondSlide.slides.map((pack) => pack.index), [1, 2, 3]);
    for (const pack of atSecondSlide.slides.slice(0, 2)) assert.deepEqual(Object.keys(pack.variants), variants);

    const trackResponse = await mutate(started, projectId, '/selection', {
      scope: 'deck', variant: 'C', expectedVersion: atSecondSlide.selectionVersion,
    });
    assert.equal(trackResponse.status, 200, await trackResponse.clone().text());
    const withTrack = (await json(trackResponse)).generation;
    const first = withTrack.slides[0];
    const selectResponse = await mutate(started, projectId, '/selection', {
      scope: 'slide', slideId: first.slideId, variant: 'B', expectedVersion: first.version,
    });
    assert.equal(selectResponse.status, 200, await selectResponse.clone().text());
    const withSelection = (await json(selectResponse)).generation;
    const second = withSelection.slides[1];
    const lockResponse = await mutate(started, projectId, `/slides/${second.slideId}/lock`, {
      locked: true, variant: 'C', expectedVersion: second.version,
    });
    assert.equal(lockResponse.status, 200, await lockResponse.clone().text());
    const withLock = (await json(lockResponse)).generation;
    assert.equal(withLock.slides[0].selectedVariant, 'B');
    assert.equal(withLock.slides[1].lockedVariant, 'C');

    const retryResponse = await fetch(`${started.url}/api/projects/${projectId}/generation`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'offline-generation-v1' }, body: '{}',
    });
    assert.equal(retryResponse.status, 200);
    assert.equal((await json(retryResponse)).generation.generationId, initial.generationId);

    const repairFindingResponse = await fetch(`${started.url}/api/projects/${projectId}/generation/slides/${first.slideId}/audit?variant=B`);
    assert.equal(repairFindingResponse.status, 200);
    const auditBody = await json(repairFindingResponse);
    const safeFinding = auditBody.audit.findings.find((finding) => finding.autofixAvailable);
    assert.ok(safeFinding, 'fixture should expose an autofixable layout finding');
    const repairResponse = await mutate(started, projectId, '/repair', {
      slideId: first.slideId, variant: 'B', findingId: safeFinding.id,
      expectedVersion: withLock.slides[0].version,
    }, 'POST');
    assert.equal(repairResponse.status, 200, await repairResponse.clone().text());
    const repaired = (await json(repairResponse)).generation;
    assert.ok(repaired.slides[0].variants.B.version > withLock.slides[0].variants.B.version);
    assert.equal(repaired.slides[0].version, withLock.slides[0].version + 1);
    assert.equal(repaired.slides[1].lockedVariant, 'C');

    gate.release();
    const completed = await waitFor(() => getGeneration(started, projectId), (state) => ['completed', 'failed'].includes(state.status), 'generation terminal state', 90_000);
    assert.equal(completed.status, 'completed', JSON.stringify({ status: completed.status, failure: completed.failure }));
    assert.equal(completed.readySlides, 3);
    assert.equal(completed.slides[0].selectedVariant, 'B');
    assert.equal(completed.slides[1].lockedVariant, 'C');
    assert.deepEqual(progress, progress.slice().sort((a, b) => a - b));
    assert.equal(gate.renderSlideCounts.filter((count) => count === 3).length, 3,
      'each slide pack validates A/B/C through one renderer pass');
    assert.equal(gate.renderSlideCounts.filter((count) => count === 1).length, 1,
      'a local single-variant repair still uses a one-slide renderer pass');
    assert.equal(inferenceCalls.length, 0, 'variants, repair, and export must not call semantic inference');
    assert.ok(completed.slides.every((pack) => pack.status === 'ready' && variants.every((variant) => pack.variants[variant].previewUrl)));

    const previewResponse = await fetch(`${started.url}${completed.slides[0].variants.B.previewUrl}`);
    assert.equal(previewResponse.status, 200);
    assert.match(previewResponse.headers.get('content-type') ?? '', /image\/png/);
    assert.ok((await previewResponse.arrayBuffer()).byteLength > 100);

    const duplicateExports = await Promise.all(Array.from({ length: 2 }, () => fetch(`${started.url}/api/projects/${projectId}/generation/export`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'selected' }),
    })));
    for (const response of duplicateExports) assert.equal(response.status, 201, await response.clone().text());
    const [exportBody, duplicateExportBody] = await Promise.all(duplicateExports.map(json));
    assert.equal(duplicateExportBody.artifact.id, exportBody.artifact.id, 'concurrent duplicate exports share one persisted artifact');
    assert.equal(exportBody.artifact.validationStatus, 'passed');
    assert.equal(exportBody.artifact.nativeOfficeStatus, 'unknown');
    const downloaded = await fetch(`${started.url}${exportBody.artifact.downloadUrl}`);
    assert.equal(downloaded.status, 200);
    const outputBytes = Buffer.from(await downloaded.arrayBuffer());
    assert.ok(outputBytes.length > 100);
    const inspection = await inspectOfficeKitPackage(outputBytes);
    assert.equal(inspection.slideCount, 3);
    assert.equal(exportBody.artifact.format, 'pptx');

    for (const variant of variants) {
      const trackResponse = await fetch(`${started.url}/api/projects/${projectId}/generation/export`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: variant, format: 'pptx' }),
      });
      assert.equal(trackResponse.status, 201, await trackResponse.clone().text());
      const trackExport = await json(trackResponse);
      const trackDownload = await fetch(`${started.url}${trackExport.artifact.downloadUrl}`);
      assert.equal(trackDownload.status, 200);
      assert.equal((await inspectOfficeKitPackage(Buffer.from(await trackDownload.arrayBuffer()))).slideCount, 3);
    }

    const persistedStateDb = new Database(path.join(dataDir, 'app.sqlite'), { readonly: true });
    const compositionStateRow = persistedStateDb.prepare('SELECT state_json FROM presentation_generations WHERE project_id = ?').get(projectId);
    persistedStateDb.close();
    const persistedCompositionState = JSON.parse(compositionStateRow.state_json);
    for (const variant of variants) {
      const exportedTrack = gate.renderAssignments.findLast((call) => call.slides.length === 3
        && call.slides.every((slide) => slide.variantId === variant));
      assert.ok(exportedTrack, `${variant} export must render the persisted track assignment`);
      for (const [index, slide] of exportedTrack.slides.entries()) {
        const expected = persistedCompositionState.slides[index].variants[variant];
        assert.deepEqual(slide.exemplar, expected.compositionChoice.exemplar,
          `${variant} export must keep the exact qualified exemplar for slide ${index + 1}`);
        const projected = exportedTrack.projectedCompositions[index];
        assert.equal(projected?.variantId, variant);
        assert.equal(projected?.projectedCompositionSignature, expected.compositionChoice.signature,
          `${variant} export must reopen with the persisted composition signature for slide ${index + 1}`);
      }
    }
    const publicVariant = completed.slides[0].variants.A;
    assert.equal(Object.hasOwn(publicVariant, 'compositionChoice'), false, 'internal donor identity must stay outside the public API');

    for (const format of ['pdf', 'html']) {
      const alternateExport = await fetch(`${started.url}/api/projects/${projectId}/generation/export`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'selected', format }),
      });
      assert.equal(alternateExport.status, 201, await alternateExport.clone().text());
      const alternateBody = await json(alternateExport);
      assert.equal(alternateBody.artifact.format, format);
      const alternateDownload = await fetch(`${started.url}${alternateBody.artifact.downloadUrl}`);
      assert.equal(alternateDownload.status, 200);
      const mime = alternateDownload.headers.get('content-type') ?? '';
      const alternateBytes = Buffer.from(await alternateDownload.arrayBuffer());
      assert.ok(alternateBytes.length > 100);
      if (format === 'pdf') {
        assert.match(mime, /application\/pdf/);
        const reopenedPdf = await PDFDocument.load(alternateBytes, { updateMetadata: false });
        assert.equal(reopenedPdf.getPageCount(), 3);
      } else {
        assert.match(mime, /text\/html/);
        const html = alternateBytes.toString('utf8');
        assert.match(html, /<main>/);
        assert.equal((html.match(/<section class="slide"/g) ?? []).length, 3);
        assert.match(html, /<h1 class="slide-title"/);
      }
    }
    assert.equal(inferenceCalls.length, 0);

    const stateDb = new Database(path.join(dataDir, 'app.sqlite'), { readonly: true });
    const persisted = stateDb.prepare('SELECT state_json FROM presentation_generations WHERE project_id = ?').get(projectId);
    stateDb.close();
    assert.equal(JSON.parse(persisted.state_json).generationId, initial.generationId);
    await assert.rejects(readFile(path.join(dataDir, 'projects', projectId, '.generation', 'state.json')));
    await closeStartedServer(started);
    started = await startServer(options);
    const reloaded = await getGeneration(started, projectId);
    assert.equal(reloaded.generationId, initial.generationId);
    assert.equal(reloaded.status, 'completed', JSON.stringify({ status: reloaded.status, failure: reloaded.failure }));
    assert.equal(reloaded.slides[0].selectedVariant, 'B');
    assert.equal(reloaded.slides[1].lockedVariant, 'C');
    assert.equal(reloaded.exports[0].id, exportBody.artifact.id);
    assert.deepEqual(reloaded.exports.map((item) => item.format), ['pptx', 'pptx', 'pptx', 'pptx', 'pdf', 'html']);
    const runManifestPath = path.join(dataDir, 'projects', projectId, '.generation', initial.generationId, 'run-manifest.json');
    const runManifest = JSON.parse(await readFile(runManifestPath, 'utf8'));
    assert.equal(runManifest.schemaVersion, 1);
    assert.equal(runManifest.run.generationId, initial.generationId);
    assert.equal(runManifest.inputHashes.template, reloaded.templateIRHash);
    assert.equal(runManifest.exports.length, 6);
    assert.equal(runManifest.contentExcluded, true);
    assert.equal(runManifest.secretsExcluded, true);
    assert.doesNotMatch(JSON.stringify(runManifest), /Evidence points to a retention constraint/);
    const repeatedExport = await fetch(`${started.url}/api/projects/${projectId}/generation/export`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'selected' }),
    });
    assert.equal(repeatedExport.status, 201);
    assert.equal((await json(repeatedExport)).artifact.id, exportBody.artifact.id, 'the same export request stays idempotent after daemon restart');
    assert.equal((await fetch(`${started.url}${reloaded.slides[0].variants.B.previewUrl}`)).status, 200);
    assert.equal(inferenceCalls.length, 0);
  } finally {
    gate.release();
    await closeStartedServer(started);
    if (priorBackend === undefined) delete process.env.LCT_PPTX_BACKEND;
    else process.env.LCT_PPTX_BACKEND = priorBackend;
  }
});

test('a later renderer failure preserves earlier ready packs and explicit cancellation persists', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-generation-failure-'));
  t.after(() => removeTempDirectory(temp));
  const dataDir = path.join(temp, 'data');
  const projectId = 'generation-failure';
  let started;
  const renderer = new OfficeKitPptxRenderer();
  const failingRenderer = {
    id: 'office-kit',
    async render(input) {
      if (input.compiledPresentation.slides[0]?.sourceDeckPlanSlideId === 'slide_offline-ready-plan_3') {
        throw new Error('synthetic later-slide failure');
      }
      return renderer.render(input);
    },
  };
  const priorBackend = process.env.LCT_PPTX_BACKEND;
  process.env.LCT_PPTX_BACKEND = 'office-kit';
  try {
    started = await startServer({
      host: '127.0.0.1', port: 0, dataDir, projectRoot: repoRoot, serveWeb: false, returnServer: true,
      semanticInferenceAdapter: { async infer() { throw new Error('generation must not call inference'); } },
      presentationRenderer: failingRenderer,
    });
    await createProject(started, projectId);
    const seeded = await seedReadyPlanningState(started, dataDir, projectId);
    if (!seeded) { t.skip('Python 3.12 unavailable: synthetic PPTX template cannot be compiled'); return; }
    const startResponse = await fetch(`${started.url}/api/projects/${projectId}/generation`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'offline-failure-v1' }, body: '{}',
    });
    assert.equal(startResponse.status, 202);
    const failed = await waitFor(() => getGeneration(started, projectId), (state) => state.status === 'failed', 'later slide failure');
    assert.equal(failed.readySlides, 2);
    assert.deepEqual(failed.slides.map((pack) => pack.status), ['ready', 'ready', 'failed']);
    assert.match(failed.failure.message, /Earlier ready slide packs remain available/);

  } finally {
    if (started) await closeStartedServer(started);
    if (priorBackend === undefined) delete process.env.LCT_PPTX_BACKEND;
    else process.env.LCT_PPTX_BACKEND = priorBackend;
  }
});

test('generation cancellation is explicit, preserves ready work, and survives reload', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-generation-cancel-'));
  t.after(() => removeTempDirectory(temp));
  const dataDir = path.join(temp, 'data');
  const projectId = 'generation-cancel';
  const gate = gateRenderer('slide_offline-ready-plan_2');
  const priorBackend = process.env.LCT_PPTX_BACKEND;
  process.env.LCT_PPTX_BACKEND = 'office-kit';
  let started = await startServer({
    host: '127.0.0.1', port: 0, dataDir, projectRoot: repoRoot, serveWeb: false, returnServer: true,
    semanticInferenceAdapter: { async infer() { throw new Error('generation must not call inference'); } },
    presentationRenderer: gate.renderer,
  });
  try {
    await createProject(started, projectId);
    const seeded = await seedReadyPlanningState(started, dataDir, projectId);
    if (!seeded) { t.skip('Python 3.12 unavailable: synthetic PPTX template cannot be compiled'); return; }
    const startResponse = await fetch(`${started.url}/api/projects/${projectId}/generation`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'offline-cancel-v1' }, body: '{}',
    });
    assert.equal(startResponse.status, 202);
    await gate.entered;
    const beforeCancel = await waitFor(() => getGeneration(started, projectId), (state) => state.readySlides === 1 && state.currentSlideId === 'slide_offline-ready-plan_2', 'one ready pack before cancel');
    const cancelPromise = mutate(started, projectId, '/cancel', {}, 'POST');
    const markedCancelled = await waitFor(() => getGeneration(started, projectId), (state) => state.status === 'cancelled', 'cancel state');
    assert.equal(markedCancelled.readySlides, 1);
    assert.equal(markedCancelled.slides[0].status, 'ready');
    assert.equal(markedCancelled.slides[1].status, 'pending');
    gate.release();
    const response = await cancelPromise;
    assert.equal(response.status, 200);
    assert.equal((await json(response)).generation.generationId, beforeCancel.generationId);
    await closeStartedServer(started);
    started = await startServer({
      host: '127.0.0.1', port: 0, dataDir, projectRoot: repoRoot, serveWeb: false, returnServer: true,
      semanticInferenceAdapter: { async infer() { throw new Error('generation must not call inference'); } },
    });
    const reloaded = await getGeneration(started, projectId);
    assert.equal(reloaded.status, 'cancelled');
    assert.equal(reloaded.readySlides, 1);
    assert.equal(reloaded.slides[0].status, 'ready');
  } finally {
    gate.release();
    await closeStartedServer(started);
    if (priorBackend === undefined) delete process.env.LCT_PPTX_BACKEND;
    else process.env.LCT_PPTX_BACKEND = priorBackend;
  }
});

test('daemon restart recovers pending packs and keeps already published artifacts immutable', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-generation-recovery-'));
  t.after(() => removeTempDirectory(temp));
  const dataDir = path.join(temp, 'data');
  const projectId = 'generation-recovery';
  const gate = gateRenderer('slide_offline-ready-plan_2');
  const priorBackend = process.env.LCT_PPTX_BACKEND;
  process.env.LCT_PPTX_BACKEND = 'office-kit';
  let started = await startServer({
    host: '127.0.0.1', port: 0, dataDir, projectRoot: repoRoot, serveWeb: false, returnServer: true,
    semanticInferenceAdapter: { async infer() { throw new Error('generation must not call inference'); } },
    presentationRenderer: gate.renderer,
  });
  try {
    await createProject(started, projectId);
    const seeded = await seedReadyPlanningState(started, dataDir, projectId);
    if (!seeded) { t.skip('Python 3.12 unavailable: generated PPTX template cannot be compiled'); return; }
    const startedResponse = await fetch(`${started.url}/api/projects/${projectId}/generation`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'offline-recovery-v1' }, body: '{}',
    });
    assert.equal(startedResponse.status, 202);
    await gate.entered;
    const partial = await waitFor(() => getGeneration(started, projectId),
      (state) => state.readySlides === 1 && state.currentSlideId === 'slide_offline-ready-plan_2', 'one ready pack before restart');
    const readyBeforeRestart = partial.slides[0];
    const stopping = closeStartedServer(started);
    started = null;
    const savedInterruption = await waitFor(() => {
      const db = new Database(path.join(dataDir, 'app.sqlite'), { readonly: true });
      try { return JSON.parse(db.prepare('SELECT state_json FROM presentation_generations WHERE project_id = ?').get(projectId).state_json); }
      finally { db.close(); }
    }, (state) => state.status === 'generating' && state.slides[1].status === 'pending', 'recoverable pending cursor');
    assert.equal(savedInterruption.slides[0].status, 'ready');
    gate.release();
    await stopping;

    started = await startServer({
      host: '127.0.0.1', port: 0, dataDir, projectRoot: repoRoot, serveWeb: false, returnServer: true,
      semanticInferenceAdapter: { async infer() { throw new Error('generation must not call inference'); } },
    });
    const completed = await waitFor(() => getGeneration(started, projectId), (state) => state.status === 'completed', 'recovered generation');
    assert.equal(completed.readySlides, 3);
    assert.equal(completed.slides[0].version, readyBeforeRestart.version);
    assert.equal(completed.slides[0].variants.A.previewUrl, readyBeforeRestart.variants.A.previewUrl);
    assert.ok(completed.slides.slice(1).every((pack) => pack.status === 'ready'));
  } finally {
    gate.release();
    if (started) await closeStartedServer(started);
    if (priorBackend === undefined) delete process.env.LCT_PPTX_BACKEND;
    else process.env.LCT_PPTX_BACKEND = priorBackend;
  }
});

test('a changed ready plan can replace a completed generation with a fresh idempotency key', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-generation-replan-'));
  t.after(() => removeTempDirectory(temp));
  const dataDir = path.join(temp, 'data');
  const projectId = 'generation-replan';
  const priorBackend = process.env.LCT_PPTX_BACKEND;
  process.env.LCT_PPTX_BACKEND = 'office-kit';
  let started;
  try {
    started = await startServer({
      host: '127.0.0.1', port: 0, dataDir, projectRoot: repoRoot, serveWeb: false, returnServer: true,
      semanticInferenceAdapter: { async infer() { throw new Error('generation must not call inference'); } },
    });
    await createProject(started, projectId);
    const firstPlan = await seedReadyPlanningState(started, dataDir, projectId);
    if (!firstPlan) { t.skip('Python 3.12 unavailable: generated PPTX template cannot be compiled'); return; }
    const firstStart = await fetch(`${started.url}/api/projects/${projectId}/generation`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'offline-replan-v1' }, body: '{}',
    });
    assert.equal(firstStart.status, 202);
    const first = (await json(firstStart)).generation;
    await waitFor(() => getGeneration(started, projectId), (state) => state.status === 'completed', 'initial generation completion');

    const refreshed = await seedReadyPlanningState(started, dataDir, projectId, 'Updated evidence reports a new retention constraint.');
    assert.ok(refreshed);
    const stale = await waitFor(() => getGeneration(started, projectId), (state) => state.status === 'stale', 'old generation becoming stale');
    assert.equal(stale.generationId, first.generationId);
    const secondStart = await fetch(`${started.url}/api/projects/${projectId}/generation`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'offline-replan-v2' }, body: '{}',
    });
    assert.equal(secondStart.status, 202, await secondStart.clone().text());
    const second = (await json(secondStart)).generation;
    assert.notEqual(second.generationId, first.generationId);
    const completed = await waitFor(() => getGeneration(started, projectId), (state) => state.status === 'completed', 'refreshed generation completion');
    assert.equal(completed.generationId, second.generationId);
    assert.equal(completed.inputFingerprint === first.inputFingerprint, false);
  } finally {
    if (started) await closeStartedServer(started);
    if (priorBackend === undefined) delete process.env.LCT_PPTX_BACKEND;
    else process.env.LCT_PPTX_BACKEND = priorBackend;
  }
});

test('one-click product workflow is idempotent, persisted, audits one selected deck, and exports all formats', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-one-click-workflow-'));
  t.after(() => removeTempDirectory(temp));
  const dataDir = path.join(temp, 'data');
  const projectId = 'one-click-workflow';
  const endpoint = await startFakeSemanticEndpoint({ model: 'offline-fake-planner' });
  t.after(() => endpoint.close());
  const oldConfig = {
    baseUrl: process.env.LCT_SEMANTIC_BASE_URL,
    model: process.env.LCT_SEMANTIC_MODEL,
    apiKey: process.env.LCT_SEMANTIC_API_KEY,
    backend: process.env.LCT_PPTX_BACKEND,
    image: Object.fromEntries(['LCT_IMAGE_BASE_URL', 'LCT_IMAGE_MODEL', 'LCT_IMAGE_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'].map((key) => [key, process.env[key]])),
  };
  process.env.LCT_SEMANTIC_BASE_URL = endpoint.baseUrl;
  process.env.LCT_SEMANTIC_MODEL = 'offline-fake-planner';
  delete process.env.LCT_SEMANTIC_API_KEY;
  process.env.LCT_PPTX_BACKEND = 'office-kit';
  for (const key of Object.keys(oldConfig.image)) delete process.env[key];
  let started;
  try {
    started = await startServer({ host: '127.0.0.1', port: 0, dataDir, projectRoot: repoRoot, serveWeb: false, returnServer: true });
    await createProject(started, projectId);
    const imageModels = await json(await fetch(`${started.url}/api/media/models`));
    assert.deepEqual(imageModels.image, []);
    assert.equal(imageModels.configured, false);
    const pptx = await makeValidSyntheticPptx(path.join(temp, 'template'));
    await upload(started, projectId, 'synthetic-template.pptx', pptx);
    const input = {
      templateFilePath: 'synthetic-template.pptx',
      contentFiles: [],
      brief: {
        audience: 'Руководители продукта',
        purpose: 'Подготовить краткую презентацию о развитии продукта на основе задачи и контекста.',
        preferences: [],
        requestedSlideCount: 3,
      },
    };
    const begin = await fetch(`${started.url}/api/projects/${projectId}/workflow/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    assert.equal(begin.status, 202, await begin.clone().text());
    const first = (await json(begin)).operation;
    const duplicate = await fetch(`${started.url}/api/projects/${projectId}/workflow/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    assert.ok([200, 202].includes(duplicate.status), await duplicate.clone().text());
    assert.equal((await json(duplicate)).operation.operationId, first.operationId);

    const getOperation = async () => (await json(await fetch(`${started.url}/api/projects/${projectId}/workflow`))).operation;
    const ready = await waitFor(getOperation, (operation) => operation?.status === 'ready' || operation?.status === 'failed', 'one-click operation ready', 120_000);
    const generationOnFailure = ready.status === 'failed' ? await getGeneration(started, projectId) : null;
    assert.equal(ready.status, 'ready', JSON.stringify({ failure: ready.failure, generation: generationOnFailure?.failure }));
    assert.equal(ready.stage, 'ready');
    assert.equal(ready.totalSlides, 3);
    assert.equal(ready.readySlides, 3);
    assert.equal(ready.contextualAudit.status, 'ready');
    assert.equal(ready.contextualAudit.findings.length, 11);

    const plan = await json(await fetch(`${started.url}/api/projects/${projectId}/planning`));
    assert.equal(plan.status, 'ready');
    assert.equal(plan.deckPlan.slides.length, 3);
    const generationResponse = await fetch(`${started.url}/api/projects/${projectId}/generation`);
    const generation = (await json(generationResponse)).generation;
    assert.equal(generation.status, 'completed');
    assert.equal(generation.slides.length, 3);
    assert.ok(generation.slides.every((pack) => ['A', 'B', 'C'].every((variant) => pack.variants[variant].status === 'ready')));
    assert.deepEqual(endpoint.state.inference.map((entry) => entry.operation).sort(), [
      'contextual-deck-audit', 'deck-plan', 'plan-review',
    ].sort());
    assert.equal(endpoint.state.inference.filter((entry) => entry.operation === 'contextual-deck-audit').length, 1);
    assert.equal(endpoint.state.inference.length, 3);

    const exportArtifact = async (mode, format) => {
      const response = await fetch(`${started.url}/api/projects/${projectId}/generation/export`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, format }),
      });
      assert.equal(response.status, 201, await response.clone().text());
      const body = await json(response);
      const download = await fetch(`${started.url}${body.artifact.downloadUrl}`);
      assert.equal(download.status, 200);
      return { artifact: body.artifact, bytes: Buffer.from(await download.arrayBuffer()), type: download.headers.get('content-type') };
    };
    for (const mode of ['selected', 'A', 'B', 'C']) {
      const exported = await exportArtifact(mode, 'pptx');
      assert.equal(exported.artifact.validationStatus, 'passed');
      assert.ok(exported.bytes.length > 1000);
      const zip = await JSZip.loadAsync(exported.bytes);
      assert.ok(Object.keys(zip.files).includes('ppt/presentation.xml'));
      assert.equal(Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).length, 3);
    }
    const pdf = await exportArtifact('selected', 'pdf');
    assert.ok(pdf.bytes.subarray(0, 5).toString('ascii').startsWith('%PDF-'));
    const pdfDocument = await PDFDocument.load(pdf.bytes);
    assert.equal(pdfDocument.getPageCount(), 3);
    const html = await exportArtifact('selected', 'html');
    assert.match(html.bytes.toString('utf8'), /<!doctype html>/i);
    assert.equal((html.bytes.toString('utf8').match(/<section class="slide"/g) ?? []).length, 3);

    const pickedTrack = await mutate(started, projectId, '/selection', {
      scope: 'deck', variant: 'C', expectedVersion: generation.selectionVersion,
    });
    assert.equal(pickedTrack.status, 200, await pickedTrack.clone().text());
    const selected = (await json(pickedTrack)).generation;
    const lock = await mutate(started, projectId, `/slides/${selected.slides[0].slideId}/lock`, {
      locked: true, variant: 'C', expectedVersion: selected.slides[0].version,
    });
    assert.equal(lock.status, 200, await lock.clone().text());

    const afterReload = await getOperation();
    assert.equal(afterReload.operationId, first.operationId);
    assert.equal(afterReload.contextualAudit.stale, true, 'changing the selected deck makes the prior semantic review stale');
    assert.equal(endpoint.state.inference.length, 3, 'repeat reads and exports must not issue semantic inference');

    await closeStartedServer(started);
    started = await startServer({ host: '127.0.0.1', port: 0, dataDir, projectRoot: repoRoot, serveWeb: false, returnServer: true });
    const restored = await getOperation();
    assert.equal(restored.operationId, first.operationId);
    assert.equal(restored.contextualAudit.stale, true);
    const restoredGeneration = (await json(await fetch(`${started.url}/api/projects/${projectId}/generation`))).generation;
    assert.equal(restoredGeneration.defaultTrack, 'C');
    assert.equal(restoredGeneration.slides[0].lockedVariant, 'C');
    assert.equal(restoredGeneration.exports.length, 6);
    assert.equal(endpoint.state.inference.length, 3, 'restart reuses persisted template, plan, generation, and contextual review');

    const sourceProjectId = 'one-click-with-optional-source';
    await createProject(started, sourceProjectId);
    await upload(started, sourceProjectId, 'source-template.pptx', pptx);
    await upload(started, sourceProjectId, 'market-context.md', Buffer.from('# Current position\nThe product serves three customer segments.\n\n# Next step\nThe team will validate the smallest pilot first.', 'utf8'));
    const withSourceInput = {
      ...input,
      templateFilePath: 'source-template.pptx',
      contentFiles: ['market-context.md'],
      brief: { ...input.brief, purpose: 'Summarize the supplied customer context and propose a bounded next step.' },
    };
    const withSourceResponse = await fetch(`${started.url}/api/projects/${sourceProjectId}/workflow/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(withSourceInput),
    });
    assert.equal(withSourceResponse.status, 202, await withSourceResponse.clone().text());
    const sourceWorkflow = await waitFor(async () => (await json(await fetch(`${started.url}/api/projects/${sourceProjectId}/workflow`))).operation,
      (operation) => operation?.status === 'ready' || operation?.status === 'failed', 'one-click optional source', 120_000);
    assert.equal(sourceWorkflow.status, 'ready', JSON.stringify(sourceWorkflow.failure));
    const sourcePlanning = await json(await fetch(`${started.url}/api/projects/${sourceProjectId}/planning`));
    assert.deepEqual(sourcePlanning.contentFiles, ['market-context.md']);
    assert.ok(sourcePlanning.contentIR.units.some((unit) => unit.text?.includes('three customer segments')));
    assert.equal(endpoint.state.inference.filter((entry) => entry.operation === 'contextual-deck-audit').length, 2);
    assert.equal(endpoint.state.inference.length, 6);

    const recoveryDataDir = path.join(temp, 'recovery-data');
    const recoveryProjectId = 'one-click-recovery-during-generation';
    const recoveryTemplate = await makeValidSyntheticPptx(path.join(temp, 'recovery-template'));
    const recoveryRendererGate = gateRenderer();
    started = await closeAndRestartWithRenderer(started, recoveryDataDir, repoRoot, recoveryRendererGate.renderer);
    await createProject(started, recoveryProjectId);
    await upload(started, recoveryProjectId, 'recovery-template.pptx', recoveryTemplate);
    const beforeRecoveryCalls = endpoint.state.inference.length;
    const recoveryInput = {
      templateFilePath: 'recovery-template.pptx', contentFiles: [],
      brief: { purpose: 'Показать безопасное восстановление генерации после перезапуска.', preferences: [], requestedSlideCount: 3 },
    };
    const recoveryStart = await fetch(`${started.url}/api/projects/${recoveryProjectId}/workflow/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(recoveryInput),
    });
    assert.equal(recoveryStart.status, 202, await recoveryStart.clone().text());
    await recoveryRendererGate.entered;
    const interrupted = (await json(await fetch(`${started.url}/api/projects/${recoveryProjectId}/workflow`))).operation;
    assert.equal(interrupted.stage, 'generating');
    const callsBeforeRestart = endpoint.state.inference.length;
    assert.equal(callsBeforeRestart - beforeRecoveryCalls, 2, 'the persisted core stage follows Worker and planning Supervisor without template profiling');
    started.server.closeAllConnections?.();
    await new Promise((resolve, reject) => started.server.close((error) => error ? reject(error) : resolve()));
    const shutdown = started.shutdown();
    recoveryRendererGate.release();
    await shutdown;
    const interruptedState = JSON.parse(await readFile(path.join(recoveryDataDir, 'projects', recoveryProjectId, '.workflow', 'state.json'), 'utf8'));
    assert.equal(interruptedState.status, 'running');
    assert.equal(interruptedState.stage, 'generating');
    assert.equal(interruptedState.failure, null);
    started = await startServer({
      host: '127.0.0.1', port: 0, dataDir: recoveryDataDir, projectRoot: repoRoot, serveWeb: false, returnServer: true,
    });
    const recovered = await waitFor(async () => (await json(await fetch(`${started.url}/api/projects/${recoveryProjectId}/workflow`))).operation,
      (operation) => operation?.status === 'ready' || operation?.status === 'failed', 'workflow recovery after generation interruption', 120_000);
    assert.equal(recovered.status, 'ready', JSON.stringify(recovered.failure));
    assert.equal(recovered.totalSlides, 3);
    assert.equal(endpoint.state.inference.length - callsBeforeRestart, 1,
      'recovery reuses template profile and plan, issuing only one contextual audit after generation');
    const recoveredGeneration = (await json(await fetch(`${started.url}/api/projects/${recoveryProjectId}/generation`))).generation;
    assert.ok(recoveredGeneration.slides.every((slide) => ['A', 'B', 'C'].every((variant) => slide.variants[variant].status === 'ready')));
  } finally {
    if (started) await closeStartedServer(started);
    if (oldConfig.baseUrl === undefined) delete process.env.LCT_SEMANTIC_BASE_URL; else process.env.LCT_SEMANTIC_BASE_URL = oldConfig.baseUrl;
    if (oldConfig.model === undefined) delete process.env.LCT_SEMANTIC_MODEL; else process.env.LCT_SEMANTIC_MODEL = oldConfig.model;
    if (oldConfig.apiKey === undefined) delete process.env.LCT_SEMANTIC_API_KEY; else process.env.LCT_SEMANTIC_API_KEY = oldConfig.apiKey;
    if (oldConfig.backend === undefined) delete process.env.LCT_PPTX_BACKEND; else process.env.LCT_PPTX_BACKEND = oldConfig.backend;
    for (const [key, value] of Object.entries(oldConfig.image)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

async function closeAndRestartWithRenderer(started, dataDir, projectRoot, renderer) {
  await closeStartedServer(started);
  return startServer({
    host: '127.0.0.1', port: 0, dataDir, projectRoot, serveWeb: false, returnServer: true, presentationRenderer: renderer,
  });
}

test('shutdown preserves every terminal generation when its task is still settling', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-generation-shutdown-terminal-'));
  const db = openPresentationStore(path.join(temp, 'data'));
  t.after(async () => { db.close(); await removeTempDirectory(temp); });
  const service = new PresentationGenerationService({
    db, projectsRoot: path.join(temp, 'projects'), planningService: {}, backend: 'custom',
  });
  const statuses = ['completed', 'failed', 'cancelled', 'stale'];
  const controllers = [];
  for (const status of statuses) {
    const projectId = `shutdown-${status}`;
    createPresentationProject(db, { id: projectId, name: projectId });
    const state = { generationId: `${projectId}-run`, revision: 4, status };
    startPresentationGeneration(db, {
      projectId, idempotencyKey: `${projectId}-key`, inputFingerprint: `${projectId}-fingerprint`, state,
    });
    const controller = new AbortController();
    controllers.push(controller);
    service.tasks.set(projectId, { controller, promise: Promise.resolve() });
  }

  await service.shutdown();

  for (const status of statuses) assert.equal(getPresentationGeneration(db, `shutdown-${status}`).state.status, status);
  assert.ok(controllers.every((controller) => controller.signal.aborted));
});

test('project drain and daemon shutdown wait for in-flight repair and export work', async () => {
  const service = new PresentationGenerationService({ db: {}, projectsRoot: '.', planningService: {}, backend: 'custom' });
  let resolveExport;
  let resolveRepair;
  let resolveOtherProject;
  const exportTask = new Promise((resolve) => { resolveExport = resolve; });
  const repairTask = new Promise((resolve) => { resolveRepair = resolve; });
  const otherProjectTask = new Promise((resolve) => { resolveOtherProject = resolve; });
  service.exportTasks.set('drain-target:export', exportTask);
  service.repairTasks.set('drain-target:repair', repairTask);
  service.exportTasks.set('other-project:export', otherProjectTask);

  let drained = false;
  const projectDrain = service.drainProject('drain-target').then((result) => { drained = result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  resolveExport();
  resolveRepair();
  // Real task wrappers remove their entries in finally; mirror that cleanup here.
  service.exportTasks.delete('drain-target:export');
  service.repairTasks.delete('drain-target:repair');
  await projectDrain;
  assert.equal(drained, true, 'deletion waits for this project but not unrelated projects');

  let shutdownFinished = false;
  const shutdown = service.shutdown().then((result) => { shutdownFinished = result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownFinished, false, 'daemon shutdown waits for exports not cancellable as generation tasks');
  resolveOtherProject();
  await shutdown;
  assert.equal(shutdownFinished, true);
});

test('generation artifact writes reject a project directory symlink outside storage', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-generation-path-'));
  const projectsRoot = path.join(temp, 'projects');
  const outside = path.join(temp, 'outside');
  await mkdir(projectsRoot);
  await mkdir(outside);
  t.after(() => removeTempDirectory(temp));
  try {
    await symlink(outside, path.join(projectsRoot, 'project-escape'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      t.skip('directory symlinks are not available in this environment');
      return;
    }
    throw error;
  }
  const service = new PresentationGenerationService({ db: {}, projectsRoot, planningService: {}, backend: 'custom' });
  await assert.rejects(service.generatedFile('project-escape', ['generation-id', 'artifact.png'], true), /escapes project storage/);
  assert.deepEqual(await readdir(outside), []);
  await assert.rejects(access(path.join(outside, '.generation')), { code: 'ENOENT' });
});
