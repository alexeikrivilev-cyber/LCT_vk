#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

import {
  OpenAICompatibleSemanticInferenceAdapter,
  semanticInferenceConfigFromEnvironment,
} from '../apps/daemon/src/presentation/adapters/openai-compatible-semantic-inference.js';
import { OfficeKitPreviewAdapter } from '../apps/daemon/src/presentation/adapters/office-kit-preview-adapter.js';
import { inspectPptx } from '../apps/daemon/src/presentation/adapters/python-inspector.js';
import { resolvePptxBackend } from '../apps/daemon/src/presentation/adapters/pptx-renderer-factory.js';
import { startServer } from '../apps/daemon/src/server.js';
import { briefHash } from '../apps/daemon/src/presentation/domain/brief.js';
import { evaluatePlanningState } from './evaluate-planning-runs.mjs';
import { runOfflineMatrixFromState } from './run-offline-presentation-matrix.mjs';
import { runPptxCompatibilityHarness } from './compare-pptx-backends.mjs';
import { workerSmokeRequest } from '../apps/daemon/test/semantic-smoke-contracts.mjs';
import { createFamilyExemplarTemplate } from '../apps/daemon/test/exemplar-template-fixtures.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCENARIO_ROOT = path.join(REPO_ROOT, 'apps', 'daemon', 'test', 'fixtures', 'planning-scenarios');
const EXPECTED_MODEL = 'Qwen/Qwen3.8-27B';
const SCENARIOS = [
  'retention-growth',
  'platform-architecture',
  'quarterly-metrics',
  'sparse-evidence',
  'conflicting-brief',
];
const SAFE_FAILURE = /^[A-Z][A-Z0-9_]{0,79}$/;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sourceRevision() {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0;
    return { head, worktreeDirty: dirty };
  } catch { return { head: null, worktreeDirty: null }; }
}

function safeFailureCode(value, fallback = 'QUALIFICATION_FAILED') {
  return typeof value === 'string' && SAFE_FAILURE.test(value) ? value : fallback;
}

function runDirectoryName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(value)) {
    throw new TypeError('--out must be a 3–64 character run name containing letters, digits, dots, underscores, or hyphens');
  }
  return value;
}

function parseArgs(argv) {
  const parsed = { mode: null, template: null, out: null, providerKind: 'unknown', profile: null };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--smoke' || item === '--suite') {
      if (parsed.mode) throw new TypeError('Choose exactly one of --smoke or --suite');
      parsed.mode = item.slice(2);
    } else if (['--template', '--out', '--provider-kind', '--profile'].includes(item)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new TypeError(`${item} requires a value`);
      const name = item === '--provider-kind' ? 'providerKind'
        : item === '--template' ? 'template'
          : item === '--profile' ? 'profile' : 'out';
      parsed[name] = value;
    } else {
      throw new TypeError(`Unknown option: ${item}`);
    }
  }
  if (!parsed.mode) throw new TypeError('Choose --smoke or --suite');
  if (!['runpod', 'cloudru', 'vk', 'local', 'unknown'].includes(parsed.providerKind)) {
    throw new TypeError('--provider-kind must be runpod, cloudru, vk, local, or unknown');
  }
  if (parsed.profile !== null && !/^[A-Za-z0-9_.-]{1,40}$/.test(parsed.profile)) {
    throw new TypeError('--profile must be a short safe label');
  }
  if (parsed.out) parsed.out = runDirectoryName(parsed.out);
  return parsed;
}

function endpointPaths(baseUrl) {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const rootPath = basePath.replace(/\/v1$/i, '');
  const root = `${base.origin}${rootPath}`;
  return {
    health: `${root}/health`,
    models: `${base.origin}${basePath}/models`,
  };
}

async function boundedBody(response, maxBytes = 1024 * 1024) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw Object.assign(new Error('Response exceeded the qualification preflight limit'), { code: 'PREFLIGHT_RESPONSE_TOO_LARGE' });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}

async function timedFetch(fetcher, url, init, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } catch {
    throw Object.assign(new Error('Semantic endpoint is unavailable'), { code: 'ENDPOINT_UNAVAILABLE' });
  } finally {
    clearTimeout(timer);
  }
}

