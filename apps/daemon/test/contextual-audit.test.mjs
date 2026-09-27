import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'tsx/esm/api';

register();
const {
  CONTEXTUAL_AUDIT_RULES,
  CONTEXTUAL_AUDIT_MESSAGE_CODES,
  CONTEXTUAL_AUDIT_REVIEW_ACTIONS,
  CONTEXTUAL_AUDIT_SCHEMA_VERSION,
  CONTEXTUAL_AUDIT_VERSION_FINGERPRINT,
  buildContextualAuditVersionFingerprint,
  diagnoseContextualDeckAuditFailure,
  validateContextualDeckAuditResponse,
} = await import('../src/presentation/application/contextual-audit-port.ts');
const { CONTEXTUAL_AUDITOR_WORKFLOW } = await import('../src/presentation/application/workflow-versions.ts');
const { readFile } = await import('node:fs/promises');
const { createHash } = await import('node:crypto');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const { auditEvidence } = await import('../src/presentation/application/product-workflow-service.ts');

const slideContentRefs = new Map([
  ['slide-1', new Set(['unit-1'])],
  ['slide-2', new Set(['unit-2'])],
]);
const validationContext = { slideContentRefs, knownEvidenceRefs: new Set(['unit-1', 'unit-2']) };

function passingAudit() {
  return {
    schemaVersion: CONTEXTUAL_AUDIT_SCHEMA_VERSION,
    findings: CONTEXTUAL_AUDIT_RULES.map((ruleId, index) => ({
      ruleId,
      slideId: index === 0 ? 'slide-1' : null,
      severity: 'info',
      messageCode: CONTEXTUAL_AUDIT_MESSAGE_CODES[ruleId][0],
      evidenceRefs: index === 0 ? ['unit-1'] : [],
      repairable: false,
      suggestedActionCode: null,
    })),
  };
}

test('contextual audit requires all eleven unique rules and validates exact bounded findings', () => {
  const result = validateContextualDeckAuditResponse(passingAudit(), validationContext);
  assert.equal(result.findings.length, 11);
  assert.deepEqual(new Set(result.findings.map((finding) => finding.ruleId)), new Set(CONTEXTUAL_AUDIT_RULES));
  assert.throws(() => validateContextualDeckAuditResponse({ ...passingAudit(), extraText: 'untrusted' }, validationContext), /invalid shape/);
  assert.throws(() => validateContextualDeckAuditResponse({ ...passingAudit(), findings: passingAudit().findings.slice(1) }, validationContext), /invalid shape/);
  for (const requiredRule of ['spelling', 'tableLegendUsefulness']) {
    assert.throws(() => validateContextualDeckAuditResponse({ ...passingAudit(), findings: passingAudit().findings.filter((item) => item.ruleId !== requiredRule) }, validationContext), /invalid shape/);
  }
  assert.throws(() => validateContextualDeckAuditResponse({ ...passingAudit(), findings: [...passingAudit().findings, passingAudit().findings[0]] }, validationContext), /invalid shape/);
  assert.throws(() => validateContextualDeckAuditResponse({ ...passingAudit(), findings: [...passingAudit().findings, { ruleId: 'unknown' }] }, validationContext), /invalid shape/);
});

test('contextual audit rejects unknown slide IDs, cross-slide evidence, mismatched codes, and duplicate rules', () => {
  const unknownSlide = passingAudit();
  unknownSlide.findings[0].slideId = 'slide-outside-deck';
  assert.throws(() => validateContextualDeckAuditResponse(unknownSlide, validationContext), /unknown slide/);

  const wrongEvidence = passingAudit();
  wrongEvidence.findings[0].evidenceRefs = ['unit-2'];
  assert.throws(() => validateContextualDeckAuditResponse(wrongEvidence, validationContext), /does not belong/);

  const mismatchedCode = passingAudit();
  mismatchedCode.findings[0].messageCode = 'FACTS_UNGROUNDED';
  assert.throws(() => validateContextualDeckAuditResponse(mismatchedCode, validationContext), /does not match/);

  const duplicateRule = passingAudit();
  duplicateRule.findings[1].ruleId = duplicateRule.findings[0].ruleId;
  assert.throws(() => validateContextualDeckAuditResponse(duplicateRule, validationContext), /known and unique/);

  const invalidRef = passingAudit();
  invalidRef.findings[0].evidenceRefs = ['unknown-evidence'];
  assert.throws(() => validateContextualDeckAuditResponse(invalidRef, validationContext), /unknown or duplicate evidence/);
});

