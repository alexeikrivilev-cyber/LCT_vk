# LCT Presentation Compiler

The product target is to convert a corporate PPTX template, source materials, and a brief into an editable presentation that follows the template's design logic. Current qualification limits are listed below; arbitrary-template support is not claimed.

The product is intentionally narrow: understand the template, plan the story once, continuously publish A/B/C slide packs, fill same-type visual slots, audit/repair locally, and export native PPTX/PDF/HTML.

## Target product flow

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

The intended flow does not stop after each slide pack. The current synthetic application slice progressively exposes ready slides and a non-blocking progress indicator while later slides continue in the background. Users can inspect, switch, or lock ready slides without restarting unrelated pending work.

`CONTEXT.md` is the canonical product contract.

## Runtime target

Semantic inference targets one logical `Qwen/Qwen3.8-27B` service. Worker and Supervisor are distinct application roles with separately constructed request contexts:

```text
shared logical Qwen3.8-27B
  -> Worker      # forward generation
  -> Supervisor  # bounded checkpoint review/repair
```

The model may run on one GPU or be sharded across several devices; Worker and Supervisor do not get separate model replicas. The serving target prewarms reusable role/stage instruction prefixes where supported; the current stateless adapter does not provide session or cache namespaces.

The first development and hackathon qualification target is one A100 80GB using the BF16 Qwen checkpoint. H100 with the official FP8 checkpoint remains the performance/fallback option. Neither profile is claimed to meet the five-minute gate until an end-to-end workload is measured. See [`INFERENCE.md`](./INFERENCE.md) for profile limits and qualification status.

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

Deterministic PPTX structural understanding is implemented: upload a `.pptx` into a project, choose **Analyze as template**, and review the saved `TemplateIR`/structural design summary in the workspace. Recompiling the same source is deterministic; changing the source marks the saved result stale. This scan has partial OOXML/style coverage and does not claim universal arbitrary-template compatibility. The workspace also supports planning from a brief and selected `.txt`, `.md`, `.json`, `.csv`, and `.tsv` sources: it compiles user-supplied evidence into `ContentIR`, asks the Worker for a narrative-only `DeckPlan`, runs a bounded Supervisor review, and persists the result across reloads. One live A100 Qwen3.8-27B path passed a small strict-schema request and a synthetic Worker → Supervisor → persisted-state/reload run with request-level thinking disabled. This does not qualify the 300-second gate or Cloud.ru/VK deployments. From a ready plan, the application now compiles and renders ordered A/B/C slide packs without further inference, persists progress, selections and locks in SQLite, supports deterministic layout-only repair, and exports selected/mixed or whole-track editable PPTX files after reopen and package validation. The web workspace exposes Template, Content/Brief, Plan, Generate and Review/Export stages with incremental persisted-state polling. Offline API end-to-end tests use synthetic PPTX fixtures and zero inference; they do not establish held-out template compatibility or native Office visual fidelity. The presentation engine has a replaceable document/render boundary with the existing custom backend and a selectable Office Kit backend. Production Office Kit adoption remains unqualified until real held-out PPTX and a native Office open/save gate pass. Image generation and PDF/HTML export are not included in this application slice. See [`ARCHITECTURE.md`](./ARCHITECTURE.md), [`AUDIT.md`](./AUDIT.md), [`TESTING.md`](./TESTING.md), [`INFERENCE.md`](./INFERENCE.md), and [`services/inference/README.md`](./services/inference/README.md).

The current visual UI is temporary and expected to be redesigned. Product/domain contracts are stable; existing screen styling/composition is not.

