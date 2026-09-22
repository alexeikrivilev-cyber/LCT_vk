// @vitest-environment jsdom
import { homeTemplateTrigger } from '../helpers/home-template-picker';
//
// Scenario-card rail coverage.
//   - The default create rail renders illustrated scenario cards carrying a
//     title AND a one-line description.
//   - The distilled rail exposes the slide deck and retained image path.
//   - Legacy prototype scenarios remain covered by compatibility code, not by
//     the new-product Home entry point.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const placeholderCarouselMock = vi.hoisted(() => ({
  reportScenario: false,
  reportedScenarioId: null as string | null,
}));

vi.mock('../../src/components/home-hero/PlaceholderCarousel', () => ({
  PlaceholderCarousel: ({
    scenarios,
    active,
    onScenarioChange,
  }: {
    scenarios: Array<{ id: string; chipId?: string | null; text: string }>;
    active: boolean;
    onScenarioChange: (scenario: { id: string; chipId?: string | null; text: string }) => void;
  }) => {
    const scenario = scenarios[0];
    if (
      placeholderCarouselMock.reportScenario &&
      active &&
      scenario &&
      placeholderCarouselMock.reportedScenarioId !== scenario.id
    ) {
      placeholderCarouselMock.reportedScenarioId = scenario.id;
      queueMicrotask(() => onScenarioChange(scenario));
    }
    return null;
  },
}));

import { HomeHero } from '../../src/components/HomeHero';
import { findChip, orderedCreateChips } from '../../src/components/home-hero/chips';

afterEach(() => {
  placeholderCarouselMock.reportScenario = false;
  placeholderCarouselMock.reportedScenarioId = null;
  cleanup();
});

function renderHero(overrides: Partial<React.ComponentProps<typeof HomeHero>> = {}) {
  const props = {
    prompt: '',
    onPromptChange: () => undefined,
    onSubmit: () => undefined,
    activePluginTitle: null,
    activeChipId: null,
    onClearActivePlugin: () => undefined,
    pluginOptions: [],
    pluginsLoading: false,
    pendingPluginId: null,
    pendingChipId: null,
    onPickPlugin: () => undefined,
    onPickChip: () => undefined,
    contextItemCount: 0,
    error: null,
    ...overrides,
  } as React.ComponentProps<typeof HomeHero>;
  render(<HomeHero {...props} />);
}

// #5517 removed the illustrated scenario-card rail from Home; scenarios are
// picked from the composer footer's radial template picker instead.
// Types are a horizontal pill row under the working-directory row (product,
// 2026-08-21); anything that does not fit folds into its 全部 popover.
function typePill(chipId: string): HTMLElement | null {
  if (!screen.queryByTestId('home-hero-template-menu')) fireEvent.click(homeTemplateTrigger());
  return screen.getByTestId('home-hero-template-menu').querySelector(`[data-chip="${chipId}"]`);
}

describe('HomeHero scenario cards', () => {
  it('labels each create scenario in the composer template picker', () => {
    renderHero();
    expect(typePill('deck')?.textContent).toContain('Slide deck');
    expect(typePill('image')?.textContent).toContain('Image');
  });

  it('uses the distilled Home creation hierarchy in product order', () => {
    const ordered = orderedCreateChips();
    const ids = ordered.map((chip) => chip.id);
    expect(ids).toEqual(['deck', 'image']);
    expect(ids).not.toContain('wireframe');
    expect(ids).not.toContain('mobile');
  });

  it('does not expose legacy prototype scenarios in the distilled picker', () => {
    renderHero();
    expect(typePill('wireframe')).toBeNull();
    expect(typePill('mobile')).toBeNull();
    expect(typePill('prototype')).toBeNull();
    expect(typePill('document')).toBeNull();
    expect(findChip('wireframe')).toBeUndefined();
    expect(findChip('mobile')).toBeUndefined();
    expect(findChip('prototype')).toBeUndefined();
    expect(findChip('document')).toBeUndefined();
  });

  it('keeps empty carousel scenario submit disabled while plugins are loading', async () => {
    placeholderCarouselMock.reportScenario = true;
    const onSubmit = vi.fn();
    const onSubmitScenario = vi.fn();
    renderHero({
      pluginsLoading: true,
      onSubmit,
      onSubmitScenario,
    });

    await waitFor(() => expect(placeholderCarouselMock.reportedScenarioId).not.toBeNull());
    const submit = screen.getByTestId('home-hero-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onSubmitScenario).not.toHaveBeenCalled();
  });

  it('uses the selected deck to scope empty-composer carousel suggestions', async () => {
    placeholderCarouselMock.reportScenario = true;
    renderHero({
      activeChipId: 'deck',
    });

    await waitFor(() => {
      expect(placeholderCarouselMock.reportedScenarioId).toBe('notes-to-deck');
    });
  });
});
