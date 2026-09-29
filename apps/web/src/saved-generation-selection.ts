export type SavedVariantId = 'A' | 'B' | 'C';

type SavedVariantState = { status: string; previewUrl: string | null };
type SavedSlidePack = {
  slideId: string;
  selectedVariant: SavedVariantId;
  status: string;
  variants: Record<SavedVariantId, SavedVariantState>;
};

export type SavedGenerationState = {
  generationId: string;
  status: string;
  readySlides: number;
  totalSlides: number;
  currentSlideId: string | null;
  defaultTrack: SavedVariantId;
  slides: SavedSlidePack[];
};

export function hasCompleteSavedVariants(state: SavedGenerationState | null): boolean {
  return Boolean(state && ['completed', 'stale'].includes(state.status) && state.slides.length > 0
    && state.readySlides === state.totalSlides
    && state.slides.every((slide) => ['A', 'B', 'C'].every((variant) => {
      const item = slide.variants[variant as SavedVariantId];
      return slide.status === 'ready' && item?.status === 'ready' && Boolean(item.previewUrl);
    })));
}

export function selectSavedSlideVariant<T extends SavedGenerationState>(
  state: T,
  slideId: string,
  variant: SavedVariantId,
): T {
  return {
    ...state,
    currentSlideId: slideId,
    slides: state.slides.map((slide) => slide.slideId === slideId ? { ...slide, selectedVariant: variant } : slide),
  };
}

export function selectSavedDeckVariant<T extends SavedGenerationState>(state: T, variant: SavedVariantId): T {
  return {
    ...state,
    defaultTrack: variant,
    slides: state.slides.map((slide) => ({ ...slide, selectedVariant: variant })),
  };
}