The earlier held-out AIOS compatibility probe at `.lct/compatibility/aios-exemplar-run/` demonstrated a one-slide donor projection, but did not qualify A/B/C composition diversity. The 2026-09-25 selector rerun found no safe content exemplar families in the same 16-slide AIOS PPTX: its available title/body regions failed the normalized content-sanity gates. The diagnostic generated fallback A is editable and reopens, but has no visible AIOS chrome; B/C were withheld because all three fallback signatures are identical. The input SHA-256 remained `18198cc08df9fc3ea5aee5f509d89e70a4ade68bb539fed61a957581ee365ad1`. This is a preview-level diagnostic only; native PowerPoint/LibreOffice open-save and broader held-out coverage remain unverified, so Office Kit is not qualified for production adoption. Detailed ignored artifacts are under `.lct/compatibility/aios-selector-rerun-20260925-verified/`.

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
corepack pnpm dev
```

For an offline planning demo, start the fake OpenAI-compatible endpoint in one terminal:

```bash
corepack pnpm dev:fake-inference
```

Then configure the normal daemon in a second terminal:

```powershell
$env:LCT_SEMANTIC_BASE_URL = 'http://127.0.0.1:8787/v1'
$env:LCT_SEMANTIC_MODEL = 'Qwen/Qwen3.8-27B'
corepack pnpm dev
```

The fake binds to loopback and implements `/v1/chat/completions`. The daemon continues to use `OpenAICompatibleSemanticInferenceAdapter` and its normal strict runtime validation.

`.node-version`, `mise.toml`, and the root `packageManager` field pin the project toolchain. Keep `pnpm-lock.yaml` in sync with package manifests and use `--frozen-lockfile` for clean installs.

The root `dev` command builds and starts the daemon, waits for its health endpoint, then starts the web UI. It shuts both down when you press Ctrl+C. Set `LCT_PORT` and `PORT` to use non-default ports.

If the pinned Node.js and pnpm versions are already active in your shell, run the `pnpm` commands directly; `mise` is only needed for selecting/installing those versions.

On Windows with Node.js 24 installed but Corepack unavailable, use the pinned pnpm release through `pnpm dlx`:

```powershell
pnpm dlx pnpm@10.33.2 install --frozen-lockfile
pnpm dlx pnpm@10.33.2 dev
```

For the offline semantic demo, start `pnpm dlx pnpm@10.33.2 dev:fake-inference` in one terminal and `pnpm dlx pnpm@10.33.2 dev` in the daemon/UI terminal after setting the semantic endpoint variables above.

If `mise` is unavailable but another `pnpm` is installed, run a script with the exact project-pinned pnpm using `pnpm dlx pnpm@10.33.2 <script>` (for example, `pnpm dlx pnpm@10.33.2 test`). This uses pnpm's package cache and does not change the repository's engine requirement.

Runtime data defaults to `.lct/`. The current server/media adapter remains deliberately small and provider details must not leak into presentation-domain contracts.

The daemon API has no authentication and binds only to `localhost` or a loopback IP. Network-facing deployment is unsupported until an authentication boundary is implemented. Uploads accept at most two files per request, each up to 64 MiB; the workspace splits larger selections into bounded requests.

## Scope

In scope: unseen PPTX templates, template decomposition, content/outline planning, continuous A/B/C slide generation, same-type visual alternatives, charts/tables/diagrams/icons/SmartArt-like structures, image generation, locks/local regeneration, selective repair, native export, two-agent semantic inference, versioned skills, tests, and reproducibility.

Out of scope unless a concrete requirement appears: multiplayer collaboration, enterprise permissions, marketplace/community systems, video/audio generation, mobile apps, generic website/prototype generation, universal vector editing, and a large external research/fact-checking subsystem.

## Verification

Before finishing a change, run the checks applicable to it. `TESTING.md` defines coverage for parser/planner/variants, progressive publication, local edits during background generation, audit/locks/export, prompt-prefix warmup, independent two-agent request contexts, hardware profiles, media inference, and the five-minute end-to-end gate.

## Offline presentation matrix

To reuse one successful planning state for five local PPTX templates and generate 15 A/B/C outputs without inference:

```bash
pnpm dlx pnpm@10.33.2 exec node --import tsx scripts/run-offline-presentation-matrix.mjs --state ".lct/projects/<project-id>/.planning/state.json" --out ".lct/experiments/<run-name>" --templates "./templates/template-1.pptx" "./templates/template-2.pptx" "./templates/template-3.pptx" "./templates/template-4.pptx" "./templates/template-5.pptx" --content-root "./projects/<project-id>" --run-metadata "./run-metadata.json"
```

`--content-root` is required when the saved plan references images; it is the project directory used to resolve and hash-check those source files. `run-metadata.json` is optional and may contain only safe labels such as `{"providerKind":"runpod","profile":"A100_BF16","thinkingEnabled":false}`. Endpoint URLs and credentials are ignored. Deterministic replay writes outputs only when A/B/C pass the distinct-composition gate and makes zero inference requests. To exercise the production template-profiling adapter against the local fake and collect per-candidate diagnostics across blocked templates, add `--local-semantic`; it profiles each unique template hash once, previews generated slides, writes outputs only for templates that pass, and records fake call counts. `matrix.json`, `replay.json`, and `diagnostics.json` describe the run. Set `LCT_PPTX_BACKEND=office-kit` for the Office Kit renderer; the default remains the custom backend until the adoption gate passes.

To qualify an individual template offline without overwriting it:

```bash
pnpm dlx pnpm@10.33.2 exec node --import tsx scripts/compare-pptx-backends.mjs "./templates/template.pptx" --out ".lct/compatibility/template-run"
```

The matcher uses explicit measured placeholders first. Where those are absent, it attempts conservative title/body/visual slot inference from repeated geometry and typography on slides sharing a layout; every inferred slot carries confidence and source evidence, and weak or ambiguous evidence fails with `UNSUPPORTED_TEMPLATE_LAYOUT` rather than a generic coordinate fallback. The harness records input safety, LCT/Office Kit inventory, no-op roundtrip, part preservation, source byte identity, generation compatibility, mutation, preview, and native Office status as independent stages. It writes `backend-compatibility-report.json` whenever the separate output directory is available, including when generation is incompatible. Preview remains approximate, and it reports `SAFE_FOR_OFFICE_KIT_BACKEND=no` until a native PowerPoint/LibreOffice open-save check passes.

## Bounded live Qwen qualification

Use the reproducible PowerShell smoke and sequential quality suite in [`LIVE_QUALIFICATION.md`](./LIVE_QUALIFICATION.md). The runner reads the existing `LCT_SEMANTIC_*` adapter settings, caps model calls, persists a replayable planning state, generates local A/B/C outputs without further inference, and keeps endpoint/key values out of its reports. It does not control cloud resources.
