import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { register } from 'tsx/esm/api';

register();
const { runLiveQualification } = await import('../../../scripts/run-live-quality-suite.mjs');
const { startFakeSemanticEndpoint } = await import('../../../scripts/lib/fake-openai-compatible-endpoint.mjs');
const repoRoot = path.resolve(import.meta.dirname, '../../..');
const expectedModel = 'Qwen/Qwen3.8-27B';

function completion(model, value, finishReason = 'stop') {
  return {
    id: 'offline-fake-request',
    model,
    choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content: typeof value === 'string' ? value : JSON.stringify(value) } }],
    usage: { prompt_tokens: 32, completion_tokens: 16 },
  };
}

function planningResponse(request, options = {}) {
  const schemaName = request.response_format?.json_schema?.name;
  if (schemaName === 'lct_worker_smoke_v1') {
    return completion(request.model, { status: 'ok', summary: 'Strict JSON response passed.', nextAction: 'Continue with planning.' });
  }
  const evidence = JSON.parse(request.messages.at(-1).content);
  if (schemaName === 'deck_plan_draft_v1') {
    const unit = evidence.contentIR.units.find((candidate) => candidate.kind !== 'media-reference');
    const count = Math.max(1, evidence.requestedSlideCount ?? 1);
    const ordinals = ['first', 'second', 'third', 'fourth', 'fifth'];
    return completion(request.model, {
      workingTitle: 'Evidence supports the planning scenario',
      narrativeSummary: 'The slides summarize the supplied source content.',
      slides: Array.from({ length: count }, (_, index) => ({
        narrativeRole: 'content',
        purpose: `Summarize the ${ordinals[index] ?? 'next'} source segment.`,
        takeaway: `The supplied source supports the ${ordinals[index] ?? 'next'} section${options.unsupportedNumber ? ' with value 99999' : ''}.`,
        contentRefs: [options.runtimeInvalidPlan ? 'invented-content-unit' : unit.id],
        mediaRefs: [],
        semanticVisualType: 'none',
        targetDensity: 'balanced',
      })),
    });
  }
  if (schemaName === 'supervisor_plan_review_v1') {
    return completion(request.model, { checkpointVersion: evidence.checkpointVersion, outcome: 'pass', findings: [], operations: [] });
  }
  return completion(request.model, { unknown: true });
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function fakeEndpoint(options = {}) {
  return startFakeSemanticEndpoint({
    model: expectedModel,
    wrongModel: options.wrongModel,
    failure: options.failure,
    respond: (request) => planningResponse(request, options),
  });
}

async function runAgainst(endpoint, mode, runId, overrides = {}) {
  const env = {
    LCT_SEMANTIC_BASE_URL: endpoint.baseUrl,
    LCT_SEMANTIC_MODEL: expectedModel,
    LCT_SEMANTIC_ENABLE_THINKING: 'false',
    ...(overrides.apiKey ? { LCT_SEMANTIC_API_KEY: overrides.apiKey } : {}),
  };
  return runLiveQualification({
    mode,
    runId,
    outputRoot: path.join(repoRoot, '.lct', 'experiments'),
    env,
    backend: 'office-kit',
    providerKind: 'local',
    profile: 'OFFLINE_FAKE',
    localSemanticMatrix: true,
    previewAdapter: {
      async preview(_pptx, index) {
        return { slideCount: 5, png: new Uint8Array([index, 1]), svg: `<svg>${index}</svg>`, textLayoutIssues: [], status: 'passed', limitations: [] };
      },
    },
  });
}

async function removeRun(runId) {
  await rm(path.join(repoRoot, '.lct', 'experiments', runId), { recursive: true, force: true });
}

async function findFiles(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await findFiles(candidate));
    else result.push(candidate);
  }
  return result;
}

