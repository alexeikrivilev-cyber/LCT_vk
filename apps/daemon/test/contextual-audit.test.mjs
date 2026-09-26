import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'tsx/esm/api';

register();
const { CONTEXTUAL_AUDIT_RULES, CONTEXTUAL_AUDIT_MESSAGE_CODES, validateContextualDeckAuditResponse } = await import('../src/presentation/application/contextual-audit-port.ts');
const { auditEvidence } = await import('../src/presentation/application/product-workflow-service.ts');

const slideContentRefs = new Map([
  ['slide-1', new Set(['unit-1'])],
  ['slide-2', new Set(['unit-2'])],
]);
const validationContext = { slideContentRefs, knownEvidenceRefs: new Set(['unit-1', 'unit-2']) };

function passingAudit() {
  return {
    schemaVersion: 1,
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

test('contextual audit requires all nine unique rules and validates exact bounded findings', () => {
  const result = validateContextualDeckAuditResponse(passingAudit(), validationContext);
  assert.equal(result.findings.length, 9);
  assert.deepEqual(new Set(result.findings.map((finding) => finding.ruleId)), new Set(CONTEXTUAL_AUDIT_RULES));
  assert.throws(() => validateContextualDeckAuditResponse({ ...passingAudit(), extraText: 'untrusted' }, validationContext), /invalid shape/);
  assert.throws(() => validateContextualDeckAuditResponse({ ...passingAudit(), findings: passingAudit().findings.slice(1) }, validationContext), /invalid shape/);
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
});

test('contextual audit cannot run when deterministic audit has an error', () => {
  const contentIR = { units: [{ id: 'unit-1', kind: 'text', text: 'Source-backed statement.' }] };
  const plan = { slides: [{ id: 'slide-1', contentRefs: ['unit-1'], narrativeRole: 'content', purpose: 'Review evidence.', takeaway: 'The source supports the statement.', semanticVisualType: 'none', targetDensity: 'balanced' }] };
  const generation = { slides: [{
    slideId: 'slide-1', index: 0, title: 'The source supports the statement.', selectedVariant: 'A',
    variants: { A: { status: 'ready', audit: { findings: [{ severity: 'error' }] } } },
  }] };
  assert.throws(() => auditEvidence(contentIR, plan, generation), (error) => error.code === 'DETERMINISTIC_AUDIT_FAILED');
});

test('contextual audit receives rendered source text including table and numeric cell values', () => {
  const contentIR = { units: [
    { id: 'heading', kind: 'heading', text: '## Итог' },
    { id: 'statement', kind: 'text', text: 'Рост подтверждён таблицей.' },
    { id: 'table-label', kind: 'table-cell', cellValue: 'Показатель' },
    { id: 'table-value', kind: 'table-cell', cellValue: '27', numericLexeme: '27' },
  ] };
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
  const contentIR = { units: [{ id: 'unit-1', kind: 'text', text: 'Source-backed statement.' }] };
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
