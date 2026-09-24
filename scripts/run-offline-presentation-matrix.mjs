#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import { inspectPptx } from '../apps/daemon/src/presentation/adapters/python-inspector.js';
import { createTemplateIR } from '../apps/daemon/src/presentation/application/template-mapper.js';
import { runOfflinePresentationMatrix } from '../apps/daemon/src/presentation/application/offline-matrix-runner.js';
import { briefHash, validateBrief } from '../apps/daemon/src/presentation/domain/brief.js';
import { validateContentIR } from '../apps/daemon/src/presentation/domain/content-ir.js';
import { validateDeckPlan } from '../apps/daemon/src/presentation/domain/deck-plan.js';
import { validatePlanReview } from '../apps/daemon/src/presentation/application/planning-service.js';

const WORKER_REQUEST_SCHEMA = 'deck_plan_draft_v1';
const SUPERVISOR_REQUEST_SCHEMA = 'supervisor_plan_review_v1';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeLabel(value, fallback) {
  if (typeof value !== 'string' || value.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9_.\-/]*$/.test(value)) return fallback;
  return value;
}

function safeModelId(value) {
  return safeLabel(value, 'unknown');
}

function safeTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function safeLatency(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeThinking(value) {
  return value === true || value === false ? value : null;
}

function safeRunMetadata(value) {
  if (!isRecord(value)) return { providerKind: 'unknown', profile: null, thinkingEnabled: null };
  const providers = new Set(['runpod', 'cloudru', 'vk', 'local', 'unknown']);
  const profiles = new Set(['A100_BF16', 'H100_FP8', 'VK_REMOTE', 'LOCAL', 'unknown']);
  const providerKind = safeLabel(value.providerKind, 'unknown').toLowerCase();
  const profile = safeLabel(value.profile, 'unknown');
  return {
    providerKind: providers.has(providerKind) ? providerKind : 'unknown',
    profile: profiles.has(profile) ? profile : null,
    thinkingEnabled: safeThinking(value.thinkingEnabled),
  };
}

export function createOfflineReplayManifest(state, templates, matrix, runMetadata = null) {
  if (!isRecord(state) || state.schemaVersion !== 1 || state.status !== 'ready' || !isRecord(state.lastSuccessful)) {
    throw new TypeError('Input must be a successful persisted planning state');
  }
  const saved = state.lastSuccessful;
  const metadata = safeRunMetadata(runMetadata);
  return {
    schemaVersion: 1,
    recordKind: 'offline-presentation-replay',
    createdAt: safeTimestamp(saved.createdAt),
    inputHashes: {
      contentIR: saved.contentIR.hash,
      brief: briefHash(saved.brief),
      templates: templates.map((template) => template.templateIR.hash),
    },
    requestSchema: { worker: WORKER_REQUEST_SCHEMA, supervisor: SUPERVISOR_REQUEST_SCHEMA },
    worker: {
      structuredResultKind: 'canonicalized-worker-checkpoint',
      structuredResult: saved.checkpoint,
      finalDeckPlan: saved.deckPlan,
      modelId: safeModelId(saved.model),
      providerKind: metadata.providerKind,
      profile: metadata.profile,
      thinkingEnabled: metadata.thinkingEnabled,
      temperature: 0.2,
      maxOutputTokens: 4096,
      latencyMs: safeLatency(saved.telemetry?.worker?.wallTimeMs),
      finishReason: safeLabel(saved.telemetry?.worker?.finishReason, null),
      startedAt: safeTimestamp(saved.telemetry?.worker?.startedAt),
      finishedAt: safeTimestamp(saved.telemetry?.worker?.finishedAt),
      promptVersion: safeLabel(saved.promptVersions?.worker, 'unknown'),
    },
    supervisor: {
      structuredResult: saved.review,
      modelId: safeModelId(saved.telemetry?.supervisor?.model),
      providerKind: metadata.providerKind,
      profile: metadata.profile,
      thinkingEnabled: metadata.thinkingEnabled,
      temperature: 0,
      maxOutputTokens: 2048,
      latencyMs: safeLatency(saved.telemetry?.supervisor?.wallTimeMs),
      finishReason: safeLabel(saved.telemetry?.supervisor?.finishReason, null),
      startedAt: safeTimestamp(saved.telemetry?.supervisor?.startedAt),
      finishedAt: safeTimestamp(saved.telemetry?.supervisor?.finishedAt),
      promptVersion: safeLabel(saved.promptVersions?.supervisor, 'unknown'),
    },
    output: {
      templateCount: matrix.templateCount,
      variantCount: matrix.variantCount,
      artifactCount: matrix.outputCount,
      inferenceRequests: matrix.inferenceRequests,
      matrixPath: 'matrix.json',
    },
    secretsStored: false,
  };
}

function usage() {
  return 'Usage: node --import tsx scripts/run-offline-presentation-matrix.mjs --state state.json --out output-dir --templates template-1.pptx template-2.pptx template-3.pptx [--run-metadata metadata.json]';
}

function parseArgs(argv) {
  const args = { templates: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--state' || key === '--out' || key === '--run-metadata') {
      const value = argv[++index];
      if (!value) throw new Error(`${key} requires a path`);
      args[key.slice(2).replaceAll('-', '')] = value;
    } else if (key === '--templates') {
      while (argv[index + 1] && !argv[index + 1].startsWith('--')) args.templates.push(argv[++index]);
    } else {
      throw new Error(`Unknown option: ${key}`);
    }
  }
  if (!args.state || !args.out || args.templates.length !== 3) throw new Error(usage());
  return args;
}

