// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/components/home-hero/PlaceholderCarousel', () => ({
  PlaceholderCarousel: () => null,
}));

vi.mock('../../src/collab/useWorkspaceContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/collab/useWorkspaceContext')>();
  return {
    ...actual,
    useWorkspaceContext: () => ({
      context: null,
      loading: false,
      failure: 'unsupported' as const,
    }),
  };
});

import { HomeView } from '../../src/components/HomeView';
import { requestHomeChip } from '../../src/runtime/home-intent';
import { homeHeroPromptText, setHomeHeroPrompt } from '../helpers/home-hero-lexical';

const HIDDEN_DEFAULT_PLUGIN = {
  id: 'od-default',
  title: 'Default design router',
  version: '0.1.0',
  trust: 'bundled' as const,
  sourceKind: 'bundled' as const,
  source: '/tmp/default-router',
  capabilitiesGranted: ['prompt:inject'],
  fsPath: '/tmp/default-router',
  installedAt: 0,
  updatedAt: 0,
  manifest: {
    name: 'od-default',
    title: 'Default design router',
    version: '0.1.0',
    description: 'Routes a free-form design brief.',
    od: {
      kind: 'scenario' as const,
      taskKind: 'new-generation' as const,
      hidden: true,
      useCase: { query: 'Create a design artifact from {{prompt}}.' },
      inputs: [{
        name: 'prompt',
        type: 'string',
        required: true,
        label: 'Prompt',
      }],
    },
  },
};

const DECK_PLUGIN = {
  ...HIDDEN_DEFAULT_PLUGIN,
  id: 'example-simple-deck',
  title: 'Simple Deck',
  source: '/tmp/simple-deck',
  fsPath: '/tmp/simple-deck',
  manifest: {
    ...HIDDEN_DEFAULT_PLUGIN.manifest,
    name: 'example-simple-deck',
    title: 'Simple Deck',
    description: 'Creates an editable slide deck.',
    od: {
      ...HIDDEN_DEFAULT_PLUGIN.manifest.od,
      hidden: false,
    },
  },
};

function stubAnimationFrame() {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = window.setTimeout(() => callback(window.performance.now()), 0);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
}

function stubPluginCatalog(plugins: unknown[] = [], applyResponse: unknown = null) {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => {
    if (url === '/api/plugins') {
      return new Response(JSON.stringify({ plugins }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (applyResponse && typeof url === 'string' && url.includes('/apply-local')) {
      return new Response(JSON.stringify(applyResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
}

function homeTemplateTrigger(): HTMLButtonElement {
  return screen.getByTestId('home-hero-template-trigger').querySelector('button')!;
}

function homeHeroPromptValue(): string {
  const text = homeHeroPromptText();
  if (text === '\n' && (screen.getByTestId('home-hero-input').textContent ?? '') === '') return '';
  return text;
}

describe('HomeView prompt handoff', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('exposes only the two supported creation types', async () => {
    stubPluginCatalog();
    stubAnimationFrame();

    render(<HomeView projects={[]} onSubmit={() => undefined} onOpenProject={() => undefined} />);

    await waitFor(() => expect((homeTemplateTrigger() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(homeTemplateTrigger());

    const options = [...screen.getByTestId('home-hero-template-menu').querySelectorAll('[data-chip]')]
      .map((option) => option.getAttribute('data-chip'));
    expect(options).toEqual(['deck', 'image']);
    expect(screen.queryByText('Prototype')).toBeNull();
    expect(screen.queryByText('Document')).toBeNull();
  });

  it('honours a queued deck selection without restoring retired types', async () => {
    stubPluginCatalog([DECK_PLUGIN], {
      query: '',
      inputs: [],
      appliedPlugin: {
        snapshotId: 'snap-deck',
        pluginId: 'example-simple-deck',
        inputs: {},
      },
    });
    stubAnimationFrame();
    requestHomeChip('deck');

    render(<HomeView projects={[]} onSubmit={() => undefined} onOpenProject={() => undefined} />);

    await waitFor(() => {
      expect(screen.getByTestId('home-hero-template-picker').getAttribute('data-type')).toBe('deck');
    });
    expect(homeTemplateTrigger()).toHaveTextContent('Slide deck');
  });

  it('routes a free-form brief through the hidden default plugin', async () => {
    stubPluginCatalog([HIDDEN_DEFAULT_PLUGIN]);
    const onSubmit = vi.fn();
    render(<HomeView projects={[]} onSubmit={onSubmit} onOpenProject={() => undefined} />);

    await screen.findByTestId('home-hero-input');
    await act(async () => {
      setHomeHeroPrompt('Make a launch page for a robotics studio');
      await Promise.resolve();
    });
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Make a launch page for a robotics studio',
      pluginId: 'od-default',
      appliedPluginSnapshotId: null,
      projectKind: 'other',
    })));
  });

  it('keeps the draft visible when a submit is rejected', async () => {
    stubPluginCatalog();
    let resolveSubmit: (accepted: boolean) => void = () => undefined;
    const submitResult = new Promise<boolean>((resolve) => { resolveSubmit = resolve; });
    stubAnimationFrame();
    render(<HomeView projects={[]} onSubmit={() => submitResult} onOpenProject={() => undefined} />);

    await screen.findByTestId('home-hero-input');
    await act(async () => {
      setHomeHeroPrompt('Create an image of a quiet reading room.');
      await Promise.resolve();
    });
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    await waitFor(() => {
      expect((screen.getByTestId('home-hero-submit') as HTMLButtonElement).disabled).toBe(true);
    });
    expect(homeHeroPromptValue()).toBe('Create an image of a quiet reading room.');

    await act(async () => {
      resolveSubmit(false);
      await submitResult;
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to start the run. Try again.');
    expect(homeHeroPromptValue()).toBe('Create an image of a quiet reading room.');
  });
});
