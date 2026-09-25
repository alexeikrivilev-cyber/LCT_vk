import assert from 'node:assert/strict';
import test from 'node:test';
import { deterministicPlanningResponse } from '../../../scripts/lib/fake-openai-compatible-endpoint.mjs';

function request(schemaName, evidence) {
  return {
    model: 'offline-fake-planner',
    response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true } },
    messages: [{ role: 'user', content: JSON.stringify(evidence) }],
  };
}

test('local fake plans a contentful three-slide deck from source sections and passes Supervisor review', () => {
  const units = [
    { id: 'unit-product-title', kind: 'heading', text: '# Presentation compiler' },
    { id: 'unit-product-description', kind: 'text', text: 'LCT creates editable presentations from corporate PowerPoint templates.' },
    { id: 'unit-problem-title', kind: 'heading', text: '## Problem' },
    { id: 'unit-problem-detail', kind: 'text', text: 'Generic generators often ignore the design logic of the uploaded template.' },
    { id: 'unit-solution-title', kind: 'heading', text: '## Solution' },
    { id: 'unit-solution-detail', kind: 'text', text: 'LCT inspects the template and reuses its layouts and slide patterns.' },
    { id: 'unit-output-title', kind: 'heading', text: '## Output' },
    { id: 'unit-output-detail', kind: 'text', text: 'The user receives an editable PowerPoint presentation.' },
  ];
  const evidence = {
    brief: { purpose: 'Explain the presentation compiler.' },
    requestedSlideCount: 3,
    contentIR: { units },
  };

  const worker = deterministicPlanningResponse(request('deck_plan_draft_v1', evidence));
  const draft = JSON.parse(worker.choices[0].message.content);
  assert.equal(draft.slides.length, 3);
  assert.deepEqual(draft.slides.map((slide) => slide.narrativeRole), ['opening', 'content', 'closing']);
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  for (const slide of draft.slides) {
    assert.ok(slide.contentRefs.length > 0);
    assert.ok(slide.contentRefs.every((id) => unitsById.get(id)?.kind === 'text'));
    assert.ok(slide.contentRefs.some((id) => unitsById.get(id)?.text.trim().length > 20));
    assert.ok(slide.takeaway.length > 0);
  }
  assert.deepEqual(draft.slides.map((slide) => slide.takeaway), ['Presentation compiler', 'Solution', 'Output']);

  const supervisor = deterministicPlanningResponse(request('supervisor_plan_review_v1', { checkpointVersion: 7 }));
  const review = JSON.parse(supervisor.choices[0].message.content);
  assert.deepEqual(review, { checkpointVersion: 7, outcome: 'pass', findings: [], operations: [] });
});

test('local fake returns generic strict-schema template role mappings from supplied evidence', () => {
  const hash = 'a'.repeat(64);
  const evidence = {
    templateIRHash: hash,
    canvas: { width: 1000, height: 560 },
    slides: [{
      sourceSlideIndex: 17,
      elements: [
        { id: 'shape-title', kind: 'shape', text: 'Headline', order: 0, placeholderRole: null, geometry: { x: 40, y: 20, width: 900, height: 90 }, styles: { fontSizesPt: [32] } },
        { id: 'shape-left', kind: 'shape', text: 'Evidence A', order: 1, placeholderRole: null, geometry: { x: 40, y: 150, width: 420, height: 280 }, styles: { fontSizesPt: [18] } },
        { id: 'shape-right', kind: 'shape', text: 'Evidence B', order: 2, placeholderRole: null, geometry: { x: 520, y: 150, width: 420, height: 280 }, styles: { fontSizesPt: [18] } },
        { id: 'visual-icon', kind: 'picture', text: null, order: 3, placeholderRole: null, geometry: { x: 5, y: 5, width: 20, height: 20 }, styles: { fontSizesPt: [] } },
      ],
    }],
  };
  const result = deterministicPlanningResponse(request('template_semantic_profile_v1', evidence));
  const profile = JSON.parse(result.choices[0].message.content);
  assert.equal(profile.templateIRHash, hash);
  assert.equal(profile.slides[0].sourceSlideIndex, 17);
  assert.equal(profile.slides[0].titleElementId, 'shape-title');
  assert.deepEqual(profile.slides[0].bodyElementIds, ['shape-left', 'shape-right']);
  assert.deepEqual(profile.slides[0].visualElementIds, ['visual-icon']);
  assert.equal(profile.slides[0].archetype, 'content-split');
  assert.ok(profile.slides[0].confidence >= 0.6);
});
