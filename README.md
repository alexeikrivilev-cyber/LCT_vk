# LCT VK Presentation Compiler

This repository is a deliberately distilled presentation product built from an OpenDesign fork for the LCT / VK Tech case. `CONTEXT.md` is the product source of truth; `DISTILLATION.md` records what remains and what was intentionally removed.

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

The repository is no longer a generic OpenDesign workspace. The runtime boundary is intentionally small: one browser workspace, one presentation daemon, project files, live HTML preview, presentation design systems, image generation, and editable source files.

## Retained foundation

- `apps/web` — presentation projects, sources, text editing, design-system selection and live HTML preview.
- `apps/daemon` — project persistence, safe project files, preview transport, presentation catalog and image-generation boundary.
- `skills/` — presentation-relevant local workflows only.
- `design-systems/` — schema plus minimal fallback/reference systems.
- `templates/deck-framework.html` — neutral HTML deck shell; fixed visual templates are not the product strategy.
- `craft/` — presentation-relevant accessibility, typography, color and anti-slop rules.

## Local development

Requirements: Node.js 24 and pnpm 10.33.2.

```bash
pnpm install
pnpm check:boundary
pnpm typecheck
pnpm build
pnpm dev
```

The old lockfile was removed because it described deleted workspaces. Regenerate `pnpm-lock.yaml` with pnpm 10.33.2 and commit it after a clean install before treating the branch as reproducible.

Image generation is intentionally provider-thin. Configure `LCT_IMAGE_API_KEY` (or `OPENAI_API_KEY`), optionally `LCT_IMAGE_BASE_URL` / `LCT_IMAGE_MODEL`. Runtime data defaults to `.lct/`; server binding can be changed with `LCT_BIND_HOST` and `LCT_PORT`.

## Scope discipline

Do not reintroduce marketplace/community, collaboration SaaS, AMR/Vela, desktop/Electron, sidecars, generic plugin runtimes, video/audio generation, deployment matrices, generic website/prototype catalogs, or fixed style galleries without a concrete dependency from the presentation compiler.

Run `pnpm check:boundary` when changing the repository graph; it guards the presentation-only workspace boundary against accidental generic-runtime regrowth.
