// @vitest-environment jsdom
import { homeTemplateTrigger } from '../helpers/home-template-picker';
//
// Stage B of plugin-driven-flow-plan — Home intent tabs / shortcuts.
// Covers:
//   - Every chip in the catalog renders with its test id.
//   - Clicking a chip forwards the full chip descriptor to onPickChip
//     so the dispatcher in HomeView can route to the right flow.
//   - The active + pending UI states light up the right chip and
//     disable all chips while a plugin is mid-apply.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPluginRecord } from '@lct/contracts';
import { automaticStrategyTaskProfileForRouteId } from '@lct/contracts';

vi.mock('../../src/components/home-hero/PlaceholderCarousel', () => ({
  PlaceholderCarousel: () => null,
}));

import { HomeHero, homeHeroExamplePluginsForChip } from '../../src/components/HomeHero';
import {
  HOME_HERO_CHIPS,
  findChip,
  orderedCreateChips,
} from '../../src/components/home-hero/chips';

afterEach(() => {
  cleanup();
});

function makePlugin(
  id: string,
  mode: string,
  title = id,
  extraTags: string[] = [],
  options: { query?: string | null } = {},
): InstalledPluginRecord {
  return {
    id,
    title,
    version: '1.0.0',
    sourceKind: 'bundled',
    source: '/tmp',
    trust: 'bundled',
    capabilitiesGranted: ['prompt:inject'],
    manifest: {
      name: id,
      version: '1.0.0',
      title,
      description: 'Plugin preset fixture',
      tags: [mode, ...extraTags],
      od: {
        mode,
        useCase: {
          ...(options.query !== null
            ? { query: options.query ?? `Create with {{topic}} using ${title}` }
            : {}),
        },
        inputs: [
          {
            name: 'topic',
            label: 'Topic',
            type: 'text',
            default: 'a focused brief',
          },
        ],
        preview: { type: 'image', poster: '/preview.png' },
      },
    },
    fsPath: '/tmp',
    installedAt: 0,
    updatedAt: 0,
  };
}

function renderHero(overrides: Partial<React.ComponentProps<typeof HomeHero>> = {}) {
  const onPickChip = vi.fn();
  const onPickPlugin = vi.fn();
  const onPickExamplePlugin = vi.fn();
  const onOpenPluginDetails = vi.fn();
  const onClearActiveChip = vi.fn();
  render(
    <HomeHero
      prompt=""
      onPromptChange={() => undefined}
      onSubmit={() => undefined}
      activePluginTitle={null}
      activeChipId={null}
      onClearActivePlugin={() => undefined}
      pluginOptions={[]}
      pluginsLoading={false}
      pendingPluginId={null}
      pendingChipId={null}
      onPickPlugin={onPickPlugin}
      onPickExamplePlugin={onPickExamplePlugin}
      onOpenPluginDetails={onOpenPluginDetails}
      onPickChip={onPickChip}
      onClearActiveChip={onClearActiveChip}
      contextItemCount={0}
      error={null}
      {...overrides}
    />,
  );
  return { onPickChip, onPickPlugin, onPickExamplePlugin, onOpenPluginDetails, onClearActiveChip };
}

function typePill(chipId: string): HTMLElement | null {
  if (!screen.queryByTestId('home-hero-template-menu')) fireEvent.click(homeTemplateTrigger());
  return screen.queryByTestId('home-hero-template-menu')?.querySelector(`[data-chip="${chipId}"]`) ?? null;
}

function pickTemplate(chipId: string) {
  const option = typePill(chipId);
  if (!option) throw new Error(`No type option for ${chipId}`);
  fireEvent.click(option);
}

