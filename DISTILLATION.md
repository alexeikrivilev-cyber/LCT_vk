# Repository distillation

This fork is intentionally narrowed to the LCT/VK Tech presentation compiler. `CONTEXT.md` is the product source of truth.

## Runtime boundary after the second pass

Only two pnpm workspaces remain:

- `apps/web` — project workspace, source upload, editable text sources, design-system selection and live HTML preview.
- `apps/daemon` — project metadata, project files, preview transport, presentation catalog and image generation.

The daemon source closure is intentionally explicit: `cli`, startup, server, presentation store/files/catalog, and `media/`. It no longer depends on the former `packages/*` graph.

Presentation assets retained outside the runtime are deliberately small:

- `design-systems/_schema`, `design-systems/default`, `design-systems/corporate`;
- `skills/pptx-html-fidelity-audit` and `skills/reference-design-contract`;
- presentation-relevant craft rules;
- `templates/deck-framework.html` as a neutral HTML preview/export shell.

Arbitrary uploaded PPTX files, not a bundled style gallery, are expected to become project-specific presentation design systems.

## Removed by design

The following upstream surfaces are outside the product boundary and were removed as whole dependency slices:

- Electron/desktop, packaged and closure applications;
- collaboration/team/cloud runtime and workspace SaaS machinery;
- marketplace/community/plugin runtime and registry protocol layers;
- AMR/Vela agent runtime, sidecars, launcher protocols and compatibility packages;
- generic website/prototype/mobile catalogs and fixed presentation-style galleries;
- generated video/audio provider stack, FFmpeg/Hyperframes and provider marketplace integrations;
- Figma plugin, browser clipper, pets, device frames and community assets;
- generic mocks/e2e corpus;
- release/pack/dev/serve workspace tooling and old GitHub automation;
- multi-cloud/deployment matrices and container infrastructure inherited from the upstream product;
- old `OD_*` runtime configuration and the `od` CLI entrypoint.

## Preserved on purpose

The cleanup must not erase the primitives the future compiler needs:

- safe binary/source file storage, including PPT/PPTX/PDF and images;
- editable HTML/CSS/JS/JSON/Markdown/text sources;
- relative-resource-safe live HTML preview;
- minimal design-system discovery/preview/static-asset serving;
- image generation behind a small OpenAI-compatible boundary;
- `jszip`, `pdf-lib` and `pptxgenjs` in the daemon dependency set as presentation import/export primitives for the next implementation stage.

## Boundary guard

`pnpm check:boundary` prevents deleted product surfaces from silently returning. It asserts that the workspace contains only `apps/web` and `apps/daemon`, rejects former generic roots, and rejects legacy workspace imports / `OD_*` runtime variables inside application source.

## Validation boundary

The previous lockfile was intentionally removed because it described workspaces that no longer exist. Before merge/release, run a clean `pnpm install` with pnpm 10.33.2, commit the regenerated `pnpm-lock.yaml`, then run:

```bash
pnpm check:boundary
pnpm typecheck
pnpm build
```

A GitHub Actions attempt earlier in the distillation failed before executing job steps, so this branch remains a draft until it has been installed and validated in a functioning runner/local checkout.

## Next implementation boundary

The generic runtime extraction is now largely complete. New work should be presentation-specific rather than another compatibility layer:

`PPTX ingest -> template semantics -> presentation design system -> deck plan -> constrained variants -> render -> audit/repair -> preflight -> editable PPTX/PDF/HTML`.
