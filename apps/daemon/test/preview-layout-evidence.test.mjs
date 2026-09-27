import assert from 'node:assert/strict';
import test from 'node:test';

import { classifySourceTemplateBleed, isPreviewLayoutIssueSummary, summarizePreviewLayoutEvidence } from '../src/presentation/application/preview-layout-evidence.ts';

function setup() {
  const element = {
    id: 'source-element', name: 'Inherited shape',
    geometry: { direct: { x: 0, y: 4748271, width: 12192000, height: 2109730, unit: 'EMU' }, resolved: null },
  };
  const template = {
    slides: [{ index: 15, sourcePart: 'ppt/slides/slide15.xml', elements: [element] }],
    layouts: [{ id: 'layout-1', sourcePart: 'ppt/slideLayouts/slideLayout1.xml', masterId: null, elements: [] }],
    masters: [],
  };
  const selection = { sourceSlideIndex: 15, sourcePart: 'ppt/slides/slide15.xml', layoutId: 'layout-1' };
  return { element, template, selection };
}

test('approximate text metrics are informational preview evidence, not blocking geometry failures', () => {
  const { template } = setup();
  const summary = summarizePreviewLayoutEvidence({
    textLayoutIssues: [{ severity: 'warning', classification: 'PREVIEW_TEXT_METRIC_APPROXIMATION', approximate: true, source: '@office-kit/pptx-preview.auditTextLayout', confidence: 'low', kind: 'overflow-y', overflowPx: 36.8, slideIndex: 0 }],
    geometryIssues: [],
  }, template, { exemplarSelection: null });
  assert.deepEqual([summary.total, summary.blocking, summary.warnings, summary.approximate], [1, 0, 0, 1]);
  assert.equal(summary.details[0].classification, 'PREVIEW_TEXT_METRIC_APPROXIMATION');
  assert.equal(summary.details[0].overflowPx, 36.8);
  assert.equal(isPreviewLayoutIssueSummary(summary), true);
});

test('real geometry errors stay blocking even if an adapter marks its measurement approximate', () => {
  const { template } = setup();
  const summary = summarizePreviewLayoutEvidence({
    textLayoutIssues: [{ severity: 'error', classification: 'PREVIEW_TEXT_OVERFLOW', approximate: true }],
    geometryIssues: [],
  }, template, { exemplarSelection: null });
  assert.deepEqual([summary.blocking, summary.warnings, summary.approximate], [1, 0, 0]);
});

test('only an exact selected source-template geometry match is retained as a visible warning', () => {
  const { template, selection } = setup();
  const issue = { severity: 'error', classification: 'GENERATED_OBJECT_OUT_OF_BOUNDS', confidence: 'high', shapeName: 'Inherited shape', bounds: { x: 0, y: 4748271, width: 12192000, height: 2109730 } };
  const inherited = classifySourceTemplateBleed(issue, template, selection);
  assert.equal(inherited.classification, 'SOURCE_TEMPLATE_BLEED');
  assert.equal(inherited.severity, 'warning');
  assert.equal(inherited.confidence, 'high');
  assert.match(inherited.source, /ppt\/slides\/slide15\.xml/u);

  const changedGeometry = classifySourceTemplateBleed({ ...issue, bounds: { ...issue.bounds, height: issue.bounds.height - 2 } }, template, selection);
  assert.equal(changedGeometry.classification, 'GENERATED_OBJECT_OUT_OF_BOUNDS');
  assert.equal(changedGeometry.severity, 'error');
  const unrelated = classifySourceTemplateBleed(issue, template, { ...selection, sourceSlideIndex: 3, sourcePart: 'ppt/slides/slide3.xml' });
  assert.equal(unrelated.classification, 'GENERATED_OBJECT_OUT_OF_BOUNDS');
});

test('summary retains inherited bleed and approximate metric as separate nonblocking categories', () => {
  const { template, selection } = setup();
  const summary = summarizePreviewLayoutEvidence({
    textLayoutIssues: [{ severity: 'warning', classification: 'PREVIEW_TEXT_METRIC_APPROXIMATION', approximate: true }],
    geometryIssues: [{ severity: 'error', classification: 'GENERATED_OBJECT_OUT_OF_BOUNDS', confidence: 'high', shapeName: 'Inherited shape', bounds: { x: 0, y: 4748271, width: 12192000, height: 2109730 } }],
  }, template, { exemplarSelection: selection });
  assert.deepEqual([summary.total, summary.blocking, summary.warnings, summary.approximate], [2, 0, 1, 1]);
  assert.equal(summary.details.find((detail) => detail.classification === 'SOURCE_TEMPLATE_BLEED').category, 'warning');
  assert.equal(summary.details.find((detail) => detail.classification === 'PREVIEW_TEXT_METRIC_APPROXIMATION').category, 'approximate');
  assert.equal(isPreviewLayoutIssueSummary({ ...summary, total: 3 }), false);
  const { overflowPx: _legacyMetric, ...legacyDetail } = summary.details.find((detail) => detail.classification === 'PREVIEW_TEXT_METRIC_APPROXIMATION');
  assert.equal(isPreviewLayoutIssueSummary({ ...summary, details: summary.details.map((detail) => detail.classification === 'PREVIEW_TEXT_METRIC_APPROXIMATION' ? legacyDetail : detail) }), true);
});
