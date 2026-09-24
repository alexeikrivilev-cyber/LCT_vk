import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { briefHash, validateBrief } from '../src/presentation/domain/brief.js';
import { contentSourceId, contentUnitId, finalizeContentIR } from '../src/presentation/domain/content-ir.js';
import { canonicalizeDeckPlan } from '../src/presentation/domain/deck-plan.js';
import {
  SUPERVISOR_PLAN_REVIEW_PROMPT_VERSION,
  WORKER_PLAN_PROMPT_VERSION,
} from '../src/presentation/application/planning-service.js';
import { evaluatePlanningState } from '../../../scripts/evaluate-planning-runs.mjs';

function savedPlanningState() {
  const sourceText = '# Retention\n31% of surveyed new customers cancelled within 90 days.';
  const sourceHash = createHash('sha256').update(sourceText, 'utf8').digest('hex');
  const sourcePath = 'source.md';
  const sourceId = contentSourceId(sourcePath, 0, sourceHash);
  const source = {
    id: sourceId,
    sourcePath,
    originalName: sourcePath,
    mediaType: 'text/markdown; charset=utf-8',
    sha256: sourceHash,
    order: 0,
    byteLength: Buffer.byteLength(sourceText, 'utf8'),
    kind: 'text',
    text: sourceText,
    warnings: [],
  };
  const unitValue = {
    sourceId,
    order: 0,
    kind: 'text',
    locator: { startByte: 0, endByte: Buffer.byteLength(sourceText, 'utf8') },
    text: sourceText,
  };
  const contentIR = finalizeContentIR([source], [{ id: contentUnitId(sourceId, unitValue), ...unitValue }]);
  const brief = validateBrief({
    audience: 'Board',
    purpose: 'Choose a retention experiment',
    expectedOutcome: 'Approve one measured pilot',
    requestedSlideCount: 2,
    preferences: [],
  });
  const inputFingerprint = 'a'.repeat(64);
  const allowedContentIds = new Set(contentIR.units.map((unit) => unit.id));
  const checkpoint = canonicalizeDeckPlan({
    workingTitle: 'Retention needs an onboarding pilot',
    narrativeSummary: 'Show the cancellation signal and propose a bounded pilot.',
    slides: [
      { narrativeRole: 'opening', purpose: 'State the decision', takeaway: 'Test onboarding before scaling acquisition.', contentRefs: [], semanticVisualType: 'none', targetDensity: 'compact' },
      { narrativeRole: 'content', purpose: 'Show the signal', takeaway: '31% of surveyed new customers cancelled within 90 days.', contentRefs: [contentIR.units[0].id], semanticVisualType: 'none', targetDensity: 'balanced' },
    ],
  }, {
    id: 'dp_fixture',
    version: 1,
    createdAt: '2026-09-25T00:00:00.000Z',
    inputFingerprint,
    briefHash: briefHash(brief),
    allowedContentIds,
    requestedSlideCount: brief.requestedSlideCount,
  });
  const telemetry = (requestId, wallTimeMs) => ({
    model: 'fixture-model', requestId, providerRequestId: null,
    startedAt: '2026-09-25T00:00:00.000Z', finishedAt: '2026-09-25T00:00:01.000Z', wallTimeMs,
    promptTokens: null, completionTokens: null,
  });
  const inputs = { contentFiles: [sourcePath], brief, contentIR, inputFingerprint };
  return {
    schemaVersion: 1,
    updatedAt: '2026-09-25T00:00:02.000Z',
    status: 'ready',
    inputs,
    lastSuccessful: {
      ...inputs,
      checkpoint,
      deckPlan: checkpoint,
      review: { checkpointVersion: 1, outcome: 'pass', findings: [], operations: [] },
      telemetry: { worker: telemetry('worker-fixture', 1800), supervisor: telemetry('supervisor-fixture', 700), totalWallTimeMs: 2500 },
      promptVersions: { worker: WORKER_PLAN_PROMPT_VERSION, supervisor: SUPERVISOR_PLAN_REVIEW_PROMPT_VERSION },
      model: 'fixture-model',
      createdAt: '2026-09-25T00:00:02.000Z',
    },
    failure: null,
    currentCheckpoint: checkpoint,
  };
}

test('planning evaluator uses production validators and leaves semantic claims for manual review', () => {
  const report = evaluatePlanningState(savedPlanningState(), 'fixture-run');
  assert.deepEqual(report, {
    run_id: 'fixture-run',
    schema_valid: true,
    slide_count_valid: true,
    references_valid: true,
    unsupported_claim_count: null,
    supervisor_outcome: 'pass',
    worker_latency_ms: 1800,
    supervisor_latency_ms: 700,
    finish_reason: { worker: null, supervisor: null },
    planning_state_persisted: true,
    failure_code: null,
    manual_review: {
      content_fidelity: null,
      title_takeaways: null,
      narrative_coherence: null,
      visual_relevance: null,
      notes: null,
    },
  });
});

test('planning evaluator retains available provider finish reasons', () => {
  const state = savedPlanningState();
  state.lastSuccessful.telemetry.worker.finishReason = 'stop';
  state.lastSuccessful.telemetry.supervisor.finishReason = 'length';
  assert.deepEqual(evaluatePlanningState(state).finish_reason, { worker: 'stop', supervisor: 'length' });
});

test('planning evaluator reports dangling evidence and slide-count mismatch', () => {
  const state = savedPlanningState();
  state.lastSuccessful.deckPlan.slides[1].contentRefs = ['unit_missing'];
  const report = evaluatePlanningState(state);
  assert.equal(report.references_valid, false);
  assert.equal(report.schema_valid, false);
  assert.equal(report.planning_state_persisted, false);

  const mismatched = savedPlanningState();
  mismatched.lastSuccessful.brief.requestedSlideCount = 3;
  const countReport = evaluatePlanningState(mismatched);
  assert.equal(countReport.slide_count_valid, false);
});

test('planning evaluation CLI compares multiple saved states without contacting inference', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-planning-evaluation-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const paths = [];
  for (const runId of ['run-1', 'run-2']) {
    const directory = path.join(temp, runId);
    await mkdir(directory, { recursive: true });
    const statePath = path.join(directory, 'state.json');
    await writeFile(statePath, JSON.stringify(savedPlanningState()), 'utf8');
    paths.push(statePath);
  }

  const scriptPath = fileURLToPath(new URL('../../../scripts/evaluate-planning-runs.mjs', import.meta.url));
  const repoRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const result = spawnSync(process.execPath, ['--import', 'tsx', scriptPath, ...paths], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).runs.map((run) => run.run_id), ['run-1', 'run-2']);
  assert.ok(JSON.parse(result.stdout).runs.every((run) => run.planning_state_persisted));
});

test('offline planning scenarios are compact, parseable, and explicitly synthetic', async () => {
  const fixtureRoot = fileURLToPath(new URL('./fixtures/planning-scenarios/', import.meta.url));
  const scenarioDirectories = (await readdir(fixtureRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.equal(scenarioDirectories.length, 5);

  for (const scenario of scenarioDirectories) {
    const source = await readFile(path.join(fixtureRoot, scenario, 'source.md'), 'utf8');
    const brief = validateBrief(JSON.parse(await readFile(path.join(fixtureRoot, scenario, 'brief.json'), 'utf8')));
    assert.match(source, /Synthetic case/);
    assert.ok(Buffer.byteLength(source, 'utf8') < 2_000);
    assert.equal(typeof brief.audience, 'string');
    assert.ok(Number.isInteger(brief.requestedSlideCount));
  }
});
