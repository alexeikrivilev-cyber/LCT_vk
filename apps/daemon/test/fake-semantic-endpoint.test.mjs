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
