#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFakeSemanticEndpoint } from './lib/fake-openai-compatible-endpoint.mjs';
import { installLoopbackFetchGuard } from './lib/offline-safety.mjs';
import { createQualificationSemanticCapture } from './lib/qualification-semantic-capture.mjs';
import {
  OpenAICompatibleSemanticInferenceAdapter,
  probeSemanticEndpoint,
  semanticInferenceConfigFromEnvironment,
} from '../apps/daemon/src/presentation/adapters/openai-compatible-semantic-inference.ts';
import { SemanticInferenceError } from '../apps/daemon/src/presentation/application/semantic-inference-port.ts';
import { QUALIFICATION_PPTX_BACKEND } from '../apps/daemon/src/presentation/application/pptx-backend-port.ts';
import { canonicalDeterministicAuditSha256, DETERMINISTIC_AUDIT_RULE_SET_VERSION } from '../apps/daemon/src/presentation/application/deterministic-audit.ts';
import {
  CONTEXTUAL_AUDIT_RULE_SET_VERSION,
  CONTEXTUAL_AUDIT_RULES,
  CONTEXTUAL_AUDIT_SCHEMA_NAME,
  CONTEXTUAL_AUDIT_SCHEMA_VERSION,
  CONTEXTUAL_AUDIT_VERSION_FINGERPRINT,
} from '../apps/daemon/src/presentation/application/contextual-audit-port.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const daemonRequire = createRequire(path.join(repoRoot, 'apps/daemon/package.json'));
const liveQualificationContract = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib/live-qualification-contract.json'), 'utf8'));
const requiredOperationTotal = liveQualificationContract.requiredOperations
  && Object.values(liveQualificationContract.requiredOperations).reduce((total, count) => total + count, 0);
const requiredOperationNames = ['deck-plan', 'plan-review', 'contextual-deck-audit'];
const optionalOperationNames = ['deck-plan-revision'];
const optionalOperationMaximumTotal = liveQualificationContract.optionalOperations
  && Object.values(liveQualificationContract.optionalOperations).reduce((total, limit) => total + limit.max, 0);
if (liveQualificationContract.schemaVersion !== 7 || liveQualificationContract.coreMaxSemanticRequests !== 4
    || liveQualificationContract.profilePreparationMaxSemanticRequests !== 32
    || liveQualificationContract.fullWorkflowMaxSemanticRequests !== 36
    || !Number.isSafeInteger(liveQualificationContract.profilerDiagnosticMaxSemanticRequests)
    || !Number.isSafeInteger(liveQualificationContract.maxProfilerRequests)
    || liveQualificationContract.maxProfilerRequests < 1 || liveQualificationContract.maxProfilerRequests > 32
    || liveQualificationContract.profilerDiagnosticMaxSemanticRequests !== liveQualificationContract.fullWorkflowMaxSemanticRequests
    || liveQualificationContract.maxProfilerRequests !== liveQualificationContract.profilePreparationMaxSemanticRequests
    || !liveQualificationContract.requiredOperations
    || Object.keys(liveQualificationContract.requiredOperations).length !== requiredOperationNames.length
    || requiredOperationNames.some((operation) => liveQualificationContract.requiredOperations[operation] !== 1)
    || !liveQualificationContract.optionalOperations
    || Object.keys(liveQualificationContract.optionalOperations).length !== optionalOperationNames.length
    || optionalOperationNames.some((operation) => liveQualificationContract.optionalOperations[operation]?.min !== 0
      || liveQualificationContract.optionalOperations[operation]?.max !== 1)
    || liveQualificationContract.generationSemanticRequests !== 0
    || !Number.isSafeInteger(requiredOperationTotal)
    || !Number.isSafeInteger(optionalOperationMaximumTotal)
    || liveQualificationContract.coreMaxSemanticRequests !== requiredOperationTotal + optionalOperationMaximumTotal
      + liveQualificationContract.generationSemanticRequests
    || liveQualificationContract.fullWorkflowMaxSemanticRequests !== liveQualificationContract.profilePreparationMaxSemanticRequests
      + liveQualificationContract.coreMaxSemanticRequests) {
  throw new TypeError('The versioned live qualification request budget contract is invalid.');
}
const CORE_MAX_SEMANTIC_REQUESTS = liveQualificationContract.coreMaxSemanticRequests;
const PROFILE_PREPARATION_MAX_SEMANTIC_REQUESTS = liveQualificationContract.profilePreparationMaxSemanticRequests;
const FULL_WORKFLOW_MAX_SEMANTIC_REQUESTS = liveQualificationContract.fullWorkflowMaxSemanticRequests;
const PROFILER_DIAGNOSTIC_MAX_SEMANTIC_REQUESTS = liveQualificationContract.profilerDiagnosticMaxSemanticRequests;
const CORE_OPERATION_LIMITS = Object.freeze({
  ...liveQualificationContract.requiredOperations,
  ...Object.fromEntries(Object.entries(liveQualificationContract.optionalOperations)
    .map(([operation, limit]) => [operation, limit.max])),
});
const DEFAULT_MODEL = 'Qwen/Qwen3.8-27B';
const RUNNER_ENV_KEYS = [
  'LCT_SEMANTIC_BASE_URL', 'LCT_SEMANTIC_MODEL', 'LCT_SEMANTIC_API_KEY', 'LCT_SEMANTIC_ENABLE_THINKING',
  'LCT_PPTX_BACKEND', 'LCT_DATA_DIR', 'LCT_IMAGE_BASE_URL', 'LCT_IMAGE_MODEL', 'LCT_IMAGE_API_KEY',
  'LCT_TEMPLATE_PROFILE_CONCURRENCY',
  'OPENAI_BASE_URL', 'OPENAI_API_KEY',
];

