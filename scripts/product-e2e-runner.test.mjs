import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startFakeSemanticEndpoint } from './lib/fake-openai-compatible-endpoint.mjs';
import { assertQualificationPptxBackend, createRequestBudgetAdapter, parseArgs, runCli, runProductE2E } from './run-product-e2e.mjs';
import { DEFAULT_PPTX_BACKEND, QUALIFICATION_PPTX_BACKEND, parsePptxBackend } from '../apps/daemon/src/presentation/application/pptx-backend-port.ts';

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
    enableTemplateProfiler, maxSemanticRequests: enableTemplateProfiler ? 17 : 3, dryRun: false, preflightOnly: false };
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

test('product CLI uses a bounded profile-preparation and generation budget by default', () => {
  const core = ['--semantic-mode', 'external', '--template', 'x.pptx', '--task', 'x'];
  const coreOptions = parseArgs(core);
  assert.equal(coreOptions.maxSemanticRequests, 17);
  assert.equal(coreOptions.enableTemplateProfiler, true);
  assert.equal(parseArgs([...core, '--max-semantic-requests', '17']).maxSemanticRequests, 17);
  assert.throws(() => parseArgs([...core, '--max-semantic-requests', '18']), /between 1 and 17/u);
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

test('core request budget hard-stops at three semantic completions', async () => {
  const delegated = [];
  const delegate = { async infer(request) { delegated.push(request.operation); return { value: {}, telemetry: {} }; } };
  const budget = createRequestBudgetAdapter(delegate, 3);
  const request = (operation) => ({ role: 'worker', operation, messages: [{ role: 'user', content: 'safe test payload' }], output: { schema: {}, validate: () => true } });
  for (const operation of ['deck-plan', 'plan-review', 'contextual-deck-audit']) await budget.adapter.infer(request(operation));
  await assert.rejects(budget.adapter.infer(request('unexpected-fourth-call')), (error) => error.code === 'RATE_LIMITED');
  assert.deepEqual(delegated, ['deck-plan', 'plan-review', 'contextual-deck-audit']);
  assert.equal(budget.records.length, 3);
  assert.equal(budget.rejectedAttempts, 1);
});

test('full product request budget allows at most fourteen profile batches plus three fixed stages', async () => {
  const delegated = [];
  const delegate = {
    model: 'Qwen/Qwen3.8-27B',
    async infer(request) {
      delegated.push(request.operation);
      return { value: {}, telemetry: { model: 'Qwen/Qwen3.8-27B', startedAt: new Date().toISOString(), wallTimeMs: 1,
        finishReason: 'stop', promptTokens: 1, completionTokens: 1 } };
    },
  };
  const budget = createRequestBudgetAdapter(delegate, 17);
  const request = (operation) => ({ role: 'worker', operation, messages: [{ role: 'user', content: 'safe test payload' }], output: { schema: {}, validate: () => true } });
  for (let index = 0; index < 14; index += 1) await budget.adapter.infer(request('template-semantic-profile'));
  for (const operation of ['deck-plan', 'plan-review', 'contextual-deck-audit']) await budget.adapter.infer(request(operation));
  await assert.rejects(budget.adapter.infer(request('unexpected-eighteenth-call')), (error) => error.code === 'RATE_LIMITED');
  assert.equal(delegated.length, 17);
  assert.equal(budget.records.length, 17);
  assert.equal(budget.rejectedAttempts, 1);
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
    assert.deepEqual(manifest.semantic.operationCounts, {
      profiler: manifest.workflow.templatePreparation.profileRequests, worker: 1, planningSupervisor: 1, contextualAudit: 1,
      revisionWorker: 0, other: 0, generation: 0, total: manifest.workflow.templatePreparation.profileRequests + 3,
    });
    assert.equal(manifest.semantic.requestCount, manifest.workflow.templatePreparation.profileRequests + 3);
    assert.equal(manifest.semantic.requestBudget, 17);
    assert.equal(manifest.workflow.templatePreparation.structuralStatus, 'ready');
    assert.equal(manifest.workflow.templatePreparation.semanticProfileStatus, 'ready');
    assert.equal(manifest.workflow.templatePreparation.cachedStatusRead, true);
    assert.ok(manifest.timing.templatePreparationMs > 0);
    assert.ok(Number.isSafeInteger(manifest.timing.timeToThreeVariantsReadyMs));
    assert.ok(manifest.semantic.requests.every((request) => request.responseFormat === 'json_schema'
      && request.strictJsonSchema === true && request.httpStatus === 200
      && request.runtimeSchemaValidation === 'passed'));
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
  assert.equal(manifest.semantic.requestBudget, 17);
  assert.equal(manifest.semantic.requestCount, 5);
  assert.deepEqual(manifest.semantic.operationCounts, {
    profiler: 2, worker: 1, planningSupervisor: 1, contextualAudit: 1,
    revisionWorker: 0, other: 0, generation: 0, total: 5,
  });
  assert.deepEqual(manifest.semantic.requests.slice(0, 2).map((request) => request.templateProfilerBatch?.batchNumber), [1, 2]);
  assert.equal(manifest.generation.variantsReady, 9);
  assert.equal(endpoints[0].state.inference.length, 5);
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
