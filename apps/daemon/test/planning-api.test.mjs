import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { register } from 'tsx/esm/api';

import { makeSyntheticPptx } from '../python-inspector-test-fixtures.mjs';

register();
const { startServer } = await import('../src/server.ts');
const { SemanticInferenceError } = await import('../src/presentation/application/semantic-inference-port.ts');
const { planningInputFingerprint } = await import('../src/presentation/application/planning-service.ts');

const repoRoot = path.resolve(import.meta.dirname, '../../..');

async function closeStartedServer(started) {
  started.server.closeAllConnections?.();
  await new Promise((resolve, reject) => started.server.close((error) => error ? reject(error) : resolve()));
  await started.shutdown();
}

async function responseJson(response) {
  return response.json();
}

function planDraft(contentId, override = {}) {
  return {
    workingTitle: 'Growth depends on retention',
    narrativeSummary: 'The supplied evidence points to a growth opportunity constrained by retention.',
    slides: [
      {
        narrativeRole: 'opening', purpose: 'Frame the decision.', takeaway: 'Growth requires a clear retention decision.',
        contentRefs: [], semanticVisualType: 'none', targetDensity: 'compact',
      },
      {
        narrativeRole: 'content', purpose: 'Present supplied evidence.', takeaway: 'The source highlights the retention constraint.',
        contentRefs: [contentId], semanticVisualType: 'diagram', targetDensity: 'balanced',
      },
    ],
    ...override,
  };
}

function reviewResult(checkpointVersion, mode) {
  if (mode === 'malformed') return { outcome: 'pass' };
  const finding = {
    targetType: 'slide', slideId: 'slide_placeholder', severity: 'medium',
    reason: 'Clarify the evidence connection.', evidenceRefs: [],
  };
  if (mode === 'pass') return { checkpointVersion, outcome: 'pass', findings: [], operations: [] };
  if (mode === 'warn') return { checkpointVersion, outcome: 'warn', findings: [{ ...finding, targetType: 'deck', slideId: null }], operations: [] };
  if (mode === 'repair' || mode === 'invalid-target') {
    return {
      checkpointVersion,
      outcome: 'repair',
      findings: [{ ...finding, slideId: 'slide_dp_placeholder_2' }],
      operations: [{
        type: 'replace_takeaway', slideId: mode === 'repair' ? 'slide_dp_placeholder_2' : 'missing-slide',
        takeaway: 'Retention is the source identified growth constraint.', purpose: null, contentRef: null, semanticVisualType: null,
      }],
    };
  }
  if (mode === 'stale-checkpoint') return { checkpointVersion: checkpointVersion + 1, outcome: 'pass', findings: [], operations: [] };
  if (mode === 'local-replan') {
    return { checkpointVersion, outcome: 'local-replan', findings: [{ ...finding, targetType: 'deck', slideId: null }], operations: [] };
  }
  return { checkpointVersion, outcome: 'pass', findings: [], operations: [] };
}

function makeFakeAdapter(control) {
  let requestNumber = 0;
  return {
    async infer(request) {
      requestNumber += 1;
      control.calls?.push({ role: request.role, operation: request.operation });
      const text = request.messages.at(-1).content;
      const evidence = JSON.parse(text);
      if (request.role === 'worker') control.workerEvidence?.push(evidence.contentIR);
      let value;
      if (request.role === 'worker') {
        if (control.workerFailure) throw new Error('controlled fake worker failure');
        const contentId = control.badWorker === 'media-ref'
          ? evidence.contentIR.units.find((unit) => unit.kind === 'media-reference')?.id ?? 'missing-media'
          : evidence.contentIR.units.find((unit) => unit.kind !== 'media-reference')?.id ?? 'unknown-content';
        const override = control.badWorker === 'unknown-ref'
          ? { slides: planDraft(contentId).slides.map((slide) => ({ ...slide, contentRefs: slide.narrativeRole === 'content' ? ['invented-unit'] : [] })) }
          : control.badWorker === 'bad-visual'
            ? { slides: planDraft(contentId).slides.map((slide) => ({ ...slide, semanticVisualType: 'arbitrary-layout' })) }
            : {};
        value = planDraft(contentId, override);
      } else {
        const checkpointVersion = evidence.checkpointVersion;
        const mode = control.reviewMode ?? 'pass';
        const result = reviewResult(checkpointVersion, mode);
        // Bind repair fixtures to the app-assigned checkpoint IDs supplied to the reviewer.
        if (mode === 'repair' || mode === 'invalid-target') {
          const targetId = evidence.checkpoint.slides[1].id;
          result.findings[0].slideId = targetId;
          result.operations[0].slideId = mode === 'repair' ? targetId : 'missing-slide';
        }
        value = result;
      }
      const now = new Date().toISOString();
      return {
        value,
        telemetry: {
          role: request.role,
          operation: request.operation,
          model: 'fake-planner-v1',
          requestId: `fake-request-${requestNumber}`,
          startedAt: now,
          finishedAt: now,
          wallTimeMs: 1,
          status: 'success',
          promptTokens: 120,
          completionTokens: 35,
          finishReason: 'stop',
        },
      };
    },
  };
}

