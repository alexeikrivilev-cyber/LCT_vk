# LCT VK Presentation Compiler

This repository is a deliberately distilled OpenDesign foundation for the LCT / VK Tech presentation-generation case.

The product direction is defined in [`CONTEXT.md`](./CONTEXT.md). The repository cleanup policy and retained OpenDesign surface are documented in [`DISTILLATION.md`](./DISTILLATION.md).

## Product target

```text
unknown PPTX
  -> template understanding
  -> presentation design system
  -> deck plan
  -> constrained A/B/C slide variants
  -> constrained A/B/C visual variants
  -> audit + selective repair
  -> preflight
  -> editable PPTX / PDF / HTML
```

OpenDesign is used as product/runtime infrastructure, not as the presentation solution itself. Presentation-specific parsing, planning, rendering and audit should live in explicit modules and versioned skills rather than growing the generic upstream surface again.

## Retained foundation

- `apps/web` — browser UI, workspace, preview and generative editing foundation.
- `apps/daemon` — project/files/runtime/design-system/skills services and export foundations.
- `skills/` — only presentation-relevant locally substantive skills.
- `design-systems/` — schema plus minimal fallback/reference systems.
- `craft/` — presentation-relevant visual rules only.
- `deploy/` — deployment foundation.

## Local development

Requirements:

- Node.js 24
- pnpm 10.33.2

```bash
pnpm install
pnpm dev
```

The workspace graph was aggressively reduced during distillation. Regenerate and commit `pnpm-lock.yaml` after the cleanup branch is checked out before treating a release as reproducible.

## Scope discipline

Do not reintroduce upstream marketplace/community, desktop/Electron packaging, Figma/clipper, video/audio, generic website/prototype catalogs or collaboration SaaS surfaces unless the presentation workflow acquires a concrete dependency on them.