export async function runOfflineMatrixFromState(args) {
  const state = JSON.parse(await readFile(args.state, 'utf8'));
  if (!isRecord(state) || state.schemaVersion !== 1 || state.status !== 'ready' || !isRecord(state.lastSuccessful)) {
    throw new TypeError('State must contain a successful planning snapshot with status ready');
  }
  const saved = state.lastSuccessful;
  const brief = validateBrief(saved.brief);
  const contentIR = validateContentIR(saved.contentIR);
  const currentInputs = state.inputs;
  if (!isRecord(currentInputs)) throw new TypeError('Saved ready state has no current planning inputs');
  const currentBrief = validateBrief(currentInputs.brief);
  const currentContentIR = validateContentIR(currentInputs.contentIR);
  const ids = new Set(contentIR.units.filter((unit) => unit.kind !== 'media-reference').map((unit) => unit.id));
  const checkpoint = validateDeckPlan(saved.checkpoint, ids, brief.requestedSlideCount);
  const deckPlan = validateDeckPlan(saved.deckPlan, ids, brief.requestedSlideCount);
  const review = validatePlanReview(saved.review, checkpoint, contentIR);
  if (state.failure !== null || !Array.isArray(currentInputs.contentFiles) || !currentInputs.contentFiles.every((item) => typeof item === 'string')
      || currentInputs.inputFingerprint !== saved.inputFingerprint || briefHash(currentBrief) !== briefHash(brief)
      || currentContentIR.hash !== contentIR.hash || briefHash(brief) !== checkpoint.briefHash
      || review.checkpointVersion !== checkpoint.version || saved.inputFingerprint !== checkpoint.inputFingerprint
      || deckPlan.id !== checkpoint.id || deckPlan.version < checkpoint.version
      || deckPlan.briefHash !== checkpoint.briefHash || deckPlan.inputFingerprint !== checkpoint.inputFingerprint
      || state.currentCheckpoint?.hash !== checkpoint.hash) {
    throw new TypeError('Saved plan, review, and current checkpoint do not agree');
  }

  const templates = [];
  let templateParsingMs = 0;
  for (let index = 0; index < args.templates.length; index += 1) {
    const parsingStarted = performance.now();
    const pptxPath = path.resolve(args.templates[index]);
    const bytes = await readFile(pptxPath);
    const fileName = path.basename(pptxPath);
    const templateIR = createTemplateIR(await inspectPptx(pptxPath), {
      filePath: `templates/${fileName}`,
      originalName: fileName,
      sha256: sha256(bytes),
      compiledAt: new Date().toISOString(),
      compilerVersion: 'lct-template-compiler/1',
    });
    templates.push({ pptxPath, templateIR });
    templateParsingMs += performance.now() - parsingStarted;
  }
  const matrix = await runOfflinePresentationMatrix({ deckPlan, contentIR, templates, outputRoot: args.out });
  let runMetadata = null;
  if (args.runmetadata) runMetadata = JSON.parse(await readFile(args.runmetadata, 'utf8'));
  const manifest = createOfflineReplayManifest(state, templates, matrix, runMetadata);
  const diagnostics = {
    schemaVersion: 1,
    inferenceRequests: 0,
    stageMs: {
      templateParsing: Number(templateParsingMs.toFixed(3)),
      contentParsing: null,
      planning: safeLatency(saved.telemetry?.totalWallTimeMs),
      slideCompilation: matrix.timingsMs.compile,
      render: matrix.timingsMs.render,
      deterministicAudit: matrix.timingsMs.audit,
      repair: null,
      export: null,
      offlineTotal: Number((templateParsingMs + matrix.timingsMs.total).toFixed(3)),
    },
    stageStatus: {
      templateParsing: 'measured during this run',
      contentParsing: 'not rerun; ContentIR was loaded from the persisted planning snapshot',
      planning: 'loaded from persisted Worker/Supervisor telemetry; no inference request was made',
      slideCompilation: 'measured during this run',
      render: 'measured during this run',
      deterministicAudit: 'measured during this run',
      repair: 'not run by this offline matrix command',
      export: 'PPTX package assembly is included in render; no separate PDF/HTML export stage exists',
    },
  };
  await Promise.all([
    writeFile(path.join(path.resolve(args.out), 'replay.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    writeFile(path.join(path.resolve(args.out), 'diagnostics.json'), `${JSON.stringify(diagnostics, null, 2)}\n`, 'utf8'),
  ]);
  return { matrix, manifest, diagnostics };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await runOfflineMatrixFromState(args);
    process.stdout.write(`${JSON.stringify({ outputCount: result.matrix.outputCount, inferenceRequests: result.matrix.inferenceRequests, outputRoot: path.resolve(args.out) }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Offline presentation matrix failed'}\n`);
    process.exitCode = 64;
  }
}
