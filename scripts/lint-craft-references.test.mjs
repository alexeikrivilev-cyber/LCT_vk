import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractCraftRequiresSlugs,
  extractDesignSystemCraftSlugs,
  findCraftReferenceViolations,
} from './lint-craft-references.ts';

test('craft skill requirements are read from YAML frontmatter', () => {
  const source = `---
name: example
od:
  craft:
    requires: [color, anti-ai-slop]
---
body text that is not frontmatter
`;
  assert.deepEqual(extractCraftRequiresSlugs(source), ['color', 'anti-ai-slop']);
  assert.deepEqual(extractCraftRequiresSlugs('# no frontmatter'), []);
});

test('design system craft references include applies, suggested, and exemptions', () => {
  const source = JSON.stringify({
    craft: {
      applies: ['color'],
      suggested: ['typography'],
      exemptions: ['accessibility-baseline'],
    },
  });
  assert.deepEqual(extractDesignSystemCraftSlugs(source), [
    'color',
    'typography',
    'accessibility-baseline',
  ]);
});

test('craft reference validation reports invalid and unresolved slugs', () => {
  const references = [
    { manifestPath: 'skills/a/SKILL.md', slug: 'color' },
    { manifestPath: 'skills/b/SKILL.md', slug: 'missing' },
    { manifestPath: 'design-systems/a/manifest.json', slug: 42 },
  ];
  assert.deepEqual(
    findCraftReferenceViolations(references, new Set(['color'])).map(({ kind }) => kind),
    ['unresolved', 'invalid'],
  );
});
