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
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item !== '--template' && item !== '--source') throw new TypeError(`Unknown option: ${item}`);
    const value = argv[++index];
    if (!value) throw new TypeError(`${item} requires a path`);
    result[item === '--template' ? 'templatePath' : 'sourcePath'] = value;
  }
  if (!result.templatePath || !result.sourcePath) {
    throw new TypeError('Usage: node --import tsx scripts/run-local-product-smoke.mjs --template <organizer.pptx> --source <source.md>');
  }
  return result;
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

async function waitForGeneration(baseUrl, projectId) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const { generation } = await requestJson(baseUrl, `/api/projects/${projectId}/generation`);
    if (generation?.status === 'completed') return generation;
    if (generation?.status === 'failed' || generation?.status === 'cancelled') {
      throw new Error(`generation ${generation.status}: ${JSON.stringify(generation.failure)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error('generation did not finish within three minutes');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const templatePath = await realpath(args.templatePath);
  const sourcePath = await realpath(args.sourcePath);
  const templateName = path.basename(templatePath);
  const sourceName = path.basename(sourcePath);
  const templateBytes = await readFile(templatePath);
  const sourceBytes = await readFile(sourcePath);
  const sourceHashBefore = sha256(templateBytes);
  const runId = `local-product-smoke-${new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
  const runDir = await realpath(repoRoot).then((root) => path.join(root, '.lct', runId));
  const dataDir = path.join(runDir, 'data');
  await mkdir(dataDir, { recursive: true });

  const envKeys = ['LCT_SEMANTIC_BASE_URL', 'LCT_SEMANTIC_MODEL', 'LCT_SEMANTIC_API_KEY', 'LCT_SEMANTIC_ENABLE_THINKING', 'LCT_PPTX_BACKEND', 'LCT_DATA_DIR'];
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
    template: { path: templatePath, sha256: sourceHashBefore, originalName: templateName },
    source: { path: sourcePath, sha256: sha256(sourceBytes), originalName: sourceName },
    gates: {},
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

    const templateUpload = await upload(daemon.url, projectId, templateName, templateBytes);
    const sourceUpload = await upload(daemon.url, projectId, sourceName, sourceBytes);
    const uploadedFiles = await requestJson(daemon.url, `/api/projects/${projectId}/files`);
    assert.ok(uploadedFiles.files.some((file) => file.path === templateName), `template filename was not preserved: ${JSON.stringify(templateUpload.files)}`);
    assert.ok(uploadedFiles.files.some((file) => file.path === sourceName), `source file was not uploaded: ${JSON.stringify(sourceUpload.files)}`);
    report.gates.upload = 'passed';
    report.gates.uploadedNames = uploadedFiles.files.map((file) => file.path);

    const templateResponse = await requestJson(daemon.url, `/api/projects/${projectId}/template/compile`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: templateName }),
    });
    assert.equal(templateResponse.status, 'ready', JSON.stringify(templateResponse.failure));
    assert.ok(templateResponse.templateIR?.hash);
    assert.ok(templateResponse.templateIR.slides.length > 0);
    report.gates.template = 'passed';
    report.templateIR = {
      hash: templateResponse.templateIR.hash,
      slides: templateResponse.templateIR.slides.length,
      layouts: templateResponse.templateIR.layouts.length,
      packageParts: templateResponse.templateIR.packageInventory?.length ?? null,
    };

    const brief = {
      audience: 'Hackathon jury and technical reviewers',
      purpose: 'Explain the presentation compiler product and its generation pipeline.',
      expectedOutcome: 'Understand the problem, pipeline, and product value.',
      preferences: ['Use uploaded template', 'Concise slides', 'Clear hierarchy', 'Do not invent unsupported facts'],
      requestedSlideCount: 3,
    };
    const planning = await requestJson(daemon.url, `/api/projects/${projectId}/planning/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentFiles: [sourceName], brief }),
    });
    assert.equal(planning.status, 'ready', JSON.stringify(planning.failure));
    assert.equal(planning.deckPlan.slides.length, 3);
    assert.equal(planning.review.outcome, 'pass');
    assert.ok(planning.contentIR.units.length > 0);
    const contentUnitsById = new Map(planning.contentIR.units.map((unit) => [unit.id, unit]));
    assert.ok(planning.deckPlan.slides.every((slide) => slide.contentRefs.length > 0
      && slide.contentRefs.every((id) => {
        const unit = contentUnitsById.get(id);
        return unit && unit.kind !== 'media-reference' && typeof unit.text === 'string' && unit.text.trim().length > 0;
      })), 'every synthetic plan slide must cite non-empty source text');
    report.gates.content = 'passed';
    report.gates.plan = 'passed';
    report.plan = { id: planning.deckPlan.id, hash: planning.deckPlan.hash, slides: planning.deckPlan.slides.length };
    report.contentIR = { hash: planning.contentIR.hash, sources: planning.contentIR.sources.length, units: planning.contentIR.units.length };
    report.fakeInferenceRequests = fake.state.inference.map((item) => ({
      role: item.role, operation: item.operation,
      strictJsonSchema: item.request.response_format?.type === 'json_schema' && item.request.response_format.json_schema?.strict === true,
    }));
    assert.deepEqual(report.fakeInferenceRequests.map((item) => item.role), ['worker', 'supervisor']);
    assert.ok(report.fakeInferenceRequests.every((item) => item.strictJsonSchema));
    await ensure(report);

    await closeDaemon(daemon);
    daemon = await start();
    const persistedPlanning = await requestJson(daemon.url, `/api/projects/${projectId}/planning`);
    assert.equal(persistedPlanning.status, 'ready');
    assert.equal(persistedPlanning.deckPlan.hash, planning.deckPlan.hash);
    report.gates.planningReload = 'passed';

    const generationStart = await requestJson(daemon.url, `/api/projects/${projectId}/generation`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'local-product-smoke-v1' }, body: '{}',
    }, 202);
    assert.equal(generationStart.generation.totalSlides, 3);
    const generation = await waitForGeneration(daemon.url, projectId);
    assert.equal(generation.readySlides, 3);
    assert.deepEqual(generation.slides.map((pack) => pack.index), [1, 2, 3]);
    report.gates.generation = 'passed';
    report.generation = {
      status: generation.status,
      readySlides: generation.readySlides,
      variants: generation.slides.map((pack) => Object.fromEntries(Object.entries(pack.variants).map(([key, variant]) => [key, variant.status]))),
      selected: generation.slides.map((pack) => pack.selectedVariant),
      recommended: generation.slides.map((pack) => pack.recommendedVariant),
    };
    assert.ok(generation.slides.every((pack) => ['A', 'B', 'C'].every((variant) => pack.variants[variant].status === 'ready')));

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

    const audit = await requestJson(daemon.url, `/api/projects/${projectId}/generation/slides/${selectedFirst.slideId}/audit?variant=A`);
    assert.ok(Array.isArray(audit.audit.findings));
    report.gates.audit = 'passed';
    report.audit = { findings: audit.audit.findings.length, errors: audit.audit.findings.filter((item) => item.severity === 'error').length };
    const repairFinding = audit.audit.findings.find((item) => item.autofixAvailable);
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

    const exported = await requestJson(daemon.url, `/api/projects/${projectId}/generation/export`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'selected' }),
    }, 201);
    assert.equal(exported.artifact.validationStatus, 'passed');
    const download = await fetch(`${daemon.url}${exported.artifact.downloadUrl}`);
    assert.equal(download.status, 200);
    const pptx = Buffer.from(await download.arrayBuffer());
    assert.ok(pptx.length > 100_000, `export unexpectedly small (${pptx.length} bytes)`);
    const { slideCount, notesSlideCount, validationIssues } = await inspectOfficeKitPackage(pptx);
    assert.equal(slideCount, 3);
    assert.equal(notesSlideCount, 0);
    assert.ok(!validationIssues.some((issue) => issue.severity === 'error'), JSON.stringify(validationIssues));
    const reopened = await loadPresentation(pptx);
    const slides = getSlides(reopened);
    const nativeTextShapes = slides.flatMap((slide) => getSlideShapes(slide)).filter((shape) => hasShapeText(shape) && getShapeText(shape).trim());
    assert.ok(nativeTextShapes.length >= 6, `expected at least two native editable text shapes per slide; got ${nativeTextShapes.length}`);
    assert.ok(nativeTextShapes.every((shape) => getShapeKind(shape) === 'shape'));
    report.gates.exportAndReopen = 'passed';
    report.export = { bytes: pptx.length, sha256: sha256(pptx), slides: slideCount, nativeTextShapes: nativeTextShapes.length, notesSlides: notesSlideCount, nativeOfficeStatus: exported.artifact.nativeOfficeStatus };

    await closeDaemon(daemon);
    daemon = await start();
    const persistedGeneration = (await requestJson(daemon.url, `/api/projects/${projectId}/generation`)).generation;
    assert.equal(persistedGeneration.status, 'completed');
    assert.equal(persistedGeneration.generationId, generation.generationId);
    assert.equal(persistedGeneration.slides[0].lockedVariant, 'C');
    assert.equal(persistedGeneration.exports[0].sha256, exported.artifact.sha256);
    const persistedPreview = await fetch(`${daemon.url}${persistedGeneration.slides[0].variants.A.previewUrl}`);
    assert.equal(persistedPreview.status, 200);
    report.gates.generationReload = 'passed';

    assert.equal(sha256(await readFile(templatePath)), sourceHashBefore, 'source template must remain byte-identical');
    report.gates.sourceImmutable = 'passed';
    assert.equal(fake.state.inference.length, 2, 'generation, selection, repair, and export must not call semantic inference');
    report.fakeInferenceCallCount = fake.state.inference.length;
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    report.completedAt = new Date().toISOString();
    await ensure(report).catch(() => undefined);
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