export async function probeSemanticEndpoint(config, fetcher = globalThis.fetch, onStatus = () => undefined) {
  const paths = endpointPaths(config.baseUrl);
  const headers = {
    accept: 'application/json',
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
  };
  let healthResponse;
  try {
    healthResponse = await timedFetch(fetcher, paths.health, { method: 'GET', headers });
    if (!healthResponse.ok) {
      await healthResponse.body?.cancel().catch(() => undefined);
      throw Object.assign(new Error('Semantic endpoint health check failed'), { code: `HTTP_${healthResponse.status}` });
    }
    await healthResponse.body?.cancel().catch(() => undefined);
    onStatus('health', 'passed');
  } catch (error) { onStatus('health', 'failed'); throw error; }

  let modelsResponse;
  try {
    modelsResponse = await timedFetch(fetcher, paths.models, { method: 'GET', headers });
    if (!modelsResponse.ok) {
      await modelsResponse.body?.cancel().catch(() => undefined);
      throw Object.assign(new Error('Semantic endpoint models check failed'), { code: `HTTP_${modelsResponse.status}` });
    }
  } catch (error) { onStatus('model', 'failed'); throw error; }
  let payload;
  try { payload = JSON.parse(await boundedBody(modelsResponse)); }
  catch (error) {
    onStatus('model', 'failed');
    throw Object.assign(new Error('Semantic endpoint returned an invalid models response'), {
      code: error?.code === 'PREFLIGHT_RESPONSE_TOO_LARGE' ? error.code : 'INVALID_MODELS_RESPONSE',
    });
  }
  const models = Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.models) ? payload.models
      : Array.isArray(payload) ? payload : [];
  const available = models.map((model) => typeof model === 'string' ? model
    : isRecord(model) && typeof model.id === 'string' ? model.id
      : isRecord(model) && typeof model.name === 'string' ? model.name : null).filter(Boolean);
  if (!available.includes(config.model)) {
    onStatus('model', 'failed');
    throw Object.assign(new Error('Expected model alias was not present in the models response'), { code: 'MODEL_ALIAS_MISMATCH' });
  }
  onStatus('model', 'passed');
  return { health: 'passed', models: 'passed', modelAlias: config.model };
}

function newSummary(mode, runId, model, providerKind, profile, startedAt) {
  return {
    schemaVersion: 1,
    mode,
    runId,
    modelAlias: model,
    providerKind,
    profile,
    thinkingEnabled: false,
    startedAt,
    finishedAt: null,
    health: 'not_run',
    model: 'not_run',
    strictJson: mode === 'smoke' ? { status: 'not_run', latencyMs: null, failureCode: null } : null,
    semanticInferenceCalls: 0,
    expectedMaximumInferenceCalls: mode === 'smoke' ? 3 : SCENARIOS.length * 2,
    scenarios: [],
    stopCondition: null,
    failureCode: null,
    stageMs: {
      templateParse: null,
      contentParse: null,
      worker: null,
      supervisor: null,
      compile: null,
      render: null,
      preview: null,
      audit: null,
      repair: null,
      export: null,
      total: null,
    },
    totalUnder300s: null,
    allScenarioPipelinesUnder300s: null,
  };
}

