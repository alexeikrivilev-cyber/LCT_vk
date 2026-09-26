#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smokeScript = path.join(repoRoot, 'scripts', 'run-local-product-smoke.mjs');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isUnknownTemplateCandidate(candidate, knownTemplates) {
  const candidateName = path.basename(candidate.name).normalize('NFKC').toLocaleLowerCase('en-US');
  return !knownTemplates.some((known) => known.sha256 === candidate.sha256
    || path.basename(known.name).normalize('NFKC').toLocaleLowerCase('en-US') === candidateName);
}

function parseArgs(argv) {
  const result = { knownTemplates: [], slideCount: 3 };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--template' || option === '--source' || option === '--slides') {
      const value = argv[++index];
      if (!value) throw new TypeError(`${option} requires a value`);
      if (option === '--slides') {
        const slides = Number(value);
        if (!Number.isSafeInteger(slides) || ![3, 6, 7, 8].includes(slides)) throw new TypeError('--slides must be one of 3, 6, 7, or 8');
        result.slideCount = slides;
      } else result[option === '--template' ? 'templatePath' : 'sourcePath'] = value;
    } else if (option === '--known-template') {
      const value = argv[++index];
      if (!value) throw new TypeError('--known-template requires a path');
      result.knownTemplates.push(value);
    } else {
      throw new TypeError(`Unknown option: ${option}`);
    }
  }
  if (!result.templatePath || !result.sourcePath || result.knownTemplates.length !== 3) {
    throw new TypeError('Usage: node --import tsx scripts/run-unknown-template-qualification.mjs --template <held-out.pptx> --source <synthetic.md> --known-template <known-1.pptx> --known-template <known-2.pptx> --known-template <known-3.pptx> [--slides 3|6|7|8]');
  }
  return result;
}

async function describePptx(value) {
  const filePath = await realpath(value);
  if (path.extname(filePath).toLowerCase() !== '.pptx') throw new TypeError('Unknown-template qualification accepts PPTX files only');
  const bytes = await readFile(filePath);
  return { filePath, name: path.basename(filePath), sha256: sha256(bytes) };
}

export function isCompleteUnknownTemplateSmoke(report) {
  const requiredGates = [
    'project', 'upload', 'template', 'content', 'plan', 'planDeckReview', 'planningReload',
    'generation', 'variantsSelectionAndLock', 'audit', 'exportAndReopen', 'trackExportsAndReopen',
    'generationReload', 'sourceImmutable',
  ];
  const tracks = report?.trackExports;
  return report?.status === 'passed'
    && requiredGates.every((gate) => report.gates?.[gate] === 'passed')
    && report.audit?.errors === 0
    && report.export?.nativeTextShapes > 0
    && report.fakeInferenceCallCount === 3
    && Array.isArray(report.fakeInferenceRequests)
    && report.fakeInferenceRequests.map((request) => request.operation).join(',') === 'template-semantic-profile,deck-plan,plan-review'
    && Array.isArray(tracks) && tracks.length === 3
    && new Set(tracks.map((track) => track.mode)).size === 3
    && tracks.every((track) => ['A', 'B', 'C'].includes(track.mode) && track.reopened === true);
}

export function fakeInferenceRequestCount(report) {
  if (Number.isSafeInteger(report?.fakeInferenceCallCount) && report.fakeInferenceCallCount >= 0) return report.fakeInferenceCallCount;
  return Array.isArray(report?.fakeInferenceRequests) ? report.fakeInferenceRequests.length : 0;
}

export async function runUnknownTemplateQualification(args) {
  const candidate = await describePptx(args.templatePath);
  const knownTemplates = await Promise.all(args.knownTemplates.map(describePptx));
  if (new Set(knownTemplates.map((item) => item.sha256)).size !== 3) throw new TypeError('Known template references must be three distinct PPTX files');
  const isUnknown = isUnknownTemplateCandidate(candidate, knownTemplates);
  const qualificationId = `unknown-template-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
  const outputDir = path.join(repoRoot, '.lct', 'unknown-template-qualification', qualificationId);
  await mkdir(outputDir, { recursive: true });

  let smokeReport = null;
  let smokeFailure = null;
  if (isUnknown) {
    const smokeReportPath = path.join(outputDir, 'product-smoke-report.json');
    const child = spawnSync(process.execPath, [
      '--import', 'tsx', smokeScript,
      '--template', candidate.filePath,
      '--source', args.sourcePath,
      '--slides', String(args.slideCount),
    ], {
      cwd: repoRoot, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, LCT_SMOKE_RESULT_FILE: smokeReportPath },
    });
    try { smokeReport = JSON.parse(await readFile(smokeReportPath, 'utf8')); } catch { /* The smoke may fail before its product flow starts. */ }
    if (child.status === 0) {
      if (!smokeReport) {
        try { smokeReport = JSON.parse(child.stdout.trim()); }
        catch { smokeFailure = 'Product smoke completed without a parseable JSON report'; }
      }
    } else {
      const errorCode = smokeReport?.failure?.match(/"code":"([A-Z0-9_]+)"/)?.[1];
      smokeFailure = child.error?.code === 'ETIMEDOUT' ? 'Product smoke exceeded the 10-minute qualification timeout'
        : errorCode ? `Product smoke stopped at a failing product gate: ${errorCode}`
          : `Product smoke failed with exit status ${child.status ?? 'unknown'}`;
    }
  } else {
    smokeFailure = 'Candidate template name or SHA-256 matches one of the three known production references';
  }

  const passed = isUnknown && !smokeFailure && isCompleteUnknownTemplateSmoke(smokeReport);
  const fakeRequestCount = fakeInferenceRequestCount(smokeReport);
  const manifest = {
    schemaVersion: 1,
    gate: 'UNKNOWN_TEMPLATE',
    status: passed ? 'PASS' : 'FAIL',
    inference: { mode: 'local-fake-semantic', requests: fakeRequestCount, external: false },
    candidate: { name: candidate.name, sha256: candidate.sha256, slideCount: args.slideCount },
    knownTemplateReferences: knownTemplates.map(({ name, sha256: hash }) => ({ name, sha256: hash })),
    flow: {
      analyzeAndProfile: smokeReport?.gates?.template ?? (isUnknown ? 'not-run' : 'blocked-known-template'),
      plan: smokeReport?.gates?.plan ?? 'not-run',
      variantsABC: smokeReport?.gates?.generation ?? (smokeReport?.failure ? 'failed' : 'not-run'),
      audit: smokeReport?.gates?.audit ?? 'not-run',
      exportAndReopen: smokeReport?.gates?.trackExportsAndReopen ?? 'not-run',
    },
    productSmokeRunId: smokeReport?.runDir ? path.basename(smokeReport.runDir) : null,
    failure: smokeFailure,
    artifactDir: path.relative(repoRoot, outputDir).replaceAll('\\', '/'),
  };
  await writeFile(path.join(outputDir, 'UNKNOWN_TEMPLATE_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await runUnknownTemplateQualification(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== 'PASS') process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Unknown-template qualification failed'}\n`);
    process.exitCode = 64;
  }
}
