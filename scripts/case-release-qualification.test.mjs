import assert from 'node:assert/strict';
import test from 'node:test';

import { createCaseQualificationManifest } from './run-case-release-qualification.mjs';

const templates = ['a', 'b', 'c'].map((letter, index) => ({ name: `template-${index + 1}.pptx`, sha256: letter.repeat(64) }));
const state = {
  schemaVersion: 1,
  status: 'ready',
  lastSuccessful: {
    contentIR: { hash: 'd'.repeat(64), sources: [{ sha256: 'e'.repeat(64) }] },
    brief: { audience: 'Test audience', purpose: 'Test purpose', expectedOutcome: 'Test outcome', preferences: [], requestedSlideCount: 3 },
    deckPlan: { id: 'plan-1', hash: 'f'.repeat(64), slides: [{ id: 'slide-1' }, { id: 'slide-2' }, { id: 'slide-3' }] },
    model: 'offline-fake-planner',
    telemetry: { worker: { wallTimeMs: 12 }, supervisor: { wallTimeMs: 4 } },
    promptVersions: { worker: 'worker.v1', supervisor: 'supervisor.v1' },
  },
};

function matrix() {
  const outputs = templates.flatMap((_template, templateIndex) => ['A', 'B', 'C'].map((variantId) => ({
    templateIndex: templateIndex + 1,
    variantId,
    artifactSha256: 'a'.repeat(64),
    renderStatus: 'passed',
    reopenStatus: 'passed',
    validationStatus: 'passed',
    factualEquivalenceStatus: 'passed',
    templatePreservationStatus: 'passed',
    nativeObjectCounts: { text: 4 },
    findingCount: 0,
    previewStatus: 'passed',
  })));
  return { templateCount: 3, variantCount: 3, outputs, templateQualifications: templates.map(() => ({ status: 'passed' })), timingsMs: { compile: 10, render: 20, semanticProfile: 3, audit: 4, preview: 6, total: 43 } };
}

test('case release manifest passes only an exact validated 3×3 matrix', () => {
  const result = createCaseQualificationManifest({
    state,
    templates,
    matrix: matrix(),
    diagnostics: { callCounts: { templateProfiler: 3 }, stageMs: { templateInspection: 9, offlineTotal: 52 } },
  });
  assert.equal(result.qualificationStatus, 'PASS');
  assert.equal(result.expectedDeckCount, 9);
  assert.equal(result.actualDeckCount, 9);
  assert.equal(result.sharedContentPackage.contentIRHash, state.lastSuccessful.contentIR.hash);
  assert.equal(result.inference.externalInference, false);
  assert.equal(result.stageTimingMs.semanticProfile, 3);
  assert.equal(JSON.stringify(result).includes('C:\\'), false);
});

test('case release manifest blocks a missing, duplicate, or invalid deck output', () => {
  const incomplete = matrix();
  incomplete.outputs.pop();
  assert.equal(createCaseQualificationManifest({ state, templates, matrix: incomplete }).qualificationStatus, 'FAIL');
  const invalid = matrix();
  invalid.outputs[0].reopenStatus = 'failed';
  assert.equal(createCaseQualificationManifest({ state, templates, matrix: invalid }).qualificationStatus, 'FAIL');
  assert.throws(() => createCaseQualificationManifest({ state, templates: templates.slice(0, 2), matrix: matrix() }), /exactly three/);
});
