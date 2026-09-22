'use client';

import dynamic from 'next/dynamic';

const App = dynamic(() => import('../../src/App').then((module) => module.App), {
  ssr: false,
  loading: () => <div className="boot-state">Loading presentation workspace…</div>,
});

export function ClientApp() {
  return <App />;
}