test('contextual audit failure diagnostics identify the first contract mismatch without echoing response text', () => {
  const cases = [
    ['missing rule', (value) => { value.findings.pop(); }, 'MISSING_RULE', /findings: missing required rule/u],
    ['duplicate rule', (value) => { value.findings[1].ruleId = value.findings[0].ruleId; }, 'DUPLICATE_RULE', /findings\[1\]\.ruleId: duplicate rule/u],
    ['invalid severity enum', (value) => { value.findings[0].severity = 'critical'; }, 'INVALID_SEVERITY', /findings\[0\]\.severity: invalid enum/u],
    ['invalid slide ref', (value) => { value.findings[0].slideId = 'private-slide-value'; }, 'INVALID_SLIDE_REF', /findings\[0\]\.slideId: unknown slide reference/u],
    ['invalid evidence ref', (value) => { value.findings[0].evidenceRefs = ['private-evidence-value']; }, 'INVALID_EVIDENCE_REF', /findings\[0\]\.evidenceRefs: unknown or duplicate reference/u],
    ['invalid action code', (value) => {
      value.findings[0].severity = 'warning';
      value.findings[0].messageCode = CONTEXTUAL_AUDIT_MESSAGE_CODES.titleTakeaway[1];
      value.findings[0].suggestedActionCode = 'PRIVATE_ACTION_VALUE';
    }, 'INVALID_ACTION_CODE', /findings\[0\]\.suggestedActionCode: invalid action code/u],
    ['unexpected field', (value) => { value.privateText = 'must not appear in diagnostics'; }, 'UNEXPECTED_FIELD', /response: unexpected field/u],
  ];
  for (const [label, mutate, code, expectedDiagnostic] of cases) {
    const value = passingAudit();
    mutate(value);
    const diagnostic = diagnoseContextualDeckAuditFailure(value, validationContext);
    assert.equal(diagnostic.code, code, label);
    assert.match(diagnostic.diagnostic, expectedDiagnostic, label);
    assert.doesNotMatch(diagnostic.diagnostic, /private-slide-value|private-evidence-value|PRIVATE_ACTION_VALUE|must not appear/u, label);
    assert.throws(() => validateContextualDeckAuditResponse(value, validationContext), (error) => error.message.length > 0);
  }
});

test('spelling and table/legend concerns use bounded actions and never request model repair', () => {
  const spelling = passingAudit();
  const spellingResult = spelling.findings.find((finding) => finding.ruleId === 'spelling');
  spellingResult.severity = 'warning';
  spellingResult.messageCode = 'SPELLING_REVIEW';
  spellingResult.evidenceRefs = [];
  spellingResult.suggestedActionCode = CONTEXTUAL_AUDIT_REVIEW_ACTIONS.spelling;
  assert.equal(validateContextualDeckAuditResponse(spelling, validationContext).findings.find((finding) => finding.ruleId === 'spelling').evidenceRefs.length, 0);

  const table = passingAudit();
  const tableResult = table.findings.find((finding) => finding.ruleId === 'tableLegendUsefulness');
  tableResult.severity = 'warning';
  tableResult.messageCode = 'TABLE_LEGEND_REVIEW';
  tableResult.evidenceRefs = ['unit-1'];
  tableResult.slideId = 'slide-1';
  tableResult.suggestedActionCode = CONTEXTUAL_AUDIT_REVIEW_ACTIONS.tableLegendUsefulness;
  assert.equal(validateContextualDeckAuditResponse(table, validationContext).findings.find((finding) => finding.ruleId === 'tableLegendUsefulness').suggestedActionCode, 'REVIEW_TABLE');

  spellingResult.repairable = true;
  assert.throws(() => validateContextualDeckAuditResponse(spelling, validationContext), /bounded action code/);
});

test('contextual auditor agent, skill, prompt hash, schema, and rule set are explicitly versioned together', async () => {
  assert.equal(CONTEXTUAL_AUDITOR_WORKFLOW.agentVersion, 'contextual-audit-supervisor.v1');
  assert.equal(CONTEXTUAL_AUDITOR_WORKFLOW.skillVersion, 'presentation-contextual-audit.v1');
  assert.equal(CONTEXTUAL_AUDITOR_WORKFLOW.promptVersion, 'contextual-deck-audit.v4');
  assert.equal(CONTEXTUAL_AUDITOR_WORKFLOW.schemaVersion, 'contextual_deck_audit_v2');
  assert.match(CONTEXTUAL_AUDIT_VERSION_FINGERPRINT, /^[a-f0-9]{64}$/u);
  assert.notEqual(buildContextualAuditVersionFingerprint({ auditor: { ...CONTEXTUAL_AUDITOR_WORKFLOW, promptVersion: 'contextual-deck-audit.v5' } }), CONTEXTUAL_AUDIT_VERSION_FINGERPRINT);
  assert.notEqual(buildContextualAuditVersionFingerprint({ schema: { type: 'object', required: ['newField'] } }), CONTEXTUAL_AUDIT_VERSION_FINGERPRINT);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const prompt = await readFile(path.join(repoRoot, 'apps/daemon/prompts/contextual-deck-audit.v4.md'));
  assert.equal(createHash('sha256').update(prompt).digest('hex'), CONTEXTUAL_AUDITOR_WORKFLOW.promptSha256);
  assert.match(prompt.toString('utf8'), /exactly 11 objects[\s\S]*never emit one finding per slide/u);
  await readFile(path.join(repoRoot, 'skills/presentation-contextual-audit/SKILL.md'));
});

