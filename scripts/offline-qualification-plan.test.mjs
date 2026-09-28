import assert from 'node:assert/strict';
import test from 'node:test';
import { deterministicPlanningResponse } from './lib/fake-openai-compatible-endpoint.mjs';
import { buildOfflineQualificationPlan, offlineQualificationResponse } from './lib/offline-qualification-plan.mjs';

test('offline long-deck fixture has a coherent qualitative story without invented measurements', () => {
  const plan = buildOfflineQualificationPlan(12);
  assert.equal(plan.slides.length, 12);
  assert.equal(plan.slides[0].narrativeRole, 'opening');
  assert.equal(plan.slides.at(-1).narrativeRole, 'closing');
  assert.equal(new Set(plan.slides.map((slide) => slide.takeaway)).size, 12);
  assert.equal(plan.slides[5].semanticVisualType, 'process');
  assert.equal(plan.slides[6].semanticVisualType, 'comparison');
  assert.ok(plan.slides.every((slide) => slide.contentRefs.length === 0
    && slide.bodyPoints.length >= 2 && slide.bodyPoints.length <= 3
    && slide.bodyPoints.every((point) => point.origin === 'generated-from-brief' && point.evidenceRefs.length === 0)));
  assert.ok(plan.slides.every((slide) => slide.bodyPoints.every((point) => {
    assert.match(point.text, /^[А-ЯЁ]/u);
    assert.match(point.text, /[.!?]$/u);
    assert.doesNotMatch(point.text, /\b[А-ЯЁа-яё]+(?:ть|чь|ти)\b/iu,
      'generated slide copy should read as presentation content, not author instructions');
    return true;
  })));
  assert.ok(!JSON.stringify(plan).match(/\b\d+(?:[.,]\d+)?\s*(?:%|руб|₽|млн|тыс|дней|лет)\b/iu));
});

test('offline qualification fixture selects an opening, process, and closing for a three-slide matrix', () => {
  const plan = buildOfflineQualificationPlan(3);
  assert.equal(plan.slides.length, 3);
  assert.deepEqual(plan.slides.map((slide) => slide.narrativeRole), ['opening', 'content', 'closing']);
  assert.deepEqual(plan.slides.map((slide) => slide.semanticVisualType), ['none', 'process', 'none']);
});

test('fake endpoint override is limited to the qualification Worker schema', () => {
  const request = { model: 'offline-test', response_format: { json_schema: { name: 'deck_plan_draft_v4' } },
    messages: [{ role: 'user', content: JSON.stringify({ requestedSlideCount: 3 }) }] };
  const response = offlineQualificationResponse(request);
  assert.equal(JSON.parse(response.choices[0].message.content).slides.length, 3);
  assert.equal(offlineQualificationResponse({ ...request, response_format: { json_schema: { name: 'supervisor_plan_review_v1' } } }), null);
});

test('generic fake Worker copy is declarative presentation text rather than prompt instructions', () => {
  const request = { model: 'offline-test', response_format: { json_schema: { name: 'deck_plan_draft_v4' } },
    messages: [{ role: 'user', content: JSON.stringify({ requestedSlideCount: 3, contentIR: { sources: [], units: [] } }) }] };
  const response = deterministicPlanningResponse(request);
  const plan = JSON.parse(response.choices[0].message.content);
  assert.ok(plan.slides.every((slide) => /^[А-ЯЁ].+[.!?]?$/u.test(slide.takeaway)
    && !/(?:\s|^)(?:и|или|но|а)$/iu.test(slide.takeaway)), 'fake takeaways must be complete phrases rather than truncated section labels');
  assert.ok(plan.slides.every((slide) => !slide.bodyPoints.some((point) => point.text.includes(slide.takeaway))),
    'fake body copy must develop the takeaway instead of restating it mechanically');
  assert.ok(plan.slides.every((slide) => slide.bodyPoints.every((point) => {
    assert.match(point.text, /^[А-ЯЁ]/u);
    assert.match(point.text, /[.!?]$/u);
    assert.doesNotMatch(point.text, /\b[А-ЯЁа-яё]+(?:ть|чь|ти)\b/iu);
    return true;
  })));
});
