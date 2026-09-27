import assert from 'node:assert/strict';
import test from 'node:test';

import { briefHash, validateBrief } from '../src/presentation/domain/brief.ts';
import {
  canonicalizeDeckPlan,
  deckPlanHash,
  validateDeckPlan,
  validateDeckPlanDraft,
} from '../src/presentation/domain/deck-plan.ts';

const allowedContentIds = new Set(['unit:revenue', 'unit:retention', 'unit:outlook']);
const metadata = {
  id: 'deck_123',
  version: 1,
  createdAt: '2026-09-23T12:00:00.000Z',
  inputFingerprint: 'f'.repeat(64),
  briefHash: 'a'.repeat(64),
  allowedContentIds,
  requestedSlideCount: 3,
};

function validBrief(overrides = {}) {
  return {
    audience: '  Executive team  ',
    purpose: 'Decision support',
    expectedOutcome: 'Align on growth investment',
    preferences: [' concise ', 'Use sourced figures'],
    ...overrides,
  };
}

function validDraft() {
  return {
    workingTitle: '  Growth is accelerating, with retention as the constraint  ',
    narrativeSummary: 'Revenue growth creates an opportunity; retention determines whether it is durable.',
    slides: [
      {
        narrativeRole: 'opening', purpose: 'Set up the decision.', takeaway: 'Growth creates a timely decision.',
        contentRefs: [], semanticVisualType: 'none', targetDensity: 'compact',
      },
      {
        narrativeRole: 'content', purpose: 'Show current revenue trend.', takeaway: 'Revenue grew 18% year over year.',
        contentRefs: ['unit:revenue'], semanticVisualType: 'chart', targetDensity: 'balanced',
      },
      {
        narrativeRole: 'closing', purpose: 'State the decision.', takeaway: 'Invest in retention before accelerating acquisition.',
        contentRefs: [], semanticVisualType: 'none', targetDensity: 'compact',
      },
    ],
  };
}

test('Brief v1 normalizes bounded required text and hashes the canonical value', () => {
  const brief = validateBrief(validBrief({ requestedSlideCount: 3 }));
  assert.deepEqual(brief, {
    audience: 'Executive team',
    purpose: 'Decision support',
    expectedOutcome: 'Align on growth investment',
    preferences: ['concise', 'Use sourced figures'],
    requestedSlideCount: 3,
  });
  assert.equal(briefHash(brief), briefHash({
    preferences: ['concise', 'Use sourced figures'],
    expectedOutcome: 'Align on growth investment',
    purpose: 'Decision support',
    audience: 'Executive team',
    requestedSlideCount: 3,
  }));
  assert.match(briefHash(brief), /^[a-f0-9]{64}$/);
  assert.throws(() => validateBrief(validBrief({ private: true })), /Brief v1 fields/);
  assert.throws(() => validateBrief(validBrief({ audience: '  ' })), /optional bounded text/);
  assert.throws(() => validateBrief(validBrief({ requestedSlideCount: 31 })), /1 through 30/);
  assert.throws(() => validateBrief(validBrief({ preferences: Array(13).fill('x') })), /at most 12/);
  assert.throws(() => validateBrief(validBrief({ preferences: ['x'.repeat(201)] })), /at most 12/);
});

test('task-only Brief accepts an optional context without requiring audience, outcome, or source files', () => {
  const brief = validateBrief({ purpose: 'Explain the requested workflow', preferences: [], context: 'Use only these stated constraints.' });
  assert.deepEqual(brief, {
    audience: '', purpose: 'Explain the requested workflow', expectedOutcome: '', preferences: [], context: 'Use only these stated constraints.',
  });
  assert.notEqual(briefHash(brief), briefHash({ purpose: 'Explain the requested workflow', preferences: [] }));
});

test('Brief validator rejects accessor properties without invoking them', () => {
  let called = false;
  const input = validBrief();
  Object.defineProperty(input, 'purpose', { enumerable: true, get() { called = true; return 'not safe'; } });
  assert.throws(() => validateBrief(input), /Brief v1 fields/);
  assert.equal(called, false);
});

