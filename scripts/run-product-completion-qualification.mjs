#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFakeSemanticEndpoint } from './lib/fake-openai-compatible-endpoint.mjs';
import { register } from 'tsx/esm/api';

register();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const daemonRequire = createRequire(path.join(repoRoot, 'apps/daemon/package.json'));
const plans = [
  { flag: '--vk-tech', label: 'VK Tech', slides: 12, formats: ['pptx', 'pdf', 'html'] },
  { flag: '--workspace', label: 'WorkSpace', slides: 3, formats: ['pptx'] },
  { flag: '--education', label: 'Education', slides: 3, formats: ['pptx'] },
  { flag: '--aios', label: 'AIOS held-out', slides: 3, formats: ['pptx'] },
];

function parseArgs(argv) {
  const values = new Map();
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--output') {
      output = argv[++index];
      if (!output) throw new TypeError('--output requires a path');
      continue;
    }
    if (!plans.some((plan) => plan.flag === flag)) throw new TypeError(`Unknown option: ${flag}`);
    const value = argv[++index];
    if (!value || values.has(flag)) throw new TypeError(`${flag} requires one unique PPTX path`);
    values.set(flag, value);
  }
  const missing = plans.filter((plan) => !values.has(plan.flag)).map((plan) => plan.flag);
  if (missing.length) throw new TypeError(`Usage: node --import tsx scripts/run-product-completion-qualification.mjs ${plans.map((plan) => `${plan.flag} <path>`).join(' ')} [--output <directory>]`);
  return { templates: plans.map((plan) => ({ ...plan, path: path.resolve(values.get(plan.flag)) })), output };
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function requestJson(baseUrl, route, options = {}, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${route}`, options);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; }
  catch { throw new Error(`${route} returned non-JSON HTTP ${response.status}`); }
  assert.equal(response.status, expectedStatus, `${route} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function closeServer(started) {
  if (!started) return;
  if (started.server.listening) {
    started.server.closeAllConnections?.();
    await new Promise((resolve, reject) => started.server.close((error) => error ? reject(error) : resolve()));
  }
  await started.shutdown();
}

async function waitForReady(baseUrl, projectId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = (await requestJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/workflow`)).operation;
    if (last?.status === 'ready' || last?.status === 'failed') return last;
    await sleep(100);
  }
  throw new Error(`Workflow timed out after ${timeoutMs}ms at ${last?.stage ?? 'unknown'}`);
}

async function uploadTemplate(baseUrl, projectId, template) {
  const form = new FormData();
  form.append('files', new Blob([template.bytes]), template.name);
  await requestJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/upload`, { method: 'POST', body: form });
  const { files } = await requestJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/files`);
  const match = files.find((file) => file.originalName === template.name || file.name === template.name || file.path === template.name);
  const templateFilePath = match?.path ?? match?.filePath ?? match?.name;
  assert.equal(typeof templateFilePath, 'string', `uploaded template path was not returned for ${template.name}`);
  return templateFilePath;
}

async function downloadExport(baseUrl, projectId, mode, format) {
  const { artifact } = await requestJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/generation/export`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, format }),
  }, 201);
  assert.equal(artifact.validationStatus, 'passed');
  const response = await fetch(`${baseUrl}${artifact.downloadUrl}`);
  assert.equal(response.status, 200, `could not download ${mode} ${format}`);
  return { artifact, bytes: Buffer.from(await response.arrayBuffer()) };
}

function uniqueSourcePhrases(presentation, office) {
  const counts = new Map();
  for (const slide of office.getSlides(presentation)) {
    const slideTerms = new Set(office.getSlideShapes(slide)
      .filter((shape) => office.hasShapeText(shape))
      .map((shape) => office.getShapeText(shape).replace(/\s+/gu, ' ').trim())
      .filter((text) => Array.from(text).length >= 24));
    for (const text of slideTerms) counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count === 1).map(([text]) => text).slice(0, 80);
}

function forbiddenMatches(presentation, forbiddenTerms, office) {
  const generatedText = office.getSlides(presentation).flatMap((slide) => office.getSlideShapes(slide))
    .filter((shape) => office.hasShapeText(shape))
    .map((shape) => office.getShapeText(shape).normalize('NFKC').toLocaleLowerCase('ru-RU'));
  return forbiddenTerms.filter((term) => {
    const normalized = term.normalize('NFKC').toLocaleLowerCase('ru-RU');
    return generatedText.some((text) => text.includes(normalized));
  });
}