export function parseArgs(argv) {
  const options = { mode: null, templatePath: null, task: null, context: '', sources: [], slides: 3,
    providerLabel: null, outputDir: null, maxSemanticRequests: null,
    maxSemanticRequestsExplicit: false, enableTemplateProfiler: true, dryRun: false, preflightOnly: false };
  const valued = new Set(['--semantic-mode', '--template', '--task', '--context', '--source', '--slides',
    '--provider-label', '--output-dir', '--max-semantic-requests']);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { ...options, help: true };
    if (flag === '--dry-run') { options.dryRun = true; continue; }
    if (flag === '--preflight-only') { options.preflightOnly = true; continue; }
    if (flag === '--enable-template-profiler') { options.enableTemplateProfiler = true; continue; }
    if (!valued.has(flag)) throw new TypeError(`Unknown option: ${flag}`);
    const value = argv[++index];
    if (value === undefined || value === '') throw new TypeError(`${flag} requires a value`);
    if (flag === '--source') { options.sources.push(value); continue; }
    if (flag === '--slides') {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 30) throw new TypeError('--slides must be an integer between 1 and 30');
      options.slides = parsed;
      continue;
    }
    if (flag === '--max-semantic-requests') {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > PROFILER_DIAGNOSTIC_MAX_SEMANTIC_REQUESTS) {
        throw new TypeError(`--max-semantic-requests must be between 1 and ${PROFILER_DIAGNOSTIC_MAX_SEMANTIC_REQUESTS}`);
      }
      options.maxSemanticRequests = parsed;
      options.maxSemanticRequestsExplicit = true;
      continue;
    }
    if (flag === '--semantic-mode') options.mode = value;
    else if (flag === '--template') options.templatePath = value;
    else if (flag === '--task') options.task = value;
    else if (flag === '--context') options.context = value;
    else if (flag === '--provider-label') options.providerLabel = value;
    else if (flag === '--output-dir') options.outputDir = value;
  }
  if (!['fake', 'external'].includes(options.mode)) throw new TypeError('--semantic-mode must be fake or external');
  if (!options.templatePath) throw new TypeError('--template is required');
  if (!options.task?.trim() || options.task.length > 8_000) throw new TypeError('--task is required and must be at most 8000 characters');
  if (options.context.length > 24_000) throw new TypeError('--context must be at most 24000 characters');
  if (options.sources.length > 12) throw new TypeError('At most 12 --source files can be supplied');
  if (options.providerLabel !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(options.providerLabel)) {
    throw new TypeError('--provider-label may contain only letters, numbers, dots, underscores, and hyphens');
  }
  if (options.dryRun && options.preflightOnly) throw new TypeError('--dry-run and --preflight-only cannot be combined');
  if (options.preflightOnly && options.mode !== 'external') throw new TypeError('--preflight-only requires --semantic-mode external');
  const requestCeiling = FULL_WORKFLOW_MAX_SEMANTIC_REQUESTS;
  if (options.maxSemanticRequestsExplicit && options.maxSemanticRequests > requestCeiling) {
    throw new TypeError(`--max-semantic-requests must be between 1 and ${requestCeiling}`);
  }
  options.maxSemanticRequests ??= requestCeiling;
  delete options.maxSemanticRequestsExplicit;
  return options;
}

export function helpText() {
  return [
    'Usage: node --import tsx scripts/run-product-e2e.mjs --semantic-mode fake|external --template <file.pptx> --task <text> [options]',
    '  --context <text>                 Optional context text',
    '  --source <file>                  Optional source file; may be repeated (up to 12)',
    '  --slides <number>                Requested slide count, 1..30 (default 3)',
    '  --provider-label <label>         Manifest label only; does not change transport',
    '  --output-dir <directory>         New or empty output directory',
    `  --max-semantic-requests <1..${FULL_WORKFLOW_MAX_SEMANTIC_REQUESTS}>   Full qualification cap; core ${CORE_MAX_SEMANTIC_REQUESTS}, profile preparation ${PROFILE_PREPARATION_MAX_SEMANTIC_REQUESTS}; default ${FULL_WORKFLOW_MAX_SEMANTIC_REQUESTS}`,
    `  --enable-template-profiler       Accepted for compatibility; template profile preparation is part of the normal flow (up to ${liveQualificationContract.maxProfilerRequests} batches)`,
    '  --dry-run                        Validate inputs/config only; no daemon or network',
    '  --preflight-only                 External mode: GET /v1/models only; no chat completion',
  ].join('\n');
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sha256Text(value) { return sha256(Buffer.from(value, 'utf8')); }
function nowIso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function safeErrorCode(error) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'PRODUCT_E2E_FAILED';
}