function reviewSheet(scenarios) {
  const fields = [
    'Narrative coherence', 'Takeaway quality', 'Source fidelity', 'Numeric fidelity',
    'Unsupported claims', 'Visual hierarchy', 'Template fidelity', 'Image relevance',
    'Chart correctness', 'Density', 'Major visual defect', 'Preferred variant', 'Notes',
  ];
  const lines = [
    '# Manual presentation review',
    '',
    'Leave every subjective field blank until a person has opened and reviewed the PPTX. Do not treat diagnostic PNGs as a PowerPoint rendering oracle.',
    '',
  ];
  for (const scenario of scenarios) {
    for (const variant of ['A', 'B', 'C']) {
      lines.push(`## ${scenario} / Variant ${variant}`, '', ...fields.map((field) => `- ${field}:`), '');
    }
  }
  return `${lines.join('\n')}\n`;
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function safeLocalJson(fetcher, baseUrl, route, init = {}) {
  const response = await fetcher(`${baseUrl}${route}`, init);
  let body = null;
  try { body = await response.json(); } catch { /* API result is checked below. */ }
  return { response, body };
}

function makeLimitedAdapter(adapter, summary) {
  const perProject = new Map();
  const calls = [];
  return {
    calls,
    async infer(request) {
      const projectId = request.metadata?.projectId ?? 'unknown-project';
      const count = perProject.get(projectId) ?? 0;
      if (count >= 2) {
        throw Object.assign(new Error('The live qualification call limit is two requests per scenario'), { code: 'CALL_LIMIT_EXCEEDED' });
      }
      perProject.set(projectId, count + 1);
      summary.semanticInferenceCalls += 1;
      const item = { role: request.role, operation: request.operation, projectId, status: 'started', latencyMs: null, failureCode: null, finishReason: null };
      calls.push(item);
      try {
        const response = await adapter.infer(request);
        item.status = 'passed';
        item.latencyMs = response.telemetry.wallTimeMs;
        item.finishReason = response.telemetry.finishReason ?? null;
        return response;
      } catch (error) {
        item.status = 'failed';
        item.latencyMs = error?.telemetry?.wallTimeMs ?? null;
        item.failureCode = safeFailureCode(error?.code);
        item.httpStatus = Number.isInteger(error?.httpStatus) ? error.httpStatus : null;
        throw error;
      }
    },
  };
}

async function createOutputTemplate(outDir, suppliedTemplate) {
  const inputDir = path.join(outDir, 'input');
  await mkdir(inputDir, { recursive: true });
  if (suppliedTemplate) {
    const source = path.resolve(suppliedTemplate);
    const bytes = await readFile(source);
    if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw Object.assign(new Error('Template must be a non-empty PPTX no larger than 64 MiB'), { code: 'INVALID_TEMPLATE' });
    const target = path.join(inputDir, 'template.pptx');
    await writeFile(target, bytes, { flag: 'wx' });
    return { path: target, sourcePath: source, sha256: sha256(bytes), sourceKind: 'user-supplied' };
  }
  const source = path.join(inputDir, 'synthetic-exemplar-family.pptx');
  await createFamilyExemplarTemplate(source);
  const bytes = await readFile(source);
  const target = path.join(inputDir, 'template.pptx');
  await writeFile(target, bytes, { flag: 'wx' });
  return { path: target, sourcePath: null, sha256: sha256(bytes), sourceKind: 'synthetic-3-family-exemplar' };
}

function safeScenarioResult(id) {
  return {
    scenario: id,
    health: 'passed',
    model: EXPECTED_MODEL,
    worker_status: 'not_run',
    worker_latency_ms: null,
    worker_finish_reason: null,
    supervisor_status: 'not_run',
    supervisor_latency_ms: null,
    supervisor_finish_reason: null,
    schema_valid: false,
    references_valid: false,
    slide_count: null,
    supervisor_outcome: null,
    planning_state_persisted: false,
    A_render: 'not_run',
    B_render: 'not_run',
    C_render: 'not_run',
    pptx_validation: 'not_run',
    audit_blockers: null,
    audit_majors: null,
    audit_warnings: null,
    unsupported_numeric_repeats: null,
    total_ms: null,
    failure_code: null,
    manual_review: null,
  };
}

function auditCounts(report) {
  const findings = Array.isArray(report?.audit?.findings) ? report.audit.findings : [];
  return {
    blockers: findings.filter((finding) => finding.severity === 'error').length,
    majors: findings.filter((finding) => finding.severity === 'warning').length,
    warnings: findings.filter((finding) => finding.severity === 'info').length,
  };
}

function repeatedUnsupportedNumericCount(reports) {
  const slidesByToken = new Map();
  for (const report of reports) {
    for (const finding of report?.audit?.findings ?? []) {
      if (finding.ruleId !== 'fidelity.unsupported-number' || typeof finding.evidence?.numericToken !== 'string') continue;
      const slides = slidesByToken.get(finding.evidence.numericToken) ?? new Set();
      slides.add(finding.slideId);
      slidesByToken.set(finding.evidence.numericToken, slides);
    }
  }
  return [...slidesByToken.values()].filter((slides) => slides.size > 1).length;
}

async function copyPreviewArtifacts(matrixResult, scenarioOut) {
  for (const output of matrixResult.matrix.outputs) {
    const variant = output.variantId.toLowerCase();
    const sourceDir = path.join(path.dirname(output.pptxPath), 'previews');
    const targetDir = path.join(scenarioOut, 'previews', `variant-${variant}`);
    await mkdir(targetDir, { recursive: true });
    for (const name of await readdir(sourceDir)) await writeFile(path.join(targetDir, name), await readFile(path.join(sourceDir, name)));
  }
}

async function readMatrixAudits(matrixResult) {
  const reports = [];
  for (const output of matrixResult.matrix.outputs) reports.push(JSON.parse(await readFile(output.auditPath, 'utf8')));
  return reports;
}

async function validateExportedPptx(matrixResult, expectedSlides) {
  let totalMs = 0;
  const checks = [];
  for (const output of matrixResult.matrix.outputs) {
    const started = performance.now();
    const inspection = await inspectPptx(output.pptxPath);
    const slideCount = inspection.inspection.slides.length;
    totalMs += performance.now() - started;
    checks.push({
      variant: output.variantId,
      status: slideCount === expectedSlides ? 'passed' : 'failed',
      slideCount,
      backendReopenStatus: output.reopenStatus,
      backendValidationStatus: output.validationStatus,
    });
  }
  return { totalMs, checks, passed: checks.every((check) => check.status === 'passed') };
}

async function copyOutputsToScenario(matrixResult, scenarioOut) {
  const variantDir = path.join(scenarioOut, 'variants');
  const auditDir = path.join(scenarioOut, 'audit');
  await Promise.all([mkdir(variantDir, { recursive: true }), mkdir(auditDir, { recursive: true })]);
  for (const output of matrixResult.matrix.outputs) {
    const id = output.variantId.toLowerCase();
    await Promise.all([
      writeFile(path.join(variantDir, `variant-${id}.pptx`), await readFile(output.pptxPath)),
      writeFile(path.join(auditDir, `variant-${id}.json`), await readFile(output.auditPath)),
    ]);
  }
}

async function startLocalQualificationServer(outDir, adapter) {
  return startServer({
    host: '127.0.0.1',
    port: 0,
    dataDir: path.join(outDir, '.daemon-data'),
    projectRoot: REPO_ROOT,
    serveWeb: false,
    returnServer: true,
    semanticInferenceAdapter: adapter,
  });
}

/** Full live qualification orchestration. Its only remote calls are health/models and bounded adapter requests. */
export async function runLiveQualification(options) {
  const mode = options.mode;
  if (!['smoke', 'suite'].includes(mode)) throw new TypeError('Mode must be smoke or suite');
  const env = options.env ?? process.env;
  const config = semanticInferenceConfigFromEnvironment(env);
  if (config.model !== EXPECTED_MODEL) throw Object.assign(new Error('LCT_SEMANTIC_MODEL must identify Qwen/Qwen3.8-27B for this qualification'), { code: 'MODEL_ALIAS_MISMATCH' });
  if (env.LCT_SEMANTIC_ENABLE_THINKING?.trim().toLowerCase() !== 'false') {
    throw Object.assign(new Error('Set LCT_SEMANTIC_ENABLE_THINKING=false before live qualification'), { code: 'THINKING_MUST_BE_DISABLED' });
  }

  const runId = runDirectoryName(options.runId ?? `live-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${randomUUID().slice(0, 8)}`);
  const outDir = path.resolve(options.outputRoot ?? path.join(REPO_ROOT, '.lct', 'experiments'), runId);
  if (path.relative(path.join(REPO_ROOT, '.lct', 'experiments'), outDir).startsWith('..')) {
    throw new TypeError('Live qualification output must remain under .lct/experiments');
  }
  await mkdir(path.dirname(outDir), { recursive: true });
  await mkdir(outDir, { recursive: false });

  const startDate = new Date();
  const startedAt = startDate.toISOString();
  const modeScenarios = mode === 'smoke' ? [SCENARIOS[0]] : SCENARIOS;
  const summary = newSummary(mode, runId, config.model, options.providerKind ?? 'unknown', options.profile ?? null, startedAt);
  const timingStart = performance.now();
  const template = await createOutputTemplate(outDir, options.templatePath ?? null);
  const backend = resolvePptxBackend(options.backend);
  let compatibility = null;
  let daemon = null;
  const inferenceAdapter = new OpenAICompatibleSemanticInferenceAdapter(config, options.fetcher ?? globalThis.fetch);
  const limitedAdapter = makeLimitedAdapter(inferenceAdapter, summary);
  let strictResponse = null;
  const manifest = {
    schemaVersion: 1,
    recordKind: 'live-quality-qualification',
    runId,
    mode,
    startedAt,
    modelAlias: config.model,
    providerKind: options.providerKind ?? 'unknown',
    profile: options.profile ?? null,
    thinkingEnabled: false,
    inferenceSettings: { worker: { temperature: 0.2, maxOutputTokens: 4096 }, supervisor: { temperature: 0, maxOutputTokens: 2048 } },
    requestSchema: { worker: 'deck_plan_draft_v4', supervisor: 'supervisor_plan_review_v1' },
    compilerVersion: 'lct-template-compiler/1',
    auditVersion: 'deterministic-audit.v1',
    sourceRevision: sourceRevision(),
    renderer: { id: backend, dependencyVersion: backend === 'office-kit' ? '@office-kit/pptx@0.21.0' : null },
    previewRenderer: '@office-kit/pptx-preview@0.11.0',
    template: { kind: template.sourceKind, sha256: template.sha256, templateIRHash: null, compatibilityReport: null },
    secretsStored: false,
    endpointStored: false,
    scenarios: [],
  };

  try {
    if (template.sourcePath) {
      compatibility = await runPptxCompatibilityHarness(template.path, path.join(outDir, 'compatibility'));
      manifest.template.compatibilityReport = 'compatibility/backend-compatibility-report.json';
      if (backend === 'office-kit' && compatibility.report.safeForOfficeKitBackend !== 'yes') {
        throw Object.assign(new Error('Office Kit is not qualified for this template; current backend policy requires custom'), { code: 'OFFICE_KIT_BACKEND_NOT_QUALIFIED' });
      }
    }

    if (config.apiKey && new URL(config.baseUrl).protocol !== 'https:'
        && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.baseUrl).hostname)) {
      throw Object.assign(new Error('API key requires HTTPS'), { code: 'CONFIGURATION_ERROR' });
    }
    await probeSemanticEndpoint(config, options.fetcher ?? globalThis.fetch, (name, status) => {
      if (name === 'health') summary.health = status;
      if (name === 'model') summary.model = status;
    });

    if (mode === 'smoke') {
      const strictStarted = performance.now();
      try {
        strictResponse = await inferenceAdapter.infer(workerSmokeRequest());
        summary.semanticInferenceCalls += 1;
        summary.strictJson = { status: 'passed', latencyMs: strictResponse.telemetry.wallTimeMs, finishReason: strictResponse.telemetry.finishReason ?? null, schemaValid: true, failureCode: null };
      } catch (error) {
        summary.semanticInferenceCalls += 1;
        const failureCode = Number.isInteger(error?.httpStatus) ? `HTTP_${error.httpStatus}` : safeFailureCode(error?.code, 'STRICT_JSON_FAILED');
        summary.strictJson = { status: 'failed', latencyMs: error?.telemetry?.wallTimeMs ?? Math.round(performance.now() - strictStarted), finishReason: null, schemaValid: false, failureCode };
        throw Object.assign(new Error('Strict JSON schema request failed'), { code: failureCode });
      }
    }

    daemon = await startLocalQualificationServer(outDir, limitedAdapter);
    for (const scenarioId of modeScenarios) {
      const scenarioStart = performance.now();
      const result = safeScenarioResult(scenarioId);
      summary.scenarios.push(result);
      const scenarioOut = path.join(outDir, scenarioId);
      const projectId = `${runId}-${scenarioId}`;
      const templateBytes = await readFile(template.path);
      const templateHashBefore = sha256(templateBytes);
      const fixtureDir = path.join(SCENARIO_ROOT, scenarioId);
      const sourceBytes = await readFile(path.join(fixtureDir, 'source.md'));
      const brief = JSON.parse(await readFile(path.join(fixtureDir, 'brief.json'), 'utf8'));

      const created = await safeLocalJson(globalThis.fetch, daemon.url, '/api/projects', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: projectId, name: `Live qualification ${scenarioId}` }),
      });
      if (!created.response.ok) throw Object.assign(new Error('Could not create the isolated qualification project'), { code: 'PROJECT_CREATE_FAILED' });

      const form = new FormData();
      form.append('files', new Blob([templateBytes]), 'template.pptx');
      form.append('files', new Blob([sourceBytes]), 'source.md');
      const upload = await safeLocalJson(globalThis.fetch, daemon.url, `/api/projects/${encodeURIComponent(projectId)}/upload`, { method: 'POST', body: form });
      if (!upload.response.ok) throw Object.assign(new Error('Could not upload qualification inputs to the local daemon'), { code: 'PROJECT_UPLOAD_FAILED' });

      const templateParseStart = performance.now();
      const compiled = await safeLocalJson(globalThis.fetch, daemon.url, `/api/projects/${encodeURIComponent(projectId)}/template/compile`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filePath: 'template.pptx' }),
      });
      if (!compiled.response.ok || compiled.body?.status !== 'ready') {
        throw Object.assign(new Error('PPTX template inspection or compilation failed'), { code: compiled.body?.failure?.code ?? 'TEMPLATE_PARSE_FAILED' });
      }
      const scenarioTemplateParseMs = Math.round(performance.now() - templateParseStart);
      summary.stageMs.templateParse = (summary.stageMs.templateParse ?? 0) + scenarioTemplateParseMs;
      manifest.template.templateIRHash ??= compiled.body.templateIR.hash;

      const planResponse = await safeLocalJson(globalThis.fetch, daemon.url, `/api/projects/${encodeURIComponent(projectId)}/planning/generate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contentFiles: ['source.md'], brief }),
      });
      const planning = planResponse.body;
      const statePath = path.join(outDir, '.daemon-data', 'projects', projectId, '.planning', 'state.json');
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      const evaluation = evaluatePlanningState(state, scenarioId);
      result.planning_state_persisted = state.status === 'ready' && evaluation.planning_state_persisted;
      result.schema_valid = evaluation.schema_valid;
      result.references_valid = evaluation.references_valid;
      result.slide_count = planning?.deckPlan?.slides?.length ?? null;
      result.supervisor_outcome = planning?.review?.outcome ?? null;
      const telemetry = planning?.telemetry;
      const scenarioCalls = limitedAdapter.calls.filter((call) => call.projectId === projectId);
      const workerCall = [...scenarioCalls].reverse().find((call) => call.role === 'worker');
      const supervisorCall = [...scenarioCalls].reverse().find((call) => call.role === 'supervisor');
      const applicationStatus = (call) => call?.status === 'failed' ? 'failed'
        : planning?.status === 'ready' ? 'passed'
          : call?.status === 'passed' ? 'application-validation-failed' : 'not_run';
      result.worker_status = applicationStatus(workerCall);
      result.worker_latency_ms = telemetry?.worker?.wallTimeMs ?? workerCall?.latencyMs ?? null;
      result.worker_finish_reason = telemetry?.worker?.finishReason ?? workerCall?.finishReason ?? null;
      result.supervisor_status = applicationStatus(supervisorCall);
      result.supervisor_latency_ms = telemetry?.supervisor?.wallTimeMs ?? supervisorCall?.latencyMs ?? null;
      result.supervisor_finish_reason = telemetry?.supervisor?.finishReason ?? supervisorCall?.finishReason ?? null;
      if (Number.isFinite(result.worker_latency_ms)) {
        summary.stageMs.worker = (summary.stageMs.worker ?? 0) + result.worker_latency_ms;
      }
      if (Number.isFinite(result.supervisor_latency_ms)) {
        summary.stageMs.supervisor = (summary.stageMs.supervisor ?? 0) + result.supervisor_latency_ms;
      }
      if (!planResponse.response.ok || planning?.status !== 'ready' || !result.schema_valid || !result.references_valid || !result.planning_state_persisted) {
        result.failure_code = safeFailureCode(planning?.failure?.code ?? planResponse.body?.error?.code, 'PLANNING_FAILED');
        const failedCall = [...limitedAdapter.calls].reverse().find((call) => call.projectId === projectId && call.status === 'failed');
        if (failedCall?.httpStatus) result.failure_code = failedCall.httpStatus === 524 ? 'HTTP_524' : `HTTP_${failedCall.httpStatus}`;
        throw Object.assign(new Error('Worker/Supervisor planning, schema validation, references, or persistence failed'), { code: result.failure_code });
      }

      await mkdir(scenarioOut, { recursive: true });
      const savedStatePath = path.join(scenarioOut, 'planning-state.json');
      await writeFile(savedStatePath, await readFile(statePath));
      const successful = state.lastSuccessful;
      manifest.scenarios.push({
        scenario: scenarioId,
        briefHash: briefHash(successful.brief),
        contentIRHash: successful.contentIR.hash,
        templateIRHash: compiled.body.templateIR.hash,
        deckPlanHash: successful.deckPlan.hash,
        supervisorOutcome: successful.review.outcome,
        worker: {
          latencyMs: successful.telemetry.worker.wallTimeMs,
          finishReason: successful.telemetry.worker.finishReason ?? null,
          promptVersion: successful.promptVersions.worker,
        },
        supervisor: {
          latencyMs: successful.telemetry.supervisor.wallTimeMs,
          finishReason: successful.telemetry.supervisor.finishReason ?? null,
          promptVersion: successful.promptVersions.supervisor,
        },
        planningState: `${scenarioId}/planning-state.json`,
      });
      const matrixStarted = performance.now();
      const matrixResult = await runOfflineMatrixFromState({
        state: savedStatePath,
        out: path.join(scenarioOut, 'matrix'),
        templates: [template.path],
        backend,
        previewAdapter: options.previewAdapter ?? new OfficeKitPreviewAdapter(),
        previewAllSlides: true,
        localSemantic: options.localSemanticMatrix === true,
      });
      const expectedMatrixProfileRequests = options.localSemanticMatrix === true ? 1 : 0;
      if (matrixResult.matrix.inferenceRequests !== expectedMatrixProfileRequests || matrixResult.matrix.outputCount !== 3) {
        throw Object.assign(new Error('Offline A/B/C replay violated its output or inference budget'), { code: 'OFFLINE_REPLAY_INVARIANT_FAILED' });
      }
      const matrixMs = performance.now() - matrixStarted;
      summary.stageMs.compile = (summary.stageMs.compile ?? 0) + Math.round(matrixResult.matrix.timingsMs.compile);
      summary.stageMs.audit = (summary.stageMs.audit ?? 0) + Math.round(matrixResult.matrix.timingsMs.audit);
      summary.stageMs.render = (summary.stageMs.render ?? 0) + Math.round(matrixResult.matrix.timingsMs.render);
      const exportValidation = await validateExportedPptx(matrixResult, result.slide_count);
      summary.stageMs.export = (summary.stageMs.export ?? 0) + Math.round(matrixResult.matrix.timingsMs.render + exportValidation.totalMs);
      summary.stageMs.preview = (summary.stageMs.preview ?? 0) + Math.round(matrixResult.matrix.timingsMs.preview ?? 0);
      const auditReports = await readMatrixAudits(matrixResult);
      const counts = auditReports.map(auditCounts);
      result.audit_blockers = counts.reduce((sum, count) => sum + count.blockers, 0);
      result.audit_majors = counts.reduce((sum, count) => sum + count.majors, 0);
      result.audit_warnings = counts.reduce((sum, count) => sum + count.warnings, 0);
      result.unsupported_numeric_repeats = repeatedUnsupportedNumericCount(auditReports);
      result.A_render = matrixResult.matrix.outputs.find((item) => item.variantId === 'A')?.renderStatus ?? 'failed';
      result.B_render = matrixResult.matrix.outputs.find((item) => item.variantId === 'B')?.renderStatus ?? 'failed';
      result.C_render = matrixResult.matrix.outputs.find((item) => item.variantId === 'C')?.renderStatus ?? 'failed';
      result.backend_reopen_status = [...new Set(matrixResult.matrix.outputs.map((item) => item.reopenStatus))].join(',');
      result.lct_reopen_validation = exportValidation;
      result.pptx_validation = exportValidation.passed ? 'passed' : 'failed';
      await copyOutputsToScenario(matrixResult, scenarioOut);
      await copyPreviewArtifacts(matrixResult, scenarioOut);
      result.total_ms = Math.round(performance.now() - scenarioStart);
      result.total_under_300s = result.total_ms <= 300_000;
      result.timings_ms = {
        templateParse: scenarioTemplateParseMs,
        contentParse: null,
        worker: result.worker_latency_ms,
        supervisor: result.supervisor_latency_ms,
        compile: Math.round(matrixResult.matrix.timingsMs.compile),
        render: Math.round(matrixResult.matrix.timingsMs.render),
        preview: Math.round(matrixResult.matrix.timingsMs.preview ?? 0),
        audit: Math.round(matrixResult.matrix.timingsMs.audit),
        repair: null,
        export: Math.round(matrixResult.matrix.timingsMs.render + exportValidation.totalMs),
        offlineReplayTotal: Math.round(matrixMs),
        total: result.total_ms,
      };
      if (result.unsupported_numeric_repeats > 0 || result.audit_blockers > 0 || result.pptx_validation !== 'passed') {
        result.failure_code = result.unsupported_numeric_repeats > 0 ? 'REPEATED_UNSUPPORTED_NUMERIC'
          : result.audit_blockers > 0 ? 'AUDIT_BLOCKER' : 'PPTX_VALIDATION_FAILED';
        throw Object.assign(new Error('Audit or PPTX validation stop condition was reached'), { code: result.failure_code });
      }
      if (sha256(await readFile(template.path)) !== templateHashBefore) {
        result.failure_code = 'SOURCE_TEMPLATE_MUTATED';
        throw Object.assign(new Error('Qualification changed the copied source template'), { code: result.failure_code });
      }
      if (template.sourcePath && sha256(await readFile(template.sourcePath)) !== template.sha256) {
        result.failure_code = 'SOURCE_TEMPLATE_MUTATED';
        throw Object.assign(new Error('The supplied source template changed during qualification'), { code: result.failure_code });
      }
    }
  } catch (error) {
    summary.failureCode = safeFailureCode(error?.code, 'QUALIFICATION_FAILED');
    summary.stopCondition = summary.failureCode;
    const current = summary.scenarios.at(-1);
    if (current && current.failure_code === null) current.failure_code = summary.failureCode;
  } finally {
    if (daemon) {
      daemon.server.closeAllConnections?.();
      await new Promise((resolve) => daemon.server.close(() => resolve()));
      await daemon.shutdown().catch(() => undefined);
    }
    summary.finishedAt = new Date().toISOString();
    summary.stageMs.total = Math.round(performance.now() - timingStart);
    summary.totalUnder300s = mode === 'smoke' && summary.scenarios.length === 1
      ? summary.scenarios[0].total_under_300s ?? null
      : null;
    summary.allScenarioPipelinesUnder300s = summary.scenarios.length > 0
      && summary.scenarios.every((scenario) => Number.isFinite(scenario.total_ms))
      ? summary.scenarios.every((scenario) => scenario.total_under_300s === true)
      : null;
    if (template.sourcePath) {
      try { manifest.template.sourceUnchanged = sha256(await readFile(template.sourcePath)) === template.sha256; }
      catch { manifest.template.sourceUnchanged = false; }
    } else manifest.template.sourceUnchanged = true;
    if (!manifest.template.sourceUnchanged && !summary.failureCode) {
      summary.failureCode = 'SOURCE_TEMPLATE_MUTATED';
      summary.stopCondition = 'SOURCE_TEMPLATE_MUTATED';
      const current = summary.scenarios.at(-1);
      if (current && current.failure_code === null) current.failure_code = 'SOURCE_TEMPLATE_MUTATED';
    }
    manifest.compatibility = compatibility ? {
      safeForOfficeKitBackend: compatibility.report.safeForOfficeKitBackend,
      report: 'compatibility/backend-compatibility-report.json',
    } : null;
    manifest.inferenceCalls = summary.semanticInferenceCalls;
    manifest.finishedAt = summary.finishedAt;
    manifest.secretsStored = false;
    manifest.endpointStored = false;
    await Promise.all([
      writeJson(path.join(outDir, 'manifest.json'), manifest),
      writeJson(path.join(outDir, 'summary.json'), summary),
      writeFile(path.join(outDir, 'manual-review.md'), reviewSheet(modeScenarios), 'utf8'),
    ]);
  }
  return { runId, outDir, summary, manifest };
}

function usage() {
  return 'Usage: node --import tsx scripts/run-live-quality-suite.mjs (--smoke|--suite) [--template <local.pptx>] [--out <run-name>] [--provider-kind runpod|cloudru|vk|local|unknown] [--profile <label>]';
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let exitCode = 0;
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await runLiveQualification({
      mode: args.mode,
      templatePath: args.template,
      runId: args.out,
      providerKind: args.providerKind,
      profile: args.profile,
      backend: process.env.LCT_PPTX_BACKEND,
    });
    process.stdout.write(`${JSON.stringify({ runId: result.runId, outputDirectory: result.outDir, status: result.summary.failureCode ? 'NOT_READY' : 'READY', inferenceCalls: result.summary.semanticInferenceCalls, stopCondition: result.summary.stopCondition }, null, 2)}\n`);
    if (result.summary.failureCode) exitCode = 1;
  } catch (error) {
    process.stderr.write(`${safeFailureCode(error?.code, 'QUALIFICATION_FAILED')}: ${error instanceof Error ? error.message : 'Qualification failed'}\n${usage()}\n`);
    exitCode = 64;
  } finally {
    process.stdout.write('Stop the GPU/Pod after qualification completes.\n');
  }
  process.exitCode = exitCode;
}