test('model draft guard enforces exact keys, slide limits, unique resolved refs, and factual content refs', () => {
  const parsed = validateDeckPlanDraft(validDraft(), allowedContentIds, 3);
  assert.equal(parsed.workingTitle, 'Growth is accelerating, with retention as the constraint');
  assert.deepEqual(parsed.slides[0].contentRefs, []);
  assert.throws(() => validateDeckPlanDraft({ ...validDraft(), id: 'model-owned' }, allowedContentIds), /draft fields/);
  const extraSlideField = validDraft();
  extraSlideField.slides[1].order = 2;
  assert.throws(() => validateDeckPlanDraft(extraSlideField, allowedContentIds), /draft slide fields/);
  const unknownReference = validDraft();
  unknownReference.slides[1].contentRefs = ['unit:unknown'];
  assert.throws(() => validateDeckPlanDraft(unknownReference, allowedContentIds), /known content unit IDs/);
  const duplicateReference = validDraft();
  duplicateReference.slides[1].contentRefs = ['unit:revenue', 'unit:revenue'];
  assert.throws(() => validateDeckPlanDraft(duplicateReference, allowedContentIds), /unique/);
  const emptyContentSlide = validDraft();
  emptyContentSlide.slides[1].contentRefs = [];
  assert.throws(() => validateDeckPlanDraft(emptyContentSlide, allowedContentIds), /require at least one/);
  assert.throws(() => validateDeckPlanDraft(validDraft(), allowedContentIds, 2), /match requestedSlideCount/);
  const layoutField = validDraft();
  layoutField.slides[1].layoutId = 'layout-id';
  assert.throws(() => validateDeckPlanDraft(layoutField, allowedContentIds), /draft slide fields/);
});

test('new planning drafts require bounded generated copy with separate source provenance', () => {
  const draft = {
    workingTitle: 'Решение начинается с контекста',
    narrativeSummary: 'Показать контекст, подтверждённый факт и следующий шаг.',
    slides: [
      {
        narrativeRole: 'opening', purpose: 'Задать тему.', takeaway: 'Контекст задаёт решение.', contentRefs: [],
        bodyPoints: [{ text: 'Сформулировать вопрос, который предстоит решить.', origin: 'generated-from-brief', evidenceRefs: [] }],
        semanticVisualType: 'none', targetDensity: 'compact',
      },
      {
        narrativeRole: 'content', purpose: 'Показать опору для решения.', takeaway: 'Выручка выросла на 18%.', contentRefs: ['unit:revenue'],
        bodyPoints: [{ text: 'Подтверждённый рост поддерживает выбранное направление.', origin: 'generated-from-brief', evidenceRefs: ['unit:revenue'] }],
        semanticVisualType: 'chart', targetDensity: 'balanced',
      },
      {
        narrativeRole: 'closing', purpose: 'Предложить следующий шаг.', takeaway: 'Проверить решение на пилоте.', contentRefs: [],
        bodyPoints: [{ text: 'Согласовать критерий следующей проверки.', origin: 'generated-from-brief', evidenceRefs: [] }],
        semanticVisualType: 'none', targetDensity: 'compact',
      },
    ],
  };
  const parsed = validateDeckPlanDraft(draft, allowedContentIds, 3, new Set(), true);
  assert.equal(parsed.slides[1].bodyPoints?.[0]?.origin, 'generated-from-brief');
  assert.throws(() => validateDeckPlanDraft({ ...draft, slides: draft.slides.map(({ bodyPoints: _body, ...slide }) => slide) }, allowedContentIds, 3, new Set(), true), /requires generated body copy/);

  const unsupportedRefs = structuredClone(draft);
  unsupportedRefs.slides[1].bodyPoints[0].evidenceRefs = ['brief-context-unit'];
  assert.throws(() => validateDeckPlanDraft(unsupportedRefs, allowedContentIds, 3, new Set(), true), /resolve to source refs/);
  const tooLongPoint = structuredClone(draft);
  tooLongPoint.slides[0].bodyPoints[0].text = 'x'.repeat(181);
  assert.throws(() => validateDeckPlanDraft(tooLongPoint, allowedContentIds, 3, new Set(), true), /bounded generated-from-brief/);
  const tooManyPoints = structuredClone(draft);
  tooManyPoints.slides[0].bodyPoints = Array(5).fill(draft.slides[0].bodyPoints[0]);
  assert.throws(() => validateDeckPlanDraft(tooManyPoints, allowedContentIds, 3, new Set(), true), /from 1 through 4/);
  const overlongGeneratedTitle = structuredClone(draft);
  overlongGeneratedTitle.slides[0].takeaway = 'x'.repeat(41);
  assert.throws(() => validateDeckPlanDraft(overlongGeneratedTitle, allowedContentIds, 3, new Set(), true), /must not exceed 40 characters/);
  assert.throws(() => validateDeckPlanDraft(overlongGeneratedTitle, allowedContentIds, 3), /must not exceed 40 characters/,
    'any draft carrying generated body copy keeps the title geometry bound, including repaired drafts');

  // Previously persisted plans without generated-copy fields can be loaded and marked stale;
  // the stricter title bound applies to plans carrying generated body copy.
  const legacyDraft = structuredClone(overlongGeneratedTitle);
  legacyDraft.slides = legacyDraft.slides.map(({ bodyPoints: _body, ...slide }) => slide);
  const legacyPlan = canonicalizeDeckPlan(legacyDraft, metadata);
  assert.equal(legacyPlan.slides[0].takeaway.length, 41);
  assert.equal(validateDeckPlan(legacyPlan, allowedContentIds, 3).hash, legacyPlan.hash);
});