test('smoke performs health/models, one strict request, Worker/Supervisor, persisted replay, and local A/B/C only', async (t) => {
  const endpoint = await fakeEndpoint();
  const runId = `test-live-smoke-${process.pid}`;
  t.after(async () => { await endpoint.close(); await removeRun(runId); });
  const secret = 'offline-test-secret-value';
  const result = await runAgainst(endpoint, 'smoke', runId, { apiKey: secret });
  assert.equal(endpoint.state.healthCalls, 1);
  assert.equal(endpoint.state.modelCalls, 1);
  assert.deepEqual(endpoint.state.inference.map((item) => item.operation), ['smoke.worker', 'deck-plan', 'plan-review']);
  assert.ok(endpoint.state.authHeaders.every((header) => header === `Bearer ${secret}`));
  assert.equal(result.summary.semanticInferenceCalls, 3);
  assert.equal(result.summary.expectedMaximumInferenceCalls, 3);
  assert.equal(result.summary.failureCode, null, JSON.stringify({ failure: result.summary.failureCode, scenario: result.summary.scenarios[0] }));
  assert.equal(result.summary.strictJson.status, 'passed');
  assert.equal(result.summary.scenarios[0].planning_state_persisted, true);
  assert.equal(result.summary.scenarios[0].schema_valid, true);
  assert.equal(result.summary.scenarios[0].references_valid, true);
  assert.equal(result.summary.scenarios[0].pptx_validation, 'passed');
  const matrix = JSON.parse(await readFile(path.join(result.outDir, 'retention-growth', 'matrix', 'matrix.json'), 'utf8'));
  assert.equal(matrix.inferenceRequests, 1, 'the matrix uses one local fake template-profile request');
  assert.equal(matrix.outputCount, 3);
  assert.ok(matrix.outputs.every((item) => item.previewStatus === 'passed'));
  assert.ok(await readFile(path.join(result.outDir, 'retention-growth', 'previews', 'variant-a', 'slide-01.png')));
  const files = await findFiles(result.outDir);
  const bytes = await Promise.all(files.map((file) => readFile(file)));
  assert.ok(bytes.every((content) => !content.includes(Buffer.from(secret))));
  assert.ok(bytes.every((content) => !content.includes(Buffer.from(endpoint.baseUrl))));
  assert.equal(result.manifest.endpointStored, false);
  assert.equal(result.manifest.secretsStored, false);
});

test('suite is sequential, stops at five scenarios, and caps remote calls at Worker plus Supervisor per scenario', async (t) => {
  const endpoint = await fakeEndpoint();
  const runId = `test-live-suite-${process.pid}`;
  t.after(async () => { await endpoint.close(); await removeRun(runId); });
  const result = await runAgainst(endpoint, 'suite', runId);
  assert.equal(result.summary.failureCode, null, JSON.stringify({ failure: result.summary.failureCode, scenario: result.summary.scenarios[0] }));
  assert.equal(result.summary.scenarios.length, 5);
  assert.equal(result.summary.expectedMaximumInferenceCalls, 10);
  assert.equal(result.summary.semanticInferenceCalls, 10);
  assert.deepEqual(endpoint.state.inference.map((item) => item.operation), Array.from({ length: 5 }, () => ['deck-plan', 'plan-review']).flat());
  for (const scenario of result.summary.scenarios) {
    const matrix = JSON.parse(await readFile(path.join(result.outDir, scenario.scenario, 'matrix', 'matrix.json'), 'utf8'));
    assert.equal(matrix.inferenceRequests, 1, 'each scenario profiles its template through the local fake endpoint');
    assert.equal(matrix.outputCount, 3);
    assert.ok(matrix.outputs.every((item) => item.previewStatus === 'passed'));
  }
});

