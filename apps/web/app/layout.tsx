import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ru } from '../src/i18n/ru';
import '../src/index.css';

export const metadata: Metadata = {
  title: ru.metadata.title,
  description: ru.metadata.description,
};

export const viewport: Viewport = {
  themeColor: '#f4f4f2',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