function errorWithCode(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function assertQualificationPptxBackend(actual) {
  if (actual !== QUALIFICATION_PPTX_BACKEND) {
    throw errorWithCode('PPTX_BACKEND_MISMATCH', `Expected qualification backend ${QUALIFICATION_PPTX_BACKEND}, received ${String(actual)}.`);
  }
  return actual;
}

async function resolveInputs(options) {
  const templatePath = await realpath(options.templatePath);
  const templateStats = await stat(templatePath);
  if (!templateStats.isFile() || templateStats.size === 0 || path.extname(templatePath).toLowerCase() !== '.pptx') {
    throw errorWithCode('INVALID_TEMPLATE_FILE', 'Template must be a non-empty PPTX file.');
  }
  const templateBytes = await readFile(templatePath);
  const sources = [];
  const sourcePaths = new Set();
  const sourceNames = new Set();
  for (const sourceArgument of options.sources) {
    const sourcePath = await realpath(sourceArgument);
    if (sourcePath === templatePath || sourcePaths.has(sourcePath)) throw errorWithCode('DUPLICATE_SOURCE_FILE', 'Template and source paths must be unique.');
    sourcePaths.add(sourcePath);
    const sourceName = path.basename(sourcePath);
    if (sourceNames.has(sourceName)) throw errorWithCode('DUPLICATE_SOURCE_FILENAME', 'Source files must have unique filenames within the project.');
    sourceNames.add(sourceName);
    const sourceStats = await stat(sourcePath);
    if (!sourceStats.isFile() || sourceStats.size === 0 || sourceStats.size > 64 * 1024 * 1024) {
      throw errorWithCode('INVALID_SOURCE_FILE', 'Each source must be a non-empty file no larger than 64 MiB.');
    }
    const bytes = await readFile(sourcePath);
    sources.push({ path: sourcePath, name: sourceName, bytes, sha256: sha256(bytes) });
  }
  return { templatePath, templateName: path.basename(templatePath), templateBytes, templateHash: sha256(templateBytes), sources };
}

export function externalSemanticConfig(environment = process.env) {
  if (!environment.LCT_SEMANTIC_BASE_URL?.trim()) throw errorWithCode('SEMANTIC_CONFIG_INVALID', 'LCT_SEMANTIC_BASE_URL is required for external mode.');
  if (!environment.LCT_SEMANTIC_MODEL?.trim()) throw errorWithCode('SEMANTIC_CONFIG_INVALID', 'LCT_SEMANTIC_MODEL is required for external mode.');
  const config = semanticInferenceConfigFromEnvironment(environment);
  return {
    config,
    summary: {
      endpointConfigured: true,
      model: config.model,
      authConfigured: Boolean(config.apiKey),
      thinkingEnabled: config.enableThinking ?? null,
    },
  };
}

function canonicalMessageFingerprint(request) {
  const hash = createHash('sha256');
  hash.update(request.role);
  hash.update('\0');
  hash.update(request.operation);
  hash.update('\0');
  hash.update(JSON.stringify(request.output.schema));
  for (const message of request.messages) {
    hash.update('\0'); hash.update(message.role); hash.update('\0');
    if (typeof message.content === 'string') hash.update(message.content);
    else for (const part of message.content) {
      hash.update(part.type); hash.update('\0');
      if (part.type === 'text') hash.update(part.text);
      else hash.update(Buffer.from(part.data));
    }
  }
  return hash.digest('hex');
}

function normalizedOperation(operation) {
  if (operation === 'template-semantic-profile') return 'profiler';
  if (operation === 'deck-plan') return 'worker';
  if (operation === 'plan-review') return 'planningSupervisor';
  if (operation === 'contextual-deck-audit') return 'contextualAudit';
  if (operation === 'deck-plan-revision') return 'revisionWorker';
  return 'other';
}

export function createRequestBudgetAdapter(delegate, limit = FULL_WORKFLOW_MAX_SEMANTIC_REQUESTS, startedAt = () => nowIso()) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > FULL_WORKFLOW_MAX_SEMANTIC_REQUESTS
      || PROFILER_DIAGNOSTIC_MAX_SEMANTIC_REQUESTS !== FULL_WORKFLOW_MAX_SEMANTIC_REQUESTS) {
    throw new TypeError(`Semantic request budget must be between 1 and ${PROFILER_DIAGNOSTIC_MAX_SEMANTIC_REQUESTS}.`);
  }
  const records = [];
  let rejectedAttempts = 0;
  let profilePreparationRequests = 0;
  let coreRequests = 0;
  const coreOperationCounts = new Map();
  let coreStarted = false;
  let profilePrepared = false;
  const reject = (message) => {
    rejectedAttempts += 1;
    throw new SemanticInferenceError('RATE_LIMITED', message);
  };
  return {
    records,
    get rejectedAttempts() { return rejectedAttempts; },
    markProfilePrepared() {
      if (profilePrepared || coreStarted || profilePreparationRequests < 1) {
        throw new TypeError('A READY semantic profile must be confirmed once, after preparation and before core generation.');
      }
      profilePrepared = true;
    },
    adapter: {
      async infer(request) {
        const isProfilePreparation = request.operation === 'template-semantic-profile';
        if (records.length >= limit) reject('Qualification full-workflow semantic request budget exhausted before dispatch');
        if (isProfilePreparation) {
          if (coreStarted) reject('Template profiling is forbidden after core generation starts');
          if (profilePreparationRequests >= PROFILE_PREPARATION_MAX_SEMANTIC_REQUESTS) {
            reject('Qualification profile-preparation semantic request budget exhausted before dispatch');
          }
          profilePreparationRequests += 1;
        } else {
          if (!profilePrepared) reject('Core generation requires a previously prepared READY semantic profile');
          if (coreRequests >= CORE_MAX_SEMANTIC_REQUESTS) reject('Qualification core-generation semantic request budget exhausted before dispatch');
          const operationLimit = CORE_OPERATION_LIMITS[request.operation];
          if (!Number.isSafeInteger(operationLimit)) reject('Unexpected semantic operation is forbidden by the qualification contract');
          const operationCount = coreOperationCounts.get(request.operation) ?? 0;
          if (operationCount >= operationLimit) reject('Qualification semantic operation limit exhausted before dispatch');
          coreStarted = true;
          coreRequests += 1;
          coreOperationCounts.set(request.operation, operationCount + 1);
        }
        const started = performance.now();
        const profilerEvidence = isProfilePreparation ? request.messages.find((message) => message.role === 'user')?.content : null;
        const record = {
          operation: request.operation,
          accounting: normalizedOperation(request.operation),
          model: delegate.model ?? null,
          requestHash: canonicalMessageFingerprint(request),
          maxOutputTokens: request.maxOutputTokens,
          responseFormat: 'json_schema',
          strictJsonSchema: true,
          templateProfilerBatch: request.metadata?.templateProfilerBatch ?? null,
          evidenceBytes: isProfilePreparation && typeof profilerEvidence === 'string'
            ? Buffer.byteLength(profilerEvidence, 'utf8') : null,
          systemPromptBytes: request.metadata?.templateProfilerBatch?.systemPromptBytes ?? null,
          schemaBytes: request.metadata?.templateProfilerBatch?.schemaBytes ?? null,
          envelopeOverheadBytes: request.metadata?.templateProfilerBatch?.envelopeOverheadBytes ?? null,
          outputTokenReserveBytes: request.metadata?.templateProfilerBatch?.outputTokenReserveBytes ?? null,
          estimatedTotalRequestBytes: request.metadata?.templateProfilerBatch?.estimatedTotalRequestBytes ?? null,
          startedAt: startedAt(),
          wallTimeMs: null,
          finishReason: null,
          httpStatus: null,
          runtimeSchemaValidation: 'not-run',
          validationFailureCode: null,
          promptTokens: null,
          completionTokens: null,
          status: 'running',
          errorCode: null,
        };
        records.push(record);
        try {
          const response = await delegate.infer(request);
          record.model = response.telemetry.model;
          record.startedAt = response.telemetry.startedAt;
          record.wallTimeMs = response.telemetry.wallTimeMs;
          record.finishReason = response.telemetry.finishReason ?? null;
          record.httpStatus = response.telemetry.httpStatus ?? null;
          record.runtimeSchemaValidation = response.telemetry.runtimeSchemaValidation ?? 'passed';
          record.validationFailureCode = response.telemetry.validationFailureCode ?? null;
          record.promptTokens = response.telemetry.promptTokens ?? null;
          record.completionTokens = response.telemetry.completionTokens ?? null;
          record.status = 'success';
          return response;
        } catch (error) {
          const telemetry = error instanceof SemanticInferenceError ? error.telemetry : undefined;
          record.model = telemetry?.model ?? record.model;
          record.startedAt = telemetry?.startedAt ?? record.startedAt;
          record.wallTimeMs = telemetry?.wallTimeMs ?? Math.max(0, Math.round(performance.now() - started));
          record.finishReason = telemetry?.finishReason ?? null;
          record.httpStatus = telemetry?.httpStatus ?? (error instanceof SemanticInferenceError ? error.httpStatus : null);
          record.runtimeSchemaValidation = telemetry?.runtimeSchemaValidation ?? 'not-run';
          record.validationFailureCode = telemetry?.validationFailureCode ?? null;
          record.promptTokens = telemetry?.promptTokens ?? null;
          record.completionTokens = telemetry?.completionTokens ?? null;
          record.status = 'error';
          record.errorCode = safeErrorCode(error);
          throw error;
        }
      },
    },
  };
}

function emptySemanticCounts() {
  return { profiler: 0, worker: 0, planningSupervisor: 0, contextualAudit: 0, revisionWorker: 0, other: 0, generation: 0, total: 0 };
}

function semanticCounts(records) {
  const counts = emptySemanticCounts();
  for (const record of records) counts[normalizedOperation(record.operation)] += 1;
  counts.total = records.length;
  return counts;
}

export function validateQualificationSemanticOperationAccounting(records) {
  if (!Array.isArray(records)) throw new TypeError('Qualification semantic operation records must be an array.');
  const rawOperationCounts = Object.fromEntries([...new Set(records.map((record) => record.operation))]
    .map((operation) => [operation, records.filter((record) => record.operation === operation).length]));
  const counts = semanticCounts(records);
  const requiredOperations = liveQualificationContract.requiredOperations;
  const optionalOperations = liveQualificationContract.optionalOperations;
  const unexpectedOperations = Object.keys(rawOperationCounts).filter((operation) => operation !== 'template-semantic-profile'
    && !Object.hasOwn(requiredOperations, operation) && !Object.hasOwn(optionalOperations, operation));
  const profileRequestCount = rawOperationCounts['template-semantic-profile'] ?? 0;
  const optionalOperationTotal = Object.entries(optionalOperations)
    .reduce((total, [operation]) => total + (rawOperationCounts[operation] ?? 0), 0);
  const optionalCountsValid = Object.entries(optionalOperations).every(([operation, limit]) => {
    const count = rawOperationCounts[operation] ?? 0;
    return count >= limit.min && count <= limit.max;
  });
  const expectedTotal = profileRequestCount + requiredOperationTotal + optionalOperationTotal
    + liveQualificationContract.generationSemanticRequests;
  if (unexpectedOperations.length || profileRequestCount < 1
      || profileRequestCount > liveQualificationContract.maxProfilerRequests
      || Object.entries(requiredOperations).some(([operation, count]) => rawOperationCounts[operation] !== count)
      || !optionalCountsValid
      || counts.generation !== liveQualificationContract.generationSemanticRequests
      || counts.total !== expectedTotal
      || counts.total > FULL_WORKFLOW_MAX_SEMANTIC_REQUESTS) {
    throw errorWithCode('SEMANTIC_OPERATION_ACCOUNTING_MISMATCH', 'One-click semantic request operation counts differ from the bounded qualification workflow.');
  }
  return {
    rawOperationCounts,
    operationCounts: counts,
    profileRequestCount,
    coreRequestCount: counts.total - profileRequestCount,
    optionalOperationTotal,
  };
}

