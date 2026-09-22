// @vitest-environment jsdom
import { pickHomeTemplate } from '../helpers/home-template-picker';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

const DECK_PLUGIN = {
  id: 'example-simple-deck',
  title: 'Simple Deck',
  version: '0.1.0',
  trust: 'bundled' as const,
  sourceKind: 'bundled' as const,
  source: '/tmp/simple-deck',
  capabilitiesGranted: ['prompt:inject'],
  fsPath: '/tmp/simple-deck',
  installedAt: 0,
  updatedAt: 0,
  manifest: {
    name: 'example-simple-deck',
    title: 'Simple Deck',
    version: '0.1.0',
    description: 'A presentation starter.',
    od: {
      kind: 'scenario',
      taskKind: 'new-generation',
      useCase: { query: 'Build a clear presentation.' },
    },
  },
};

function fetchMockFor(plugins: unknown[]) {
  return vi.fn<typeof fetch>(async (url) => {
    if (typeof url === 'string' && url === '/api/plugins') {
      return new Response(JSON.stringify({ plugins }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

describe('HomeView current chip selection survives a real remount', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('restores the selected deck entry point without reapplying the plugin', async () => {
    const fetchMock = fetchMockFor([DECK_PLUGIN]);
    vi.stubGlobal('fetch', fetchMock);

    const mounted = render(
      <HomeView projects={[]} onSubmit={() => undefined} onOpenProject={() => undefined} />,
    );
    await screen.findByTestId('home-hero-input');
    await pickHomeTemplate('deck');
    await waitFor(() => {
      expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Slide deck');
    });

    mounted.unmount();
    render(<HomeView projects={[]} onSubmit={() => undefined} onOpenProject={() => undefined} />);
    await screen.findByTestId('home-hero-input');
    await waitFor(() => {
      expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Slide deck');
    });
    expect(fetchMock.mock.calls.some(([url]) =>
      typeof url === 'string' && url.includes('/api/plugins/example-simple-deck/apply'),
    )).toBe(false);
  });

  it('clears a persisted pointer to an unavailable plugin', async () => {
    window.localStorage.setItem(
      'lct:home-composer:chip',
      JSON.stringify({ chipId: 'deck', pluginId: 'example-simple-deck', projectKind: 'deck' }),
    );
    vi.stubGlobal('fetch', fetchMockFor([]));

    render(<HomeView projects={[]} onSubmit={() => undefined} onOpenProject={() => undefined} />);
    await screen.findByTestId('home-hero-input');
    await waitFor(() => {
      expect(window.localStorage.getItem('lct:home-composer:chip')).toBeNull();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