describe('HomeHero intent rail', () => {
  it('offers every creation type in the dropdown', () => {
    renderHero();
    // The row is a curated entry set, not the whole create catalog (product,
    // 2026-08-31). Everything else — Brand Kit's own action, the migrate
    // shortcuts, and the create scenarios that left the row — is reached from
    // the Brand Kit tab, the Extensions tab, and the composer + menu.
    const reachable = new Set(orderedCreateChips().map((chip) => chip.id));
    for (const chip of HOME_HERO_CHIPS) {
      const wedge = typePill(chip.id);
      if (reachable.has(chip.id)) {
        expect(wedge).toBeTruthy();
      } else {
        expect(wedge).toBeNull();
      }
    }
  });

  it('no longer renders the inline template rail below the composer', () => {
    renderHero({ onStartBlankProject: vi.fn() });

    expect(screen.queryByTestId('home-hero-template-section')).toBeNull();
    expect(screen.queryByTestId('home-hero-template-toggle')).toBeNull();
    expect(screen.queryByTestId('home-hero-blank-project')).toBeNull();
    expect(screen.queryByTestId('home-hero-type-tabs')).toBeNull();
    expect(screen.queryByTestId('home-hero-shortcuts-trigger')).toBeNull();
    for (const chip of HOME_HERO_CHIPS) {
      expect(screen.queryByTestId(`home-hero-rail-${chip.id}`)).toBeNull();
    }
  });

  it('renders execution switcher inside the input footer when provided', () => {
    renderHero({
      executionSwitcher: (
        <button type="button" data-testid="home-execution-switcher">
          Local CLI
        </button>
      ),
    });

    const switcher = screen.getByTestId('home-execution-switcher');
    const footer = switcher.closest('.home-hero__input-foot');
    expect(footer).toBeTruthy();
  });

  it('forwards the matching chip descriptor when clicked', () => {
    const { onPickChip } = renderHero();
    pickTemplate('image');
    expect(onPickChip).toHaveBeenCalledTimes(1);
    expect(onPickChip).toHaveBeenCalledWith(findChip('image'));
  });

  it('moves the active creation chip into the composer and hides the tab row', () => {
    renderHero({ activeChipId: 'deck' });
    expect(screen.queryByTestId('home-hero-type-tabs')).toBeNull();
    expect(screen.queryByTestId('home-hero-rail-deck')).toBeNull();
    const node = screen.getByTestId('home-hero-template-trigger');
    expect(node.textContent).toContain('Slide deck');
  });

  it('does not reserve an empty active-context row for a hidden chip-bound plugin', () => {
    renderHero({
      activeChipId: 'deck',
      activePluginTitle: 'Wireframe',
      showActivePluginChip: false,
      contextItemCount: 3,
    });

    expect(document.querySelector('.home-hero__active')).toBeNull();
    expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Slide deck');
  });

  it('switches the creation type without a clear control', () => {
    const onClearActiveChip = vi.fn();
    const { onPickChip } = renderHero({ activeChipId: 'deck', onClearActiveChip });
    expect(screen.queryByTestId('home-hero-template-clear')).toBeNull();
    pickTemplate('image');
    expect(onPickChip).toHaveBeenCalledWith(findChip('image'));
    expect(onClearActiveChip).not.toHaveBeenCalled();
  });

  it('tracks the committed template on the footer pill and resets it on clear', () => {
    // The pill mirrors the committed chip: it must pick the label up when a
    // template becomes active and fall back to the empty "Template" kicker the
    // moment the chip is cleared (issue: the pill stayed "Slide deck").
    const baseProps = {
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
      onPickPlugin: vi.fn(),
      onPickExamplePlugin: vi.fn(),
      onPickChip: vi.fn(),
      onClearActiveChip: vi.fn(),
      contextItemCount: 0,
      error: null,
    } as React.ComponentProps<typeof HomeHero>;

    const { rerender } = render(<HomeHero {...baseProps} activeChipId={null} />);
    expect(homeTemplateTrigger().textContent).toContain('Creation type');
    expect(typePill('deck')).toBeTruthy();

    // Picking a template from the menu commits the chip through the host.
    rerender(<HomeHero {...baseProps} activeChipId="deck" />);
    expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Slide deck');

    rerender(<HomeHero {...baseProps} activeChipId={null} />);
    expect(homeTemplateTrigger().textContent).toContain('Creation type');
  });

  it('uses the active creation chip as the only clear control for a chip-bound plugin', () => {
    const activePlugin = makePlugin('example-image-a', 'image', 'Product image');
    renderHero({
      activeChipId: 'image',
      activePluginTitle: 'Product image',
      activePluginRecord: activePlugin,
      showActivePluginChip: true,
    });

    expect(screen.getByTestId('home-hero-active-plugin')).toBeTruthy();
    expect(screen.getByTestId('home-hero-template-trigger').textContent).not.toContain('None');
    expect(screen.queryByLabelText('Clear active plugin')).toBeNull();
  });

  it('keeps the active plugin clear control when no creation chip is active', () => {
    const activePlugin = makePlugin('example-image-a', 'image', 'Product image');
    const onClearActivePlugin = vi.fn();
    renderHero({
      activeChipId: null,
      activePluginTitle: 'Product image',
      activePluginRecord: activePlugin,
      onClearActivePlugin,
      showActivePluginChip: true,
    });

    const clear = screen.getByLabelText('Clear active plugin');
    fireEvent.click(clear);

    expect(onClearActivePlugin).toHaveBeenCalledTimes(1);
  });

  it('shows prompt examples below the composer for the selected tab', () => {
    const onPromptChange = vi.fn();
    renderHero({ activeChipId: 'deck', onPromptChange });

    expect(screen.getByTestId('home-hero-prompt-examples')).toBeTruthy();
    const examples = screen.getAllByTestId('home-hero-prompt-example');
    expect(examples).toHaveLength(4);

    fireEvent.click(examples[0]!);
    expect(onPromptChange).toHaveBeenCalledWith(
      'Research the market opportunity for a product launch, including competitors, target users, pricing hypotheses, and launch narrative',
    );
    // The top "selected example" pill was removed from the composer; picking an
    // example still seeds the prompt but no longer surfaces a dismissible chip.
    expect(screen.queryByTestId('home-hero-active-example')).toBeNull();
  });

  it('shows matching plugin presets in the example prompt area for the selected tab', () => {
    const deckPlugin = makePlugin('example-deck-a', 'deck', 'Investor deck');
    const imagePlugin = makePlugin('example-image-a', 'image', 'Product image');
    const { onPickExamplePlugin, onOpenPluginDetails } = renderHero({
      activeChipId: 'deck',
      pluginOptions: [deckPlugin, imagePlugin],
    });

    const presets = screen.getAllByTestId('home-hero-plugin-preset');
    expect(presets).toHaveLength(1);
    // The preset card is now a thumbnail + name only; the prompt blurb was
    // dropped from the card face but is still passed through on click below.
    expect(presets[0]?.textContent).toContain('Investor deck');

    // The whole card is the single click-to-use affordance (2026-07 removed
    // the hover-revealed Use/Remix overlay and the card-click-opens-details
    // behavior, restoring the #5517 baseline) — clicking it directly seeds
    // the composer with the preset's brief.
    fireEvent.click(presets[0]!);
    expect(onPickExamplePlugin).toHaveBeenCalledWith(
      deckPlugin,
      'deck',
      'Create with a focused brief using Investor deck',
    );
    expect(onOpenPluginDetails).not.toHaveBeenCalled();
  });

  // OPEND-3100 (supersedes OPEND-2697): the poster carries NO eye badge and no
  // "Preview" tooltip — not at rest, not on hover. The whole poster is still
  // the way into the preview; the row itself still seeds the composer.
  it('renders the template poster without an eye badge or preview tooltip, at rest and on hover', () => {
    const deckPlugin = makePlugin('example-deck-a', 'deck', 'Investor deck');
    const { onOpenPluginDetails, onPickExamplePlugin } = renderHero({
      activeChipId: 'deck',
      pluginOptions: [deckPlugin],
    });

    const row = screen.getByTestId('home-hero-plugin-preset');
    const thumb = row.querySelector<HTMLElement>('.home-hero__plugin-preset-row-thumb');
    expect(thumb).not.toBeNull();
    const expectNoEye = () => {
      expect(row.querySelector('.home-hero__plugin-preset-row-preview')).toBeNull();
      expect(row.querySelector('svg path[d^="M12.0003 3C17.3924"]')).toBeNull();
      expect(within(row).queryByTitle('Preview')).toBeNull();
      expect(thumb!.getAttribute('title')).toBeNull();
    };

    expectNoEye();
    fireEvent.mouseEnter(row);
    fireEvent.mouseOver(row);
    expectNoEye();
    fireEvent.mouseEnter(thumb!);
    fireEvent.mouseOver(thumb!);
    expectNoEye();

    // Clicking the poster still opens the preview, not the composer seed.
    fireEvent.click(thumb!);
    expect(onOpenPluginDetails).toHaveBeenCalledWith(deckPlugin);
    expect(onPickExamplePlugin).not.toHaveBeenCalled();
  });

  it('orders curated example presets first for the selected artifact type', () => {
    const ordinaryDeck = makePlugin('example-ordinary-deck', 'deck', 'Ordinary deck');
    const capsule = makePlugin(
      'example-html-ppt-zhangzara-capsule',
      'deck',
      'Html Ppt Zhangzara Capsule',
    );
    const creativeMode = makePlugin(
      'example-html-ppt-zhangzara-creative-mode',
      'deck',
      'Html Ppt Zhangzara Creative Mode',
    );
    renderHero({
      activeChipId: 'deck',
      pluginOptions: [ordinaryDeck, capsule, creativeMode],
    });

    const presets = screen.getAllByTestId('home-hero-plugin-preset');
    expect(presets.map((preset) => preset.getAttribute('data-plugin-id'))).toEqual([
      'example-html-ppt-zhangzara-creative-mode',
      'example-html-ppt-zhangzara-capsule',
      'example-ordinary-deck',
    ]);
  });

  it('keeps curated presets even when they rely on fallback prompt text', () => {
    const otakuDance = makePlugin(
      'image-template-infographic-otaku-dance-choreography-breakdown-gokurakujodo-16-panels',
      'image',
      'Infographic - Otaku Dance Choreography Breakdown (Gokuraku Jodo, 16 Panels)',
      ['image-template'],
      { query: null },
    );
    const ordinaryImage = makePlugin(
      'image-template-ordinary',
      'image',
      'Ordinary image',
      ['image-template'],
    );
    renderHero({
      activeChipId: 'image',
      pluginOptions: [ordinaryImage, otakuDance],
    });

    const presets = screen.getAllByTestId('home-hero-plugin-preset');
    expect(presets[0]?.getAttribute('data-plugin-id')).toBe(
      'image-template-infographic-otaku-dance-choreography-breakdown-gokurakujodo-16-panels',
    );
  });

  it('keeps Hatch Pet at the end of the image example presets', () => {
    const hatchPet = makePlugin('example-hatch-pet', 'image', 'Hatch Pet');
    const imagePoster = makePlugin('image-template-poster', 'image', 'Image Poster');
    const stoneInfographic = makePlugin('image-template-stone', 'image', 'Stone Infographic');
    renderHero({
      activeChipId: 'image',
      pluginOptions: [hatchPet, imagePoster, stoneInfographic],
    });

    const presets = screen.getAllByTestId('home-hero-plugin-preset');
    expect(presets.map((preset) => preset.textContent)).toEqual([
      expect.stringContaining('Image Poster'),
      expect.stringContaining('Stone Infographic'),
      expect.stringContaining('Hatch Pet'),
    ]);
  });

  it('disables every template while a plugin apply is in flight', () => {
    const { onPickChip } = renderHero({
      pendingPluginId: 'od-figma-migration',
      pendingChipId: 'figma',
    });
    expect(homeTemplateTrigger().disabled).toBe(true);
    fireEvent.click(homeTemplateTrigger());
    expect(screen.queryByTestId('home-hero-template-menu')).toBeNull();
    expect(onPickChip).not.toHaveBeenCalled();
  });

  it('keeps the generic fallback in the free-form prompt instead of an Other chip', () => {
    renderHero();

    expect(findChip('other')).toBeUndefined();
    expect(screen.queryByTestId('home-hero-rail-other')).toBeNull();
  });

  it('migration chips carry the right action discriminator', () => {
    expect(findChip('create-plugin')?.action).toMatchObject({ kind: 'create-plugin' });
    expect(findChip('figma')?.action).toMatchObject({ kind: 'apply-figma-migration' });
    expect(findChip('folder')).toBeUndefined();
    expect(findChip('template')?.action).toMatchObject({ kind: 'open-template-picker' });
  });

  it('keeps image creation on the media generation scenario', () => {
    expect(findChip('image')?.action).toMatchObject({
      kind: 'apply-scenario',
      pluginId: 'od-media-generation',
      projectKind: 'image',
    });
  });

  it('marks the presentation scenarios as daemon-owned defaults', () => {
    expect(findChip('deck')?.action).toMatchObject({
      pluginId: 'example-simple-deck',
      projectKind: 'deck',
      automaticDefault: true,
    });
    expect(findChip('image')?.action).toMatchObject({ automaticDefault: true });
    expect(automaticStrategyTaskProfileForRouteId('deck')).toBe('ppt');
    expect(automaticStrategyTaskProfileForRouteId('image')).toBeNull();
  });
});