test('canonicalizer assigns stable slide IDs and one-based order, and strict validator verifies the hash', () => {
  const first = canonicalizeDeckPlan(validDraft(), metadata);
  const second = canonicalizeDeckPlan(validDraft(), metadata);
  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.hash, deckPlanHash({
    schemaVersion: first.schemaVersion,
    id: first.id,
    version: first.version,
    createdAt: first.createdAt,
    inputFingerprint: first.inputFingerprint,
    briefHash: first.briefHash,
    workingTitle: first.workingTitle,
    narrativeSummary: first.narrativeSummary,
    slides: first.slides,
  }));
  assert.deepEqual(first.slides.map(({ id, order }) => ({ id, order })), [
    { id: 'slide_deck_123_1', order: 1 },
    { id: 'slide_deck_123_2', order: 2 },
    { id: 'slide_deck_123_3', order: 3 },
  ]);
  assert.deepEqual(validateDeckPlan(first, allowedContentIds, 3), first);

  const changed = structuredClone(first);
  changed.slides[1].takeaway = 'Revenue grew 19% year over year.';
  assert.throws(() => validateDeckPlan(changed, allowedContentIds, 3), /hash mismatch/);
  changed.hash = deckPlanHash({
    schemaVersion: changed.schemaVersion,
    id: changed.id,
    version: changed.version,
    createdAt: changed.createdAt,
    inputFingerprint: changed.inputFingerprint,
    briefHash: changed.briefHash,
    workingTitle: changed.workingTitle,
    narrativeSummary: changed.narrativeSummary,
    slides: changed.slides,
  });
  assert.equal(validateDeckPlan(changed, allowedContentIds).slides[1].takeaway, 'Revenue grew 19% year over year.');
});

test('strict canonical validator rejects extra geometry/native fields and broken ordering or references', () => {
  const plan = canonicalizeDeckPlan(validDraft(), metadata);
  const withGeometry = structuredClone(plan);
  withGeometry.slides[1].geometry = { x: 0, y: 0, width: 100, height: 100 };
  assert.throws(() => validateDeckPlan(withGeometry, allowedContentIds), /hash payload slide fields/);
  const wrongOrder = structuredClone(plan);
  wrongOrder.slides[0].order = 0;
  assert.throws(() => validateDeckPlan(wrongOrder, allowedContentIds), /hash payload slide/);
  const duplicateSlideId = structuredClone(plan);
  duplicateSlideId.slides[1].id = duplicateSlideId.slides[0].id;
  assert.throws(() => validateDeckPlan(duplicateSlideId, allowedContentIds), /slide IDs must be non-empty and unique/);
  const missingRef = structuredClone(plan);
  missingRef.slides[1].contentRefs = ['unit:missing'];
  missingRef.hash = deckPlanHash({
    schemaVersion: missingRef.schemaVersion,
    id: missingRef.id,
    version: missingRef.version,
    createdAt: missingRef.createdAt,
    inputFingerprint: missingRef.inputFingerprint,
    briefHash: missingRef.briefHash,
    workingTitle: missingRef.workingTitle,
    narrativeSummary: missingRef.narrativeSummary,
    slides: missingRef.slides,
  });
  assert.throws(() => validateDeckPlan(missingRef, allowedContentIds), /known content unit IDs/);
});