function requestRecords(records) {
  return records.map(({ operation, model, requestHash, maxOutputTokens, responseFormat, strictJsonSchema, templateProfilerBatch, evidenceBytes, systemPromptBytes, schemaBytes, envelopeOverheadBytes, outputTokenReserveBytes, estimatedTotalRequestBytes, startedAt, wallTimeMs, httpStatus, finishReason, promptTokens, completionTokens, runtimeSchemaValidation, validationFailureCode, status, errorCode }) => ({
    operation, model, requestHash, maxOutputTokens, responseFormat, strictJsonSchema, templateProfilerBatch, evidenceBytes, systemPromptBytes, schemaBytes, envelopeOverheadBytes, outputTokenReserveBytes, estimatedTotalRequestBytes, startedAt, wallTimeMs, httpStatus, finishReason, promptTokens, completionTokens, runtimeSchemaValidation, validationFailureCode, status, errorCode,
  }));
}

function safeManifestBase(options, input, model) {
  let gitSha = null;
  try { gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { /* A copied source tree may not have Git metadata. */ }
  return {
    schemaVersion: 1,
    mode: options.mode,
    providerLabel: options.providerLabel ?? (options.mode === 'fake' ? 'local-fake' : 'external'),
    templateProfilerEnabled: options.enableTemplateProfiler,
    gitSha,
    startedAt: nowIso(),
    finishedAt: null,
    taskHash: sha256Text(options.task),
    contextHash: options.context ? sha256Text(options.context) : null,
    template: {
      filename: input.templateName,
      sha256: input.templateHash,
      slideCount: null,
    },
    sources: input.sources.map(({ name, sha256: sourceHash }) => ({ filename: name, sha256: sourceHash })),
    requestedSlides: options.slides,
    expectedPptxBackend: QUALIFICATION_PPTX_BACKEND,
    pptxBackend: null,
    actualSlides: null,
    semantic: {
      model,
      requestBudget: options.maxSemanticRequests,
      requestCount: 0,
      requests: [],
      operationCounts: emptySemanticCounts(),
      rawOperationCounts: {},
      budgetRejectedAttempts: 0,
      automaticRetries: 0,
      healthRequests: 0,
      modelsRequests: 0,
    },
    workflow: { stages: [], finalStatus: 'not-started', templatePreparation: null, timeToThreeVariantsReadyMs: null },
    generation: { variantsReady: 0, deterministicAudit: { status: 'not-run', errorCount: null, warningCount: null }, contextualAudit: { status: 'not-run', findingCount: null, ruleIds: [] } },
    audit: {
      deterministic: { ruleSetVersion: DETERMINISTIC_AUDIT_RULE_SET_VERSION, canonicalSha256: null, auditedVariants: 0 },
      contextual: { ruleSetVersion: CONTEXTUAL_AUDIT_RULE_SET_VERSION, schemaName: CONTEXTUAL_AUDIT_SCHEMA_NAME,
        schemaVersion: CONTEXTUAL_AUDIT_SCHEMA_VERSION, expectedRules: CONTEXTUAL_AUDIT_RULES.length, actualRules: null,
        versionFingerprint: CONTEXTUAL_AUDIT_VERSION_FINGERPRINT },
    },
    exports: { pptx: {}, pdf: null, html: null },
    timing: {
      templateAnalysisMs: null, templateStructuralMs: null, templateSemanticProfileMs: null,
      templatePreparationMs: null, timeToThreeVariantsReadyMs: null, planningMs: null,
      generationMs: null, contextualAuditMs: null, exportsMs: null, totalMs: null,
      semanticTotalMs: 0, deterministicTotalMs: null,
    },
    sourceTemplateUnchanged: null,
    imageGeneration: { configured: false, networkRequests: 0 },
    result: 'RUNNING',
    failure: null,
  };
}

async function prepareOutputDirectory(outputDir) {
  await mkdir(path.dirname(outputDir), { recursive: true });
  try {
    const contents = await readdir(outputDir);
    if (contents.length > 0) throw errorWithCode('OUTPUT_DIRECTORY_NOT_EMPTY', 'The output directory must be empty.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(outputDir, { recursive: false });
  }
}

async function writeManifest(outputDir, manifest) {
  await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function requestJson(baseUrl, route, options = {}, expectedStatus = 200) {
  const response = await fetch(new URL(route, baseUrl), options);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; }
  catch { throw errorWithCode('PRODUCT_API_INVALID_JSON', 'Product API returned a non-JSON response.'); }
  if (response.status !== expectedStatus) {
    const apiCode = body?.error?.code ?? body?.failure?.code ?? body?.semanticProfile?.failureCode;
    throw errorWithCode(typeof apiCode === 'string' && /^[A-Z0-9_]{1,64}$/.test(apiCode) ? apiCode : 'PRODUCT_API_HTTP_ERROR', `Unexpected HTTP ${response.status} from product API.`);
  }
  return body;
}

async function uploadFile(baseUrl, projectId, name, bytes) {
  const form = new FormData();
  form.append('files', new Blob([bytes]), name);
  const { files } = await requestJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/upload`, { method: 'POST', body: form });
  const match = files?.find((file) => file.originalName === name || file.name === name || file.path === name);
  const savedPath = match?.path ?? match?.filePath ?? match?.name;
  if (typeof savedPath !== 'string' || !savedPath) throw errorWithCode('UPLOAD_PATH_MISSING', 'Uploaded file path was not returned.');
  return savedPath;
}

async function downloadArtifact(baseUrl, projectId, mode, format) {
  const { artifact } = await requestJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/generation/export`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, format }),
  }, 201);
  if (artifact?.validationStatus !== 'passed' || typeof artifact.downloadUrl !== 'string') {
    throw errorWithCode('EXPORT_VALIDATION_FAILED', `${mode} ${format} export did not pass product validation.`);
  }
  const target = new URL(artifact.downloadUrl, baseUrl);
  if (target.origin !== new URL(baseUrl).origin) throw errorWithCode('EXPORT_URL_INVALID', 'Product export URL escaped the local product API.');
  const response = await fetch(target);
  if (!response.ok) throw errorWithCode('EXPORT_DOWNLOAD_FAILED', `Could not download ${mode} ${format} export.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (artifact.sha256 && sha256(bytes) !== artifact.sha256) throw errorWithCode('EXPORT_HASH_MISMATCH', `${mode} ${format} export hash does not match its manifest.`);
  return { artifact, bytes };
}

async function waitForWorkflow(baseUrl, projectId, timeoutMs, onSnapshot) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = (await requestJson(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/workflow`)).operation;
    if (last) onSnapshot(last);
    if (last?.status === 'ready' || last?.status === 'failed') return last;
    await sleep(100);
  }
  throw errorWithCode('PRODUCT_WORKFLOW_TIMEOUT', `Product workflow did not finish at stage ${last?.stage ?? 'unknown'}.`);
}

