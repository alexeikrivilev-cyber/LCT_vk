// The small, intentional Home creation catalog.
//
// Home is the entry point for the presentation/design foundation. It should
// answer one question quickly: what kind of artifact are we starting? Keep
// this table limited to the two workflows that are reliable and useful for
// that foundation. Other capabilities remain discoverable from their own
// product surfaces, but do not become hidden Home modes.

import type { ProjectKind, ProjectMetadata } from '@lct/contracts';
import type { DefaultScenarioPluginId } from '@lct/contracts';
import type { IconName } from '../Icon';

export type ChipScenarioPluginId = DefaultScenarioPluginId;

export type ChipAction =
  | {
      kind: 'apply-scenario';
      pluginId: ChipScenarioPluginId;
      projectKind: ProjectKind;
      /** The daemon may derive this route as the product default. */
      automaticDefault?: boolean;
      inputs?: Record<string, unknown>;
      projectMetadata?: ProjectMetadata;
    }
  | {
      kind: 'apply-figma-migration';
      pluginId: 'od-figma-migration';
      projectKind: ProjectKind;
      inputs?: Record<string, unknown>;
      projectMetadata?: ProjectMetadata;
    }
  | { kind: 'create-plugin' }
  | { kind: 'open-template-picker' }
  | { kind: 'create-brand-kit' };

export type ChipGroup = 'create' | 'migrate';

export interface HomeHeroChip {
  id: string;
  label: string;
  icon: IconName;
  group: ChipGroup;
  hint?: string;
  description?: string;
  action: ChipAction;
}

export const HOME_HERO_CHIPS: ReadonlyArray<HomeHeroChip> = [
  {
    id: 'deck',
    label: 'Slide deck',
    icon: 'present',
    group: 'create',
    description: 'Presentations & pitch decks',
    action: {
      kind: 'apply-scenario',
      pluginId: 'example-simple-deck',
      projectKind: 'deck',
      automaticDefault: true,
    },
  },
  {
    id: 'image',
    label: 'Image',
    icon: 'image',
    group: 'create',
    description: 'Posters, graphics & art',
    action: {
      kind: 'apply-scenario',
      pluginId: 'od-media-generation',
      projectKind: 'image',
      automaticDefault: true,
      inputs: {
        mediaKind: 'image',
        subject: 'a polished product concept',
        style: 'cinematic, high-quality, on-brand',
        aspect: '16:9',
      },
    },
  },
  // These actions remain addressable by their owning surfaces and by the
  // workspace hand-off code, but are deliberately not part of the create
  // rail. Keeping them here avoids a second, subtly different action table.
  {
    id: 'create-brand-kit',
    label: 'Create Brand Kit',
    icon: 'swatchbook',
    group: 'migrate',
    hint: 'Extract a brand kit from a website, then apply it in any chat.',
    action: { kind: 'create-brand-kit' },
  },
  {
    id: 'create-plugin',
    label: 'Create plugin',
    icon: 'edit',
    group: 'migrate',
    hint: 'Author a reusable LCT plugin and add it to My plugins.',
    action: { kind: 'create-plugin' },
  },
  {
    id: 'figma',
    label: 'From Figma',
    icon: 'import',
    group: 'migrate',
    hint: 'Migrate a Figma frame into the active design system.',
    action: {
      kind: 'apply-figma-migration',
      pluginId: 'od-figma-migration',
      projectKind: 'prototype',
      inputs: {
        figmaUrl: 'the Figma file URL you provide',
        targetStack: 'React 18 + Tailwind',
      },
    },
  },
  {
    id: 'template',
    label: 'From template',
    icon: 'file-code',
    group: 'migrate',
    hint: 'Start from a bundled template.',
    action: { kind: 'open-template-picker' },
  },
];

const CREATE_RAIL_ORDER = ['deck', 'image'] as const;
const VISIBLE_MIGRATE_CHIP_IDS = new Set<string>(['template']);

export function chipsForGroup(group: ChipGroup): HomeHeroChip[] {
  const chips = HOME_HERO_CHIPS.filter((chip) => chip.group === group);
  if (group === 'create') {
    return CREATE_RAIL_ORDER
      .map((id) => chips.find((chip) => chip.id === id))
      .filter((chip): chip is HomeHeroChip => Boolean(chip));
  }
  return chips.filter((chip) => VISIBLE_MIGRATE_CHIP_IDS.has(chip.id));
}

export { CREATE_RAIL_ORDER };

export function orderedCreateChips(): HomeHeroChip[] {
  return chipsForGroup('create');
}

// Cross-surface handoff: the workspace tabs-bar '+' fan can request a
// template pick without duplicating Home's dispatcher.
export const HOME_APPLY_TEMPLATE_EVENT = 'lct:home-apply-template';

export function findChip(id: string): HomeHeroChip | undefined {
  return HOME_HERO_CHIPS.find((chip) => chip.id === id);
}
