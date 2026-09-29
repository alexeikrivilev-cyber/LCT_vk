import assert from 'node:assert/strict';
import test from 'node:test';

import { fakeInferenceRequestCount, isCompleteUnknownTemplateSmoke, isUnknownTemplateCandidate, matchesExpectedTemplateIdentity } from './run-unknown-template-qualification.mjs';

const known = [
  { name: 'VK Tech.pptx', sha256: 'a'.repeat(64) },
  { name: 'Education.pptx', sha256: 'b'.repeat(64) },
  { name: 'WorkSpace.pptx', sha256: 'c'.repeat(64) },
];

test('unknown-template gate rejects a known filename or a renamed copy by content hash', () => {
  assert.equal(isUnknownTemplateCandidate({ name: 'vk tech.PPTX', sha256: 'd'.repeat(64) }, known), false);
  assert.equal(isUnknownTemplateCandidate({ name: 'renamed.pptx', sha256: 'a'.repeat(64) }, known), false);
  assert.equal(isUnknownTemplateCandidate({ name: 'held-out.pptx', sha256: 'd'.repeat(64) }, known), true);
});

test('held-out identity requires the exact expected onboarding filename and hash', () => {
  const expected = { name: 'AIOS_Онбординг (4) (1) (1).pptx', sha256: '1'.repeat(64) };
  assert.equal(matchesExpectedTemplateIdentity({ ...expected }, expected), true);
  assert.equal(matchesExpectedTemplateIdentity({ name: 'AIOS_Лекция (1).pptx', sha256: '2'.repeat(64) }, expected), false);
  assert.equal(matchesExpectedTemplateIdentity({ name: expected.name, sha256: '2'.repeat(64) }, expected), false);
  assert.equal(matchesExpectedTemplateIdentity({ name: 'AIOS_onboarding.pptx', sha256: expected.sha256 }, expected), false);
});

test('unknown-template acceptance requires every real product-smoke gate and counts calls on failure reports', () => {
  const report = {
    status: 'passed',
    gates: Object.fromEntries(['project', 'upload', 'template', 'content', 'plan', 'planDeckReview', 'planningReload',
      'generation', 'variantsSelectionAndLock', 'audit', 'exportAndReopen', 'trackExportsAndReopen', 'generationReload', 'sourceImmutable']
      .map((gate) => [gate, 'passed'])),
    audit: { errors: 0 }, export: { nativeTextShapes: 6 },
    fakeInferenceCallCount: 10,
    fakeInferenceRequests: [
      ...Array.from({ length: 8 }, () => ({ operation: 'template-semantic-profile' })),
      { operation: 'deck-plan' },
      { operation: 'plan-review' },
    ],
    trackExports: ['A', 'B', 'C'].map((mode) => ({ mode, reopened: true })),
  };
  assert.equal(isCompleteUnknownTemplateSmoke(report), true);
  report.sourceResidueCheck = { status: 'passed', forbiddenTermCount: 5 };
  assert.equal(isCompleteUnknownTemplateSmoke(report), true);
  report.sourceResidueCheck.status = 'failed';
  assert.equal(isCompleteUnknownTemplateSmoke(report), false);
  delete report.sourceResidueCheck;
  assert.equal(fakeInferenceRequestCount({ fakeInferenceRequests: report.fakeInferenceRequests }), 10);
  report.fakeInferenceRequests.push({ operation: 'unexpected-operation' });
  report.fakeInferenceCallCount += 1;
  assert.equal(isCompleteUnknownTemplateSmoke(report), false, 'unexpected semantic operations must block unknown-template acceptance');
  report.fakeInferenceRequests.pop();
  report.fakeInferenceCallCount -= 1;
  const withoutProfile = { ...report, fakeInferenceRequests: report.fakeInferenceRequests.filter((request) => request.operation !== 'template-semantic-profile') };
  withoutProfile.fakeInferenceCallCount = withoutProfile.fakeInferenceRequests.length;
  assert.equal(isCompleteUnknownTemplateSmoke(withoutProfile), false, 'a fresh candidate must be semantically profiled before planning');
  report.gates.generation = 'failed';
  assert.equal(isCompleteUnknownTemplateSmoke(report), false);
});
