# Repository distillation

This fork is intentionally narrowed to the LCT/VK Tech presentation case. `CONTEXT.md` is the product source of truth.

## Retained product surface

- `apps/web` — browser UI, workspace, preview and generative editing foundation.
- `apps/daemon` — persistence, files, runtime orchestration, skills/design-system services and export foundations.
- `packages/*` — only the dependency closure currently required by the retained web/daemon/dev runtime.
- `design-systems` — schema plus two small fallback/reference systems (`default`, `corporate`). Arbitrary uploaded PPTX templates are expected to become project-specific presentation design systems.
- `design-templates/guizang-ppt` — one deck implementation retained only as a reference/smoke-test fixture, not as the product's template strategy.
- `skills/pptx-html-fidelity-audit` — code-backed presentation fidelity/audit workflow.
- `skills/reference-design-contract` — reusable evidence-to-design-contract workflow that can be adapted to PPTX template understanding.
- presentation-relevant craft rules: accessibility, anti-slop, color and typography.
- `deploy` — deployment foundation kept because the hackathon requires a reproducible service setup.

## Removed by design

The following upstream OpenDesign surfaces are outside the hackathon product and should not be reintroduced unless they become a concrete dependency of the presentation pipeline:

- desktop/Electron, packaged and closure applications;
- generic prototype/web/mobile generation catalogs;
- video/audio creation flows and bundled prompt galleries;
- Figma plugin and browser clipper products;
- marketplace/community/plugin catalogs and preview data;
- Kubernetes chart and desktop release/packaging tooling;
- hundreds of bundled design systems and presentation style galleries;
- catalogue-only skills that merely point to external repositories instead of carrying executable/reference material locally;
- community pets, device-frame galleries and live-artifact examples;
- upstream maintenance/migration/seed scripts unrelated to the retained runtime;
- upstream GitHub automation, long-form docs/spec archives, privacy/quickstart material and deployment config that described removed product surfaces.

## What is deliberately not deleted yet

Some generic internals remain because `apps/web` or `apps/daemon` still imports them. They are candidates for later passes only after the retained application is green:

- plugin/runtime abstractions still referenced by the daemon;
- sidecar/runtime protocol packages used by the current web/daemon transport;
- generic UI modules inside `apps/web/src` and daemon routes inside `apps/daemon/src`;
- existing mock/e2e infrastructure until it is replaced by presentation-specific regression coverage.

Distillation should proceed dependency-first: remove a product surface, remove its imports/routes/contracts/tests, then remove the underlying package. Do not keep dead compatibility code merely because it existed upstream, but do not break the retained presentation workflow to make the tree smaller.

## Lockfile / validation boundary

The workspace graph changed substantially, so the old `pnpm-lock.yaml` is intentionally not retained: it referenced deleted apps/tools and would present a false reproducibility guarantee. After checking out this branch, run `pnpm install` with pnpm 10.33.2 and commit the newly generated lockfile before merging/releasing.

A temporary minimal GitHub Actions workflow was attempted during distillation, but the repository runner failed before executing any job steps, so the branch should remain draft until the retained workspace is installed and typechecked in a working runner/local checkout.

## Target architecture

`unknown PPTX -> template understanding -> presentation design system -> deck plan -> constrained slide/visual variants -> audit/repair -> preflight -> editable PPTX/PDF/HTML`

The next cleanup pass should reduce `apps/web` and `apps/daemon` around that architecture using import/route dependency boundaries, then introduce the presentation-specific parser/planner/renderer/audit modules and versioned skills.
