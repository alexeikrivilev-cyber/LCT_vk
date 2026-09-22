import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '../src/index.css';

export const metadata: Metadata = {
  title: 'LCT Presentation Core',
  description: 'Presentation workspace for template understanding, generation, editing and export.',
};

export const viewport: Viewport = {
  themeColor: '#f4f4f2',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
