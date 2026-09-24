#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { briefHash, validateBrief } from '../apps/daemon/src/presentation/domain/brief.js';
import { validateContentIR } from '../apps/daemon/src/presentation/domain/content-ir.js';
import { validateDeckPlan } from '../apps/daemon/src/presentation/domain/deck-plan.js';
import {
  SUPERVISOR_PLAN_REVIEW_PROMPT_VERSION,
  WORKER_PLAN_PROMPT_VERSION,
  validatePlanReview,
} from '../apps/daemon/src/presentation/application/planning-service.js';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function latency(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function runIdFor(inputPath) {
  const name = path.basename(inputPath, path.extname(inputPath));
  return name === 'state' || name === 'planning-state'
    ? path.basename(path.dirname(inputPath))
    : name;
}

function baseResult(runId) {
  return {
    run_id: runId,
    schema_valid: false,
    slide_count_valid: false,
    references_valid: false,
    unsupported_claim_count: null,
    supervisor_outcome: null,
    worker_latency_ms: null,
    supervisor_latency_ms: null,
    finish_reason: null,
    planning_state_persisted: false,
    failure_code: null,
    manual_review: {
      content_fidelity: null,
      title_takeaways: null,
      narrative_coherence: null,
      visual_relevance: null,
      notes: null,
    },
  };
}

export function evaluatePlanningState(state, runId = 'planning-run') {
  const result = baseResult(runId);
  if (!isRecord(state)) {
    result.failure_code = null;
    result.evaluation_error = 'Saved state is not a JSON object';
    return result;
  }

  result.failure_code = isRecord(state.failure) && typeof state.failure.code === 'string'
    ? state.failure.code
    : null;
  const saved = state.lastSuccessful;
  if (!isRecord(saved)) {
    result.evaluation_error = 'Saved state has no successful planning snapshot';
    return result;
  }

  const contentIR = isRecord(saved.contentIR) ? saved.contentIR : null;
  const allowedContentIds = new Set(Array.isArray(contentIR?.units)
    ? contentIR.units.filter((unit) => isRecord(unit) && unit.kind !== 'media-reference').map((unit) => unit.id)
    : []);
  result.references_valid = Array.isArray(saved.deckPlan?.slides)
    && saved.deckPlan.slides.every((slide) => isRecord(slide)
      && Array.isArray(slide.contentRefs)
      && slide.contentRefs.every((reference) => typeof reference === 'string' && allowedContentIds.has(reference)));
  result.supervisor_outcome = isRecord(saved.review) && typeof saved.review.outcome === 'string'
    ? saved.review.outcome
    : null;
  result.worker_latency_ms = isRecord(saved.telemetry) ? latency(saved.telemetry.worker?.wallTimeMs) : null;
  result.supervisor_latency_ms = isRecord(saved.telemetry) ? latency(saved.telemetry.supervisor?.wallTimeMs) : null;
  result.finish_reason = isRecord(saved.telemetry)
    ? { worker: saved.telemetry.worker?.finishReason ?? null, supervisor: saved.telemetry.supervisor?.finishReason ?? null }
    : null;

  try {
    const brief = validateBrief(saved.brief);
    const validatedContentIR = validateContentIR(saved.contentIR);
    const ids = new Set(validatedContentIR.units
      .filter((unit) => unit.kind !== 'media-reference')
      .map((unit) => unit.id));
    const checkpoint = validateDeckPlan(saved.checkpoint, ids);
    const deckPlan = validateDeckPlan(saved.deckPlan, ids);
    const review = validatePlanReview(saved.review, checkpoint, validatedContentIR);
    result.slide_count_valid = brief.requestedSlideCount === undefined
      ? null
      : deckPlan.slides.length === brief.requestedSlideCount;

    if (!result.references_valid) throw new TypeError('DeckPlan has a dangling or disallowed content reference');
    if (deckPlan.id !== checkpoint.id || deckPlan.version < checkpoint.version
        || checkpoint.briefHash !== briefHash(brief) || deckPlan.briefHash !== briefHash(brief)
        || checkpoint.inputFingerprint !== saved.inputFingerprint
        || deckPlan.inputFingerprint !== saved.inputFingerprint
        || review.checkpointVersion !== checkpoint.version) {
      throw new TypeError('Saved plan, checkpoint, brief, and input fingerprint do not agree');
    }

    result.schema_valid = true;
    result.supervisor_outcome = review.outcome;
    let persistedCheckpointIsValid = false;
    let persistedInputsMatch = false;
    try {
      persistedCheckpointIsValid = validateDeckPlan(state.currentCheckpoint, ids).hash === checkpoint.hash;
      const currentBrief = validateBrief(state.inputs?.brief);
      const currentContentIR = validateContentIR(state.inputs?.contentIR);
      persistedInputsMatch = state.inputs?.inputFingerprint === saved.inputFingerprint
        && briefHash(currentBrief) === briefHash(brief)
        && currentContentIR.hash === validatedContentIR.hash;
    } catch {
      // Keep artifact-schema validity separate from whether this is the current persisted state.
    }
    result.planning_state_persisted = state.status === 'ready'
      && state.failure === null
      && persistedInputsMatch
      && persistedCheckpointIsValid;
  } catch (error) {
    result.evaluation_error = error instanceof Error ? error.message : 'Saved planning snapshot failed validation';
  }

  return result;
}

async function main(argv) {
  const inputPaths = [];
  let outputPath;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') {
      outputPath = argv[index + 1];
      if (!outputPath) throw new Error('--out requires an output file path');
      index += 1;
    } else if (argv[index].startsWith('-')) {
      throw new Error(`Unknown option: ${argv[index]}`);
    } else {
      inputPaths.push(argv[index]);
    }
  }
  if (inputPaths.length === 0) {
    throw new Error('Usage: node --import tsx scripts/evaluate-planning-runs.mjs [--out results.json] state-1.json [state-2.json ...]');
  }

  const runs = [];
  for (const inputPath of inputPaths) {
    try {
      const state = JSON.parse(await readFile(inputPath, 'utf8'));
      runs.push(evaluatePlanningState(state, runIdFor(inputPath)));
    } catch (error) {
      const result = baseResult(runIdFor(inputPath));
      result.evaluation_error = error instanceof Error ? error.message : 'Could not read saved planning state';
      runs.push(result);
    }
  }

  const report = `${JSON.stringify({ runs }, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, report, 'utf8');
  else process.stdout.write(report);
  if (runs.some((run) => !run.schema_valid || run.slide_count_valid === false)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Planning evaluation failed'}\n`);
    process.exitCode = 64;
  });
}
