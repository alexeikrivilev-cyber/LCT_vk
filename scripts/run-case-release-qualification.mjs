#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { briefHash } from '../apps/daemon/src/presentation/domain/brief.ts';
import { LEGACY_UNRECORDED_WORKFLOW_VERSIONS } from '../apps/daemon/src/presentation/application/workflow-versions.ts';
import { runOfflineMatrixFromState } from './run-offline-presentation-matrix.mjs';

const VARIANTS = ['A', 'B', 'C'];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function createCaseQualificationManifest({ state, templates, matrix, diagnostics, backend = 'custom', localFakeSemantic = true }) {
  if (!isRecord(state) || state.schemaVersion !== 1 || state.status !== 'ready' || !isRecord(state.lastSuccessful)) {
    throw new TypeError('Qualification requires a successful persisted planning state');
  }
  if (!Array.isArray(templates) || templates.length !== 3 || new Set(templates.map((template) => template.sha256)).size !== 3) {
    throw new TypeError('Qualification must use exactly three distinct PPTX templates');
  }
  if (!isRecord(matrix) || matrix.templateCount !== 3 || matrix.variantCount !== 3 || !Array.isArray(matrix.outputs)
      || !Array.isArray(matrix.templateQualifications)) {
    throw new TypeError('The presentation matrix must contain three templates and three variants');
  }
  const outputKeys = new Set(matrix.outputs.map((output) => `${output.templateIndex}/${output.variantId}`));
  const expectedKeys = templates.flatMap((_template, index) => VARIANTS.map((variant) => `${index + 1}/${variant}`));
  const allNine = matrix.outputs.length === 9 && expectedKeys.every((key) => outputKeys.has(key))
    && matrix.outputs.every((output) => output.renderStatus === 'passed' && output.reopenStatus === 'passed'
      && output.validationStatus === 'passed' && output.factualEquivalenceStatus === 'passed'
      && output.templatePreservationStatus === 'passed')
    && matrix.templateQualifications.every((item) => item.status === 'passed');
  const saved = state.lastSuccessful;
  const templateAnalysisMs = diagnostics?.stageMs?.templateInspection ?? null;
  const offlineWorkloadMs = [templateAnalysisMs, matrix.timingsMs.semanticProfile, matrix.timingsMs.compile,
    matrix.timingsMs.audit, matrix.timingsMs.render, matrix.timingsMs.preview]
    .filter((value) => Number.isFinite(value)).reduce((sum, value) => sum + value, 0);
  const qualificationStatus = allNine ? 'PASS' : 'FAIL';
  return {
    schemaVersion: 1,
    recordKind: 'case-three-template-three-variant-qualification',
    qualificationStatus,
    expectedDeckCount: 9,
    actualDeckCount: matrix.outputs.length,
    backend,
    inference: {
      mode: localFakeSemantic ? 'local-fake-semantic-template-profile' : 'no-inference',
      templateProfilerRequests: diagnostics?.callCounts?.templateProfiler ?? 0,
      workerRequestsDuringMatrix: diagnostics?.callCounts?.planningWorker ?? 0,
      supervisorRequestsDuringMatrix: diagnostics?.callCounts?.planningSupervisor ?? 0,
      generationRequestsDuringMatrix: diagnostics?.callCounts?.generation ?? 0,
      externalInference: false,
      runPod: false,
    },
    sharedContentPackage: {
      contentIRHash: saved.contentIR.hash,
      briefHash: briefHash(saved.brief),
      planId: saved.deckPlan.id,
      planHash: saved.deckPlan.hash,
      sourceCount: saved.contentIR.sources.length,
      sourceHashes: saved.contentIR.sources.map((source) => source.sha256),
      modelUsedForPlanning: saved.model,
      provenance: 'One persisted ContentIR, brief, and DeckPlan were applied to all three templates; the organizer content package must be verified separately.',
    },
    workflows: saved.agentWorkflowVersions ?? LEGACY_UNRECORDED_WORKFLOW_VERSIONS,
    promptVersions: saved.promptVersions ?? null,
    templates: templates.map(({ name, sha256: hash }, index) => ({ index: index + 1, name, sha256: hash })),
    decks: matrix.outputs.map((output) => ({
      templateIndex: output.templateIndex,
      variant: output.variantId,
      file: `template-${output.templateIndex}/variant-${output.variantId.toLowerCase()}/presentation.pptx`,
      sha256: output.artifactSha256,
      reopen: output.reopenStatus,
      nativeObjectCounts: output.nativeObjectCounts,
      templatePreservation: output.templatePreservationStatus,
      deterministicFindingCount: output.findingCount,
      factualEquivalence: output.factualEquivalenceStatus,
      previewStatus: output.previewStatus,
    })),
    stageTimingMs: {
      templateAnalysis: templateAnalysisMs,
      semanticProfile: matrix.timingsMs.semanticProfile,
      contentCompile: null,
      worker: saved.telemetry?.worker?.wallTimeMs ?? null,
      supervisor: saved.telemetry?.supervisor?.wallTimeMs ?? null,
      generation: Number((matrix.timingsMs.compile + matrix.timingsMs.render).toFixed(3)),
      audit: matrix.timingsMs.audit,
      preview: matrix.timingsMs.preview,
      export: { durationMs: matrix.timingsMs.render, includes: 'PPTX assembly and reopen validation measured in the render stage; not a separate extra duration.' },
      qualificationTotal: diagnostics?.stageMs?.offlineTotal ?? matrix.timingsMs.total,
      liveProductEndToEnd: null,
    },
    performance: {
      plannedSlideCount: saved.deckPlan.slides.length,
      targetSlideCount: '10–15 or user requested count',
      offlineDeterministicStagesMs: Number(offlineWorkloadMs.toFixed(3)),
      offlineBudgetMs: 300000,
      offlineStagesWithinBudget: offlineWorkloadMs <= 300000,
      liveInferenceIncluded: false,
      liveFiveMinuteRequirement: 'UNKNOWN; must be measured with the selected live inference runtime and actual case content',
    },
    timingStatus: {
      templateAnalysis: 'measured in this run',
      semanticProfile: localFakeSemantic ? 'measured local fake endpoint wall time' : 'not requested',
      contentCompile: 'not rerun; ContentIR loaded from persisted plan state',
      worker: 'loaded from planning telemetry; planning was not rerun in this qualification',
      supervisor: 'loaded from planning telemetry; planning was not rerun in this qualification',
      export: 'PPTX render, package assembly, and reopen are a combined stage in the matrix runner',
      liveProductEndToEnd: 'unknown; no live inference was invoked',
    },
    gates: {
      exactNineDecks: allNine,
      oneSharedPlanAndContent: true,
      sourceMutationChecked: matrix.outputs.every((output) => output.templatePreservationStatus === 'passed'),
      caseContentVerified: false,
    },
  };
}

