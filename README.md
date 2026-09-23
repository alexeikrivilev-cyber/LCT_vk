# LCT Presentation Compiler

LCT converts an arbitrary corporate PPTX template, source materials, and a brief into a complete editable presentation that follows the template's design logic.

The product is intentionally narrow: understand the template, plan the story once, continuously publish A/B/C slide packs, fill same-type visual slots, audit/repair locally, and export native PPTX/PDF/HTML.

## Product flow

```text
PPTX template + content + brief
  -> template understanding
  -> deck outline / shared DeckPlan
  -> continuous slide packs
       slide 1: A/B/C -> ready
       slide 2: A/B/C -> ready
       ...
  -> same-type visual candidates update slots as they arrive
  -> recommended mixed deck
  -> audit + selective repair
  -> preflight
  -> editable PPTX / PDF / HTML
```

Generation does not stop after each slide pack. The UI progressively exposes ready slides and a non-blocking progress indicator while later slides continue in the background. Users can inspect, switch, or lock ready slides without restarting unrelated pending work.

`CONTEXT.md` is the canonical product contract.

## Runtime target

Semantic inference targets one logical `Qwen/Qwen3.8-27B` service. Worker and Supervisor are distinct application roles with separately constructed request contexts:

```text
shared logical Qwen3.8-27B
  -> Worker      # forward generation
  -> Supervisor  # bounded checkpoint review/repair
```

The model may run on one GPU or be sharded across several devices; Worker and Supervisor do not get separate model replicas. The serving target prewarms reusable role/stage instruction prefixes where supported; the current stateless adapter does not provide session or cache namespaces.

Primary hardware target is a single H100-class GPU. If that profile cannot reliably meet the five-minute gate, the documented fallback is a dual RTX 5090-class sharded profile selected by benchmark rather than assumed linear scaling.

Image/photo slots use the media adapter with `Qwen/Qwen-Image-2.1` as the preferred technical target, subject to the license/compliance gate in `INFERENCE.md`.

A normal 10–15 slide generation has a hard 300-second gate with a warm inference service.

`INFERENCE.md` is canonical for precision, physical GPU topology, sharding, caches/prefixes, scheduling, media residency, and performance gates.

## Current repository state

The repository contains the minimal product shell:

- `apps/web` — Next.js presentation workspace and preview surface.
- `apps/daemon` — Express service, project persistence, safe file transport, catalogs, and current media boundary.
- `skills/` — presentation-specific semantic workflows.
- `design-systems/` — schema plus minimal fallback/reference systems.
- `craft/` — compact presentation craft guidance.
- `templates/deck-framework.html` — neutral HTML preview shell.

Deterministic PPTX structural understanding is implemented: upload a `.pptx` into a project, choose **Analyze as template**, and review the saved `TemplateIR`/structural design summary in the workspace. Recompiling the same source is deterministic; changing the source marks the saved result stale. This scan has partial OOXML/style coverage and does not claim universal arbitrary-template or native rendering compatibility. The workspace also supports planning from a brief and selected `.txt`, `.md`, `.json`, `.csv`, and `.tsv` sources: it compiles user-supplied evidence into `ContentIR`, asks the Worker for a narrative-only `DeckPlan`, runs a bounded Supervisor review, and persists the result across reloads. Local fake-adapter/API tests cover this planning slice. Without semantic inference configuration, template understanding remains available and plan generation returns an actionable configuration error. Actual Qwen serving and Cloud.ru deployment remain unverified; SlidePack generation, rendering, audit, and export remain future work. See [`services/inference/README.md`](./services/inference/README.md).

The current visual UI is temporary and expected to be redesigned. Product/domain contracts are stable; existing screen styling/composition is not.

## Documentation

Start with `AGENTS.md` when working as a coding agent.

- [`CONTEXT.md`](./CONTEXT.md) — canonical product/UX behavior.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — domain/state boundaries and progressive generation.
- [`MODELS.md`](./MODELS.md) — Worker/Supervisor responsibilities, prompts, and skills.
- [`INFERENCE.md`](./INFERENCE.md) — hardware profiles, cache/prefix policy, scheduler, media model, and five-minute gate.
- [`AUDIT.md`](./AUDIT.md) — audit, repair, and preflight.
- [`TESTING.md`](./TESTING.md) — tests, benchmarks, and release gates.
- [`skills/README.md`](./skills/README.md) — skill authoring/cache policy.
- [`design-systems/README.md`](./design-systems/README.md) — design-system package contract.
- [`craft/README.md`](./craft/README.md) — presentation craft references.

## Local development

Requirements:

- Node.js 24
- pnpm 10.33.2
- mise to install and select the project-pinned versions (or install those exact versions with your existing tool manager)

```bash
mise install
mise exec -- node --version
mise exec -- pnpm --version
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm check:boundary
mise exec -- pnpm lint:craft
mise exec -- pnpm test
mise exec -- pnpm typecheck
mise exec -- pnpm build
mise exec -- pnpm dev
```

`.node-version`, `mise.toml`, and the root `packageManager` field pin the project toolchain. Keep `pnpm-lock.yaml` in sync with package manifests and use `--frozen-lockfile` for clean installs.

If the pinned Node.js and pnpm versions are already active in your shell, run the `pnpm` commands directly; `mise` is only needed for selecting/installing those versions.

Runtime data defaults to `.lct/`. The current server/media adapter remains deliberately small and provider details must not leak into presentation-domain contracts.

## Scope

In scope: unseen PPTX templates, template decomposition, content/outline planning, continuous A/B/C slide generation, same-type visual alternatives, charts/tables/diagrams/icons/SmartArt-like structures, image generation, locks/local regeneration, selective repair, native export, two-agent semantic inference, versioned skills, tests, and reproducibility.

Out of scope unless a concrete requirement appears: multiplayer collaboration, enterprise permissions, marketplace/community systems, video/audio generation, mobile apps, generic website/prototype generation, universal vector editing, and a large external research/fact-checking subsystem.

## Verification

Before finishing a change, run the checks applicable to it. `TESTING.md` defines coverage for parser/planner/variants, progressive publication, local edits during background generation, audit/locks/export, prompt-prefix warmup, independent two-agent request contexts, hardware profiles, media inference, and the five-minute end-to-end gate.
