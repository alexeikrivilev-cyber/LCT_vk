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

test('local fake returns bounded generated copy alongside source-backed planning refs', () => {
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

  const worker = deterministicPlanningResponse(request('deck_plan_draft_v4', evidence));
  const draft = JSON.parse(worker.choices[0].message.content);
  assert.equal(draft.slides.length, 3);
  assert.deepEqual(draft.slides.map((slide) => slide.narrativeRole), ['opening', 'content', 'closing']);
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  for (const slide of draft.slides) {
    assert.ok(slide.contentRefs.length > 0);
    assert.ok(slide.contentRefs.every((id) => ['text', 'heading'].includes(unitsById.get(id)?.kind)));
    assert.ok(slide.contentRefs.some((id) => unitsById.get(id)?.kind === 'heading'));
    assert.ok(slide.contentRefs.some((id) => unitsById.get(id)?.text.trim().length > 20));
    assert.ok(slide.takeaway.length > 0);
    assert.ok(slide.bodyPoints.length >= 1 && slide.bodyPoints.length <= 4);
    assert.ok(slide.bodyPoints.every((point) => point.origin === 'generated-from-brief'
      && point.text.length <= 180 && Array.isArray(point.evidenceRefs)));
  }
  assert.deepEqual(draft.slides.map((slide) => slide.takeaway), ['Presentation compiler', 'Solution', 'Output']);

  const supervisor = deterministicPlanningResponse(request('supervisor_plan_review_v1', { checkpointVersion: 7 }));
  const review = JSON.parse(supervisor.choices[0].message.content);
  assert.deepEqual(review, { checkpointVersion: 7, outcome: 'pass', findings: [], operations: [] });
});

test('local fake keeps task/context instructions out of references and uses only uploaded-source units', () => {
  const units = [
    { id: 'task', sourceId: 'task-source', kind: 'text', text: 'Prepare a short deck about reliable automation.' },
    { id: 'context-heading-1', sourceId: 'context-source', kind: 'heading', text: '## Verification' },
    { id: 'context-1', sourceId: 'context-source', kind: 'text', text: 'Reliability requires checking results before handoff. The check remains visible to the next owner.' },
    { id: 'context-heading-2', sourceId: 'context-source', kind: 'heading', text: '## Rules' },
    { id: 'context-2', sourceId: 'context-source', kind: 'text', text: 'Explicit constraints make each stage inspectable. Reviewers can check each decision.' },
    { id: 'context-heading-3', sourceId: 'context-source', kind: 'heading', text: '## Reproducibility' },
    { id: 'context-3', sourceId: 'context-source', kind: 'text', text: 'Reproducibility supports later verification. The same inputs produce a checkable result.' },
  ];
  const response = deterministicPlanningResponse(request('deck_plan_draft_v4', {
    brief: { purpose: 'Present reliable automation.' },
    requestedSlideCount: 3,
    contentIR: { sources: [{ id: 'task-source', kind: 'brief-task' }, { id: 'context-source', kind: 'brief-context' }, { id: 'source', kind: 'text' }], units: [
      ...units.filter((unit) => unit.sourceId === 'context-source').map((unit) => ({ ...unit, sourceId: 'source' })),
      ...units.filter((unit) => unit.sourceId === 'task-source'),
    ] },
  }));
  const draft = JSON.parse(response.choices[0].message.content);
  assert.equal(new Set(draft.slides.map((slide) => slide.takeaway)).size, 3);
  assert.equal(new Set(draft.slides.map((slide) => slide.contentRefs.join('|'))).size, 3);
  assert.deepEqual(draft.slides.map((slide) => slide.takeaway), ['Verification', 'Rules', 'Reproducibility']);
  assert.ok(draft.slides.every((slide) => slide.contentRefs.length === 2
    && slide.contentRefs.every((id) => units.some((unit) => unit.id === id))
    && !slide.contentRefs.includes('task')
    && slide.bodyPoints.every((point) => point.origin === 'generated-from-brief')));
});

test('local fake task-only planning generates copy without exporting task wording or citing it', () => {
  const response = deterministicPlanningResponse(request('deck_plan_draft_v4', {
    brief: { purpose: 'Prepare a short deck about reliable automation.' },
    requestedSlideCount: 1,
    contentIR: { sources: [{ id: 'task-source', kind: 'brief-task' }], units: [
      { id: 'task', sourceId: 'task-source', kind: 'text', text: 'Prepare a short deck about reliable automation.' },
    ] },
  }));
  const draft = JSON.parse(response.choices[0].message.content);
  assert.equal(draft.slides.length, 1);
  assert.deepEqual(draft.slides[0].contentRefs, []);
  assert.equal(draft.slides[0].takeaway, 'Главная мысль и контекст');
  assert.equal(draft.slides[0].bodyPoints[0].origin, 'generated-from-brief');
  assert.ok(!JSON.stringify(draft.slides[0]).includes('Prepare a short deck about reliable automation.'));
});

test('local fake keeps new planning titles within the v4 limit without cutting a word', () => {
  const response = deterministicPlanningResponse(request('deck_plan_draft_v4', {
    requestedSlideCount: 1,
    contentIR: { sources: [{ id: 'source', kind: 'text' }], units: [
      { id: 'long-heading', sourceId: 'source', kind: 'heading', text: '# This is a deliberately long product title where last word should not be truncated' },
      { id: 'supporting-text', sourceId: 'source', kind: 'text', text: 'A real section has body content under its heading.' },
    ] },
  }));
  const draft = JSON.parse(response.choices[0].message.content);
  assert.equal(draft.slides[0].takeaway, 'This is a deliberately long product');
  assert.ok(draft.slides[0].takeaway.length <= 40);
});

test('local fake preserves distinct task-only steps as one grounded source', () => {
  const task = 'Подготовить краткий план запуска презентации.\nПроверить готовность исходных материалов.\nСогласовать следующий проверяемый шаг команды.';
  const response = deterministicPlanningResponse(request('deck_plan_draft_v4', {
    brief: { purpose: task },
    requestedSlideCount: 3,
    contentIR: { sources: [{ id: 'task-source', kind: 'brief-task' }], units: [
      { id: 'task', sourceId: 'task-source', kind: 'text', text: task },
    ] },
  }));
  const draft = JSON.parse(response.choices[0].message.content);
  assert.deepEqual(draft.slides.map((slide) => slide.contentRefs), [[], [], []]);
  assert.ok(draft.slides.every((slide) => slide.bodyPoints.length >= 3 && slide.bodyPoints.length <= 4
    && slide.bodyPoints.every((point) => point.origin === 'generated-from-brief'
      && !point.text.includes('Проверить готовность исходных материалов'))));
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
