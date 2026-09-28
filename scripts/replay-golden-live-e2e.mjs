import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.cwd();
if (!process.argv[2]) {
  console.error('Usage: node --import tsx scripts/replay-golden-live-e2e.mjs <bundle-directory>');
  process.exit(2);
}
const bundleRoot = path.resolve(process.argv[2]);
const reportPath = path.join(bundleRoot, 'offline-replay-report.json');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const daemonRequire = createRequire(path.join(repoRoot, 'apps/daemon/package.json'));
const blockedNetwork = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const rawUrl = input instanceof Request ? input.url : String(input);
  const url = new URL(rawUrl);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    blockedNetwork.push(url.hostname);
    throw new Error('Offline replay blocked non-loopback network access.');
  }
  return originalFetch(input, init);
};
async function closeServer(started) {
  await started.shutdown();
  started.server.closeAllConnections();
  await new Promise((resolve, reject) => started.server.close((error) => error ? reject(error) : resolve()));
}
async function apiJson(base, route, init, expected = 200) {
  const response = await fetch(new URL(route, base), init);
  const body = await response.json();
  assert.equal(response.status, expected, 'Unexpected local API status: ' + response.status + ' ' + JSON.stringify(body));
  return body;
}
async function installFixtureProfile(bundle, projectDir, expectedTemplateHash) {
  const identity = await readJson(path.join(bundle, 'template-identities.json'));
  const profile = await readJson(path.join(bundle, 'semantic-profile-cache.json'));
  const status = await readJson(path.join(bundle, 'semantic-profile-status.json'));
  assert.equal(identity.templateIR.hash, expectedTemplateHash);
  assert.equal(profile.templateIRHash, expectedTemplateHash);
  assert.equal(status.status, 'ready');
  assert.equal(status.profileCacheKey, identity.semanticProfile.profileCacheKey);
  const compilerDir = path.join(projectDir, '.template-compiler');
  await mkdir(path.join(compilerDir, 'semantic-profiles'), { recursive: true });
  await mkdir(path.join(compilerDir, 'semantic-profile-status'), { recursive: true });
  await writeFile(path.join(compilerDir, 'semantic-profiles', status.profileCacheKey + '.json'), JSON.stringify(profile));
  await writeFile(path.join(compilerDir, 'semantic-profile-status', status.profileCacheKey + '.json'), JSON.stringify(status));
}
async function main() {
  const golden = await readJson(path.join(bundleRoot, 'golden-manifest.json'));
  assert.equal(golden.status, 'PASS');
  const identity = await readJson(path.join(bundleRoot, 'template-identities.json'));
  const contentIR = await readJson(path.join(bundleRoot, 'content-ir.json'));
  const expectedDeckPlan = await readJson(path.join(bundleRoot, 'deck-plan.json'));
  const workflowInput = await readJson(path.join(bundleRoot, 'workflow-input.json'));
  const sourceBytes = await readFile(path.join(bundleRoot, 'source-template.pptx'));
  assert.equal(sha256(sourceBytes), golden.template.sha256);

  const fixtureFiles = (await readdir(path.join(bundleRoot, 'semantic-fixtures'))).filter((name) => name.endsWith('.json'));
  const fixtures = new Map();
  for (const name of fixtureFiles) {
    const fixture = await readJson(path.join(bundleRoot, 'semantic-fixtures', name));
    assert.ok(!fixtures.has(fixture.operation), 'Golden bundle contains duplicate success fixtures.');
    fixtures.set(fixture.operation, fixture);
  }
  for (const operation of ['deck-plan', 'plan-review', 'contextual-deck-audit']) {
    assert.ok(fixtures.has(operation), 'Missing sanitized real-Qwen fixture for ' + operation);
  }

  const calls = [];
  const fixtureAdapter = {
    model: 'Qwen/Qwen3.8-27B',
    async infer(request) {
      const fixture = fixtures.get(request.operation);
      assert.ok(fixture, 'No recorded inference fixture for ' + request.operation);
      assert.equal(request.output.name, fixture.schemaName);
      assert.equal(request.maxOutputTokens, fixture.request.maxOutputTokens);
      assert.equal(request.temperature ?? null, fixture.request.temperature);
      const actualMessages = request.messages.map((message) => ({
        role: message.role,
        utf8Bytes: Buffer.byteLength(message.content, 'utf8'),
        sha256: sha256(Buffer.from(message.content, 'utf8')),
      }));
      if (JSON.stringify(actualMessages) !== JSON.stringify(fixture.request.messages)) {
        const mismatch = new Error('Captured real request metadata mismatch.');
        mismatch.code = 'FIXTURE_REQUEST_MISMATCH';
        mismatch.detail = { operation: request.operation, expected: fixture.request.messages, actual: actualMessages };
        console.error(JSON.stringify({ event: 'golden.fixture.request_mismatch', ...mismatch.detail }));
        throw mismatch;
      }
      assert.equal(calls.filter((entry) => entry.operation === request.operation).length, 0);
      calls.push({ operation: request.operation, schemaName: request.output.name, requestMatched: true,
        responseSha256: sha256(Buffer.from(JSON.stringify(fixture.response))) });
      const now = new Date().toISOString();
      return {
        value: fixture.response,
        telemetry: {
          role: request.role, operation: request.operation, model: 'Qwen/Qwen3.8-27B',
          requestId: 'offline-fixture-' + request.operation, startedAt: now, finishedAt: now, wallTimeMs: 0,
          promptTokens: fixture.telemetry?.promptTokens ?? 0, completionTokens: fixture.telemetry?.completionTokens ?? 0,
          httpStatus: 200, finishReason: fixture.telemetry?.finishReason ?? 'stop',
          runtimeSchemaValidation: 'passed', status: 'success',
        },
      };
    },
  };

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lct-golden-live-replay-'));
  const dataDir = path.join(tempRoot, 'runtime-data');
  const projectId = 'golden-replay-' + randomUUID().replaceAll('-', '').slice(0, 20);
  const projectDir = path.join(dataDir, 'projects', projectId);
  const { startServer } = await import(pathToFileURL(path.join(repoRoot, 'apps/daemon/src/server.ts')));
  process.env.LCT_PPTX_BACKEND = 'office-kit';
  let templateFilePath;
  let server = await startServer({
    host: '127.0.0.1', port: 0, dataDir, projectRoot: repoRoot, serveWeb: false, returnServer: true,
    semanticInferenceAdapter: { model: 'offline-compile-only', async infer() { throw new Error('Inference is forbidden during template compilation.'); } },
    enableSemanticProfiling: false,
  });
  try {
    await apiJson(server.url, '/api/projects', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: 'Golden live fixture replay' }),
    }, 201);
    const form = new FormData();
    form.append('files', new Blob([sourceBytes]), golden.template.originalName);
    const uploadedResponse = await fetch(new URL('/api/projects/' + encodeURIComponent(projectId) + '/upload', server.url), { method: 'POST', body: form });
    assert.equal(uploadedResponse.status, 200, await uploadedResponse.clone().text());
    const uploaded = await uploadedResponse.json();
    templateFilePath = uploaded.files.find((file) => file.originalName === golden.template.originalName)?.path;
    assert.ok(templateFilePath);
    const compiled = await apiJson(server.url, '/api/projects/' + encodeURIComponent(projectId) + '/template/compile', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filePath: templateFilePath }),
    });
    assert.equal(compiled.templateIR.hash, golden.template.templateIRHash);
  } finally {
    await closeServer(server);
    server = null;
  }

  await installFixtureProfile(bundleRoot, projectDir, golden.template.templateIRHash);
  const semanticCalls = [];
  const guardedAdapter = {
    model: fixtureAdapter.model,
    async infer(request) { semanticCalls.push(request.operation); return fixtureAdapter.infer(request); },
  };
  let planningIdCalls = 0;
  server = await startServer({
    host: '127.0.0.1', port: 0, dataDir, projectRoot: repoRoot, serveWeb: false, returnServer: true,
    semanticInferenceAdapter: guardedAdapter, enableSemanticProfiling: true, templateProfileConcurrency: 1,
    planningNow: () => new Date(expectedDeckPlan.createdAt),
    planningCreateId: () => planningIdCalls++ === 0 ? '00000000-0000-4000-8000-000000000001' : expectedDeckPlan.id.slice(3),
    generationCreateId: () => golden.generationId,
  });
  const exported = [];
  try {
    const template = await apiJson(server.url, '/api/projects/' + encodeURIComponent(projectId) + '/template');
    assert.equal(template.status, 'ready');
    assert.equal(template.semanticProfile.status, 'ready');
    assert.equal(template.templateIR.hash, golden.template.templateIRHash);

    const start = await apiJson(server.url, '/api/projects/' + encodeURIComponent(projectId) + '/workflow/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateFilePath, contentFiles: workflowInput.contentFiles, brief: workflowInput.brief }),
    }, 202);
    assert.ok(start.operation.operationId);
    let operation = start.operation;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline && !['ready', 'failed'].includes(operation.status)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      operation = (await apiJson(server.url, '/api/projects/' + encodeURIComponent(projectId) + '/workflow')).operation;
    }
    assert.equal(operation.status, 'ready', JSON.stringify({ stage: operation.stage, failure: operation.failure }));
    assert.equal(operation.stage, 'ready');
    assert.equal(operation.contextualAudit.status, 'ready');
    assert.equal(operation.contextualAudit.findings.length, 11);
    assert.deepEqual(semanticCalls, ['deck-plan', 'plan-review', 'contextual-deck-audit']);

    const planning = await apiJson(server.url, '/api/projects/' + encodeURIComponent(projectId) + '/planning');
    assert.equal(planning.status, 'ready');
    assert.equal(planning.contentIR.hash, contentIR.hash);
    assert.equal(planning.deckPlan.hash, expectedDeckPlan.hash);
    assert.equal(planning.deckPlan.slides.length, 3);
    const generation = (await apiJson(server.url, '/api/projects/' + encodeURIComponent(projectId) + '/generation')).generation;
    assert.equal(generation.status, 'completed');
    assert.equal(generation.slides.length, 3);
    assert.ok(generation.slides.every((slide) => ['A', 'B', 'C'].every((variant) => slide.variants[variant]?.status === 'ready')));
    const runDir = path.join(projectDir, '.generation', generation.generationId);
    const runManifest = await readJson(path.join(runDir, 'run-manifest.json'));
    assert.equal(runManifest.auditSummary.errors, 0);
    assert.equal(runManifest.compositionDistinctness.distinct, true);

    const office = await import(pathToFileURL(path.join(repoRoot, 'apps/daemon/node_modules/@office-kit/pptx/dist/node.js')));
    const packageInspector = await import(pathToFileURL(path.join(repoRoot, 'apps/daemon/src/presentation/adapters/office-kit-package-inspector.ts')));
    for (const mode of ['A', 'B', 'C', 'selected']) {
      const result = await apiJson(server.url, '/api/projects/' + encodeURIComponent(projectId) + '/generation/export', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, format: 'pptx' }),
      }, 201);
      const response = await fetch(new URL(result.artifact.downloadUrl, server.url));
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      const inspected = await packageInspector.inspectOfficeKitPackage(bytes);
      assert.equal(inspected.slideCount, 3);
      assert.equal(inspected.notesSlideCount, 0);
      assert.ok(!inspected.validationIssues.some((issue) => issue.severity === 'error'));
      const reopened = await office.loadPresentation(bytes);
      assert.equal(office.getSlides(reopened).length, 3);
      const editableTextPerSlide = office.getSlides(reopened).map((slide) => office.getSlideShapes(slide)
        .filter((shape) => office.hasShapeText(shape) && office.getShapeText(shape).trim().length > 0).length);
      assert.ok(editableTextPerSlide.every((count) => count >= 1));
      exported.push({ mode, format: 'pptx', bytes: bytes.length, sha256: sha256(bytes), editableTextPerSlide, validationIssues: inspected.validationIssues.length });
    }
    for (const format of ['pdf', 'html']) {
      const result = await apiJson(server.url, '/api/projects/' + encodeURIComponent(projectId) + '/generation/export', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'selected', format }),
      }, 201);
      const response = await fetch(new URL(result.artifact.downloadUrl, server.url));
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (format === 'pdf') {
        const { PDFDocument } = daemonRequire('pdf-lib');
        assert.equal((await PDFDocument.load(bytes)).getPageCount(), 3);
      } else {
        const html = bytes.toString('utf8');
        assert.match(html, /<!doctype html>/iu);
        assert.equal((html.match(/<section class="slide"/gu) ?? []).length, 3);
      }
      exported.push({ mode: 'selected', format, bytes: bytes.length, sha256: sha256(bytes) });
    }
    assert.equal(blockedNetwork.length, 0);
    const replayReport = {
      status: 'PASS', mode: 'offline-real-fixture-replay', projectId,
      templateIRHash: template.templateIR.hash, pdsHash: identity.presentationDesignSystem.hash,
      contentIRHash: planning.contentIR.hash, deckPlanHash: planning.deckPlan.hash,
      semanticFixtureCalls: calls, noProfilerCalls: true, noNetwork: blockedNetwork.length === 0,
      variantSlides: generation.slides.length, readyVariants: generation.slides.length * 3,
      deterministicAuditErrors: runManifest.auditSummary.errors, contextualAudit: 'PASS',
      exports: exported, sourceTemplateHash: sha256(sourceBytes),
    };
    await writeFile(reportPath, JSON.stringify(replayReport, null, 2) + '\n');
    const goldenManifestPath = path.join(bundleRoot, 'golden-manifest.json');
    const updatedGolden = await readJson(goldenManifestPath);
    updatedGolden.offlineReplay = { status: 'PASS', reportPath: 'offline-replay-report.json', networkDisabled: true,
      operations: semanticCalls, exactCapturedRequestMatch: calls.every((call) => call.requestMatched) };
    await writeFile(goldenManifestPath, JSON.stringify(updatedGolden, null, 2) + '\n');
    console.log(JSON.stringify(replayReport, null, 2));
  } finally {
    if (server) await closeServer(server);
    await rm(tempRoot, { recursive: true, force: true });
  }
}
main().catch(async (error) => {
  const report = { status: 'FAIL', code: error?.code ?? 'GOLDEN_REPLAY_FAILED',
    message: String(error?.message ?? error).slice(0, 800), diagnostic: error?.detail ?? null, deniedExternalRequests: blockedNetwork.length };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n').catch(() => undefined);
  console.error(JSON.stringify(report));
  process.exitCode = 1;
});
