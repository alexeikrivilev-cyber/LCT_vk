# Presentation design systems

This directory contains only small built-in fallback/reference design systems. The main product strategy is to compile each uploaded PPTX into a project-specific presentation design system.

Do not add a large gallery of fixed visual styles as a substitute for template understanding.

## Built-in package contract

Built-in systems follow the schema in `_schema/`. The common package shape is:

```text
design-systems/<id>/
  manifest.json
  DESIGN.md
  tokens.css
  ... optional previews/assets/derived token files
```

- `manifest.json` provides discovery metadata and declares files.
- `DESIGN.md` contains compact human/model-readable design guidance.
- `tokens.css` provides machine-consumable semantic tokens.
- optional previews/assets support the UI and generation where declared.

The current runtime discovers `manifest.json` packages through `apps/daemon/src/presentation-catalog.ts`. Follow the checked-in schema when editing built-in fixtures; do not casually rename schema fields without migrating the reader and tests.

## Project-specific template compilation

An uploaded PPTX should compile into project state conceptually similar to:

```text
original-template.pptx          immutable source
template-ir.json                exact structural facts
presentation-design-system/
  DESIGN.md                     compact semantic guidance
  tokens.json / tokens.css      exact/semantic token mapping
  layouts.json                  layout families + stable source ids
  assets/                       reusable template assets
  previews/                     rendered evidence where useful
```

The exact persistence layout may evolve. The invariants are:

- exact values come from PPTX/OOXML parsing;
- semantic labels may be model-assisted;
- every derived layout/asset keeps a stable reference to its source;
- the original PPTX remains available for native export;
- generated design-system state is project data, not a new global hardcoded theme.

## What the compiler should capture

Where present:

- slide dimensions/aspect ratio;
- masters/layouts/placeholders;
- theme colors and semantic roles;
- typography hierarchy/scales;
- guides/margins/spacing;
- logos, headers, footers, and protected elements;
- reusable shapes/icons/images;
- chart/table conventions;
- image treatments;
- composition/layout families;
- density patterns and constraints.

`ARCHITECTURE.md` defines `TemplateIR` versus `PresentationDesignSystem`. Keep exact structural facts separate from compact semantic guidance.

## Template Inspector

The UI may expose a lightweight summary of the compiled design system: layouts, colors, typography levels, reusable assets, chart patterns, and composition families.

The inspector is for confidence and review. It is not a requirement to build a full manual design-system editor.

## Precedence

For generated slides:

1. hard export/integrity/accessibility constraints;
2. exact uploaded-template constraints and protected elements;
3. project-specific derived design-system rules;
4. general `craft/` guidance;
5. model aesthetic preference.

A model must not override a known template fact merely because another treatment looks better.

## Provenance

Built-in package provenance belongs in each package manifest and any package-level license/source files. Preserve those records when normalizing or simplifying a design-system package.
