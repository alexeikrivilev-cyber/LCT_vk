import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasCompleteSavedVariants,
  selectSavedDeckVariant,
  selectSavedSlideVariant,
} from '../src/saved-generation-selection.ts';

function generation() {
  const variants = Object.fromEntries(['A', 'B', 'C'].map((variant) => [variant, { status: 'ready', previewUrl: `/preview/${variant}.png` }]));
  return {
    generationId: 'saved-generation', status: 'completed', readySlides: 2, totalSlides: 2,
    currentSlideId: 'slide-1', defaultTrack: 'A',
    slides: ['slide-1', 'slide-2'].map((slideId) => ({ slideId, status: 'ready', selectedVariant: 'A', variants: { ...variants } })),
    exports: [{ id: 'existing-pptx', mode: 'B', format: 'pptx', downloadUrl: '/existing.pptx' }],
  };
}

test('complete saved A/B/C result remains browseable when its inputs are stale', () => {
  const stale = generation();
  stale.status = 'stale';
  assert.equal(hasCompleteSavedVariants(stale), true);
  const incomplete = { ...stale, slides: stale.slides.map((slide) => ({ ...slide, variants: { ...slide.variants } })) };
  incomplete.slides[1].variants.C.previewUrl = null;
  assert.equal(hasCompleteSavedVariants(incomplete), false);
});

test('selecting a stale slide variant changes only the local saved-result state', () => {
  const existing = generation();
  const selected = selectSavedSlideVariant(existing, 'slide-2', 'C');

  assert.equal(selected.generationId, existing.generationId);
  assert.equal(selected.slides[0].selectedVariant, 'A');
  assert.equal(selected.slides[1].selectedVariant, 'C');
  assert.equal(selected.currentSlideId, 'slide-2');
  assert.deepEqual(selected.exports, existing.exports);
  assert.equal(existing.slides[1].selectedVariant, 'A');
});

test('selecting a stale deck track changes saved previews without changing artifacts', () => {
  const existing = generation();
  const selected = selectSavedDeckVariant(existing, 'B');

  assert.equal(selected.defaultTrack, 'B');
  assert.deepEqual(selected.slides.map((slide) => slide.selectedVariant), ['B', 'B']);
  assert.deepEqual(selected.exports, existing.exports);
  assert.deepEqual(existing.slides.map((slide) => slide.selectedVariant), ['A', 'A']);
});