async function createProject(started, projectId) {
  const created = await fetch(`${started.url}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: projectId, name: 'Planning API test' }),
  });
  assert.equal(created.status, 201);
}

async function upload(started, projectId, filename, bytes) {
  const form = new FormData();
  form.append('files', new Blob([bytes]), filename);
  const response = await fetch(`${started.url}/api/projects/${projectId}/upload`, { method: 'POST', body: form });
  assert.equal(response.status, 200, await response.clone().text());
}

async function compileTemplate(started, projectId, bytes) {
  await upload(started, projectId, 'template.pptx', bytes);
  const response = await fetch(`${started.url}/api/projects/${projectId}/template/compile`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filePath: 'template.pptx' }),
  });
  if (response.status === 503) {
    const result = await responseJson(response);
    if (result.failure?.code === 'INSPECTOR_UNAVAILABLE') return false;
  }
  assert.equal(response.status, 200, await response.clone().text());
  return true;
}

async function generate(started, projectId, brief = undefined, contentFiles = ['source.md']) {
  return fetch(`${started.url}/api/projects/${projectId}/planning/generate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contentFiles,
      brief: brief ?? { audience: 'Executive team', purpose: 'Choose a growth priority', expectedOutcome: 'Align on retention investment', requestedSlideCount: 2, preferences: ['Use supplied evidence'] },
    }),
  });
}

