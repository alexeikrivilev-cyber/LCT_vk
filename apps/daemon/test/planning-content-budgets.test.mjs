import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'tsx/esm/api';

register();
const { deriveTextRegionBudget, validateDraftAgainstContentBudgets } = await import('../src/presentation/application/planning-content-budgets.ts');

const metrics = (overrides = {}) => ({
  widthEmu: 6 * 914400,
  heightEmu: 2.5 * 914400,
  fontFamily: 'Test Sans',
  fontSizePt: 16,
  bold: false,
  italic: false,
  marginsEmu: { left: 0, right: 0, top: 0, bottom: 0 },
  paragraphProperties: [{ marL: 0, marR: 0, indent: 0, lineSpacing: null, spcBefPts: 0, spcAftPts: 0, bullet: 'none' }],
  ...overrides,
});

const measuredFont = (text, spec) => ({ widthPx: Array.from(text).length * spec.sizePx * 0.48, ascentPx: spec.sizePx * 0.8, descentPx: spec.sizePx * 0.2, lineGapPx: 0, approximate: false });

test('fit budget gets more conservative with effective margins, paragraph spacing, indentation and larger typography', () => {
  const base = deriveTextRegionBudget(metrics(), 'body', measuredFont);
  const constrained = deriveTextRegionBudget(metrics({
    fontSizePt: 24,
    marginsEmu: { left: 914400, right: 914400, top: 91440, bottom: 91440 },
    paragraphProperties: [{ marL: 457200, marR: 228600, indent: 152400, lineSpacing: { kind: 'pct', value: 1.2 }, spcBefPts: 8, spcAftPts: 10, bullet: 'char' }],
  }), 'body', measuredFont);
  assert.ok(base);
  assert.ok(constrained);
  assert.ok(constrained.maxCharacters < base.maxCharacters);
  assert.ok(constrained.maxCharactersPerLine < base.maxCharactersPerLine);
});

test('title budgets respect measured geometry while keeping the DeckPlan hard title ceiling', () => {
  const budget = deriveTextRegionBudget(metrics({ widthEmu: 2 * 914400, heightEmu: 0.7 * 914400, fontSizePt: 28 }), 'title', measuredFont);
  assert.ok(budget);
  assert.ok(budget.maxCharacters <= 40);
  assert.ok(budget.maxLines >= 1);
});

test('approximate font metrics receive a larger reserve than measured font metrics', () => {
  const approximateFont = (text, spec) => ({ ...measuredFont(text, spec), approximate: true });
  const measured = deriveTextRegionBudget(metrics(), 'body', measuredFont);
  const approximate = deriveTextRegionBudget(metrics(), 'body', approximateFont);
  assert.ok(measured);
  assert.ok(approximate);
  assert.ok(approximate.maxCharacters <= measured.maxCharacters);
});

test('runtime accepts copy only when one role-compatible candidate family can fit every region', () => {
  const budgets = {
    version: 'fit-aware-copy-budget.v1',
    profileSha256: 'a'.repeat(64),
    candidateFamilies: [{
      familyKey: 'family-1', archetype: 'content', supportedContentModes: ['text'],
      titleRegion: { maxCharacters: 24, maxLines: 1, maxCharactersPerLine: 24 },
      bodyRegions: [{ maxCharacters: 44, maxLines: 2, maxCharactersPerLine: 22 }],
      body: { maxCharacters: 44, maxPoints: 2, maxCharactersPerPoint: 22 },
    }],
    slides: [{ order: 1, candidateFamilyKeys: ['family-1'] }],
  };
  const slide = { narrativeRole: 'content', takeaway: 'Доказуемый вывод', bodyPoints: [
    { text: 'Краткий аргумент', origin: 'generated-from-brief', evidenceRefs: [] },
  ], semanticVisualType: 'none' };
  assert.doesNotThrow(() => validateDraftAgainstContentBudgets([slide], budgets));
  assert.throws(() => validateDraftAgainstContentBudgets([{ ...slide, takeaway: 'Заголовок превышает безопасную вместимость области' }], budgets), /PLANNED_COPY_EXCEEDS_TEMPLATE_BUDGET/u);
  assert.throws(() => validateDraftAgainstContentBudgets([{ ...slide, bodyPoints: [
    { text: 'Первый длинный аргумент для этой области', origin: 'generated-from-brief', evidenceRefs: [] },
    { text: 'Второй длинный аргумент для этой области', origin: 'generated-from-brief', evidenceRefs: [] },
  ] }], budgets), /PLANNED_COPY_EXCEEDS_TEMPLATE_BUDGET/u);
});

test('a visual-led text family can budget a concise closing slide without weakening runtime fit checks', () => {
  const budgets = {
    version: 'fit-aware-copy-budget.v1', profileSha256: 'c'.repeat(64),
    candidateFamilies: [{
      familyKey: 'visual-closing', archetype: 'visual-led', supportedContentModes: ['text'],
      titleRegion: { maxCharacters: 18, maxLines: 1, maxCharactersPerLine: 18 },
      bodyRegions: [{ maxCharacters: 32, maxLines: 2, maxCharactersPerLine: 16 }],
      body: { maxCharacters: 32, maxPoints: 1, maxCharactersPerPoint: 32 },
    }],
    slides: [{ order: 1, candidateFamilyKeys: ['visual-closing'] }],
  };
  const closing = { narrativeRole: 'closing', takeaway: 'Следующий шаг', semanticVisualType: 'none', bodyPoints: [
    { text: 'Шаг переводит план в работу.', origin: 'generated-from-brief', evidenceRefs: [] },
  ] };
  assert.doesNotThrow(() => validateDraftAgainstContentBudgets([closing], budgets));
  assert.throws(() => validateDraftAgainstContentBudgets([{ ...closing, takeaway: 'Заголовок намного длиннее вместимости' }], budgets), /PLANNED_COPY_EXCEEDS_TEMPLATE_BUDGET/u);
});
