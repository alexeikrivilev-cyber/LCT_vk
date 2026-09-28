import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startFakeSemanticEndpoint } from './lib/fake-openai-compatible-endpoint.mjs';
import { assertQualificationPptxBackend, createRequestBudgetAdapter, parseArgs, runCli, runProductE2E,
  validateQualificationSemanticOperationAccounting } from './run-product-e2e.mjs';
import { DEFAULT_PPTX_BACKEND, QUALIFICATION_PPTX_BACKEND, parsePptxBackend } from '../apps/daemon/src/presentation/application/pptx-backend-port.ts';
import { SemanticInferenceError } from '../apps/daemon/src/presentation/application/semantic-inference-port.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(repoRoot, 'apps/daemon/package.json'));

async function tempPptxPath(t) {
  const scratch = await mkdtemp(path.join(repoRoot, '.lct', 'product-e2e-input-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  const target = path.join(scratch, 'preflight-input.pptx');
  await writeFile(target, await readFile(fileURLToPath(import.meta.url)));
  return target;
}

function configEnv(overrides = {}) {
  return {
    LCT_SEMANTIC_BASE_URL: 'https://inference.example.test/v1',
    LCT_SEMANTIC_MODEL: 'Qwen/Qwen3.8-27B',
    LCT_SEMANTIC_API_KEY: 'runner-test-secret-do-not-print',
    LCT_SEMANTIC_ENABLE_THINKING: 'false',
    ...overrides,
  };
}

async function makeTemplate(filePath, { slideCount = 3 } = {}) {
  const PptxGenJS = require('pptxgenjs');
  const deck = new PptxGenJS();
  deck.layout = 'LAYOUT_WIDE';
  deck.author = 'Product E2E runner integration test';
  const masters = [
    { title: 'LCT_E2E_BALANCED', titleBox: { x: 0.6, y: 0.35, w: 12, h: 0.8 }, bodyBoxes: [{ x: 0.75, y: 1.55, w: 11.5, h: 4.8 }] },
    { title: 'LCT_E2E_SPLIT', titleBox: { x: 0.6, y: 0.35, w: 12, h: 0.8 }, bodyBoxes: [{ x: 0.75, y: 1.65, w: 5.4, h: 4.5 }, { x: 6.95, y: 1.65, w: 5.4, h: 4.5 }] },
    { title: 'LCT_E2E_SPACIOUS', titleBox: { x: 1.1, y: 0.7, w: 10.8, h: 1.05 }, bodyBoxes: [{ x: 1.1, y: 2.2, w: 8.2, h: 3.55 }] },
  ];
  for (let index = 0; index < slideCount; index += 1) {
    const master = masters[index % masters.length];
    deck.defineSlideMaster({
      title: master.title,
      background: { color: 'FFFFFF' },
      objects: [
        { placeholder: { options: { name: `E2E_TITLE_${index}`, type: 'title', ...master.titleBox, fontFace: 'Aptos Display', fontSize: 26, bold: true } } },
        ...master.bodyBoxes.map((box, bodyIndex) => ({ placeholder: { options: { name: `E2E_BODY_${index}_${bodyIndex}`, type: 'body', ...box, fontFace: 'Aptos', fontSize: 18 } } })),
      ],
    });
    const slide = deck.addSlide({ masterName: master.title });
    slide.addText(`Шаблон для интеграционной проверки ${index + 1}`, { placeholder: `E2E_TITLE_${index}` });
    slide.addText('Редактируемое содержимое заменяется продуктовым потоком.', { placeholder: `E2E_BODY_${index}_0` });
    if (master.bodyBoxes.length > 1) slide.addText('Дополнительная колонка для сравнения.', { placeholder: `E2E_BODY_${index}_1` });
    if (index === 2) slide.addShape(deck.ShapeType.rect, { x: 9.7, y: 2.55, w: 1.6, h: 1.6, fill: { color: 'D9EAF7' }, line: { color: 'D9EAF7' } });
  }
  await deck.writeFile({ fileName: filePath });
}

function workflowOptions(templatePath, outputDir, slides, task, enableTemplateProfiler = true) {
  return { mode: 'fake', templatePath, task, context: '', sources: [], slides, providerLabel: 'local-test', outputDir,
    enableTemplateProfiler, maxSemanticRequests: enableTemplateProfiler ? 36 : 4, dryRun: false, preflightOnly: false };
}

test('CLI validates external dry-run config without making any network request or printing secrets', async (t) => {
  let calls = 0;
  const env = configEnv();
  const template = await tempPptxPath(t);
  const args = ['--semantic-mode', 'external', '--provider-label', 'runpod', '--template', template,
    '--task', 'Проверить dry-run', '--slides', '3', '--dry-run'];
  const result = await runCli(args, { environment: env, fetcher: async () => { calls += 1; throw new Error('must not fetch'); } });
  assert.equal(result.exitCode, 0);
  assert.equal(calls, 0);
  assert.equal(result.report.wouldStartDaemon, false);
  assert.equal(result.report.wouldCallEndpoint, false);
  assert.equal(result.report.providerLabel, 'runpod');
  const serialized = JSON.stringify(result.report);
  assert.ok(!serialized.includes(env.LCT_SEMANTIC_API_KEY));
  assert.ok(!serialized.includes(env.LCT_SEMANTIC_BASE_URL));
});

test('external preflight sends only one models GET and never sends chat completion', async (t) => {
  const endpoint = await startFakeSemanticEndpoint({ model: 'Qwen/Qwen3.8-27B' });
  t.after(() => endpoint.close());
  const env = configEnv({ LCT_SEMANTIC_BASE_URL: endpoint.baseUrl });
  const template = await tempPptxPath(t);
  const result = await runCli(['--semantic-mode', 'external', '--template', template,
    '--task', 'Проверить внешний preflight', '--preflight-only'], { environment: env });
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.modelsReachable, true);
  assert.equal(result.report.modelsRequests, 1);
  assert.equal(result.report.chatCompletionRequests, 0);
  assert.equal(endpoint.state.modelCalls, 1);
  assert.equal(endpoint.state.inference.length, 0);
  const serialized = JSON.stringify(result.report);
  assert.ok(!serialized.includes(env.LCT_SEMANTIC_API_KEY));
  assert.ok(!serialized.includes(env.LCT_SEMANTIC_BASE_URL));
});

test('versioned qualification contract separates core, profile preparation, and full workflow budgets', () => {
  const contract = JSON.parse(readFileSync(path.join(repoRoot, 'scripts/lib/live-qualification-contract.json'), 'utf8'));
  assert.equal(contract.schemaVersion, 7);
  assert.equal(contract.coreMaxSemanticRequests, 4);
  assert.equal(contract.profilePreparationMaxSemanticRequests, 32);
  assert.equal(contract.fullWorkflowMaxSemanticRequests, 36);
  assert.equal(contract.profilerDiagnosticMaxSemanticRequests, 36);
  assert.equal(contract.maxProfilerRequests, 32);
  assert.deepEqual(contract.requiredOperations, { 'deck-plan': 1, 'plan-review': 1, 'contextual-deck-audit': 1 });
  assert.deepEqual(contract.optionalOperations, { 'deck-plan-revision': { min: 0, max: 1 } });
  assert.equal(contract.generationSemanticRequests, 0);
});

test('product CLI uses full qualification budget while the adapter separately caps core generation', () => {
  const core = ['--semantic-mode', 'external', '--template', 'x.pptx', '--task', 'x'];
  const coreOptions = parseArgs(core);
  assert.equal(coreOptions.maxSemanticRequests, 36);
  assert.equal(coreOptions.enableTemplateProfiler, true);
  assert.equal(parseArgs([...core, '--max-semantic-requests', '20']).maxSemanticRequests, 20);
  assert.throws(() => parseArgs([...core, '--max-semantic-requests', '37']), /between 1 and 36/u);
  assert.equal(parseArgs([...core, '--preflight-only']).preflightOnly, true);
  assert.throws(() => parseArgs(['--semantic-mode', 'fake', '--template', 'x.pptx', '--task', 'x', '--preflight-only']), /requires --semantic-mode external/u);
});

test('canonical runner prepares and caches the semantic profile before the UI workflow', async () => {
  const source = await readFile(path.join(repoRoot, 'scripts/run-product-e2e.mjs'), 'utf8');
  assert.match(source, /\/template\/compile/u);
  assert.match(source, /\/workflow\/generate/u);
  assert.ok(source.indexOf('/template/compile') < source.indexOf('/workflow/generate'));
  assert.doesNotMatch(source, /\/planning\/generate|TemplateSemanticProfiler|PlanningService|GenerationService/u);
  assert.doesNotMatch(source, /env\.LCT_PPTX_BACKEND\s*=/u, 'runner must use the same configured backend as the UI');
  assert.match(source, /enableSemanticProfiling:\s*options\.enableTemplateProfiler/u);
  assert.match(source, /readiness\.checks\?\.pptxBackend/u);
  assert.match(source, /generation\.backend/u);
});

test('release PPTX backend is office-kit across defaults, env example, runner and docs', async () => {
  assert.equal(QUALIFICATION_PPTX_BACKEND, 'office-kit');
  assert.equal(DEFAULT_PPTX_BACKEND, 'office-kit');
  assert.equal(parsePptxBackend(undefined), 'office-kit');
  assert.equal(parsePptxBackend(null), 'office-kit');
  assert.equal(parsePptxBackend(''), 'office-kit');
  assert.equal(parsePptxBackend('office-kit'), 'office-kit');
  assert.equal(parsePptxBackend('custom'), 'custom');
  assert.throws(() => parsePptxBackend('unknown'), /LCT_PPTX_BACKEND must be custom or office-kit/u);
  assert.equal(assertQualificationPptxBackend('office-kit'), 'office-kit');
  assert.throws(() => assertQualificationPptxBackend('custom'), (error) => error.code === 'PPTX_BACKEND_MISMATCH');

  const env = await readFile(path.join(repoRoot, '.env.example'), 'utf8');
  assert.match(env, /^LCT_PPTX_BACKEND=office-kit$/mu);
  const [readme, config, testing] = await Promise.all([
    readFile(path.join(repoRoot, 'README.md'), 'utf8'),
    readFile(path.join(repoRoot, 'docs/getting-started/configuration.md'), 'utf8'),
    readFile(path.join(repoRoot, 'TESTING.md'), 'utf8'),
  ]);
  assert.match(readme, /Office Kit.*default|default.*Office Kit/iu);
  assert.match(config, /office-kit.*default/u);
  assert.match(testing, /qualification backend.*Office Kit|Office Kit.*qualification backend/iu);
});

test('qualification operation accounting accepts both valid core paths', async () => {
  async function runCorePath(coreOperations) {
    const delegated = [];
    const delegate = { async infer(request) { delegated.push(request.operation); return { value: {}, telemetry: {} }; } };
    const budget = createRequestBudgetAdapter(delegate, 20);
    const request = (operation) => ({ role: 'worker', operation, messages: [{ role: 'user', content: 'safe test payload' }], output: { schema: {}, validate: () => true } });
    await budget.adapter.infer(request('template-semantic-profile'));
    budget.markProfilePrepared();
    for (const operation of coreOperations) await budget.adapter.infer(request(operation));
    const accounting = validateQualificationSemanticOperationAccounting(budget.records);
    assert.equal(accounting.coreRequestCount, coreOperations.length);
    assert.equal(accounting.profileRequestCount, 1);
    assert.equal(accounting.operationCounts.total, coreOperations.length + 1);
    assert.deepEqual(delegated, ['template-semantic-profile', ...coreOperations]);
    return accounting;
  }

  const withoutRevision = await runCorePath(['deck-plan', 'plan-review', 'contextual-deck-audit']);
  assert.equal(withoutRevision.coreRequestCount, 3);
  assert.equal(withoutRevision.rawOperationCounts['deck-plan-revision'] ?? 0, 0);

  const withOneRevision = await runCorePath(['deck-plan', 'plan-review', 'deck-plan-revision', 'contextual-deck-audit']);
  assert.equal(withOneRevision.coreRequestCount, 4);
  assert.equal(withOneRevision.rawOperationCounts['deck-plan-revision'], 1);
});

test('qualification budget rejects a second revision and every unexpected operation before dispatch', async () => {
  const delegated = [];
  const delegate = { async infer(request) { delegated.push(request.operation); return { value: {}, telemetry: {} }; } };
  const budget = createRequestBudgetAdapter(delegate, 20);
  const request = (operation) => ({ role: 'worker', operation, messages: [{ role: 'user', content: 'safe test payload' }], output: { schema: {}, validate: () => true } });
  await budget.adapter.infer(request('template-semantic-profile'));
  budget.markProfilePrepared();
  for (const operation of ['deck-plan', 'plan-review', 'deck-plan-revision']) await budget.adapter.infer(request(operation));
  await assert.rejects(budget.adapter.infer(request('deck-plan-revision')), (error) => error.code === 'RATE_LIMITED');
  await budget.adapter.infer(request('contextual-deck-audit'));
  await assert.rejects(budget.adapter.infer(request('unexpected-operation')), (error) => error.code === 'RATE_LIMITED');
  assert.deepEqual(delegated, ['template-semantic-profile', 'deck-plan', 'plan-review', 'deck-plan-revision', 'contextual-deck-audit']);
  assert.equal(validateQualificationSemanticOperationAccounting(budget.records).coreRequestCount, 4);
  assert.equal(budget.records.length, 5);
  assert.equal(budget.rejectedAttempts, 2);
});

test('request budget retains only safe profiler validation diagnostics and token counts on failure', async () => {
  const telemetry = {
    role: 'worker', operation: 'template-semantic-profile', model: 'Qwen/Qwen3.8-27B', requestId: 'safe-test-id',
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), wallTimeMs: 10,
    promptTokens: 42, completionTokens: 13, httpStatus: 200, finishReason: 'stop',
    runtimeSchemaValidation: 'failed', validationFailureCode: 'HASH_MISMATCH', status: 'error', errorCode: 'INVALID_STRUCTURED_OUTPUT',
  };
  const budget = createRequestBudgetAdapter({ async infer() {
    throw new SemanticInferenceError('INVALID_STRUCTURED_OUTPUT', 'safe failure', { telemetry });
  } }, 20);
  await assert.rejects(budget.adapter.infer({
    role: 'worker', operation: 'template-semantic-profile', maxOutputTokens: 4096,
    messages: [{ role: 'user', content: 'private evidence must not be persisted' }],
    output: { name: 'template_semantic_profile_v1', schema: {}, validate: () => false },
    metadata: { templateProfilerBatch: { batchNumber: 1, totalBatches: 1, sourceSlideIndexes: [1] } },
  }), (error) => error.code === 'INVALID_STRUCTURED_OUTPUT');
  assert.equal(budget.records[0].validationFailureCode, 'HASH_MISMATCH');
  assert.equal(budget.records[0].promptTokens, 42);
  assert.equal(budget.records[0].completionTokens, 13);
  assert.equal(budget.records[0].runtimeSchemaValidation, 'failed');
  assert.equal(budget.records[0].evidenceBytes, Buffer.byteLength('private evidence must not be persisted', 'utf8'));
  assert.ok(!JSON.stringify(budget.records[0]).includes('private evidence'));
});