test('Planning API runs a bounded Worker/Supervisor flow, persists, reloads, and marks changed inputs stale', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-planning-api-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const dataDir = path.join(temp, 'data');
  const control = { reviewMode: 'pass', badWorker: null, workerFailure: false, calls: [], workerEvidence: [] };
  const adapter = makeFakeAdapter(control);
  const options = { host: '127.0.0.1', port: 0, dataDir, projectRoot: repoRoot, serveWeb: false, returnServer: true, semanticInferenceAdapter: adapter };
  let started = await startServer(options);
  const projectId = 'planning-vertical-slice';
  try {
    await createProject(started, projectId);
    if (!await compileTemplate(started, projectId, await makeSyntheticPptx({ slideCount: 2, layoutCount: 2 }))) {
      t.skip('Python 3.12 unavailable: local template fixture cannot be compiled');
      return;
    }
    await upload(started, projectId, 'source.md', Buffer.from('# Retention\n\nRetention is the limiting factor for sustained growth.', 'utf8'));
    const ungenerated = await responseJson(await fetch(`${started.url}/api/projects/${projectId}/planning`));
    assert.equal(ungenerated.status, 'ready_for_planning');
    assert.equal(ungenerated.templateStatus, 'ready');

    const firstResponse = await generate(started, projectId);
    assert.equal(firstResponse.status, 200, await firstResponse.clone().text());
    const first = await responseJson(firstResponse);
    assert.equal(first.status, 'ready');
    assert.equal(first.review.outcome, 'pass');
    assert.equal(first.deckPlan.slides.length, 2);
    assert.deepEqual(first.deckPlan.slides.map((slide) => slide.order), [1, 2]);
    assert.ok(first.contentIR.units.some((unit) => first.deckPlan.slides[1].contentRefs.includes(unit.id)));
    assert.equal(Object.hasOwn(first.deckPlan.slides[1], 'geometry'), false);

    const savedPath = path.join(dataDir, 'projects', projectId, '.planning', 'state.json');
    const saved = JSON.parse(await readFile(savedPath, 'utf8'));
    assert.equal(saved.lastSuccessful.deckPlan.hash, first.deckPlan.hash);
    assert.equal(saved.lastSuccessful.telemetry.worker.model, 'fake-planner-v1');
    assert.equal(saved.lastSuccessful.telemetry.worker.finishReason, 'stop');
    assert.equal(saved.lastSuccessful.telemetry.supervisor.finishReason, 'stop');
    // Older schemaVersion=1 planning states did not store finishReason.
    delete saved.lastSuccessful.telemetry.worker.finishReason;
    delete saved.lastSuccessful.telemetry.supervisor.finishReason;
    await writeFile(savedPath, JSON.stringify(saved));
    await closeStartedServer(started);
    started = await startServer(options);
    const reloaded = await responseJson(await fetch(`${started.url}/api/projects/${projectId}/planning`));
    assert.equal(reloaded.status, 'ready');
    assert.equal(reloaded.deckPlan.hash, first.deckPlan.hash);

    control.reviewMode = 'warn';
    const warnResponse = await generate(started, projectId);
    assert.equal(warnResponse.status, 200, await warnResponse.clone().text());
    assert.equal((await responseJson(warnResponse)).review.outcome, 'warn');

    control.reviewMode = 'repair';
    const repairedResponse = await generate(started, projectId);
    assert.equal(repairedResponse.status, 200, await repairedResponse.clone().text());
    const repaired = await responseJson(repairedResponse);
    assert.equal(repaired.review.outcome, 'repair');
    assert.equal(repaired.deckPlan.version, 2);
    assert.match(repaired.deckPlan.slides[1].takeaway, /source identified growth constraint/);

    control.reviewMode = 'invalid-target';
    const invalidRepair = await generate(started, projectId);
    assert.equal(invalidRepair.status, 422);
    assert.equal((await responseJson(invalidRepair)).error.code, 'PLANNING_FAILED');

    control.reviewMode = 'stale-checkpoint';
    const staleCheckpoint = await generate(started, projectId);
    assert.equal(staleCheckpoint.status, 422);

    control.reviewMode = 'local-replan';
    const callStart = control.calls.length;
    const replanResponse = await generate(started, projectId);
    assert.equal(replanResponse.status, 200, await replanResponse.clone().text());
    const replanned = await responseJson(replanResponse);
    assert.equal(replanned.review.outcome, 'local-replan');
    assert.equal(replanned.deckPlan.version, 2);
    assert.deepEqual(control.calls.slice(callStart), [
      { role: 'worker', operation: 'deck-plan' },
      { role: 'supervisor', operation: 'plan-review' },
      { role: 'worker', operation: 'deck-plan-revision' },
    ], 'local re-plan permits exactly one revision Worker call and no recursive Supervisor review');

    control.reviewMode = 'malformed';
    const malformedReview = await generate(started, projectId);
    assert.equal(malformedReview.status, 422);
    const failedReviewState = await responseJson(await fetch(`${started.url}/api/projects/${projectId}/planning`));
    assert.equal(failedReviewState.status, 'failed', 'reload must preserve a failed same-input Supervisor attempt instead of presenting it as ready');
    assert.ok(failedReviewState.deckPlan, 'the last successful plan remains available alongside the failed-attempt status');
    assert.equal(failedReviewState.failure.code, 'PLANNING_FAILED');

    control.reviewMode = 'pass';
    control.badWorker = 'unknown-ref';
    const unknownRef = await generate(started, projectId);
    assert.equal(unknownRef.status, 422);
    control.badWorker = 'bad-visual';
    const badVisual = await generate(started, projectId);
    assert.equal(badVisual.status, 422);
    await upload(started, projectId, 'photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    control.badWorker = 'media-ref';
    const mediaReference = await generate(started, projectId, undefined, ['source.md', 'photo.png']);
    assert.equal(mediaReference.status, 422, 'an image metadata reference cannot be cited as factual evidence');
    const mediaEvidence = control.workerEvidence.at(-1);
    assert.ok(mediaEvidence.sources.every((source) => source.kind === 'text'));
    assert.ok(mediaEvidence.units.every((unit) => unit.kind !== 'media-reference'));
    assert.equal(mediaEvidence.sources.some((source) => source.originalName === 'photo.png'), false);
    control.badWorker = null;

    const changedBrief = { audience: 'Board', purpose: 'Set a retention priority', expectedOutcome: 'Approve a focused experiment', requestedSlideCount: 2, preferences: ['Explain tradeoffs'] };
    control.workerFailure = true;
    const failedChangedBrief = await generate(started, projectId, changedBrief);
    assert.equal(failedChangedBrief.status, 422);
    const briefStale = await responseJson(await fetch(`${started.url}/api/projects/${projectId}/planning`));
    assert.equal(briefStale.status, 'stale', 'a failed attempt with a changed brief keeps the old plan marked stale');
    assert.equal(briefStale.deckPlan.hash, replanned.deckPlan.hash);
    assert.equal(briefStale.contentIR.hash, replanned.contentIR.hash, 'stale-plan citations retain the ContentIR snapshot that produced the displayed plan');

    control.workerFailure = false;
    const sourcePath = path.join(dataDir, 'projects', projectId, 'source.md');
    await writeFile(sourcePath, '# Retention\n\nNew source evidence changes the conclusion.', 'utf8');
    const contentStale = await responseJson(await fetch(`${started.url}/api/projects/${projectId}/planning`));
    assert.equal(contentStale.status, 'stale');
    assert.equal(contentStale.contentIR.hash, replanned.contentIR.hash);

    const changedTemplate = await makeSyntheticPptx({ slideCount: 3, layoutCount: 3 });
    assert.equal(await compileTemplate(started, projectId, changedTemplate), true);
    const templateStale = await responseJson(await fetch(`${started.url}/api/projects/${projectId}/planning`));
    assert.equal(templateStale.status, 'stale', 'recompiling a different canonical template invalidates the prior plan');
  } finally {
    await closeStartedServer(started);
  }
});