test('strict-schema failures, 524, null content, truncation, and malformed JSON stop without retry', async (t) => {
  for (const [label, failure, expectedCalls, code] of [
    ['strict-invalid', (_role, operation) => operation === 'smoke.worker' ? 'invalid-schema' : null, 1, 'INVALID_STRUCTURED_OUTPUT'],
    ['worker-524', (role, operation) => role === 'worker' && operation === 'deck-plan' ? 'http-524' : null, 2, 'HTTP_524'],
    ['worker-null', (role, operation) => role === 'worker' && operation === 'deck-plan' ? 'content-null' : null, 2, 'EMPTY_RESPONSE'],
    ['worker-length', (role, operation) => role === 'worker' && operation === 'deck-plan' ? 'length' : null, 2, 'INVALID_STRUCTURED_OUTPUT'],
    ['worker-malformed', (role, operation) => role === 'worker' && operation === 'deck-plan' ? 'malformed-json' : null, 2, 'INVALID_JSON'],
  ]) {
    await t.test(label, async (subtest) => {
      const endpoint = await fakeEndpoint({ failure });
      const runId = `test-live-${label}-${process.pid}`;
      subtest.after(async () => { await endpoint.close(); await removeRun(runId); });
      const result = await runAgainst(endpoint, 'smoke', runId);
      assert.equal(result.summary.failureCode, code);
      assert.equal(endpoint.state.inference.length, expectedCalls);
      assert.equal(result.summary.semanticInferenceCalls, expectedCalls);
      assert.equal(result.summary.scenarios.length, label === 'strict-invalid' ? 0 : 1);
    });
  }
});

test('model mismatch and unavailable endpoint fail before semantic requests', async (t) => {
  const endpoint = await fakeEndpoint({ wrongModel: true });
  const mismatchRun = `test-live-model-mismatch-${process.pid}`;
  t.after(async () => { await endpoint.close(); await removeRun(mismatchRun); });
  const mismatch = await runAgainst(endpoint, 'smoke', mismatchRun);
  assert.equal(mismatch.summary.failureCode, 'MODEL_ALIAS_MISMATCH');
  assert.equal(endpoint.state.inference.length, 0);

  const closedServer = createServer();
  const port = await listen(closedServer);
  await new Promise((resolve) => closedServer.close(resolve));
  const dead = { baseUrl: `http://127.0.0.1:${port}/v1`, state: { inference: [] } };
  const unavailableRun = `test-live-unavailable-${process.pid}`;
  t.after(() => removeRun(unavailableRun));
  const unavailable = await runAgainst(dead, 'smoke', unavailableRun);
  assert.equal(unavailable.summary.failureCode, 'ENDPOINT_UNAVAILABLE');
  assert.equal(unavailable.summary.semanticInferenceCalls, 0);
});

test('a suite failure stops before later scenarios and never retries a 524', async (t) => {
  const endpoint = await fakeEndpoint({ failure: (role, operation) => role === 'worker' && operation === 'deck-plan' ? 'http-524' : null });
  const runId = `test-live-suite-stop-${process.pid}`;
  t.after(async () => { await endpoint.close(); await removeRun(runId); });
  const result = await runAgainst(endpoint, 'suite', runId);
  assert.equal(result.summary.failureCode, 'HTTP_524');
  assert.equal(endpoint.state.inference.length, 1);
  assert.equal(result.summary.scenarios.length, 1);
  assert.equal(result.summary.semanticInferenceCalls, 1);
});

test('runtime-invalid DeckPlan output stops after the Worker response', async (t) => {
  const endpoint = await fakeEndpoint({ runtimeInvalidPlan: true });
  const runId = `test-live-invalid-plan-${process.pid}`;
  t.after(async () => { await endpoint.close(); await removeRun(runId); });
  const result = await runAgainst(endpoint, 'smoke', runId);
  assert.equal(result.summary.failureCode, 'INVALID_STRUCTURED_OUTPUT');
  assert.equal(endpoint.state.inference.length, 2, 'the Supervisor and every later request must be skipped');
  assert.equal(result.summary.scenarios[0].schema_valid, false);
});

test('a deterministic unsupported-number blocker stops the quality suite', async (t) => {
  const endpoint = await fakeEndpoint({ unsupportedNumber: true });
  const runId = `test-live-audit-stop-${process.pid}`;
  t.after(async () => { await endpoint.close(); await removeRun(runId); });
  const result = await runAgainst(endpoint, 'suite', runId);
  assert.equal(result.summary.failureCode, 'REPEATED_UNSUPPORTED_NUMERIC', JSON.stringify(result.summary.scenarios[0]));
  assert.ok(result.summary.scenarios[0].unsupported_numeric_repeats > 0);
  assert.equal(endpoint.state.inference.length, 2);
  assert.equal(result.summary.scenarios.length, 1, 'later suite cases must be skipped after the audit blocker');
});