test('profiler cannot run after Generate starts and core cannot start before a prepared profile', async () => {
  const delegated = [];
  const delegate = { async infer(request) { delegated.push(request.operation); return { value: {}, telemetry: {} }; } };
  const budget = createRequestBudgetAdapter(delegate, 20);
  const request = (operation) => ({ role: 'worker', operation, messages: [{ role: 'user', content: 'safe test payload' }], output: { schema: {}, validate: () => true } });
  await assert.rejects(budget.adapter.infer(request('deck-plan')), (error) => error.code === 'RATE_LIMITED');
  await budget.adapter.infer(request('template-semantic-profile'));
  budget.markProfilePrepared();
  await budget.adapter.infer(request('deck-plan'));
  await assert.rejects(budget.adapter.infer(request('template-semantic-profile')), (error) => error.code === 'RATE_LIMITED');
  assert.deepEqual(delegated, ['template-semantic-profile', 'deck-plan']);
  assert.equal(budget.records.length, 2);
  assert.equal(budget.rejectedAttempts, 2);
});

test('full product request budget allows 32 profile batches plus four bounded core stages', async () => {
  const delegated = [];
  const delegate = {
    model: 'Qwen/Qwen3.8-27B',
    async infer(request) {
      delegated.push(request.operation);
      return { value: {}, telemetry: { model: 'Qwen/Qwen3.8-27B', startedAt: new Date().toISOString(), wallTimeMs: 1,
        finishReason: 'stop', promptTokens: 1, completionTokens: 1 } };
    },
  };
  const budget = createRequestBudgetAdapter(delegate, 36);
  const request = (operation) => ({ role: 'worker', operation, messages: [{ role: 'user', content: 'safe test payload' }], output: { schema: {}, validate: () => true } });
  for (let index = 0; index < 32; index += 1) await budget.adapter.infer(request('template-semantic-profile'));
  await assert.rejects(budget.adapter.infer(request('template-semantic-profile')), (error) => error.code === 'RATE_LIMITED');
  budget.markProfilePrepared();
  for (const operation of ['deck-plan', 'plan-review', 'deck-plan-revision', 'contextual-deck-audit']) await budget.adapter.infer(request(operation));
  await assert.rejects(budget.adapter.infer(request('unexpected-after-budget')), (error) => error.code === 'RATE_LIMITED');
  assert.equal(delegated.length, 36);
  assert.equal(budget.records.length, 36);
  assert.equal(budget.rejectedAttempts, 2);
});

