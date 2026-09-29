import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { register } from 'tsx/esm/api';

register();
const { ProductWorkflowService, renameWithTransientRetry } = await import('../src/presentation/application/product-workflow-service.ts');
const { CONTEXTUAL_AUDIT_RULE_SET_VERSION, CONTEXTUAL_AUDIT_SCHEMA_VERSION, CONTEXTUAL_AUDIT_VERSION_FINGERPRINT } = await import('../src/presentation/application/contextual-audit-port.ts');
const { validateBrief } = await import('../src/presentation/domain/brief.ts');
const { resolvePresentationFilePath } = await import('../src/presentation-files.ts');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

test('workflow state replacement retries bounded transient Windows file locks', async () => {
  let attempts = 0;
  const delays = [];
  await renameWithTransientRetry('state.tmp', 'state.json', async () => {
    attempts += 1;
    if (attempts < 4) throw Object.assign(new Error('file is temporarily locked'), { code: 'EPERM' });
  }, async (ms) => { delays.push(ms); });

  assert.equal(attempts, 4);
  assert.deepEqual(delays, [20, 40, 80]);
});

test('workflow state replacement does not retry permanent failures', async () => {
  let attempts = 0;
  await assert.rejects(renameWithTransientRetry('state.tmp', 'state.json', async () => {
    attempts += 1;
    throw Object.assign(new Error('source does not exist'), { code: 'ENOENT' });
  }, async () => {}), { code: 'ENOENT' });
  assert.equal(attempts, 1);
});

test('persisted legacy nine-rule contextual audit remains readable only as stale v1 evidence', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-legacy-contextual-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, 'projects');
  await mkdir(projectsRoot, { recursive: true });
  const projectId = 'legacy-audit-fixture';
  const brief = validateBrief({ audience: 'Reviewers', purpose: 'Explain the supplied process.', expectedOutcome: 'A clear process summary.', preferences: [], requestedSlideCount: 3 });
  const inputs = { templateFilePath: 'uploads/template.pptx', contentFiles: [], brief };
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const ruleIds = ['titleTakeaway', 'titleContentAlignment', 'factGrounding', 'visualSemanticFit', 'languageConsistency', 'narrativeContinuity', 'redundancy', 'garbage', 'oneSentenceSummary'];
  const state = {
    schemaVersion: 1,
    operationId: 'legacy-operation',
    inputFingerprint: hash(canonicalJson(inputs)),
    inputs,
    status: 'ready',
    stage: 'ready',
    readySlides: 3,
    totalSlides: 3,
    planningFingerprint: null,
    generationId: 'legacy-generation',
    contextualAudit: {
      status: 'ready',
      deckFingerprint: 'a'.repeat(64),
      findings: ruleIds.map((ruleId) => ({ ruleId, slideId: null, severity: 'info', messageCode: `${ruleId}_CLEAR`, evidenceRefs: [], repairable: false, suggestedActionCode: null })),
      telemetry: { model: 'legacy-model', wallTimeMs: 1, finishReason: 'stop' },
      checkedAt: new Date().toISOString(),
      failureCode: null,
    },
    failure: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const stateFile = await resolvePresentationFilePath(projectsRoot, projectId, '.workflow/state.json', { createParent: true });
  await writeFile(stateFile.absolute, JSON.stringify(state), 'utf8');
  const service = new ProductWorkflowService({
    projectRoot: root,
    projectsRoot,
    planningService: {},
    generationService: { getSnapshot: async () => null },
    getInferenceAdapter: () => { throw new Error('The legacy read must not infer.'); },
  });

  const snapshot = await service.get(projectId);
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.contextualAudit.schemaVersion, 1);
  assert.equal(snapshot.contextualAudit.ruleSetVersion, 'contextual-deck-audit.v1');
  assert.equal(snapshot.contextualAudit.auditVersionFingerprint, null);
  assert.equal(snapshot.contextualAudit.findings.length, 9);
  assert.equal(snapshot.contextualAudit.stale, true);
});

test('failed contextual audit preserves safe validation diagnosis and is not mislabeled stale or clean', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-failed-contextual-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = path.join(root, 'projects');
  await mkdir(projectsRoot, { recursive: true });
  const projectId = 'failed-audit-fixture';
  const brief = validateBrief({ audience: 'Reviewers', purpose: 'Explain the supplied process.', expectedOutcome: 'A clear process summary.', preferences: [], requestedSlideCount: 3 });
  const inputs = { templateFilePath: 'uploads/template.pptx', contentFiles: [], brief };
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const state = {
    schemaVersion: 1,
    operationId: 'failed-audit-operation',
    inputFingerprint: hash(canonicalJson(inputs)),
    inputs,
    status: 'failed',
    stage: 'contextual_audit',
    readySlides: 3,
    totalSlides: 3,
    planningFingerprint: null,
    generationId: 'failed-audit-generation',
    contextualAudit: {
      schemaVersion: CONTEXTUAL_AUDIT_SCHEMA_VERSION,
      ruleSetVersion: CONTEXTUAL_AUDIT_RULE_SET_VERSION,
      auditVersionFingerprint: CONTEXTUAL_AUDIT_VERSION_FINGERPRINT,
      status: 'failed',
      deckFingerprint: 'b'.repeat(64),
      findings: null,
      telemetry: { model: 'Qwen/Qwen3.8-27B', wallTimeMs: 17_000, finishReason: 'stop', httpStatus: 200, validationFailureCode: 'INVALID_SLIDE_REF' },
      checkedAt: new Date().toISOString(),
      failureCode: 'INVALID_STRUCTURED_OUTPUT',
    },
    failure: { code: 'INVALID_STRUCTURED_OUTPUT', stage: 'contextual_audit', retryable: true },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const stateFile = await resolvePresentationFilePath(projectsRoot, projectId, '.workflow/state.json', { createParent: true });
  await writeFile(stateFile.absolute, JSON.stringify(state), 'utf8');
  const service = new ProductWorkflowService({
    projectRoot: root,
    projectsRoot,
    planningService: {},
    generationService: { getSnapshot: async () => null },
    getInferenceAdapter: () => { throw new Error('Reading a failed audit must not call inference.'); },
  });

  const snapshot = await service.get(projectId);
  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.contextualAudit.status, 'failed');
  assert.equal(snapshot.contextualAudit.stale, false, 'a failed check did not establish an audit result that could become stale');
  assert.equal(snapshot.contextualAudit.findings, null, 'failed output must not be presented as zero findings');
  assert.equal(snapshot.contextualAudit.telemetry.validationFailureCode, 'INVALID_SLIDE_REF');
  assert.equal(snapshot.contextualAudit.telemetry.httpStatus, 200);
});