function artifactSummary(bytes, extra = {}) {
  return { bytes: bytes.length, sha256: sha256(bytes), validation: 'passed', ...extra };
}

async function closeServer(started) {
  if (!started) return;
  if (started.server.listening) {
    started.server.closeAllConnections?.();
    await new Promise((resolve, reject) => started.server.close((error) => error ? reject(error) : resolve()));
  }
  await started.shutdown();
}

function operationTimes(records) {
  const sum = (operation) => records.filter((record) => record.operation === operation).reduce((total, record) => total + (record.wallTimeMs ?? 0), 0);
  return {
    templateSemanticProfileMs: sum('template-semantic-profile'),
    planningMs: sum('deck-plan') + sum('plan-review') + sum('deck-plan-revision'),
    contextualAuditMs: sum('contextual-deck-audit'),
  };
}

function stageClock(stageTransitions, stage) {
  const start = stageTransitions.find((item) => item.stage === stage)?.at;
  if (start === undefined) return null;
  const end = stageTransitions.find((item) => item.at > start && ['understanding_template', 'planning', 'generating', 'contextual_audit', 'ready', 'failed'].includes(item.stage))?.at;
  return end === undefined ? null : Math.max(0, Math.round(end - start));
}

async function runProductWorkflow(options, input, outputDir, dependencies = {}) {
  const env = dependencies.environment ?? process.env;
  const envBackup = Object.fromEntries(RUNNER_ENV_KEYS.map((key) => [key, env[key]]));
  const flowStarted = performance.now();
  const manifest = safeManifestBase(options, input, options.mode === 'fake' ? 'offline-fake-planner' : options.externalConfig.model);
  const semanticCapture = createQualificationSemanticCapture(outputDir, {
    forbiddenValues: [env.LCT_SEMANTIC_BASE_URL, env.LCT_SEMANTIC_API_KEY, options.externalConfig?.baseUrl, options.externalConfig?.apiKey],
  });
  const semanticEndpointFactory = dependencies.startFakeSemanticEndpoint ?? startFakeSemanticEndpoint;
  let fakeEndpoint = null;
  let startedServer = null;
  const networkGuard = options.mode === 'fake' ? installLoopbackFetchGuard() : null;
  let stage = 'configuration';
  let lastStage = null;
  const observe = (operation) => {
    if (operation?.stage && operation.stage !== lastStage) {
      lastStage = operation.stage;
      manifest.workflow.stages.push({ stage: operation.stage, observedAt: nowIso(), readySlides: operation.readySlides, totalSlides: operation.totalSlides });
      stageTransitions.push({ stage: operation.stage, at: performance.now() });
    }
  };
  const stageTransitions = [];
  let budget = null;
  try {
    if (options.mode === 'fake') {
      fakeEndpoint = await semanticEndpointFactory({ model: 'offline-fake-planner' });
      env.LCT_SEMANTIC_BASE_URL = fakeEndpoint.baseUrl;
      env.LCT_SEMANTIC_MODEL = 'offline-fake-planner';
      env.LCT_SEMANTIC_ENABLE_THINKING = 'false';
      delete env.LCT_SEMANTIC_API_KEY;
    } else {
      const probe = dependencies.probeSemanticEndpoint ?? probeSemanticEndpoint;
      manifest.semantic.modelsRequests += 1;
      const reachable = await probe(options.externalConfig, dependencies.fetcher ?? globalThis.fetch);
      if (!reachable) throw errorWithCode('SEMANTIC_MODELS_UNREACHABLE', 'External semantic endpoint or configured model is unavailable; no chat completion was sent.');
    }
    env.LCT_DATA_DIR = path.join(outputDir, 'runtime-data');
    for (const key of ['LCT_IMAGE_BASE_URL', 'LCT_IMAGE_MODEL', 'LCT_IMAGE_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_KEY']) delete env[key];

    const delegate = options.mode === 'fake'
      ? new OpenAICompatibleSemanticInferenceAdapter({ baseUrl: fakeEndpoint.baseUrl, model: 'offline-fake-planner', enableThinking: false })
      : new OpenAICompatibleSemanticInferenceAdapter(options.externalConfig);
    budget = createRequestBudgetAdapter(semanticCapture.wrap(delegate), options.maxSemanticRequests);
    const { startServer } = await import('../apps/daemon/src/server.ts');
    const { inspectOfficeKitPackage } = await import('../apps/daemon/src/presentation/adapters/office-kit-package-inspector.ts');
    const officePackageJson = daemonRequire.resolve('@office-kit/pptx/package.json');
    const office = await import(pathToFileURL(path.join(path.dirname(officePackageJson), 'dist/node.js')));

    stage = 'daemon-startup';
    startedServer = await startServer({ host: '127.0.0.1', port: 0, dataDir: path.join(outputDir, 'runtime-data'), projectRoot: repoRoot,
      serveWeb: false, returnServer: true, semanticInferenceAdapter: budget.adapter,
      templateProfileConcurrency: Number(env.LCT_TEMPLATE_PROFILE_CONCURRENCY ?? 1),
      enableSemanticProfiling: options.enableTemplateProfiler });
    manifest.semantic.healthRequests += 1;
    await requestJson(startedServer.url, '/api/health');
    const readiness = await requestJson(startedServer.url, '/api/readiness');
    manifest.pptxBackend = assertQualificationPptxBackend(readiness.checks?.pptxBackend);
    const imageModels = await requestJson(startedServer.url, '/api/media/models');
    assert.equal(imageModels.configured, false, 'E2E runner must not configure or call an image service');
    assert.deepEqual(imageModels.image, []);

    stage = 'uploading';
    const projectId = `e2e-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    await requestJson(startedServer.url, '/api/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: projectId, name: 'Локальная E2E квалификация' }),
    }, 201);
    const templateFilePath = await uploadFile(startedServer.url, projectId, input.templateName, input.templateBytes);
    const contentFiles = [];
    for (const source of input.sources) contentFiles.push(await uploadFile(startedServer.url, projectId, source.name, source.bytes));

    stage = 'template-preparation';
    const templateStructure = await inspectOfficeKitPackage(input.templateBytes);
    manifest.template.slideCount = templateStructure.slideCount;
    const preparationStarted = performance.now();
    const prepared = await requestJson(startedServer.url, `/api/projects/${encodeURIComponent(projectId)}/template/compile`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filePath: templateFilePath }),
    });
    if (prepared.status !== 'ready') {
      throw errorWithCode('TEMPLATE_STRUCTURAL_ANALYSIS_NOT_READY', 'Structural template analysis did not reach READY.');
    }
    if (options.enableTemplateProfiler && prepared.semanticProfile?.status !== 'ready') {
      const failureCode = prepared.semanticProfile?.failureCode;
      throw errorWithCode(typeof failureCode === 'string' ? failureCode : 'TEMPLATE_PROFILE_NOT_READY',
        'Template semantic profile preparation did not reach READY.');
    }
    const templatePreparationMs = Math.max(0, Math.round(performance.now() - preparationStarted));
    const preparedStatus = await requestJson(startedServer.url, `/api/projects/${encodeURIComponent(projectId)}/template`);
    const expectedProfileStatus = 'ready';
    if (preparedStatus.status !== 'ready' || prepared.semanticProfile?.status !== 'ready'
        || preparedStatus.semanticProfile?.status !== expectedProfileStatus
        || preparedStatus.semanticProfile?.cached !== true
        || Object.hasOwn(preparedStatus, 'semanticProfileData')) {
      throw errorWithCode('TEMPLATE_STATUS_INVALID', 'Structural or semantic template preparation status was not safely read back.');
    }
    budget.markProfilePrepared();
    const profilerCountBeforeGenerate = budget.records.filter((record) => record.operation === 'template-semantic-profile').length;
    if (profilerCountBeforeGenerate < 1 || profilerCountBeforeGenerate > liveQualificationContract.maxProfilerRequests) {
      throw errorWithCode('TEMPLATE_PROFILE_REQUEST_COUNT_INVALID', 'Template profile preparation exceeded its configured batch limit.');
    }
    manifest.workflow.templatePreparation = {
      structuralStatus: 'ready',
      semanticProfileStatus: prepared.semanticProfile?.status ?? 'missing',
      cachedStatusRead: true,
      profileRequests: profilerCountBeforeGenerate,
      templateStructuralMs: prepared.templateStructuralMs ?? templatePreparationMs,
      templateSemanticProfileMs: prepared.semanticProfile?.templateSemanticProfileMs ?? null,
      templatePreparationMs,
    };
    manifest.timing.templateStructuralMs = prepared.templateStructuralMs ?? templatePreparationMs;
    manifest.timing.templateAnalysisMs = manifest.timing.templateStructuralMs;
    manifest.timing.templateSemanticProfileMs = prepared.semanticProfile?.templateSemanticProfileMs ?? null;
    manifest.timing.templatePreparationMs = templatePreparationMs;
    const brief = {
      audience: 'Аудитория из задачи',
      purpose: options.task,
      expectedOutcome: 'Получить связную презентацию по задаче и предоставленным материалам.',
      context: options.context,
      preferences: [],
      requestedSlideCount: options.slides,
    };
    stage = 'generation-click';
    const workflowStarted = performance.now();
    const begin = await requestJson(startedServer.url, `/api/projects/${encodeURIComponent(projectId)}/workflow/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateFilePath, contentFiles, brief }),
    }, 202);
    const operationId = begin.operation?.operationId;
    if (typeof operationId !== 'string') throw errorWithCode('PRODUCT_WORKFLOW_ID_MISSING', 'Product workflow did not return an operation id.');
    observe(begin.operation);
    const operation = await waitForWorkflow(startedServer.url, projectId, options.slides >= 10 ? 240_000 : 180_000, observe);
    const profilerCountAfterGenerate = budget.records.filter((record) => record.operation === 'template-semantic-profile').length;
    if (profilerCountAfterGenerate !== profilerCountBeforeGenerate) {
      throw errorWithCode('TEMPLATE_PROFILE_RAN_DURING_GENERATE', 'Generate requested template profiling instead of using the prepared cache.');
    }
    if (operation.operationId !== operationId) throw errorWithCode('PRODUCT_WORKFLOW_ID_CHANGED', 'A different operation replaced the isolated E2E workflow.');
    if (operation.status !== 'ready') throw errorWithCode(operation.failure?.code ?? 'PRODUCT_WORKFLOW_FAILED', 'Product workflow ended before READY.');
    if (!Number.isSafeInteger(operation.timeToThreeVariantsReadyMs) || operation.timeToThreeVariantsReadyMs < 0
        || !operation.generationStartedAt || !operation.threeVariantsReadyAt) {
      throw errorWithCode('THREE_VARIANTS_TIMING_MISSING', 'Workflow did not persist its three-variant readiness timing.');
    }
    manifest.timing.timeToThreeVariantsReadyMs = operation.timeToThreeVariantsReadyMs;
    manifest.workflow.timeToThreeVariantsReadyMs = operation.timeToThreeVariantsReadyMs;
    if (operation.totalSlides !== options.slides || operation.readySlides !== options.slides) throw errorWithCode('REQUESTED_SLIDE_COUNT_MISMATCH', 'Product workflow did not complete the requested slide count.');
    if (operation.contextualAudit?.status !== 'ready' || operation.contextualAudit?.stale !== false
        || operation.contextualAudit.schemaVersion !== CONTEXTUAL_AUDIT_SCHEMA_VERSION
        || operation.contextualAudit.ruleSetVersion !== CONTEXTUAL_AUDIT_RULE_SET_VERSION
        || operation.contextualAudit.auditVersionFingerprint !== CONTEXTUAL_AUDIT_VERSION_FINGERPRINT
        || operation.contextualAudit.findings?.length !== CONTEXTUAL_AUDIT_RULES.length) {
      throw errorWithCode('CONTEXTUAL_AUDIT_INVALID', 'Contextual audit is missing, stale, or incomplete.');
    }
    const operationThroughAuditMs = Math.round(performance.now() - workflowStarted);

    stage = 'retrieving-product-state';
    const planning = await requestJson(startedServer.url, `/api/projects/${encodeURIComponent(projectId)}/planning`);
    if (planning.status !== 'ready' || planning.deckPlan?.slides?.length !== options.slides) throw errorWithCode('PLANNING_STATE_INVALID', 'Saved DeckPlan does not match requested slide count.');
    const { generation } = await requestJson(startedServer.url, `/api/projects/${encodeURIComponent(projectId)}/generation`);
    if (generation?.status !== 'completed' || generation.slides?.length !== options.slides) throw errorWithCode('GENERATION_STATE_INVALID', 'Generated slide packs are incomplete.');
    assertQualificationPptxBackend(generation.backend);
    if (generation.backend !== manifest.pptxBackend) throw errorWithCode('PPTX_BACKEND_DRIFT', 'The generation backend differs from daemon readiness.');
    const unready = generation.slides.flatMap((slide) => ['A', 'B', 'C'].filter((variant) => slide.variants?.[variant]?.status !== 'ready'));
    if (unready.length) throw errorWithCode('VARIANT_WITHHELD', `${unready.length} A/B/C variants are not ready.`);
    const deterministicReports = generation.slides.flatMap((slide) => ['A', 'B', 'C'].map((variant) => {
      const audit = slide.variants[variant]?.audit;
      if (!audit || audit.ruleSetVersion !== DETERMINISTIC_AUDIT_RULE_SET_VERSION || !Array.isArray(audit.findings) || !Array.isArray(audit.checks)) {
        throw errorWithCode('DETERMINISTIC_AUDIT_MISSING', `Slide ${slide.slideId} variant ${variant} has no versioned deterministic audit.`);
      }
      return { slideId: slide.slideId, variant, canonicalSha256: canonicalDeterministicAuditSha256(audit) };
    }));
    const deterministicFindings = generation.slides.flatMap((slide) => ['A', 'B', 'C'].flatMap((variant) =>
      slide.variants[variant]?.audit?.findings ?? []));
    const deterministicErrors = deterministicFindings.filter((finding) => finding.severity === 'error');
    if (deterministicErrors.length) throw errorWithCode('DETERMINISTIC_AUDIT_FAILED', `${deterministicErrors.length} deterministic audit errors block export.`);
    const auditReadback = (await requestJson(startedServer.url, `/api/projects/${encodeURIComponent(projectId)}/workflow`)).operation;
    if (auditReadback?.operationId !== operationId || auditReadback.contextualAudit?.stale !== false) {
      throw errorWithCode('CONTEXTUAL_AUDIT_STALE', 'Persisted workflow/audit state did not survive reload-style readback.');
    }
    manifest.actualSlides = generation.slides.length;
    manifest.workflow.finalStatus = 'ready';
    manifest.generation.variantsReady = generation.slides.length * 3;
    manifest.generation.deterministicAudit = {
      status: 'passed', errorCount: deterministicErrors.length,
      warningCount: deterministicFindings.filter((finding) => finding.severity === 'warning').length,
    };
    manifest.generation.contextualAudit = {
      status: 'passed', findingCount: operation.contextualAudit.findings.length,
      ruleIds: operation.contextualAudit.findings.map((finding) => finding.ruleId).sort(),
    };
    manifest.audit.deterministic.canonicalSha256 = sha256Text(JSON.stringify({
      ruleSetVersion: DETERMINISTIC_AUDIT_RULE_SET_VERSION,
      reports: deterministicReports,
    }));
    manifest.audit.deterministic.auditedVariants = deterministicReports.length;
    manifest.audit.contextual.actualRules = operation.contextualAudit.findings.length;
    manifest.timing.planningMs = stageClock(stageTransitions, 'planning');
    manifest.timing.generationMs = stageClock(stageTransitions, 'generating');
    manifest.timing.contextualAuditMs = operationTimes(budget.records).contextualAuditMs;

    stage = 'exports';
    const exportStarted = performance.now();
    const pptxResults = {};
    const pptxHashes = new Set();
    for (const mode of ['selected', 'A', 'B', 'C']) {
      const { artifact, bytes } = await downloadArtifact(startedServer.url, projectId, mode, 'pptx');
      const inspected = await inspectOfficeKitPackage(bytes);
      assert.equal(inspected.slideCount, options.slides);
      assert.equal(inspected.notesSlideCount, 0);
      assert.ok(!inspected.validationIssues.some((issue) => issue.severity === 'error'), `${mode} PPTX package validation failed`);
      assert.ok(inspected.masterParts.length >= templateStructure.masterParts.length, `${mode} PPTX lost template masters`);
      assert.ok(inspected.layoutNames.length >= templateStructure.layoutNames.length, `${mode} PPTX lost template layouts`);
      if (templateStructure.themeAvailable) assert.equal(inspected.themeAvailable, true, `${mode} PPTX lost the source theme`);
      const reopened = await office.loadPresentation(bytes);
      const reopenedSlides = office.getSlides(reopened);
      assert.equal(reopenedSlides.length, options.slides);
      const nativeTextCounts = reopenedSlides.map((slide) => office.getSlideShapes(slide)
        .filter((shape) => office.hasShapeText(shape) && office.getShapeText(shape).trim()).length);
      assert.ok(nativeTextCounts.every((count) => count > 0), `${mode} PPTX has a slide without editable native text`);
      const outputName = mode === 'selected' ? 'selected.pptx' : `${mode}.pptx`;
      await writeFile(path.join(outputDir, outputName), bytes);
      pptxResults[mode] = artifactSummary(bytes, {
        slides: inspected.slideCount,
        editableTextShapes: nativeTextCounts.reduce((sum, value) => sum + value, 0),
        editableTextPerSlide: nativeTextCounts,
        rasterOnlySlides: 0,
        notesSlides: inspected.notesSlideCount,
        masterParts: inspected.masterParts.length,
        layouts: inspected.layoutNames.length,
        themeAvailable: inspected.themeAvailable,
        packageValidationErrors: 0,
        file: outputName,
        productArtifactId: artifact.id,
      });
      if (mode !== 'selected') pptxHashes.add(sha256(bytes));
    }
    if (pptxHashes.size !== 3) throw errorWithCode('VARIANT_EXPORTS_NOT_DISTINCT', 'A/B/C PPTX exports are not three distinct files.');
    manifest.exports.pptx = pptxResults;
    manifest.exports.aBCRawHashesDistinct = pptxHashes.size === 3;

    const { artifact: pdfArtifact, bytes: pdfBytes } = await downloadArtifact(startedServer.url, projectId, 'selected', 'pdf');
    assert.ok(pdfBytes.subarray(0, 5).toString('ascii').startsWith('%PDF-'));
    const { PDFDocument } = daemonRequire('pdf-lib');
    const pdf = await PDFDocument.load(pdfBytes);
    assert.equal(pdf.getPageCount(), options.slides);
    await writeFile(path.join(outputDir, 'selected.pdf'), pdfBytes);
    manifest.exports.pdf = artifactSummary(pdfBytes, { pages: pdf.getPageCount(), file: 'selected.pdf', productArtifactId: pdfArtifact.id });

    const { artifact: htmlArtifact, bytes: htmlBytes } = await downloadArtifact(startedServer.url, projectId, 'selected', 'html');
    const html = htmlBytes.toString('utf8');
    assert.match(html, /<!doctype html>/iu);
    assert.equal((html.match(/<section class="slide"/gu) ?? []).length, options.slides);
    assert.doesNotMatch(html, /<script\b|javascript\s*:|on(?:error|load|click)\s*=/iu, 'HTML export contains active markup');
    await writeFile(path.join(outputDir, 'selected.html'), htmlBytes);
    manifest.exports.html = artifactSummary(htmlBytes, { slides: options.slides, file: 'selected.html', productArtifactId: htmlArtifact.id, activeMarkupFound: false });
    manifest.timing.exportsMs = Math.round(performance.now() - exportStarted);

    stage = 'final-verification';
    const unchanged = sha256(await readFile(input.templatePath)) === input.templateHash;
    manifest.sourceTemplateUnchanged = unchanged;
    if (!unchanged) throw errorWithCode('SOURCE_TEMPLATE_MUTATED', 'The source template changed during qualification.');
    manifest.semantic.requestCount = budget.records.length;
    manifest.semantic.requests = requestRecords(budget.records);
    manifest.semantic.operationCounts = semanticCounts(budget.records);
    manifest.semantic.budgetRejectedAttempts = budget.rejectedAttempts;
    manifest.semantic.automaticRetries = 0;
    if (manifest.semantic.requestCount > options.maxSemanticRequests) throw errorWithCode('SEMANTIC_BUDGET_OVERRUN', 'Semantic request budget was exceeded.');
    const operationAccounting = validateQualificationSemanticOperationAccounting(budget.records);
    if (operationAccounting.operationCounts.total > options.maxSemanticRequests) {
      throw errorWithCode('SEMANTIC_OPERATION_ACCOUNTING_MISMATCH', 'One-click semantic request operation counts exceed the selected workflow budget.');
    }
    manifest.semantic.rawOperationCounts = operationAccounting.rawOperationCounts;
    manifest.timing.semanticTotalMs = budget.records.reduce((sum, request) => sum + (request.wallTimeMs ?? 0), 0);
    manifest.timing.totalMs = Math.round(performance.now() - flowStarted);
    manifest.timing.deterministicTotalMs = Math.max(0, manifest.timing.totalMs - manifest.timing.semanticTotalMs);
    manifest.result = 'PASS';
    manifest.workflow.finalStatus = 'ready';
  } catch (error) {
    manifest.result = 'FAIL';
    manifest.workflow.finalStatus = manifest.workflow.finalStatus === 'not-started' ? 'failed' : manifest.workflow.finalStatus;
    manifest.failure = { stage, code: safeErrorCode(error) };
    manifest.semantic.requestCount = budget?.records.length ?? 0;
    manifest.semantic.requests = requestRecords(budget?.records ?? []);
    manifest.semantic.operationCounts = semanticCounts(budget?.records ?? []);
    manifest.semantic.rawOperationCounts = Object.fromEntries([...new Set((budget?.records ?? []).map((record) => record.operation))]
      .map((operation) => [operation, budget.records.filter((record) => record.operation === operation).length]));
    manifest.semantic.budgetRejectedAttempts = budget?.rejectedAttempts ?? 0;
    manifest.semantic.automaticRetries = 0;
    manifest.timing.semanticTotalMs = (budget?.records ?? []).reduce((sum, request) => sum + (request.wallTimeMs ?? 0), 0);
    manifest.timing.deterministicTotalMs = Math.max(0, manifest.timing.totalMs - manifest.timing.semanticTotalMs);
    manifest.timing.totalMs = Math.round(performance.now() - flowStarted);
  } finally {
    manifest.finishedAt = nowIso();
    try { await closeServer(startedServer); }
    catch { if (manifest.result === 'PASS') { manifest.result = 'FAIL'; manifest.failure = { stage: 'shutdown', code: 'DAEMON_SHUTDOWN_FAILED' }; } }
    try { await fakeEndpoint?.close(); }
    catch { if (manifest.result === 'PASS') { manifest.result = 'FAIL'; manifest.failure = { stage: 'shutdown', code: 'FAKE_ENDPOINT_SHUTDOWN_FAILED' }; } }
    manifest.semantic.localCapture = await semanticCapture.summary();
    if (networkGuard) {
      manifest.networkGuard = {
        blockedExternalAttempts: networkGuard.blockedRequestCount,
        noExternalCalls: networkGuard.blockedRequestCount === 0,
      };
      if (networkGuard.blockedRequestCount > 0) {
        manifest.result = 'FAIL';
        manifest.failure = { stage: 'offline-network-guard', code: 'EXTERNAL_FETCH_BLOCKED' };
      }
    }
    for (const key of RUNNER_ENV_KEYS) {
      if (envBackup[key] === undefined) delete env[key];
      else env[key] = envBackup[key];
    }
    try { await writeManifest(outputDir, manifest); }
    finally { networkGuard?.restore(); }
  }
  return manifest;
}

