import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { reviewDeckLevel } from '../src/presentation/application/deck-level-review.ts';
import { canonicalizeDeckPlan } from '../src/presentation/domain/deck-plan.ts';
import { contentByteOffsets, contentSourceId, contentUnitId, finalizeContentIR } from '../src/presentation/domain/content-ir.ts';

function makeContentIR(values) {
  const sourcePath = 'synthetic-source.csv';
  const sourceText = values.map((row) => row.join(',')).join('\n');
  const bytes = Buffer.from(sourceText);
  const byteOffsets = contentByteOffsets(sourceText);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const sourceId = contentSourceId(sourcePath, 0, sha256);
  const source = {
    id: sourceId, sourcePath, originalName: sourcePath, mediaType: 'text/csv; charset=utf-8', sha256,
    order: 0, byteLength: bytes.length, kind: 'text', text: bytes.toString('utf8'), warnings: [],
  };
  const units = values.flatMap((row, rowIndex) => row.map((cellValue, columnIndex) => {
    const rowStart = values.slice(0, rowIndex).reduce((sum, previous) => sum + previous.join(',').length + 1, 0);
    const startChar = rowStart + row.slice(0, columnIndex).reduce((sum, previous) => sum + previous.length + 1, 0);
    const endChar = startChar + cellValue.length;
    const payload = {
      sourceId, order: rowIndex * row.length + columnIndex, kind: 'table-cell',
      locator: { startByte: byteOffsets[startChar], endByte: byteOffsets[endChar], rowIndex, columnIndex }, cellValue,
      ...(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(cellValue) ? { numericLexeme: cellValue } : {}),
    };
    return { id: contentUnitId(sourceId, payload), ...payload };
  }));
  return finalizeContentIR([source], units);
}

function makePlan(contentIR, slides) {
  return canonicalizeDeckPlan({
    workingTitle: 'Synthetic deck quality review',
    narrativeSummary: 'A fake-driven review of a synthetic source.',
    slides,
  }, {
    id: 'deck_quality_review', version: 1, createdAt: '2026-09-26T00:00:00.000Z',
    inputFingerprint: 'f'.repeat(64), briefHash: 'a'.repeat(64),
    allowedContentIds: new Set(contentIR.units.map((unit) => unit.id)),
    requestedSlideCount: slides.length,
  });
}

function compiledTrack(plan, contentIR, variantId, override = {}) {
  const refs = plan.slides[1].contentRefs;
  const chart = {
    kind: 'column', categories: ['A', 'B'], categorySourceRefs: [refs[2], refs[4]],
    series: [{ name: 'Score', nameSourceRef: refs[1], values: [12, 9], sourceRefs: [refs[3], refs[5]] }],
    unit: null, title: 'Scores', provenanceRefs: refs,
  };
  const slide = {
    id: `compiled_${variantId}`, sourceDeckPlanSlideId: plan.slides[1].id, intent: 'data', layoutId: 'layout_data',
    layoutSourcePart: 'ppt/slideLayouts/slideLayout1.xml', variantId, title: plan.slides[1].takeaway, body: [],
    visualization: { type: 'chart', sourceRefs: refs, status: 'referenced', tableData: null, tableCellRefs: null,
      chartData: { ...chart, ...override.chart }, processSteps: [], kpi: null },
    imageRefs: [], provenanceRefs: refs,
    placements: { title: { x: 0, y: 0, width: 1, height: 1, unit: 'EMU' }, body: { x: 0, y: 1, width: 1, height: 1, unit: 'EMU' }, visual: null },
    layoutCandidates: [], selectedCandidateIndex: 0,
  };
  return {
    schemaVersion: 1, id: `compiled_${variantId}`, variantId, variantPolicyVersion: 'test',
    deckPlanId: plan.id, deckPlanHash: plan.hash, contentIRHash: contentIR.hash,
    templateIRId: 'template_test', templateIRHash: 'b'.repeat(64), slides: [
      { ...slide, sourceDeckPlanSlideId: plan.slides[0].id, intent: 'title', title: plan.slides[0].takeaway, provenanceRefs: [], visualization: { ...slide.visualization, type: 'none', status: 'none', sourceRefs: [], chartData: null } },
      slide,
      { ...slide, id: `compiled_${variantId}_last`, sourceDeckPlanSlideId: plan.slides[2].id, intent: 'summary', title: plan.slides[2].takeaway, provenanceRefs: [], visualization: { ...slide.visualization, type: 'none', status: 'none', sourceRefs: [], chartData: null } },
    ],
  };
}