test('an all-clear contextual response cannot clear a deterministic blocking error', () => {
  const contentIR = { sources: [{ id: 'source-1', kind: 'text' }], units: [{ id: 'unit-1', sourceId: 'source-1', kind: 'text', text: 'Source-backed statement.' }] };
  const plan = { slides: [{ id: 'slide-1', contentRefs: ['unit-1'], narrativeRole: 'content', purpose: 'Review evidence.', takeaway: 'The source supports the statement.', semanticVisualType: 'none', targetDensity: 'balanced' }] };
  const generation = { slides: [{
    slideId: 'slide-1', index: 0, title: 'The source supports the statement.', selectedVariant: 'A',
    variants: { A: { status: 'ready', audit: { findings: [{ severity: 'error' }] } } },
  }] };
  const allClearContextualResult = validateContextualDeckAuditResponse(passingAudit(), validationContext);
  assert.ok(allClearContextualResult.findings.every((finding) => finding.severity === 'info'));
  assert.throws(() => auditEvidence(contentIR, plan, generation), (error) => error.code === 'DETERMINISTIC_AUDIT_FAILED');
  assert.equal(generation.slides[0].variants.A.audit.findings[0].severity, 'error', 'contextual result cannot mutate or downgrade deterministic evidence');
});

test('contextual audit receives rendered source text including table and numeric cell values', () => {
  const contentIR = { units: [
    { id: 'heading', sourceId: 'source-1', kind: 'heading', text: '## Итог' },
    { id: 'statement', sourceId: 'source-1', kind: 'text', text: 'Рост подтверждён таблицей.' },
    { id: 'table-label', sourceId: 'source-1', kind: 'table-cell', cellValue: 'Показатель' },
    { id: 'table-value', sourceId: 'source-1', kind: 'table-cell', cellValue: '27', numericLexeme: '27' },
  ], sources: [{ id: 'source-1', kind: 'text' }] };
  const plan = { slides: [{
    id: 'slide-1', contentRefs: ['heading', 'statement', 'table-label', 'table-value'],
    narrativeRole: 'content', purpose: 'Показать результат.', takeaway: 'Рост подтверждён таблицей.',
    semanticVisualType: 'table', targetDensity: 'balanced',
  }] };
  const generation = { slides: [{
    slideId: 'slide-1', index: 0, title: 'Рост подтверждён таблицей.', selectedVariant: 'A',
    variants: { A: { status: 'ready', audit: { findings: [] } } },
  }] };

  const audited = auditEvidence(contentIR, plan, generation);
  const [{ bodyText, evidenceRefs }] = audited.slides;
  assert.deepEqual(bodyText, ['Итог', 'Рост подтверждён таблицей.', 'Показатель', '27']);
  assert.deepEqual(evidenceRefs, plan.slides[0].contentRefs);
  assert.deepEqual(audited.evidence, [
    { id: 'heading', kind: 'heading', text: 'Итог' },
    { id: 'statement', kind: 'text', text: 'Рост подтверждён таблицей.' },
    { id: 'table-label', kind: 'table-cell', text: 'Показатель' },
    { id: 'table-value', kind: 'table-cell', text: '27' },
  ]);
});

test('contextual audit fails closed when a selected slide evidence ref is missing', () => {
  const contentIR = { sources: [{ id: 'source-1', kind: 'text' }], units: [{ id: 'unit-1', sourceId: 'source-1', kind: 'text', text: 'Source-backed statement.' }] };
  const plan = { slides: [{
    id: 'slide-1', contentRefs: ['unit-1', 'missing-unit'], narrativeRole: 'content', purpose: 'Review evidence.',
    takeaway: 'The source supports the statement.', semanticVisualType: 'none', targetDensity: 'balanced',
  }] };
  const generation = { slides: [{
    slideId: 'slide-1', index: 0, title: 'The source supports the statement.', selectedVariant: 'A',
    variants: { A: { status: 'ready', audit: { findings: [] } } },
  }] };
  assert.throws(() => auditEvidence(contentIR, plan, generation), (error) => error.code === 'CONTEXTUAL_AUDIT_EVIDENCE_MISSING');
});