function parseArgs(argv) {
  const args = { templates: [], backend: 'custom', fakeSemantic: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--state' || key === '--out' || key === '--content-root' || key === '--backend') {
      const value = argv[++index];
      if (!value) throw new Error(`${key} requires a value`);
      args[key === '--content-root' ? 'contentRoot' : key.slice(2)] = value;
    } else if (key === '--templates') {
      while (argv[index + 1] && !argv[index + 1].startsWith('--')) args.templates.push(argv[++index]);
    } else if (key === '--fake-semantic') args.fakeSemantic = true;
    else throw new Error(`Unknown option: ${key}`);
  }
  if (!args.state || !args.out || args.templates.length !== 3 || !['custom', 'office-kit'].includes(args.backend)) {
    throw new Error('Usage: node --import tsx scripts/run-case-release-qualification.mjs --state <successful-planning-state.json> --out <new-output-dir> --templates <template-1.pptx> <template-2.pptx> <template-3.pptx> [--content-root <project-dir>] [--backend custom|office-kit] --fake-semantic');
  }
  if (!args.fakeSemantic) throw new Error('Use --fake-semantic explicitly; this release command never enables external inference.');
  return args;
}

export async function runCaseReleaseQualification(args) {
  const outputRoot = path.resolve(args.out);
  const existing = await readdir(outputRoot).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  if (existing.length) throw new TypeError('Output directory must be new or empty; existing qualification artifacts are never overwritten');
  await mkdir(outputRoot, { recursive: true });
  const templateInputs = await Promise.all(args.templates.map(async (templatePath) => {
    const bytes = await readFile(path.resolve(templatePath));
    return { path: path.resolve(templatePath), name: path.basename(templatePath), sha256: sha256(bytes) };
  }));
  if (new Set(templateInputs.map((template) => template.sha256)).size !== 3) throw new TypeError('The three template files must have distinct content hashes');
  const state = JSON.parse(await readFile(path.resolve(args.state), 'utf8'));
  const result = await runOfflineMatrixFromState({
    state: path.resolve(args.state),
    out: outputRoot,
    templates: templateInputs.map((template) => template.path),
    ...(args.contentRoot ? { contentroot: path.resolve(args.contentRoot) } : {}),
    backend: args.backend,
    localSemantic: true,
  });
  const manifest = createCaseQualificationManifest({
    state,
    templates: templateInputs,
    matrix: result.matrix,
    diagnostics: result.diagnostics,
    backend: args.backend,
    localFakeSemantic: true,
  });
  await writeFile(path.join(outputRoot, 'CASE_QUALIFICATION_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { outputRoot, manifest, matrix: result.matrix };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await runCaseReleaseQualification(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ qualificationStatus: result.manifest.qualificationStatus, expectedDeckCount: 9, actualDeckCount: result.manifest.actualDeckCount, outputRoot: result.outputRoot }, null, 2)}\n`);
    if (result.manifest.qualificationStatus !== 'PASS') process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Case qualification failed'}\n`);
    process.exitCode = 64;
  }
}