export async function runProductE2E(options, dependencies = {}) {
  const enableTemplateProfiler = true;
  const requestCeiling = FULL_WORKFLOW_MAX_SEMANTIC_REQUESTS;
  const resolvedOptions = { ...options, enableTemplateProfiler,
    maxSemanticRequests: options.maxSemanticRequests ?? requestCeiling };
  if (!Number.isSafeInteger(resolvedOptions.maxSemanticRequests) || resolvedOptions.maxSemanticRequests < 1
      || resolvedOptions.maxSemanticRequests > requestCeiling) {
    throw errorWithCode('SEMANTIC_BUDGET_INVALID', `Semantic request budget exceeds the selected qualification ceiling of ${requestCeiling}.`);
  }
  const input = await resolveInputs(resolvedOptions);
  if (resolvedOptions.mode === 'external' && !resolvedOptions.externalConfig) {
    resolvedOptions.externalConfig = externalSemanticConfig(dependencies.environment ?? process.env).config;
  }
  const outputDir = path.resolve(resolvedOptions.outputDir ?? path.join(repoRoot, '.lct', 'product-e2e',
    `${new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14)}-${resolvedOptions.mode}-${randomUUID().slice(0, 8)}`));
  await prepareOutputDirectory(outputDir);
  const manifest = await runProductWorkflow(resolvedOptions, input, outputDir, dependencies);
  manifest.artifactDirectory = path.relative(repoRoot, outputDir).replaceAll('\\', '/');
  await writeManifest(outputDir, manifest);
  return manifest;
}

