import assert from 'node:assert/strict';
import { access, readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { register } from 'tsx/esm/api';

import { makeSyntheticPptx } from '../python-inspector-test-fixtures.mjs';

register();
const { startServer } = await import('../src/server.ts');
const { SemanticInferenceError } = await import('../src/presentation/application/semantic-inference-port.ts');
const { planningInputFingerprint } = await import('../src/presentation/application/planning-service.ts');
const { deckPlanHash } = await import('../src/presentation/domain/deck-plan.ts');
const { AGENT_WORKFLOW_CONTRACT_SHA256, AGENT_WORKFLOW_VERSIONS } = await import('../src/presentation/application/workflow-versions.ts');

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
        narrativeRole: 'opening', purpose: 'Frame the decision.', takeaway: 'Retention requires a clear decision.',
        contentRefs: [], bodyPoints: [{ text: 'Задать контекст и сформулировать центральную мысль.', origin: 'generated-from-brief', evidenceRefs: [] }], semanticVisualType: 'none', targetDensity: 'compact',
      },
      {
        narrativeRole: 'content', purpose: 'Present supplied evidence.', takeaway: 'Source highlights retention constraint.',
        contentRefs: contentId === 'unknown-content' ? [] : [contentId],
        bodyPoints: [{ text: 'Показать логику решения и следующий шаг.', origin: 'generated-from-brief', evidenceRefs: [] }],
        semanticVisualType: 'diagram', targetDensity: 'balanced',
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
        takeaway: 'Retention is the growth constraint.', purpose: null, contentRef: null, semanticVisualType: null,
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
      control.schemas?.push({ operation: request.operation, name: request.output.name, schema: request.output.schema });
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
  const control = { reviewMode: 'pass', badWorker: null, workerFailure: false, calls: [], workerEvidence: [], schemas: [] };
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
    assert.equal(first.agentWorkflowVersions.worker.skillId, 'presentation-planning');
    assert.equal(first.agentWorkflowVersions.supervisor.agentVersion, 'plan-review-supervisor.v1');
    assert.deepEqual(first.deckPlan.slides.map((slide) => slide.order), [1, 2]);
    assert.ok(first.contentIR.units.some((unit) => first.deckPlan.slides[1].contentRefs.includes(unit.id)));
    assert.equal(Object.hasOwn(first.deckPlan.slides[1], 'geometry'), false);

    const savedPath = path.join(dataDir, 'projects', projectId, '.planning', 'state.json');
    const saved = JSON.parse(await readFile(savedPath, 'utf8'));
    assert.equal(saved.lastSuccessful.deckPlan.hash, first.deckPlan.hash);
    assert.equal(saved.lastSuccessful.telemetry.worker.model, 'fake-planner-v1');
    assert.equal(saved.lastSuccessful.telemetry.worker.finishReason, 'stop');
    assert.equal(saved.lastSuccessful.telemetry.supervisor.finishReason, 'stop');
    assert.equal(saved.lastSuccessful.agentWorkflowVersions.worker.schemaVersion, 'deck_plan_draft_v4');
    const workerSchema = control.schemas.find((item) => item.operation === 'deck-plan');
    assert.equal(workerSchema?.name, 'deck_plan_draft_v4');
    assert.equal(workerSchema?.schema.properties.slides.items.properties.takeaway.maxLength, 40);
    // Older schemaVersion=1 planning states did not store finishReason.
    delete saved.lastSuccessful.telemetry.worker.finishReason;
    delete saved.lastSuccessful.telemetry.supervisor.finishReason;
    await writeFile(savedPath, JSON.stringify(saved));
    await closeStartedServer(started);
    started = await startServer(options);
    const reloaded = await responseJson(await fetch(`${started.url}/api/projects/${projectId}/planning`));
    assert.equal(reloaded.status, 'ready');
    assert.equal(reloaded.deckPlan.hash, first.deckPlan.hash);

    const { readWorkspaceDraft } = await import('../../web/src/workspace-draft.ts');
    const draft = {
      updatedAt: Date.now() + 1,
      selectedContentFiles: ['source.md'],
      briefAudience: 'Руководители',
      briefPurpose: 'Выбрать приоритет',
      briefExpectedOutcome: 'Согласовать следующий шаг',
      briefPreferences: '',
      requestedSlideCount: '2',
    };
    await new Promise((resolve) => setTimeout(resolve, 20));
    const repeatedRead = await responseJson(await fetch(`${started.url}/api/projects/${projectId}/planning`));
    assert.equal(repeatedRead.updatedAt, reloaded.updatedAt, 'a read-only GET does not make saved planning state appear newer');
    assert.deepEqual(readWorkspaceDraft({ getItem: () => JSON.stringify(draft) }, projectId, repeatedRead.updatedAt, new Set(['source.md'])), draft,
      'a client draft edited after the last persisted plan survives a refresh planning read');

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
    assert.match(repaired.deckPlan.slides[1].takeaway, /Retention is the growth constraint/);

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
    assert.ok(mediaEvidence.sources.every((source) => ['text', 'brief-task', 'brief-context'].includes(source.kind)));
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

test('Planning API accepts a task and optional context with zero uploaded source files', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-planning-task-only-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const control = { reviewMode: 'pass', badWorker: null, workerFailure: false, calls: [], workerEvidence: [] };
  const options = {
    host: '127.0.0.1', port: 0, dataDir: path.join(temp, 'data'), projectRoot: repoRoot,
    serveWeb: false, returnServer: true, semanticInferenceAdapter: makeFakeAdapter(control),
  };
  let started = await startServer(options);
  const projectId = 'planning-task-only';
  try {
    await createProject(started, projectId);
    if (!await compileTemplate(started, projectId, await makeSyntheticPptx({ slideCount: 2, layoutCount: 2 }))) {
      t.skip('Python 3.12 unavailable: local template fixture cannot be compiled');
      return;
    }
    const brief = { purpose: 'Explain the onboarding objective without adding unsupported facts.', context: 'Keep the recommendation practical.', preferences: [], requestedSlideCount: 2 };
    const response = await generate(started, projectId, brief, []);
    assert.equal(response.status, 200, await response.clone().text());
    const planned = await responseJson(response);
    assert.equal(planned.status, 'ready');
    assert.deepEqual(planned.contentFiles, []);
    assert.deepEqual(planned.contentIR.sources.map((source) => source.kind), ['brief-task', 'brief-context']);
    assert.equal(planned.contentIR.hash, control.workerEvidence[0].hash);
    assert.deepEqual(control.workerEvidence[0].sources, [], 'brief instructions are not sent as source evidence');
    assert.deepEqual(control.workerEvidence[0].units, [], 'brief instructions are not sent as source content units');
    assert.ok(planned.deckPlan.slides.every((slide) => slide.contentRefs.length === 0));
    assert.ok(planned.deckPlan.slides.every((slide) => slide.bodyPoints?.length > 0
      && slide.bodyPoints.every((point) => point.origin === 'generated-from-brief')));
    assert.ok(!JSON.stringify(planned.deckPlan).includes(brief.purpose));
    assert.deepEqual(control.calls.map(({ role }) => role), ['worker', 'supervisor']);

    await closeStartedServer(started);
    started = await startServer(options);
    const reloaded = await responseJson(await fetch(`${started.url}/api/projects/${projectId}/planning`));
    assert.equal(reloaded.status, 'ready');
    assert.equal(reloaded.contentIR.hash, planned.contentIR.hash, 'task/context provenance is deterministic across reload');
  } finally {
    await closeStartedServer(started);
  }
});

