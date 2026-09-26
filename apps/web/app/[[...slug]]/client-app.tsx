'use client';

import dynamic from 'next/dynamic';
import { ru } from '../../src/i18n/ru';

const App = dynamic(() => import('../../src/App').then((module) => module.App), {
  ssr: false,
  loading: () => <div className="boot-state" role="status" aria-live="polite">{ru.workspace.boot}</div>,
});

export function ClientApp() {
  return <App />;
}