export async function runCli(argv, dependencies = {}) {
  const options = parseArgs(argv);
  if (options.help) return { exitCode: 0, output: helpText() };
  const input = await resolveInputs(options);
  let model = options.mode === 'fake' ? 'offline-fake-planner' : null;
  let config = null;
  if (options.mode === 'external') {
    const validated = externalSemanticConfig(dependencies.environment ?? process.env);
    config = validated.config;
    model = validated.summary.model;
  }
  const common = {
    mode: options.mode,
    providerLabel: options.providerLabel ?? (options.mode === 'fake' ? 'local-fake' : 'external'),
    templateProfilerEnabled: options.enableTemplateProfiler,
    template: { filename: input.templateName, sha256: input.templateHash },
    sourceCount: input.sources.length,
    requestedSlides: options.slides,
    maxSemanticRequests: options.maxSemanticRequests,
    model,
    endpointConfigured: options.mode === 'external',
    authConfigured: options.mode === 'external' ? Boolean(config.apiKey) : false,
    networkRequests: 0,
    chatCompletionRequests: 0,
  };
  if (options.dryRun) return { exitCode: 0, report: { mode: 'dry-run', ...common, modelsReachable: null, wouldStartDaemon: false, wouldCallEndpoint: false } };
  if (options.preflightOnly) {
    const probe = dependencies.probeSemanticEndpoint ?? probeSemanticEndpoint;
    const reachable = await probe(config, dependencies.fetcher ?? globalThis.fetch);
    return {
      exitCode: reachable ? 0 : 2,
      report: { mode: 'preflight-only', ...common, networkRequests: 1, modelsRequests: 1, healthRequests: 0,
        modelsReachable: reachable, chatCompletionRequests: 0, wouldStartDaemon: false },
    };
  }
  const manifest = await runProductE2E({ ...options, externalConfig: config, templatePath: input.templatePath }, dependencies);
  return { exitCode: manifest.result === 'PASS' ? 0 : 2, report: manifest };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    const result = await runCli(process.argv.slice(2));
    process.stdout.write(`${typeof result.report === 'undefined' ? result.output : JSON.stringify(result.report, null, 2)}\n`);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  } catch (error) {
    const code = safeErrorCode(error);
    process.stderr.write(`${code}: product E2E command stopped before an unsafe continuation.\n`);
    process.exitCode = 2;
  }
}