test('legacy task-backed review references stay readable only for a saved plan so it can be replaced', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-planning-legacy-task-review-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const control = { reviewMode: 'pass', badWorker: null, workerFailure: false, calls: [], workerEvidence: [] };
  const options = {
    host: '127.0.0.1', port: 0, dataDir: path.join(temp, 'data'), projectRoot: repoRoot,
    serveWeb: false, returnServer: true, semanticInferenceAdapter: makeFakeAdapter(control),
  };
  const started = await startServer(options);
  const projectId = 'planning-legacy-task-review';
  try {
    await createProject(started, projectId);
    if (!await compileTemplate(started, projectId, await makeSyntheticPptx({ slideCount: 2, layoutCount: 2 }))) {
      t.skip('Python 3.12 unavailable: local template fixture cannot be compiled');
      return;
    }
    const brief = { purpose: 'Explain the onboarding objective.', preferences: [], requestedSlideCount: 2 };
    const generated = await generate(started, projectId, brief, []);
    assert.equal(generated.status, 200, await generated.clone().text());

    const statePath = path.join(temp, 'data', 'projects', projectId, '.planning', 'state.json');
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    const taskSource = saved.lastSuccessful.contentIR.sources.find((source) => source.kind === 'brief-task');
    const taskUnit = saved.lastSuccessful.contentIR.units.find((unit) => unit.sourceId === taskSource.id);
    assert.ok(taskUnit);
    saved.lastSuccessful.promptVersions.worker = 'worker-deck-plan.v2';
    saved.lastSuccessful.agentWorkflowVersions.worker.promptVersion = 'worker-deck-plan.v2';
    saved.lastSuccessful.agentWorkflowVersions.worker.schemaVersion = 'deck_plan_draft_v1';
    saved.lastSuccessful.review = {
      checkpointVersion: saved.lastSuccessful.checkpoint.version,
      outcome: 'warn',
      findings: [{ targetType: 'deck', slideId: null, severity: 'medium', reason: 'Legacy saved review cited the task instruction.', evidenceRefs: [taskUnit.id] }],
      operations: [],
    };
    await writeFile(statePath, `${JSON.stringify(saved, null, 2)}\n`);

    const readable = await responseJson(await fetch(`${started.url}/api/projects/${projectId}/planning`));
    assert.equal(readable.status, 'ready', 'old persisted plan can be loaded for stale-state recovery');
    assert.deepEqual(readable.review.findings[0].evidenceRefs, [taskUnit.id]);

    const replaced = await generate(started, projectId, brief, []);
    assert.equal(replaced.status, 200, await replaced.clone().text());
    const current = await responseJson(replaced);
    assert.equal(current.status, 'ready');
    assert.equal(current.deckPlan.slides.every((slide) => slide.bodyPoints?.length > 0), true);
    assert.equal(current.deckPlan.slides.every((slide) => slide.contentRefs.length === 0), true);
    assert.deepEqual(control.calls.slice(-2).map(({ role }) => role), ['worker', 'supervisor']);
    assert.deepEqual(control.workerEvidence.at(-1).units, [], 'new planning never sends task text as source evidence');
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

test('deleting a project cancels and drains an in-flight planning request before removing its files', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-planning-delete-'));
  let enterInference;
  const inferenceStarted = new Promise((resolve) => { enterInference = resolve; });
  let abortObserved = false;
  const adapter = {
    infer(request) {
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          abortObserved = true;
          reject(new Error('cancelled by project deletion'));
        }, { once: true });
        enterInference();
      });
    },
  };
  const started = await startServer({
    host: '127.0.0.1', port: 0, dataDir: path.join(temp, 'data'), projectRoot: repoRoot,
    serveWeb: false, returnServer: true, semanticInferenceAdapter: adapter,
  });
  const projectId = 'planning-delete-inflight';
  t.after(async () => {
    await closeStartedServer(started);
    await rm(temp, { recursive: true, force: true });
  });
  await createProject(started, projectId);
  if (!await compileTemplate(started, projectId, await makeSyntheticPptx({ slideCount: 1, layoutCount: 1 }))) {
    t.skip('Python 3.12 unavailable: local template fixture cannot be compiled');
    return;
  }
  await upload(started, projectId, 'source.md', Buffer.from('Evidence for a bounded planning cancellation test.', 'utf8'));
  const planRequest = generate(started, projectId);
  await Promise.race([inferenceStarted, new Promise((_, reject) => setTimeout(() => reject(new Error('planning did not reach inference')), 10_000))]);
  const deletion = await fetch(`${started.url}/api/projects/${projectId}`, { method: 'DELETE' });
  assert.equal(deletion.status, 200, await deletion.clone().text());
  assert.equal(abortObserved, true);
  const cancelledResponse = await planRequest;
  assert.equal(cancelledResponse.status, 409);
  assert.equal((await responseJson(cancelledResponse)).error.code, 'PLANNING_CANCELLED');
  assert.equal((await fetch(`${started.url}/api/projects/${projectId}`)).status, 404);
  await assert.rejects(access(path.join(temp, 'data', 'projects', projectId)), { code: 'ENOENT' });
});

