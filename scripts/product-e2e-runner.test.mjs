import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startFakeSemanticEndpoint } from './lib/fake-openai-compatible-endpoint.mjs';
import { createRequestBudgetAdapter, parseArgs, runCli, runProductE2E } from './run-product-e2e.mjs';

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

async function makeTemplate(filePath) {
  const PptxGenJS = require('pptxgenjs');
  const deck = new PptxGenJS();
  deck.layout = 'LAYOUT_WIDE';
  deck.author = 'Product E2E runner integration test';
  const masters = [
    { title: 'LCT_E2E_BALANCED', titleBox: { x: 0.6, y: 0.35, w: 12, h: 0.8 }, bodyBoxes: [{ x: 0.75, y: 1.55, w: 11.5, h: 4.8 }] },
    { title: 'LCT_E2E_SPLIT', titleBox: { x: 0.6, y: 0.35, w: 12, h: 0.8 }, bodyBoxes: [{ x: 0.75, y: 1.65, w: 5.4, h: 4.5 }, { x: 6.95, y: 1.65, w: 5.4, h: 4.5 }] },
    { title: 'LCT_E2E_SPACIOUS', titleBox: { x: 1.1, y: 0.7, w: 10.8, h: 1.05 }, bodyBoxes: [{ x: 1.1, y: 2.2, w: 8.2, h: 3.55 }] },
  ];
  for (const [index, master] of masters.entries()) {
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

function workflowOptions(templatePath, outputDir, slides, task) {
  return { mode: 'fake', templatePath, task, context: '', sources: [], slides, providerLabel: 'local-test', outputDir,
    maxSemanticRequests: 4, dryRun: false, preflightOnly: false };
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

test('external CLI requires explicit model alias and caps configured request budgets at four', () => {
  assert.throws(() => parseArgs(['--semantic-mode', 'external', '--template', 'x.pptx', '--task', 'x', '--max-semantic-requests', '5']), /between 1 and 4/u);
  assert.equal(parseArgs(['--semantic-mode', 'external', '--template', 'x.pptx', '--task', 'x', '--preflight-only']).preflightOnly, true);
  assert.throws(() => parseArgs(['--semantic-mode', 'fake', '--template', 'x.pptx', '--task', 'x', '--preflight-only']), /requires --semantic-mode external/u);
});

test('canonical runner enters through the same public one-click workflow endpoint as the UI', async () => {
  const source = await readFile(path.join(repoRoot, 'scripts/run-product-e2e.mjs'), 'utf8');
  assert.match(source, /\/workflow\/generate/u);
  assert.doesNotMatch(source, /\/planning\/generate|TemplateSemanticProfiler|PlanningService|GenerationService/u);
});

test('request budget rejects the fifth inference before calling the production adapter', async () => {
  const delegated = [];
  const delegate = {
    model: 'Qwen/Qwen3.8-27B',
    async infer(request) {
      delegated.push(request.operation);
      return { value: {}, telemetry: { model: 'Qwen/Qwen3.8-27B', startedAt: new Date().toISOString(), wallTimeMs: 1,
        finishReason: 'stop', promptTokens: 1, completionTokens: 1 } };
    },
  };
  const budget = createRequestBudgetAdapter(delegate, 4);
  const request = (operation) => ({ role: 'worker', operation, messages: [{ role: 'user', content: 'safe test payload' }], output: { schema: {}, validate: () => true } });
  for (const operation of ['template-semantic-profile', 'deck-plan', 'plan-review', 'contextual-deck-audit']) await budget.adapter.infer(request(operation));
  await assert.rejects(budget.adapter.infer(request('unexpected-fifth-call')), (error) => error.code === 'RATE_LIMITED');
  assert.equal(delegated.length, 4);
  assert.equal(budget.records.length, 4);
  assert.equal(budget.rejectedAttempts, 1);
});

test('same one-click ProductWorkflow API uses four fake semantic requests for 3 and 12 requested slides', async (t) => {
  const scratch = await mkdtemp(path.join(repoRoot, '.lct', 'product-e2e-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  const templatePath = path.join(scratch, 'синтетический шаблон.pptx');
  await makeTemplate(templatePath);
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
    assert.equal(manifest.requestedSlides, slides);
    assert.equal(manifest.actualSlides, slides);
    assert.deepEqual(manifest.semantic.operationCounts, {
      profiler: 1, worker: 1, planningSupervisor: 1, contextualAudit: 1,
      revisionWorker: 0, other: 0, generation: 0, total: 4,
    });
    assert.equal(manifest.semantic.requestCount, 4);
    assert.equal(manifest.semantic.automaticRetries, 0);
    assert.equal(manifest.generation.variantsReady, slides * 3);
    assert.equal(manifest.generation.deterministicAudit.status, 'passed');
    assert.equal(manifest.generation.contextualAudit.findingCount, 9);
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
  assert.deepEqual(endpoints.map((endpoint) => endpoint.state.inference.length), [4, 4]);
});

test('a fake semantic request failure stops the product run without retrying', async (t) => {
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
  const manifest = await runProductE2E(workflowOptions(templatePath, path.join(scratch, 'failure'), 3, 'Проверить контролируемый отказ.'), {
    startFakeSemanticEndpoint: endpointFactory,
  });
  assert.equal(manifest.result, 'FAIL');
  assert.equal(manifest.failure?.code, 'SERVICE_UNAVAILABLE');
  assert.equal(manifest.semantic.requestCount, 1);
  assert.equal(manifest.semantic.automaticRetries, 0);
  assert.equal(endpoints[0].state.inference.length, 1);
});
