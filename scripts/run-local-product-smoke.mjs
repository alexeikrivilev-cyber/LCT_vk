#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFakeSemanticEndpoint } from './lib/fake-openai-compatible-endpoint.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const daemonRequire = createRequire(path.join(repoRoot, 'apps/daemon/package.json'));

function parseArgs(argv) {
  const result = { slideCount: 3, task: 'Explain the presentation compiler product and its generation pipeline.', forbiddenOutputText: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--assert-no-output-text') {
      const value = argv[++index];
      if (value === undefined || value.trim() === '' || value.length > 256) throw new TypeError('--assert-no-output-text requires a non-empty phrase up to 256 characters');
      result.forbiddenOutputText.push(value);
      continue;
    }
    if (item === '--slides') {
      const value = Number(argv[++index]);
      if (!Number.isSafeInteger(value) || value < 3 || value > 15) {
        throw new TypeError('--slides must be an integer between 3 and 15');
      }
      result.slideCount = value;
      continue;
    }
    if (!['--template', '--source', '--task', '--context'].includes(item)) throw new TypeError(`Unknown option: ${item}`);
    const value = argv[++index];
    if (value === undefined || value === '') throw new TypeError(`${item} requires a value`);
    if (item === '--template') result.templatePath = value;
    else if (item === '--source') result.sourcePath = value;
    else if (item === '--task') result.task = value;
    else result.context = value;
  }
  if (!result.templatePath || !result.task.trim()) {
    throw new TypeError('Usage: node --import tsx scripts/run-local-product-smoke.mjs --template <template.pptx> --task <presentation task> [--context <optional context>] [--source <optional source.md>] [--slides 3..15]');
  }
  return result;
}