test('planning input fingerprint changes when prompt assets or the agent workflow contract changes', () => {
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
  assert.notEqual(planningInputFingerprint({ ...input, contentBudgetProfileSha256: '3'.repeat(64) }), baseline);
  assert.notEqual(planningInputFingerprint({ ...input, agentWorkflowContractSha256: '3'.repeat(64) }), baseline);
  assert.equal(AGENT_WORKFLOW_VERSIONS.worker.promptVersion, 'worker-deck-plan.v7');
  assert.equal(AGENT_WORKFLOW_VERSIONS.worker.schemaVersion, 'deck_plan_draft_v4');
  assert.equal(AGENT_WORKFLOW_VERSIONS.supervisor.schemaVersion, 'supervisor_plan_review_v1');
  assert.match(AGENT_WORKFLOW_CONTRACT_SHA256, /^[a-f0-9]{64}$/);
});

test('legacy v4 generated-copy title overflow invalidates only the saved plan and preserves inputs for replanning', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-planning-legacy-title-'));
  const dataDir = path.join(temp, 'data');
  const control = { reviewMode: 'pass', badWorker: null, workerFailure: false, calls: [], workerEvidence: [], schemas: [] };
  const adapter = makeFakeAdapter(control);
  const options = { host: '127.0.0.1', port: 0, dataDir, projectRoot: repoRoot, serveWeb: false, returnServer: true, semanticInferenceAdapter: adapter };
  let started = await startServer(options);
  const projectId = 'planning-legacy-title-overflow';
  t.after(async () => {
    await closeStartedServer(started);
    await rm(temp, { recursive: true, force: true });
  });

  await createProject(started, projectId);
  if (!await compileTemplate(started, projectId, await makeSyntheticPptx({ slideCount: 2, layoutCount: 2 }))) {
    t.skip('Python 3.12 unavailable: local template fixture cannot be compiled');
    return;
  }
  await upload(started, projectId, 'source.md', Buffer.from('# Retention\n\nRetention is the limiting factor for sustained growth.', 'utf8'));
  const initial = await generate(started, projectId);
  assert.equal(initial.status, 200, await initial.clone().text());
  assert.equal((await responseJson(initial)).status, 'ready');

  const savedPath = path.join(dataDir, 'projects', projectId, '.planning', 'state.json');
  const legacy = JSON.parse(await readFile(savedPath, 'utf8'));
  assert.equal(legacy.lastSuccessful.promptVersions.worker, 'worker-deck-plan.v7');
  // Recreate the persisted v4 violation that existed before the generated title cap.
  legacy.lastSuccessful.promptVersions.worker = 'worker-deck-plan.v4';
  const longTitle = 'A legacy generated-copy title exceeding the current forty character limit';
  for (const plan of [legacy.currentCheckpoint, legacy.lastSuccessful.checkpoint, legacy.lastSuccessful.deckPlan]) {
    if (!plan) continue;
    plan.slides[0].takeaway = longTitle;
    const { hash: _oldHash, ...payload } = plan;
    plan.hash = deckPlanHash(payload);
  }
  await writeFile(savedPath, JSON.stringify(legacy));
  const callsBeforeReload = control.calls.length;

  await closeStartedServer(started);
  started = await startServer(options);
  const recovered = await responseJson(await fetch(`${started.url}/api/projects/${projectId}/planning`));
  assert.equal(recovered.status, 'ready_for_planning');
  assert.equal(recovered.deckPlan, null);
  assert.equal(recovered.contentIR.hash, legacy.inputs.contentIR.hash);
  assert.equal(recovered.brief.purpose, legacy.inputs.brief.purpose);
  assert.equal(control.calls.length, callsBeforeReload, 'state recovery must not make an inference request');

  const migrated = JSON.parse(await readFile(savedPath, 'utf8'));
  assert.equal(migrated.status, 'ready_for_planning');
  assert.equal(migrated.lastSuccessful, null);
  assert.equal(migrated.currentCheckpoint, null);
  assert.deepEqual(migrated.inputs.contentFiles, legacy.inputs.contentFiles);
  const replanned = await generate(started, projectId);
  assert.equal(replanned.status, 200, await replanned.clone().text());
  const fresh = await responseJson(replanned);
  assert.equal(fresh.status, 'ready');
  assert.ok(fresh.deckPlan.slides.every((slide) => slide.takeaway.length <= 40));
  assert.equal(control.calls.filter((call) => call.operation === 'deck-plan').length, 2);
});
