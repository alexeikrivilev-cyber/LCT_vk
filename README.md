# LCT Presentation Compiler

LCT converts an arbitrary corporate PPTX template, source materials, and a short brief into a complete editable presentation that follows the template's design logic.

The product is intentionally narrow: understand the template, plan the story, generate constrained slide and visual alternatives, audit the result, repair selected issues, and export native PPTX/PDF/HTML.

## Product flow

```text
PPTX template + content package + brief
  -> template understanding
  -> presentation design system
  -> deck outline
  -> deck plan
  -> A/B/C variants per slide
  -> A/B/C candidates per visual slot
  -> recommended mixed deck
  -> audit + selective repair
  -> preflight
  -> editable PPTX / PDF / HTML
```

The default path requires no manual design work. The system selects a recommended slide and visual candidate at every choice point; the user only intervenes where they want a different option.

## Current repository state

The repository already contains the minimal product shell:

- `apps/web` — Next.js presentation workspace, uploads, editable source files, design-system selection, and live HTML preview.
- `apps/daemon` — Express service, project persistence, safe file transport, design-system/skill catalog, and image-generation boundary.
- `skills/` — presentation-specific skill packages.
- `design-systems/` — schema plus minimal fallback/reference systems.
- `craft/` — compact presentation craft guidance.
- `templates/deck-framework.html` — neutral HTML deck preview shell.

The presentation compiler pipeline described in `ARCHITECTURE.md` is the target for ongoing implementation. Documentation distinguishes implemented foundation from required target behavior.

## Documentation

Start with `AGENTS.md` when working as a coding agent.

- [`CONTEXT.md`](./CONTEXT.md) — canonical product specification.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system boundaries and pipeline.
- [`MODELS.md`](./MODELS.md) — model, prompts, skills, and offline optimization.
- [`AUDIT.md`](./AUDIT.md) — audit, repair, and preflight contract.
- [`TESTING.md`](./TESTING.md) — test strategy and acceptance criteria.
- [`skills/README.md`](./skills/README.md) — skill authoring policy.
- [`design-systems/README.md`](./design-systems/README.md) — design-system/package contract.
- [`craft/README.md`](./craft/README.md) — presentation craft references.

## Local development

Requirements:

- Node.js 24
- pnpm 10.33.2

```bash
pnpm install
pnpm check:boundary
pnpm typecheck
pnpm build
pnpm dev
```

The repository currently has no committed lockfile after the workspace reduction. Regenerate `pnpm-lock.yaml` with pnpm 10.33.2 and commit it before treating a build as release-reproducible.

Runtime data defaults to `.lct/`.

Server configuration:

```text
LCT_BIND_HOST
LCT_PORT
LCT_DATA_DIR
```

Image generation is exposed through a deliberately small adapter:

```text
LCT_IMAGE_API_KEY
LCT_IMAGE_BASE_URL
LCT_IMAGE_MODEL
```

`OPENAI_API_KEY` may be used as the current compatibility fallback for the image adapter. Presentation domain code must not depend on that provider-specific detail.

## Scope

The hackathon product is desktop-web only and optimized for roughly 10–15 slides or a user-selected count. Generation should fit the case time budget, with a target of no more than five minutes for a normal deck.

In scope: unknown PPTX templates, template decomposition, content/outline planning, charts/tables/diagrams/icons/SmartArt-like structures, image generation, three controlled variants, selective repair, native export, skills/versioning, tests, and reproducibility.

Out of scope unless a concrete requirement appears: multiplayer collaboration, enterprise permissions, marketplace/community systems, video/audio generation, mobile apps, generic website/prototype generation, universal vector editing, and a large external research/fact-checking subsystem.

## Verification

Before finishing a code change, run the checks applicable to it. `pnpm check:boundary` protects the presentation-only repository boundary. `TESTING.md` defines the expected coverage for parser, planner, variants, renderer, audit, locks, export, and end-to-end flows.