function forbiddenTextMatches(presentation, forbiddenTerms, officeKitNode) {
  const { getSlides, getSlideShapes, getShapeText, hasShapeText } = officeKitNode;
  const visibleText = getSlides(presentation).flatMap((slide) => getSlideShapes(slide))
    .filter((shape) => hasShapeText(shape))
    .map((shape) => getShapeText(shape).normalize('NFKC').toLocaleLowerCase('ru-RU'));
  return forbiddenTerms.filter((term) => {
    const normalized = term.normalize('NFKC').toLocaleLowerCase('ru-RU');
    return visibleText.some((text) => text.includes(normalized));
  });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function closeDaemon(started) {
  if (!started) return;
  started.server.closeAllConnections?.();
  await new Promise((resolve, reject) => started.server.close((error) => error ? reject(error) : resolve()));
  await started.shutdown();
}

async function requestJson(baseUrl, route, options = {}, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${route}`, options);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; }
  catch { throw new Error(`${route} returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`); }
  assert.equal(response.status, expectedStatus, `${route} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function upload(baseUrl, projectId, name, bytes) {
  const form = new FormData();
  form.append('files', new Blob([bytes]), name);
  return requestJson(baseUrl, `/api/projects/${projectId}/upload`, { method: 'POST', body: form });
}

async function waitForGeneration(baseUrl, projectId, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { generation } = await requestJson(baseUrl, `/api/projects/${projectId}/generation`);
    if (generation?.status === 'completed') return generation;
    if (generation?.status === 'failed' || generation?.status === 'cancelled') {
      throw new Error(`generation ${generation.status}: ${JSON.stringify(generation.failure)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`generation did not finish within ${Math.round(timeoutMs / 1000)} seconds`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runStartedAt = performance.now();
  const templatePath = await realpath(args.templatePath);
  const sourcePath = args.sourcePath ? await realpath(args.sourcePath) : null;
  const templateName = path.basename(templatePath);
  const sourceName = sourcePath ? path.basename(sourcePath) : null;
  const templateBytes = await readFile(templatePath);
  const sourceBytes = sourcePath ? await readFile(sourcePath) : null;
  const templateHashBefore = sha256(templateBytes);
  const runId = `local-product-smoke-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
  const runDir = await realpath(repoRoot).then((root) => path.join(root, '.lct', runId));
  const dataDir = path.join(runDir, 'data');
  await mkdir(dataDir, { recursive: true });

  const envKeys = ['LCT_SEMANTIC_BASE_URL', 'LCT_SEMANTIC_MODEL', 'LCT_SEMANTIC_API_KEY', 'LCT_SEMANTIC_ENABLE_THINKING', 'LCT_PPTX_BACKEND', 'LCT_DATA_DIR', 'LCT_SMOKE_RESULT_FILE'];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const fake = await startFakeSemanticEndpoint({ model: 'offline-fake-planner' });
  process.env.LCT_SEMANTIC_BASE_URL = fake.baseUrl;
  process.env.LCT_SEMANTIC_MODEL = 'offline-fake-planner';
  delete process.env.LCT_SEMANTIC_API_KEY;
  process.env.LCT_SEMANTIC_ENABLE_THINKING = 'false';
  process.env.LCT_PPTX_BACKEND = 'office-kit';
  process.env.LCT_DATA_DIR = dataDir;

  const { startServer } = await import('../apps/daemon/src/server.js');
  const { inspectOfficeKitPackage } = await import('../apps/daemon/src/presentation/adapters/office-kit-package-inspector.js');
    const officeKitPackage = daemonRequire.resolve('@office-kit/pptx/package.json');
    const officeKitNode = await import(pathToFileURL(path.join(path.dirname(officeKitPackage), 'dist/node.js')));
    const { getShapeKind, getShapeText, getSlideShapes, getSlides, hasShapeText, loadPresentation } = officeKitNode;
  let daemon;
  const report = {
    status: 'running', runDir, projectId: `smoke_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    template: { path: templatePath, sha256: templateHashBefore, originalName: templateName },
    inputContract: { task: args.task, contextProvided: Boolean(args.context?.trim()), sourceFileCount: Number(Boolean(sourceName)) },
    source: sourcePath && sourceBytes && sourceName ? { path: sourcePath, sha256: sha256(sourceBytes), originalName: sourceName } : null,
    gates: {},
    timingsMs: {},
  };
  const start = () => startServer({ host: '127.0.0.1', port: 0, dataDir, projectRoot: repoRoot, serveWeb: false, returnServer: true });
  const ensure = async (body) => writeFile(path.join(runDir, 'smoke-report.json'), JSON.stringify(body, null, 2));

  try {
    daemon = await start();
    const projectId = report.projectId;
    await requestJson(daemon.url, '/api/health');
    await requestJson(daemon.url, '/api/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'Local Product Qualification' }),
    }, 201);
    report.gates.project = 'passed';

    let stageStartedAt = performance.now();
    const templateUpload = await upload(daemon.url, projectId, templateName, templateBytes);
    const sourceUpload = sourceName && sourceBytes ? await upload(daemon.url, projectId, sourceName, sourceBytes) : null;
    const uploadedFiles = await requestJson(daemon.url, `/api/projects/${projectId}/files`);
    assert.ok(uploadedFiles.files.some((file) => file.path === templateName), `template filename was not preserved: ${JSON.stringify(templateUpload.files)}`);
    if (sourceName) assert.ok(uploadedFiles.files.some((file) => file.path === sourceName), `source file was not uploaded: ${JSON.stringify(sourceUpload?.files)}`);
    report.gates.upload = 'passed';
    report.gates.uploadedNames = uploadedFiles.files.map((file) => file.path);
    report.timingsMs.uploadAndList = Math.round(performance.now() - stageStartedAt);

    stageStartedAt = performance.now();
    const templateResponse = await requestJson(daemon.url, `/api/projects/${projectId}/template/compile`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: templateName }),
    });
    assert.equal(templateResponse.status, 'ready', JSON.stringify(templateResponse.failure));
    assert.ok(templateResponse.templateIR?.hash);
    assert.ok(templateResponse.templateIR.slides.length > 0);
    report.gates.template = 'passed';
    const sourcePackage = await inspectOfficeKitPackage(templateBytes);
    report.templateIR = {
      hash: templateResponse.templateIR.hash,
      slides: templateResponse.templateIR.slides.length,
      layouts: templateResponse.templateIR.layouts.length,
      packageParts: templateResponse.templateIR.packageInventory?.length ?? null,
    };
    report.templatePackage = {
      masters: sourcePackage.masterParts.length,
      layouts: sourcePackage.layoutNames.length,
      themeAvailable: sourcePackage.themeAvailable,
    };
    report.timingsMs.templateAnalysis = Math.round(performance.now() - stageStartedAt);

    const brief = {
      audience: 'Hackathon jury and technical reviewers',
      purpose: args.task,
      expectedOutcome: '',
      ...(args.context?.trim() ? { context: args.context } : {}),
      preferences: ['Use uploaded template', 'Concise slides', 'Clear hierarchy', 'Do not invent unsupported facts'],
      requestedSlideCount: args.slideCount,
    };
    stageStartedAt = performance.now();
    const planning = await requestJson(daemon.url, `/api/projects/${projectId}/planning/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentFiles: sourceName ? [sourceName] : [], brief }),
    });
    assert.equal(planning.status, 'ready', JSON.stringify(planning.failure));
    assert.equal(planning.deckPlan.slides.length, args.slideCount);
    assert.equal(planning.review.outcome, 'pass');
    assert.ok(planning.contentIR.units.length > 0);
    const { reviewDeckLevel } = await import('../apps/daemon/src/presentation/application/deck-level-review.ts');
    const planDeckReview = reviewDeckLevel({ deckPlan: planning.deckPlan, contentIR: planning.contentIR });
    const planDeckRules = planDeckReview.findings.map((finding) => finding.ruleId);
    assert.ok(!planDeckReview.findings.some((finding) => finding.severity === 'error'));
    for (const ruleId of ['deck.repeated-title', 'deck.repeated-content-ref', 'deck.repeated-message', 'deck.cover-role-missing', 'deck.cover-not-first', 'deck.closing-in-middle']) {
      assert.ok(!planDeckRules.includes(ruleId), `synthetic plan deck review found ${ruleId}`);
    }
    report.deckLevelPlanReview = planDeckReview;
    report.gates.planDeckReview = 'passed';
    const contentUnitsById = new Map(planning.contentIR.units.map((unit) => [unit.id, unit]));
    assert.ok(planning.deckPlan.slides.every((slide) => slide.contentRefs.length > 0
      && slide.contentRefs.every((id) => {
        const unit = contentUnitsById.get(id);
        return unit && unit.kind !== 'media-reference' && typeof unit.text === 'string' && unit.text.trim().length > 0;
      })), 'every synthetic plan slide must cite non-empty source text');
    assert.equal(new Set(planning.deckPlan.slides.map((slide) => slide.takeaway.trim().toLocaleLowerCase())).size,
      planning.deckPlan.slides.length, 'synthetic long-deck plan must not repeat takeaways');
    assert.equal(new Set(planning.deckPlan.slides.map((slide) => [...slide.contentRefs].sort().join('|'))).size,
      planning.deckPlan.slides.length, 'synthetic long-deck plan must not repeat its source claims');
    report.gates.content = 'passed';
    report.gates.plan = 'passed';
    report.plan = { id: planning.deckPlan.id, hash: planning.deckPlan.hash, slides: planning.deckPlan.slides.length };
    report.contentIR = { hash: planning.contentIR.hash, sources: planning.contentIR.sources.length, units: planning.contentIR.units.length };
    report.fakeInferenceRequests = fake.state.inference.map((item) => ({
      role: item.role, operation: item.operation,
      strictJsonSchema: item.request.response_format?.type === 'json_schema' && item.request.response_format.json_schema?.strict === true,
    }));
    assert.deepEqual(report.fakeInferenceRequests.map((item) => item.operation), ['template-semantic-profile', 'deck-plan', 'plan-review']);
    assert.ok(report.fakeInferenceRequests.every((item) => item.strictJsonSchema));
    report.timingsMs.planningIncludingFakeInference = Math.round(performance.now() - stageStartedAt);
    report.timingsMs.workerAndSupervisorReportedMs = planning.telemetry?.totalWallTimeMs ?? null;
    await ensure(report);

    await closeDaemon(daemon);
    daemon = await start();
    const persistedPlanning = await requestJson(daemon.url, `/api/projects/${projectId}/planning`);
    assert.equal(persistedPlanning.status, 'ready');
    assert.equal(persistedPlanning.deckPlan.hash, planning.deckPlan.hash);
    report.gates.planningReload = 'passed';

    stageStartedAt = performance.now();
    const generationStart = await requestJson(daemon.url, `/api/projects/${projectId}/generation`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'local-product-smoke-v1' }, body: '{}',
    }, 202);
    assert.equal(generationStart.generation.totalSlides, args.slideCount);
    const generation = await waitForGeneration(daemon.url, projectId);
    assert.equal(generation.readySlides, args.slideCount);
    assert.deepEqual(generation.slides.map((pack) => pack.index), Array.from({ length: args.slideCount }, (_, index) => index + 1));
    report.gates.generation = 'passed';
    report.generation = {
      status: generation.status,
      readySlides: generation.readySlides,
      variants: generation.slides.map((pack) => Object.fromEntries(Object.entries(pack.variants).map(([key, variant]) => [key, variant.status]))),
      selected: generation.slides.map((pack) => pack.selectedVariant),
      recommended: generation.slides.map((pack) => pack.recommendedVariant),
    };
    assert.ok(generation.slides.every((pack) => ['A', 'B', 'C'].every((variant) => pack.variants[variant].status === 'ready')));
    report.timingsMs.generationRenderAndPreview = Math.round(performance.now() - stageStartedAt);

    const defaultResponse = await requestJson(daemon.url, `/api/projects/${projectId}/generation/selection`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'deck', variant: 'B', expectedVersion: generation.selectionVersion }),
    });
    let currentGeneration = defaultResponse.generation;
    const firstPack = currentGeneration.slides[0];
    const selectedResponse = await requestJson(daemon.url, `/api/projects/${projectId}/generation/selection`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'slide', slideId: firstPack.slideId, variant: 'C', expectedVersion: firstPack.version }),
    });
    currentGeneration = selectedResponse.generation;
    const selectedFirst = currentGeneration.slides[0];
    assert.equal(selectedFirst.selectedVariant, 'C');
    assert.equal(selectedFirst.recommendedVariant, generation.slides[0].recommendedVariant);
    const lockResponse = await requestJson(daemon.url, `/api/projects/${projectId}/generation/slides/${selectedFirst.slideId}/lock`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locked: true, variant: 'C', expectedVersion: selectedFirst.version }),
    });
    currentGeneration = lockResponse.generation;
    assert.equal(currentGeneration.slides[0].lockedVariant, 'C');
    report.gates.variantsSelectionAndLock = 'passed';

    stageStartedAt = performance.now();
    const previewChecks = [];
    for (const pack of currentGeneration.slides) {
      for (const variant of ['A', 'B', 'C']) {
        const previewUrl = pack.variants[variant].previewUrl;
        assert.ok(previewUrl, `${pack.slideId} variant ${variant} omitted its preview`);
        const response = await fetch(`${daemon.url}${previewUrl}`);
        assert.equal(response.status, 200);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(response.headers.get('content-type')?.split(';')[0], 'image/png');
        assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        previewChecks.push({ slide: pack.index, variant, bytes: bytes.length });
      }
    }
    report.gates.preview = 'passed';
    report.previews = previewChecks;

    const auditChecks = [];
    let selectedAudit = null;
    for (const pack of currentGeneration.slides) {
      for (const variant of ['A', 'B', 'C']) {
        const audit = await requestJson(daemon.url,
          `/api/projects/${projectId}/generation/slides/${pack.slideId}/audit?variant=${variant}`);
        assert.ok(Array.isArray(audit.audit.findings));
        const errors = audit.audit.findings.filter((item) => item.severity === 'error');
        assert.equal(errors.length, 0, `${pack.slideId}/${variant} audit errors: ${JSON.stringify(errors)}`);
        auditChecks.push({ slide: pack.index, variant, findings: audit.audit.findings.length, errors: errors.length });
        if (pack.slideId === selectedFirst.slideId && variant === 'A') selectedAudit = audit;
      }
    }
    report.gates.audit = 'passed';
    report.audit = { variantsChecked: auditChecks.length, findings: auditChecks.reduce((sum, item) => sum + item.findings, 0), errors: 0, checks: auditChecks };
    const repairFinding = selectedAudit?.audit.findings.find((item) => item.autofixAvailable);
    if (repairFinding) {
      const repair = await requestJson(daemon.url, `/api/projects/${projectId}/generation/repair`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slideId: selectedFirst.slideId, variant: 'A', findingId: repairFinding.id, expectedVersion: currentGeneration.slides[0].version }),
      });
      assert.ok(repair.generation.slides[0].variants.A.version > currentGeneration.slides[0].variants.A.version);
      currentGeneration = repair.generation;
      report.gates.safeRepair = 'passed';
    } else {
      report.gates.safeRepair = 'not-available';
    }
    report.timingsMs.previewAuditAndRepair = Math.round(performance.now() - stageStartedAt);

    stageStartedAt = performance.now();
    const exported = await requestJson(daemon.url, `/api/projects/${projectId}/generation/export`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'selected' }),
    }, 201);
    assert.equal(exported.artifact.validationStatus, 'passed');
    const download = await fetch(`${daemon.url}${exported.artifact.downloadUrl}`);
    assert.equal(download.status, 200);
    const pptx = Buffer.from(await download.arrayBuffer());
    const outputPackage = await inspectOfficeKitPackage(pptx);
    const { slideCount, notesSlideCount, validationIssues } = outputPackage;
    assert.equal(slideCount, args.slideCount);
    assert.equal(notesSlideCount, 0);
    assert.ok(!validationIssues.some((issue) => issue.severity === 'error'), JSON.stringify(validationIssues));
    assert.deepEqual([...outputPackage.masterParts].sort(), [...sourcePackage.masterParts].sort(), 'PPTX export retains the template master parts');
    assert.equal(outputPackage.layoutNames.length, sourcePackage.layoutNames.length, 'PPTX export retains the template layouts');
    assert.equal(outputPackage.themeAvailable, sourcePackage.themeAvailable, 'PPTX export retains the source theme');
    const reopened = await loadPresentation(pptx);
    const slides = getSlides(reopened);
    const selectedResidue = forbiddenTextMatches(reopened, args.forbiddenOutputText, officeKitNode);
    assert.deepEqual(selectedResidue, [], `selected PPTX contains forbidden source-specific text: ${selectedResidue.join(', ')}`);
    const nativeTextShapes = slides.flatMap((slide) => getSlideShapes(slide)).filter((shape) => hasShapeText(shape) && getShapeText(shape).trim());
    assert.ok(nativeTextShapes.length >= 6, `expected at least two native editable text shapes per slide; got ${nativeTextShapes.length}`);
    assert.ok(nativeTextShapes.every((shape) => getShapeKind(shape) === 'shape'));
    report.gates.exportAndReopen = 'passed';
    report.export = {
      bytes: pptx.length, sha256: sha256(pptx), slides: slideCount,
      nativeTextShapes: nativeTextShapes.length, notesSlides: notesSlideCount,
      masters: outputPackage.masterParts.length, layouts: outputPackage.layoutNames.length,
      themeAvailable: outputPackage.themeAvailable, nativeOfficeStatus: exported.artifact.nativeOfficeStatus,
    };
    report.timingsMs.selectedExportAndReopen = Math.round(performance.now() - stageStartedAt);

    stageStartedAt = performance.now();
    const trackExports = [];
    for (const mode of ['A', 'B', 'C']) {
      const trackExport = await requestJson(daemon.url, `/api/projects/${projectId}/generation/export`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }),
      }, 201);
      assert.equal(trackExport.artifact.mode, mode);
      assert.equal(trackExport.artifact.validationStatus, 'passed');
      const trackDownload = await fetch(`${daemon.url}${trackExport.artifact.downloadUrl}`);
      assert.equal(trackDownload.status, 200);
      const trackPptx = Buffer.from(await trackDownload.arrayBuffer());
      const inspectedTrack = await inspectOfficeKitPackage(trackPptx);
      assert.equal(inspectedTrack.slideCount, args.slideCount, `${mode} track export slide count`);
      assert.equal(inspectedTrack.notesSlideCount, 0, `${mode} track export should not add notes`);
      assert.ok(!inspectedTrack.validationIssues.some((issue) => issue.severity === 'error'), `${mode} track package errors`);
      const reopenedTrack = await loadPresentation(trackPptx);
      assert.equal(getSlides(reopenedTrack).length, args.slideCount, `${mode} track should reopen`);
      const residue = forbiddenTextMatches(reopenedTrack, args.forbiddenOutputText, officeKitNode);
      assert.deepEqual(residue, [], `${mode} track contains forbidden source-specific text: ${residue.join(', ')}`);
      trackExports.push({ mode, bytes: trackPptx.length, sha256: sha256(trackPptx), slides: inspectedTrack.slideCount, reopened: true });
    }
    report.gates.trackExportsAndReopen = 'passed';
    report.trackExports = trackExports;
    report.sourceResidueCheck = {
      status: args.forbiddenOutputText.length ? 'passed' : 'not-requested',
      scannedPresentations: 4,
      forbiddenTermCount: args.forbiddenOutputText.length,
      forbiddenTermHashes: args.forbiddenOutputText.map((term) => sha256(term)),
    };
    report.timingsMs.trackExportsAndReopen = Math.round(performance.now() - stageStartedAt);

    await closeDaemon(daemon);
    daemon = await start();
    const persistedGeneration = (await requestJson(daemon.url, `/api/projects/${projectId}/generation`)).generation;
    assert.equal(persistedGeneration.status, 'completed');
    assert.equal(persistedGeneration.generationId, generation.generationId);
    assert.equal(persistedGeneration.slides[0].lockedVariant, 'C');
    assert.ok(persistedGeneration.exports.some((artifact) => artifact.sha256 === exported.artifact.sha256));
    assert.deepEqual(new Set(persistedGeneration.exports.map((artifact) => artifact.mode)), new Set(['selected', 'A', 'B', 'C']));
    const persistedPreview = await fetch(`${daemon.url}${persistedGeneration.slides[0].variants.A.previewUrl}`);
    assert.equal(persistedPreview.status, 200);
    report.gates.generationReload = 'passed';

    assert.equal(sha256(await readFile(templatePath)), templateHashBefore, 'source template must remain byte-identical');
    if (sourcePath && report.source) assert.equal(sha256(await readFile(sourcePath)), report.source.sha256, 'optional source file must remain byte-identical');
    report.gates.sourceImmutable = 'passed';
    assert.equal(fake.state.inference.filter((item) => item.operation === 'template-semantic-profile').length, 1,
      'template profiling happens once during compile and remains cached after daemon reload');
    assert.equal(fake.state.inference.length, 3, 'generation, selection, repair, and export must not call semantic inference');
    report.fakeInferenceCallCount = fake.state.inference.length;
    report.timingsMs.total = Math.round(performance.now() - runStartedAt);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    report.completedAt = new Date().toISOString();
    await ensure(report).catch(() => undefined);
    if (process.env.LCT_SMOKE_RESULT_FILE) {
      const allowedRoot = `${path.resolve(repoRoot, '.lct')}${path.sep}`.toLocaleLowerCase('en-US');
      const requestedPath = path.resolve(process.env.LCT_SMOKE_RESULT_FILE);
      if (requestedPath.toLocaleLowerCase('en-US').startsWith(allowedRoot)) {
        await writeFile(requestedPath, JSON.stringify(report, null, 2), 'utf8').catch(() => undefined);
      }
    }
    await closeDaemon(daemon).catch(() => undefined);
    await fake.close();
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(`[local-product-smoke] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