test('deck review detects repeated source claims, repeated refs, misplaced cover/closing, and repetitive track composition', () => {
  const contentIR = makeContentIR([['Metric', 'A'], ['Sample score', '12']]);
  const [header, category, seriesName, value] = contentIR.units;
  const plan = makePlan(contentIR, [
    { narrativeRole: 'content', purpose: 'Open the story.', takeaway: 'A measured improvement is visible.', contentRefs: [header.id], semanticVisualType: 'none', targetDensity: 'balanced' },
    { narrativeRole: 'content', purpose: 'Show the evidence.', takeaway: 'The sample score is 12.', contentRefs: [header.id, category.id, seriesName.id, value.id], semanticVisualType: 'chart', targetDensity: 'balanced' },
    { narrativeRole: 'content', purpose: 'Repeat the evidence.', takeaway: 'The sample score is 12.', contentRefs: [header.id, category.id, seriesName.id, value.id], semanticVisualType: 'chart', targetDensity: 'balanced' },
    { narrativeRole: 'closing', purpose: 'Close early.', takeaway: 'Close before the last slide.', contentRefs: [], semanticVisualType: 'none', targetDensity: 'balanced' },
    { narrativeRole: 'content', purpose: 'Late content.', takeaway: 'A final supporting note.', contentRefs: [header.id], semanticVisualType: 'none', targetDensity: 'balanced' },
  ]);
  const repeated = plan.slides.map((slide) => ({ slideId: slide.id, signature: 'same-layout', archetype: 'content' }));
  const report = reviewDeckLevel({ deckPlan: plan, contentIR, compositionsByVariant: { A: repeated, B: repeated, C: repeated } });
  const rules = new Set(report.findings.map((finding) => finding.ruleId));
  assert.equal(report.status, 'error');
  assert.ok(rules.has('deck.cover-role-missing'));
  assert.ok(rules.has('deck.repeated-title'));
  assert.ok(rules.has('deck.repeated-content-ref'));
  assert.ok(rules.has('deck.repeated-message'));
  assert.ok(rules.has('deck.closing-in-middle'));
  assert.ok(rules.has('deck.track-single-composition'));
  assert.ok(rules.has('deck.three-adjacent-same-archetype'));
});

test('A/B/C deck review follows chart values and labels back to the exact ContentIR cells and checks factual equivalence', () => {
  const contentIR = makeContentIR([['Period', 'Score'], ['A', '12'], ['B', '9']]);
  const refs = contentIR.units.map((unit) => unit.id);
  const plan = makePlan(contentIR, [
    { narrativeRole: 'opening', purpose: 'Open.', takeaway: 'A synthetic review begins.', contentRefs: [], semanticVisualType: 'none', targetDensity: 'balanced' },
    { narrativeRole: 'content', purpose: 'Show supplied metrics.', takeaway: 'Synthetic scores vary by group.', contentRefs: refs, semanticVisualType: 'chart', targetDensity: 'balanced' },
    { narrativeRole: 'closing', purpose: 'Close.', takeaway: 'The sample ends with its source data.', contentRefs: [], semanticVisualType: 'none', targetDensity: 'balanced' },
  ]);
  const compositions = Object.fromEntries(['A', 'B', 'C'].map((variant) => [variant,
    plan.slides.map((slide, index) => ({ slideId: slide.id, signature: `${variant}-${index}`, archetype: index === 1 ? 'chart' : 'content' }))]));
  const report = reviewDeckLevel({ deckPlan: plan, contentIR,
    compiledTracks: ['A', 'B', 'C'].map((variant) => compiledTrack(plan, contentIR, variant)),
    compositionsByVariant: compositions,
  });
  assert.equal(report.trackFacts, 'passed');
  assert.equal(report.provenance, 'passed');
  assert.equal(report.status, 'pass');
  assert.ok(!report.findings.some((finding) => finding.severity === 'error'));

  const badTrack = compiledTrack(plan, contentIR, 'C', { chart: { series: [{
    name: 'Score', nameSourceRef: refs[1], values: [120, 9], sourceRefs: [refs[3], refs[5]],
  }] } });
  const invalid = reviewDeckLevel({ deckPlan: plan, contentIR,
    compiledTracks: [compiledTrack(plan, contentIR, 'A'), compiledTrack(plan, contentIR, 'B'), badTrack],
  });
  assert.equal(invalid.trackFacts, 'failed');
  assert.equal(invalid.provenance, 'failed');
  assert.ok(invalid.findings.some((finding) => finding.ruleId === 'deck.track-factual-divergence'));
  assert.ok(invalid.findings.some((finding) => finding.ruleId === 'deck.provenance-chart-value-mismatch'));

  const tableTrack = compiledTrack(plan, contentIR, 'A');
  const tableSlide = tableTrack.slides[1];
  tableSlide.visualization = {
    ...tableSlide.visualization,
    type: 'table',
    tableData: [['Period', 'Score'], ['A', '12'], ['B', '9']],
    tableCellRefs: [[refs[0], refs[1]], [refs[2], refs[3]], [refs[4], refs[5]]],
    chartData: null,
  };
  tableSlide.visualization.tableData[1][1] = '120';
  const invalidTable = reviewDeckLevel({ deckPlan: plan, contentIR, compiledTracks: [tableTrack] });
  assert.equal(invalidTable.provenance, 'failed');
  assert.ok(invalidTable.findings.some((finding) => finding.ruleId === 'deck.provenance-table-value-mismatch'));
});