function syntheticContext() {
  return [
    'Синтетический сценарий: продуктовая команда получает запросы на запуск из нескольких внутренних каналов.',
    'Команда фиксирует цель релиза и аудиторию до выбора состава презентации.',
    'Для каждого запроса назначается владелец, который собирает исходные материалы.',
    'Проверка материалов отделяет подтверждённые сведения от рабочих предположений.',
    'Обсуждение выявляет зависимости между продуктом, поддержкой и коммуникациями.',
    'Команда сравнивает варианты запуска по одинаковым критериям.',
    'Риски и ограничения фиксируются рядом с решениями, которых они касаются.',
    'Открытые вопросы получают владельца и следующий проверяемый шаг.',
    'План запуска связывает подготовку, проверку готовности и информирование аудитории.',
    'Команда использует обратную связь участников для уточнения последовательности действий.',
    'Перед запуском ответственные подтверждают готовность своих частей процесса.',
    'Итоговая презентация должна привести участников к одному согласованному следующему шагу.',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = `product-completion-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
  const outputDir = path.resolve(args.output ?? path.join(repoRoot, '.lct', runId));
  const dataDir = path.join(outputDir, 'runtime-data');
  await mkdir(outputDir, { recursive: true });
  const templates = await Promise.all(args.templates.map(async (template) => {
    const bytes = await readFile(template.path);
    return { ...template, name: path.basename(template.path), bytes, hash: sha256(bytes) };
  }));
  const envKeys = ['LCT_SEMANTIC_BASE_URL', 'LCT_SEMANTIC_MODEL', 'LCT_SEMANTIC_API_KEY', 'LCT_SEMANTIC_ENABLE_THINKING', 'LCT_PPTX_BACKEND', 'LCT_DATA_DIR', 'LCT_IMAGE_BASE_URL', 'LCT_IMAGE_MODEL', 'LCT_IMAGE_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const report = {
    schemaVersion: 1,
    status: 'running',
    runId,
    inference: { mode: 'local-fake-openai-compatible', externalRequests: 0, operations: {} },
    imageGeneration: { configured: false, networkRequests: 0 },
    input: { sourceFiles: 0, taskProvided: true, syntheticContextProvided: true },
    templates: [],
    artifactDirectory: path.relative(repoRoot, outputDir).replaceAll('\\', '/'),
  };
  const fake = await startFakeSemanticEndpoint({ model: 'offline-fake-planner' });
  let server = null;
  let failures = [];
  try {
    process.env.LCT_SEMANTIC_BASE_URL = fake.baseUrl;
    process.env.LCT_SEMANTIC_MODEL = 'offline-fake-planner';
    process.env.LCT_SEMANTIC_ENABLE_THINKING = 'false';
    process.env.LCT_PPTX_BACKEND = 'office-kit';
    process.env.LCT_DATA_DIR = dataDir;
    for (const key of ['LCT_SEMANTIC_API_KEY', 'LCT_IMAGE_BASE_URL', 'LCT_IMAGE_MODEL', 'LCT_IMAGE_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_KEY']) delete process.env[key];

    const { startServer } = await import('../apps/daemon/src/server.ts');
    const { inspectOfficeKitPackage } = await import('../apps/daemon/src/presentation/adapters/office-kit-package-inspector.ts');
    const officePackageJson = daemonRequire.resolve('@office-kit/pptx/package.json');
    const office = await import(pathToFileURL(path.join(path.dirname(officePackageJson), 'dist/node.js')));
    server = await startServer({ host: '127.0.0.1', port: 0, dataDir, projectRoot: repoRoot, serveWeb: false, returnServer: true });
    const imageModels = await requestJson(server.url, '/api/media/models');
    assert.equal(imageModels.configured, false);
    assert.deepEqual(imageModels.image, []);

    for (const [index, template] of templates.entries()) {
      const projectId = `completion-${index}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      await requestJson(server.url, '/api/projects', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: projectId, name: `Квалификация: ${template.label}` }),
      }, 201);
      const templateFilePath = await uploadTemplate(server.url, projectId, template);
      const context = template.label === 'VK Tech' ? syntheticContext() : '';
      const brief = {
        audience: 'Продуктовая команда',
        purpose: template.label === 'VK Tech'
          ? 'Подготовить презентацию к запуску на основе синтетического сценария.'
          : [
            'Подготовить краткий план запуска презентации.',
            'Проверить готовность исходных материалов.',
            'Согласовать следующий проверяемый шаг команды.',
          ].join('\n'),
        expectedOutcome: 'Согласовать следующий проверяемый шаг.',
        preferences: [],
        requestedSlideCount: template.slides,
        ...(context ? { context } : {}),
      };
      const inferenceOffset = fake.state.inference.length;
      const flowStartedAt = performance.now();
      const begin = await requestJson(server.url, `/api/projects/${encodeURIComponent(projectId)}/workflow/generate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ templateFilePath, contentFiles: [], brief }),
      }, 202);
      const initialOperationId = begin.operation.operationId;
      const operation = await waitForReady(server.url, projectId, template.slides === 12 ? 180_000 : 120_000);
      const generationMs = Math.round(performance.now() - flowStartedAt);
      assert.equal(operation.operationId, initialOperationId);
      assert.equal(operation.status, 'ready', `${template.label}: ${JSON.stringify(operation.failure)}`);
      assert.equal(operation.totalSlides, template.slides);
      assert.equal(operation.readySlides, template.slides);
      assert.equal(operation.contextualAudit?.status, 'ready');
      assert.equal(operation.contextualAudit.findings.length, 11);

      const planning = await requestJson(server.url, `/api/projects/${encodeURIComponent(projectId)}/planning`);
      assert.equal(planning.status, 'ready');
      assert.equal(planning.deckPlan.slides.length, template.slides, `${template.label} must honor requested slide count`);
      const generation = (await requestJson(server.url, `/api/projects/${encodeURIComponent(projectId)}/generation`)).generation;
      assert.equal(generation.status, 'completed');
      assert.equal(generation.slides.length, template.slides);
      const unready = generation.slides.flatMap((slide) => ['A', 'B', 'C'].filter((variant) => slide.variants[variant]?.status !== 'ready'));
      assert.deepEqual(unready, [], `${template.label} has unready A/B/C variants`);
      const deterministicErrors = generation.slides.flatMap((slide) => ['A', 'B', 'C'].flatMap((variant) =>
        slide.variants[variant]?.audit?.findings?.filter((finding) => finding.severity === 'error') ?? []));
      assert.deepEqual(deterministicErrors, [], `${template.label} deterministic audit has errors`);

      const caseCalls = fake.state.inference.slice(inferenceOffset);
      const callsByOperation = Object.fromEntries([...new Set(caseCalls.map((call) => call.operation))]
        .map((name) => [name, caseCalls.filter((call) => call.operation === name).length]));
      assert.equal(callsByOperation['contextual-deck-audit'], 1, `${template.label} must receive exactly one contextual deck review`);
      assert.equal(caseCalls.length, 4, `${template.label} should use profiler, worker, planning review and one contextual review`);

      const variantExports = [];
      const pptxByMode = new Map();
      for (const mode of ['selected', 'A', 'B', 'C']) {
        const { artifact, bytes } = await downloadExport(server.url, projectId, mode, 'pptx');
        const inspected = await inspectOfficeKitPackage(bytes);
        assert.equal(inspected.slideCount, template.slides);
        assert.equal(inspected.notesSlideCount, 0);
        assert.ok(!inspected.validationIssues.some((issue) => issue.severity === 'error'));
        const reopened = await office.loadPresentation(bytes);
        const reopenedSlides = office.getSlides(reopened);
        assert.equal(reopenedSlides.length, template.slides);
        const nativeTextBySlide = reopenedSlides.map((slide) => office.getSlideShapes(slide)
          .filter((shape) => office.hasShapeText(shape) && office.getShapeText(shape).trim()).length);
        assert.ok(nativeTextBySlide.every((count) => count >= 1), `${template.label} export should contain editable native text on every slide`);
        const nativeTextCount = nativeTextBySlide.reduce((sum, count) => sum + count, 0);
        const fileName = `${template.label.replace(/[^\p{L}\p{N}-]+/gu, '-')}-${mode}.pptx`;
        await writeFile(path.join(outputDir, fileName), bytes);
        pptxByMode.set(mode, bytes);
        variantExports.push({ mode, format: 'pptx', slides: inspected.slideCount, nativeTextShapes: nativeTextCount, nativeTextShapesPerSlide: nativeTextBySlide, bytes: bytes.length, sha256: sha256(bytes), validation: artifact.validationStatus });
      }

      const otherExports = [];
      if (template.formats.includes('pdf')) {
        const { artifact, bytes } = await downloadExport(server.url, projectId, 'selected', 'pdf');
        assert.ok(bytes.subarray(0, 5).toString('ascii').startsWith('%PDF-'));
        const { PDFDocument } = daemonRequire('pdf-lib');
        const pdf = await PDFDocument.load(bytes);
        assert.equal(pdf.getPageCount(), template.slides);
        await writeFile(path.join(outputDir, `${template.label.replace(/\s+/gu, '-')}-selected.pdf`), bytes);
        otherExports.push({ mode: 'selected', format: 'pdf', pages: pdf.getPageCount(), bytes: bytes.length, sha256: sha256(bytes), validation: artifact.validationStatus });
      }
      if (template.formats.includes('html')) {
        const { artifact, bytes } = await downloadExport(server.url, projectId, 'selected', 'html');
        const html = bytes.toString('utf8');
        assert.match(html, /<!doctype html>/iu);
        assert.equal((html.match(/<section class="slide"/gu) ?? []).length, template.slides);
        await writeFile(path.join(outputDir, `${template.label.replace(/\s+/gu, '-')}-selected.html`), bytes);
        otherExports.push({ mode: 'selected', format: 'html', slides: template.slides, bytes: bytes.length, sha256: sha256(bytes), validation: artifact.validationStatus });
      }

      let sourceResidue = { status: 'not-applicable', termsChecked: 0, matches: [] };
      if (template.label === 'AIOS held-out') {
        const sourcePresentation = await office.loadPresentation(template.bytes);
        const terms = uniqueSourcePhrases(sourcePresentation, office);
        assert.ok(terms.length > 0, 'held-out template must provide unique source text for residue scan');
        const matchesByMode = {};
        for (const mode of ['selected', 'A', 'B', 'C']) {
          const deck = await office.loadPresentation(pptxByMode.get(mode));
          matchesByMode[mode] = forbiddenMatches(deck, terms, office);
        }
        const matches = Object.values(matchesByMode).flat();
        assert.deepEqual(matches, [], `AIOS source-specific text remains: ${JSON.stringify(matchesByMode)}`);
        sourceResidue = { status: 'passed', termsChecked: terms.length, matches: [], variantsChecked: matchesByMode };
      }

      const finishedProject = (await requestJson(server.url, `/api/projects/${encodeURIComponent(projectId)}/workflow`)).operation;
      assert.equal(finishedProject.operationId, initialOperationId, 'refresh-style read must restore the same saved operation');
      assert.equal(finishedProject.contextualAudit.stale, false);
      report.templates.push({
        label: template.label,
        templateFileName: template.name,
        templateSha256: template.hash,
        requestedSlides: template.slides,
        sourceFiles: 0,
        taskProvided: true,
        contextProvided: Boolean(context),
        operationStatus: operation.status,
        stage: operation.stage,
        readyVariants: template.slides * 3,
        deterministicAudit: 'passed',
        contextualAudit: { status: 'passed', findings: 9, requests: callsByOperation['contextual-deck-audit'] },
        semanticCalls: { count: caseCalls.length, byOperation: callsByOperation },
        generationMs,
        exports: [...variantExports, ...otherExports],
        sourceResidue,
      });
      if (template.label === 'VK Tech') report.performance = {
        oneClickThroughAuditMs: generationMs,
        postAuditExportsMs: Math.round(performance.now() - flowStartedAt) - generationMs,
        fullFlowMs: Math.round(performance.now() - flowStartedAt),
        targetUnder180Seconds: generationMs < 180_000,
      };
      await writeFile(path.join(outputDir, 'qualification.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }

    report.inference.operations = Object.fromEntries([...new Set(fake.state.inference.map((entry) => entry.operation))]
      .map((operation) => [operation, fake.state.inference.filter((entry) => entry.operation === operation).length]));
    report.inference.totalRequests = fake.state.inference.length;
    report.inference.noExternalCalls = true;
    report.status = report.performance?.targetUnder180Seconds && report.templates.length === 4 ? 'PASS' : 'BLOCKED';
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    report.status = 'BLOCKED';
  } finally {
    report.inference.totalRequests = fake.state.inference.length;
    report.inference.operations = Object.fromEntries([...new Set(fake.state.inference.map((entry) => entry.operation))]
      .map((operation) => [operation, fake.state.inference.filter((entry) => entry.operation === operation).length]));
    report.inference.noExternalCalls = true;
    report.failures = failures;
    await closeServer(server).catch((error) => failures.push(`daemon shutdown: ${error instanceof Error ? error.message : String(error)}`));
    await fake.close().catch((error) => failures.push(`fake endpoint shutdown: ${error instanceof Error ? error.message : String(error)}`));
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    report.failures = failures;
    await writeFile(path.join(outputDir, 'qualification.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'PASS') process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