test('Planning API starts offline and reports inference configuration failure only when invoked', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-planning-offline-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  let factoryCalls = 0;
  const options = {
    host: '127.0.0.1', port: 0, dataDir: path.join(temp, 'data'), projectRoot: repoRoot, serveWeb: false, returnServer: true,
    semanticInferenceAdapterFactory: () => {
      factoryCalls += 1;
      throw new SemanticInferenceError('CONFIGURATION_ERROR', 'No test endpoint configured.');
    },
  };
  const started = await startServer(options);
  try {
    assert.equal(factoryCalls, 0, 'server startup must not construct the semantic adapter');
    await createProject(started, 'offline-project');
    if (!await compileTemplate(started, 'offline-project', await makeSyntheticPptx({ slideCount: 1, layoutCount: 1 }))) {
      t.skip('Python 3.12 unavailable: local template fixture cannot be compiled');
      return;
    }
    await upload(started, 'offline-project', 'source.md', Buffer.from('A supplied planning source.', 'utf8'));
    assert.equal(factoryCalls, 0, 'template compilation must not construct the semantic adapter');
    const response = await fetch(`${started.url}/api/projects/offline-project/planning/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentFiles: ['source.md'], brief: { audience: 'Team', purpose: 'Review', expectedOutcome: 'Align', preferences: [] } }),
    });
    assert.equal(response.status, 503);
    const result = await responseJson(response);
    assert.equal(result.error.code, 'INFERENCE_NOT_CONFIGURED');
    assert.match(result.error.message, /Set LCT_SEMANTIC_BASE_URL/);
    assert.equal(factoryCalls, 1);
  } finally {
    await closeStartedServer(started);
  }
});

test('planning input fingerprint changes when either versioned prompt asset changes', () => {
  const input = {
    templateIRHash: 'a'.repeat(64),
    presentationDesignSystemHash: 'b'.repeat(64),
    contentIRHash: 'c'.repeat(64),
    briefHash: 'd'.repeat(64),
    workerPromptSha256: 'e'.repeat(64),
    supervisorPromptSha256: 'f'.repeat(64),
  };
  const baseline = planningInputFingerprint(input);
  assert.notEqual(planningInputFingerprint({ ...input, workerPromptSha256: '1'.repeat(64) }), baseline);
  assert.notEqual(planningInputFingerprint({ ...input, supervisorPromptSha256: '2'.repeat(64) }), baseline);
});
