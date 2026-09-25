import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { register } from 'tsx/esm/api';
import Database from 'better-sqlite3';

register();
const require = createRequire(import.meta.url);
const PptxGenJS = require('pptxgenjs');
const { startServer } = await import('../src/server.ts');
const { compileContentIR } = await import('../src/presentation/application/content-compiler.ts');
const { planningInputFingerprint, validatePlanReview } = await import('../src/presentation/application/planning-service.ts');
const { canonicalizeDeckPlan } = await import('../src/presentation/domain/deck-plan.ts');
const { briefHash } = await import('../src/presentation/domain/brief.ts');
const { OfficeKitPptxRenderer } = await import('../src/presentation/adapters/office-kit-pptx-renderer.ts');
const { inspectOfficeKitPackage } = await import('../src/presentation/adapters/office-kit-package-inspector.ts');
const { PresentationGenerationService } = await import('../src/presentation/application/generation-service.ts');
const { createPresentationProject, openPresentationStore } = await import('../src/presentation-store.ts');
const { getPresentationGeneration, startPresentationGeneration } = await import('../src/presentation-generation-store.ts');

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

async function seedReadyPlanningState(server, dataDir, projectId, sourceText = 'Evidence points to a retention constraint for sustained growth.') {
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
  await upload(server, projectId, 'source.md', Buffer.from(sourceText, 'utf8'));

  const projectsRoot = path.join(dataDir, 'projects');
  const contentIR = await compileContentIR(projectsRoot, projectId, ['source.md']);
  const [workerPrompt, supervisorPrompt] = await Promise.all([
    readFile(path.join(repoRoot, 'apps/daemon/prompts/worker-deck-plan.v2.md'), 'utf8'),
    readFile(path.join(repoRoot, 'apps/daemon/prompts/supervisor-plan-review.v1.md'), 'utf8'),
  ]);
  const brief = {
    audience: 'Executive team',
    purpose: 'Choose a retention investment',
    expectedOutcome: 'Agree on one bounded pilot',
    preferences: ['Use supplied evidence'],
    requestedSlideCount: 3,
  };
  const fingerprint = planningInputFingerprint({
    templateIRHash: template.templateIR.hash,
    presentationDesignSystemHash: template.presentationDesignSystem.hash,
    contentIRHash: contentIR.hash,
    briefHash: briefHash(brief),
    workerPromptSha256: createHash('sha256').update(workerPrompt).digest('hex'),
    supervisorPromptSha256: createHash('sha256').update(supervisorPrompt).digest('hex'),
  });
  const contentId = contentIR.units.find((unit) => unit.kind !== 'media-reference')?.id;
  assert.ok(contentId);
  const now = new Date().toISOString();
  const plan = canonicalizeDeckPlan({
    workingTitle: 'Retention is the growth constraint',
    narrativeSummary: 'Show the supplied retention evidence and one decision.',
    slides: [
      { narrativeRole: 'opening', purpose: 'Frame the decision.', takeaway: 'Growth requires a retention decision.', contentRefs: [], semanticVisualType: 'chart', targetDensity: 'compact' },
      { narrativeRole: 'content', purpose: 'Show the evidence.', takeaway: 'The source identifies retention as a constraint.', contentRefs: [contentId], semanticVisualType: 'chart', targetDensity: 'balanced' },
      { narrativeRole: 'closing', purpose: 'State the next step.', takeaway: 'Run a bounded retention pilot.', contentRefs: [contentId], semanticVisualType: 'chart', targetDensity: 'compact' },
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
    inputs: { contentFiles: ['source.md'], brief, contentIR, inputFingerprint: fingerprint },
    lastSuccessful: {
      contentFiles: ['source.md'], brief, contentIR, inputFingerprint: fingerprint,
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

function gateRenderer(targetSlideId) {
  const renderer = new OfficeKitPptxRenderer();
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let blocked = false;
  const errors = [];
  return {
    entered,
    errors,
    release: () => release(),
    renderer: {
      id: 'office-kit',
      async render(input) {
        if (!blocked && input.compiledPresentation.slides[0]?.sourceDeckPlanSlideId === targetSlideId) {
          blocked = true;
          enter();
          await gate;
        }
        try { return await renderer.render(input); }
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
    const seeded = await seedReadyPlanningState(started, dataDir, projectId);
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
    assert.equal(inferenceCalls.length, 0, 'variants, repair, and export must not call semantic inference');
    assert.ok(completed.slides.every((pack) => pack.status === 'ready' && variants.every((variant) => pack.variants[variant].previewUrl)));

    const previewResponse = await fetch(`${started.url}${completed.slides[0].variants.B.previewUrl}`);
    assert.equal(previewResponse.status, 200);
    assert.match(previewResponse.headers.get('content-type') ?? '', /image\/png/);
    assert.ok((await previewResponse.arrayBuffer()).byteLength > 100);

    const exportResponse = await fetch(`${started.url}/api/projects/${projectId}/generation/export`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'selected' }),
    });
    assert.equal(exportResponse.status, 201, await exportResponse.clone().text());
    const exportBody = await json(exportResponse);
    assert.equal(exportBody.artifact.validationStatus, 'passed');
    assert.equal(exportBody.artifact.nativeOfficeStatus, 'unknown');
    const downloaded = await fetch(`${started.url}${exportBody.artifact.downloadUrl}`);
    assert.equal(downloaded.status, 200);
    const outputBytes = Buffer.from(await downloaded.arrayBuffer());
    assert.ok(outputBytes.length > 100);
    const inspection = await inspectOfficeKitPackage(outputBytes);
    assert.equal(inspection.slideCount, 3);
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