test('canonical fake E2E prepares the profile before Generate and runs no profiler requests during Generate', async (t) => {
  const scratch = await mkdtemp(path.join(repoRoot, '.lct', 'product-e2e-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  const templatePath = path.join(scratch, 'синтетический шаблон.pptx');
  await makeTemplate(templatePath, { slideCount: 9 });
  const endpoints = [];
  const endpointFactory = async (options) => {
    const endpoint = await startFakeSemanticEndpoint(options);
    endpoints.push(endpoint);
    return endpoint;
  };
  for (const slides of [3, 12]) {
    const outputDir = path.join(scratch, `run-${slides}`);
    const task = Array.from({ length: slides }, (_, index) => index === 0
      ? 'Синтетический этап 1: текстовый ввод </section><script>alert(1)</script> & "кавычки".'
      : `Синтетический этап ${index + 1}: подготовить проверяемый шаг процесса.`).join('\n');
    const manifest = await runProductE2E(workflowOptions(templatePath, outputDir, slides, task), { startFakeSemanticEndpoint: endpointFactory });
    assert.equal(manifest.result, 'PASS', `failed at ${manifest.failure?.stage}: ${manifest.failure?.code}; semantic=${JSON.stringify(manifest.semantic.rawOperationCounts)}`);
    assert.equal(manifest.expectedPptxBackend, 'office-kit');
    assert.equal(manifest.pptxBackend, 'office-kit');
    assert.equal(manifest.requestedSlides, slides);
    assert.equal(manifest.actualSlides, slides);
    assert.equal(manifest.templateProfilerEnabled, true);
    assert.ok(manifest.workflow.templatePreparation.profileRequests > 0);
    assert.equal(manifest.workflow.templatePreparation.profileRequests,
      manifest.semantic.requests.filter((request) => request.operation === 'template-semantic-profile').length);
    assert.deepEqual(manifest.semantic.operationCounts, {
      profiler: manifest.workflow.templatePreparation.profileRequests, worker: 1, planningSupervisor: 1, contextualAudit: 1,
      revisionWorker: 0, other: 0, generation: 0, total: manifest.workflow.templatePreparation.profileRequests + 3,
    });
    assert.equal(manifest.semantic.requestCount, manifest.workflow.templatePreparation.profileRequests + 3);
    assert.equal(manifest.semantic.requestBudget, 36);
    assert.equal(manifest.workflow.templatePreparation.structuralStatus, 'ready');
    assert.equal(manifest.workflow.templatePreparation.semanticProfileStatus, 'ready');
    assert.equal(manifest.workflow.templatePreparation.cachedStatusRead, true);
    assert.ok(manifest.timing.templatePreparationMs > 0);
    assert.ok(Number.isSafeInteger(manifest.timing.timeToThreeVariantsReadyMs));
    assert.ok(manifest.semantic.requests.every((request) => request.responseFormat === 'json_schema'
      && request.strictJsonSchema === true && request.httpStatus === 200
      && request.runtimeSchemaValidation === 'passed'));
    assert.ok(manifest.semantic.requests.filter((request) => request.operation === 'template-semantic-profile')
      .every((request) => Number.isSafeInteger(request.evidenceBytes) && request.evidenceBytes > 0 && request.evidenceBytes <= 24 * 1024));
    assert.deepEqual(manifest.semantic.requests.slice(-3).map((request) => request.operation), [
      'deck-plan', 'plan-review', 'contextual-deck-audit',
    ]);
    assert.equal(manifest.semantic.automaticRetries, 0);
    assert.equal(manifest.generation.variantsReady, slides * 3);
    assert.equal(manifest.generation.deterministicAudit.status, 'passed');
    assert.equal(manifest.generation.contextualAudit.findingCount, 11);
    assert.equal(manifest.audit.contextual.expectedRules, 11);
    assert.equal(manifest.audit.contextual.actualRules, 11);
    assert.equal(manifest.audit.contextual.ruleSetVersion, 'contextual-deck-audit.v2');
    assert.match(manifest.audit.deterministic.canonicalSha256, /^[a-f0-9]{64}$/u);
    assert.equal(manifest.audit.deterministic.auditedVariants, slides * 3);
    assert.equal(manifest.exports.pptx.selected.slides, slides);
    assert.equal(manifest.exports.pptx.A.slides, slides);
    assert.equal(manifest.exports.pptx.B.slides, slides);
    assert.equal(manifest.exports.pptx.C.slides, slides);
    assert.equal(manifest.exports.aBCRawHashesDistinct, true);
    assert.equal(manifest.exports.pdf.pages, slides);
    assert.equal(manifest.exports.html.slides, slides);
    assert.equal(manifest.sourceTemplateUnchanged, true);
    assert.equal(manifest.imageGeneration.networkRequests, 0);
    assert.ok(!JSON.stringify(manifest).includes('http://127.0.0.1:'));
    assert.ok(!JSON.stringify(manifest).includes('Authorization'));
    const persisted = JSON.parse(await readFile(path.join(outputDir, 'manifest.json'), 'utf8'));
    assert.equal(persisted.result, 'PASS');
  }
  assert.equal(endpoints.length, 2);
  assert.ok(endpoints.every((endpoint) => endpoint.state.inference.filter((call) => call.operation === 'template-semantic-profile').length > 0));
  assert.ok(endpoints.every((endpoint) => endpoint.state.inference.slice(-3).map((call) => call.operation).join(',')
    === 'deck-plan,plan-review,contextual-deck-audit'));
});

test('profile batches remain bounded and run before all three downstream semantic operations', async (t) => {
  const scratch = await mkdtemp(path.join(repoRoot, '.lct', 'product-e2e-profile-required-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  const templatePath = path.join(scratch, 'синтетический шаблон.pptx');
  await makeTemplate(templatePath, { slideCount: 9 });
  const endpoints = [];
  const endpointFactory = async (options) => {
    const endpoint = await startFakeSemanticEndpoint(options);
    endpoints.push(endpoint);
    return endpoint;
  };
  const options = workflowOptions(templatePath, path.join(scratch, 'full'), 3, 'Проверить подготовку шаблона.');
  const manifest = await runProductE2E(options, { startFakeSemanticEndpoint: endpointFactory });
  assert.equal(manifest.result, 'PASS', `failed at ${manifest.failure?.stage}: ${manifest.failure?.code}`);
  assert.equal(manifest.templateProfilerEnabled, true);
  assert.equal(manifest.semantic.requestBudget, 36);
  assert.equal(manifest.semantic.requestCount, 8);
  assert.deepEqual(manifest.semantic.operationCounts, {
    profiler: 5, worker: 1, planningSupervisor: 1, contextualAudit: 1,
    revisionWorker: 0, other: 0, generation: 0, total: 8,
  });
  assert.deepEqual(manifest.semantic.requests.slice(0, 5).map((request) => request.templateProfilerBatch?.batchNumber), [1, 2, 3, 4, 5]);
  assert.equal(manifest.generation.variantsReady, 9);
  assert.equal(endpoints[0].state.inference.length, 8);
});

test('fake profile preparation stops after one failure and does not retry', async (t) => {
  const scratch = await mkdtemp(path.join(repoRoot, '.lct', 'product-e2e-failure-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  const templatePath = path.join(scratch, 'template.pptx');
  await makeTemplate(templatePath);
  const endpoints = [];
  const endpointFactory = async (options) => {
    const endpoint = await startFakeSemanticEndpoint({ ...options, failure: () => 'http-524' });
    endpoints.push(endpoint);
    return endpoint;
  };
  const manifest = await runProductE2E(workflowOptions(templatePath, path.join(scratch, 'failure'), 3, 'Проверить контролируемый отказ.', true), {
    startFakeSemanticEndpoint: endpointFactory,
  });
  assert.equal(manifest.result, 'FAIL');
  assert.equal(manifest.failure?.code, 'SERVICE_UNAVAILABLE');
  assert.equal(manifest.semantic.requestCount, 1);
  assert.equal(manifest.semantic.automaticRetries, 0);
  assert.equal(manifest.semantic.requests[0].httpStatus, 524);
  assert.equal(manifest.semantic.requests[0].runtimeSchemaValidation, 'not-run');
  assert.equal(manifest.semantic.requests[0].operation, 'template-semantic-profile');
  assert.equal(manifest.semantic.rawOperationCounts['deck-plan'], undefined);
  assert.equal(endpoints[0].state.inference.length, 1);
  assert.deepEqual(endpoints[0].state.inference.map((call) => call.operation), ['template-semantic-profile']);
});
