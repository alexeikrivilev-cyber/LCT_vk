import assert from 'node:assert/strict';
import test from 'node:test';

import { fakeInferenceRequestCount, isCompleteUnknownTemplateSmoke, isUnknownTemplateCandidate } from './run-unknown-template-qualification.mjs';

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

test('unknown-template acceptance requires every real product-smoke gate and counts calls on failure reports', () => {
  const report = {
    status: 'passed',
    gates: Object.fromEntries(['project', 'upload', 'template', 'content', 'plan', 'planDeckReview', 'planningReload',
      'generation', 'variantsSelectionAndLock', 'audit', 'exportAndReopen', 'trackExportsAndReopen', 'generationReload', 'sourceImmutable']
      .map((gate) => [gate, 'passed'])),
    audit: { errors: 0 }, export: { nativeTextShapes: 6 },
    fakeInferenceCallCount: 3,
    fakeInferenceRequests: ['template-semantic-profile', 'deck-plan', 'plan-review'].map((operation) => ({ operation })),
    trackExports: ['A', 'B', 'C'].map((mode) => ({ mode, reopened: true })),
  };
  assert.equal(isCompleteUnknownTemplateSmoke(report), true);
  assert.equal(fakeInferenceRequestCount({ fakeInferenceRequests: report.fakeInferenceRequests }), 3);
  report.gates.generation = 'failed';
  assert.equal(isCompleteUnknownTemplateSmoke(report), false);
});
