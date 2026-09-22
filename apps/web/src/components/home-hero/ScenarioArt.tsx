// Small, token-driven illustrations for the two Home creation cards.

import type { ReactElement, ReactNode } from 'react';
import { Icon, type IconName } from '../Icon';

const INK = 'var(--text-muted)';
const ACCENT = 'var(--accent)';
const SURFACE = 'var(--bg-panel)';

function Frame({ children }: { children: ReactNode }) {
  return (
    <svg
      className="home-hero__scenario-art-svg"
      viewBox="0 0 60 42"
      width={60}
      height={42}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function DeckArt() {
  return (
    <Frame>
      <rect x="15" y="6" width="38" height="24" rx="3" stroke={INK} strokeWidth="2" strokeOpacity="0.45" />
      <rect x="7" y="11" width="38" height="24" rx="3" fill={SURFACE} stroke={INK} strokeWidth="2" />
      <rect x="11" y="15" width="14" height="5" rx="1.5" fill={ACCENT} />
      <line x1="11" y1="25" x2="41" y2="25" stroke={INK} strokeWidth="2" />
      <line x1="11" y1="30" x2="34" y2="30" stroke={INK} strokeWidth="2" />
    </Frame>
  );
}

function ImageArt() {
  return (
    <Frame>
      <rect x="8" y="8" width="44" height="26" rx="4" stroke={INK} strokeWidth="2" />
      <circle cx="19" cy="16" r="3" fill={ACCENT} />
      <path d="M11 31 L22 20 L29 26 L37 17 L49 31" stroke={INK} strokeWidth="2" />
    </Frame>
  );
}

const ART_BY_CHIP: Record<string, () => ReactElement> = {
  deck: DeckArt,
  image: ImageArt,
};

interface ScenarioArtProps {
  chipId: string;
  fallbackIcon: IconName;
}

export function ScenarioArt({ chipId, fallbackIcon }: ScenarioArtProps) {
  const Art = ART_BY_CHIP[chipId];
  if (Art) return <Art />;
  return <Icon name={fallbackIcon} size={24} aria-hidden />;
}
