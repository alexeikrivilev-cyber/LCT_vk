import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createQualificationSemanticCapture } from './lib/qualification-semantic-capture.mjs';
import { OpenAICompatibleSemanticInferenceAdapter } from '../apps/daemon/src/presentation/adapters/openai-compatible-semantic-inference.ts';
import { SemanticInferenceError } from '../apps/daemon/src/presentation/application/semantic-inference-port.ts';

function response(content) {
  return {
    id: 'local-diagnostic-test',
    model: 'offline-test-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 9 },
  };
}

async function startResponseServer(t, payload) {
  const server = createServer((_request, reply) => {
    reply.writeHead(200, { 'content-type': 'application/json' });
    reply.end(JSON.stringify(response(JSON.stringify(payload))));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return `http://127.0.0.1:${address.port}/v1`;
}

test('qualification capture stores bounded parsed output and exact safe validation diagnostics outside stdout', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-qualification-capture-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const outputDir = path.join(temp, '.lct', 'run-123');
  const sourceSentinel = 'request-content-must-not-be-printed';
  const parsedResponse = { schemaVersion: 2, findings: [] };
  const baseUrl = await startResponseServer(t, parsedResponse);
  const delegate = new OpenAICompatibleSemanticInferenceAdapter({
    baseUrl,
    model: 'offline-test-model',
    apiKey: undefined,
    requestTimeoutMs: 500,
  });
  const capture = createQualificationSemanticCapture(outputDir);
  const logs = [];
  const previousLog = console.log;
  console.log = (...values) => logs.push(values.join(' '));
  try {
    await assert.rejects(capture.wrap(delegate).infer({
      role: 'supervisor',
      operation: 'contextual-deck-audit',
      messages: [{ role: 'user', content: sourceSentinel }],
      output: {
        name: 'contextual_deck_audit_v2',
        schemaVersion: 2,
        schema: { type: 'object' },
        validate: () => false,
        diagnoseValidationFailure: () => 'MISSING_RULE',
        diagnoseValidationFailureDetail: () => 'findings: missing required rule titleTakeaway',
      },
      maxOutputTokens: 3072,
      temperature: 0,
    }), (error) => {
      assert.ok(error instanceof SemanticInferenceError);
      assert.equal(error.code, 'INVALID_STRUCTURED_OUTPUT');
      assert.equal(error.structuredOutputDiagnostic.validationFailureCode, 'MISSING_RULE');
      assert.equal(error.structuredOutputDiagnostic.validationDiagnostic, 'findings: missing required rule titleTakeaway');
      return true;
    });
  } finally {
    console.log = previousLog;
  }
  const summary = await capture.summary();
  assert.deepEqual(summary.diagnosticFiles.length, 1);
  assert.equal(summary.captureError, null);
  const artifactText = await readFile(path.join(outputDir, 'semantic-diagnostics', summary.diagnosticFiles[0]), 'utf8');
  const artifact = JSON.parse(artifactText);
  assert.equal(artifact.operation, 'contextual-deck-audit');
  assert.equal(artifact.schemaName, 'contextual_deck_audit_v2');
  assert.equal(artifact.schemaVersion, 2);
  assert.equal(artifact.responseJsonValid, true);
  assert.deepEqual(artifact.parsedResponse, parsedResponse);
  assert.equal(artifact.validationFailureCode, 'MISSING_RULE');
  assert.equal(artifact.validationDiagnostic, 'findings: missing required rule titleTakeaway');
  assert.doesNotMatch(artifactText, new RegExp(`${baseUrl}|request-content-must-not-be-printed|authorization|apiKey`, 'iu'));
  assert.doesNotMatch(logs.join('\n'), /request-content-must-not-be-printed|"findings":\[\]/u);
});

test('qualification capture omits oversized parsed responses but preserves the structural diagnostic', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-qualification-capture-bound-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const outputDir = path.join(temp, '.lct', 'bounded-run');
  const capture = createQualificationSemanticCapture(outputDir);
  const adapter = {
    async infer() {
      throw new SemanticInferenceError('INVALID_STRUCTURED_OUTPUT', 'invalid output', {
        structuredOutputDiagnostic: {
          operation: 'contextual-deck-audit', schemaName: 'contextual_deck_audit_v2', schemaVersion: 2,
          requestId: '12345678-1234-4123-8123-123456789abc', responseJsonValid: true,
          parsedResponse: { oversized: 'x'.repeat(110 * 1024) },
          validationFailureCode: 'INVALID_EVIDENCE_REF', validationDiagnostic: 'findings[0].evidenceRefs: unknown reference',
        },
      });
    },
  };
  await assert.rejects(capture.wrap(adapter).infer({}), (error) => error.code === 'INVALID_STRUCTURED_OUTPUT');
  const summary = await capture.summary();
  const files = await readdir(path.join(outputDir, 'semantic-diagnostics'));
  assert.equal(files.length, 1);
  const record = JSON.parse(await readFile(path.join(outputDir, 'semantic-diagnostics', files[0]), 'utf8'));
  assert.equal(record.parsedResponseOmitted, 'SIZE_LIMIT');
  assert.equal(Object.hasOwn(record, 'parsedResponse'), false);
  assert.equal(record.validationFailureCode, 'INVALID_EVIDENCE_REF');
  assert.ok(summary.capturedBytes < 96 * 1024);
});

test('qualification capture gives repeated batches of one operation unique fixture files', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'lct-qualification-capture-batches-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const outputDir = path.join(temp, '.lct', 'batch-run');
  let requestIndex = 0;
  const privateEndpoint = 'https://private-endpoint.example.invalid/v1';
  const privateToken = 'raw-private-api-token-value';
  const sourceText = `private source prompt ${privateEndpoint} ${privateToken}`;
  const capture = createQualificationSemanticCapture(outputDir, { forbiddenValues: [privateEndpoint, privateToken] });
  const adapter = {
    async infer() {
      requestIndex += 1;
      return {
        value: { batch: requestIndex, echoed: `${privateEndpoint} ${privateToken}`, authorization: 'Bearer original-secret-value' },
        telemetry: { requestId: `12345678-1234-4123-8123-123456789ab${requestIndex}`, model: 'offline-test-model',
          role: 'supervisor', operation: 'template-semantic-profile', status: 'success' },
      };
    },
  };
  const wrapped = capture.wrap(adapter);
  const request = { role: 'supervisor', operation: 'template-semantic-profile', messages: [{ role: 'user', content: sourceText }], output: { name: 'template_profile_v1' } };
  await wrapped.infer(request);
  await wrapped.infer(request);
  const files = await readdir(path.join(outputDir, 'semantic-fixtures'));
  assert.equal(files.length, 2);
  assert.notEqual(files[0], files[1]);
  assert.equal((await capture.summary()).captureError, null);
  const artifactText = (await Promise.all(files.map((file) => readFile(path.join(outputDir, 'semantic-fixtures', file), 'utf8')))).join('\n');
  assert.doesNotMatch(artifactText, /private-endpoint|raw-private-api-token-value|private source prompt|original-secret-value/u);
  assert.match(artifactText, /"sha256": "[a-f0-9]{64}"/u);
  assert.match(artifactText, /REDACTED_PRIVATE_VALUE|REDACTED_CREDENTIAL/u);
});
