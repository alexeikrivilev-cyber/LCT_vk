# Architecture

## Goal

The system is a presentation compiler. It converts an arbitrary PPTX template plus user content into a constrained internal representation, makes semantic decisions with models, renders native presentation objects deterministically, audits the result, and exports editable deliverables.

Implementation details may evolve. The boundaries in this document are architectural invariants.

## Runtime topology

```text
Browser / Next.js
      |
      | HTTP
      v
Presentation daemon / Express
      |
      +-- project + file persistence
      +-- presentation application service
      |     +-- template compiler
      |     +-- content compiler
      |     +-- deck planner
      |     +-- variant engine
      |     +-- visual engine
      |     +-- renderer/exporter
      |     +-- deterministic audit
      |     +-- repair / preflight
      |
      +-- semantic inference adapter
      |        |
      |        v
      |   GPU inference host
      |     +-- scheduler / deadline manager
      |     +-- one Qwen3.8-27B weight set
      |     +-- worker session + KV cache
      |     +-- supervisor session + KV cache
      |
      +-- image adapter
               |
               v
          Qwen-Image media service
```

`apps/web` is a client. Presentation-domain logic belongs in `apps/daemon` or future presentation-specific services, not in React components.

The GPU serving implementation may be Python and may use a dedicated inference engine. The daemon talks to it through narrow adapters. Serving-engine types, CUDA details, and provider request objects must not leak into presentation domain contracts.

`INFERENCE.md` is the canonical source for precision, cache isolation, GPU residency, request scheduling, and the five-minute deadline.

## Current foundation

Implemented today:

- project persistence and safe project files;
- source upload;
- text-source editing;
- live HTML preview with relative resources;
- built-in design-system and skill discovery;
- image-generation adapter;
- presentation-oriented Node/TypeScript runtime;
- PPTX/PDF primitives already available to the daemon.

The compiler and GPU-orchestration modules below are target architecture for the next implementation stages. Documentation must distinguish implemented behavior from target behavior.

## Canonical pipeline

```text
PPTX
  -> ingest + OOXML parse
  -> TemplateIR
  -> PresentationDesignSystem
content package
  -> ContentIR

TemplateIR + PresentationDesignSystem + ContentIR + brief
  -> worker: DeckPlan
  -> supervisor: bounded plan review
  -> SlideSpec candidates A/B/C
  -> deterministic render + audit
  -> supervisor: targeted slide review/repair
  -> VisualSlot candidates A/B/C
  -> image generation only for image slots
  -> supervisor: targeted visual review
  -> SelectedDeck
  -> native renderer
  -> deterministic audit
  -> contextual audit / bounded repair
  -> preflight
  -> PPTX / PDF / HTML
```

Each arrow is a typed/validated boundary. Do not allow one giant agent call to own the whole pipeline. The supervisor is a shadow review/repair role, not a second independent generation pipeline.

## Sources of truth

### Original template

The uploaded PPTX is immutable. Keep it available throughout generation/export. Never destructively normalize the only copy.

### `TemplateIR`

Exact structural facts extracted from PPTX/OOXML:

- slide dimensions;
- masters/layouts;
- relationships;
- placeholder types and geometry;
- shape/text properties;
- theme/font/color data;
- assets;
- existing charts/tables;
- stable source identifiers.

Exact information is parsed by code, not inferred from screenshots.

### `PresentationDesignSystem`

A compact derivative used by planning and rendering. It contains semantic tokens, layout/composition families, typography hierarchy, chart/table/image conventions, reusable assets, and rules. It references exact `TemplateIR` entities instead of duplicating or approximating them.

A model may help label semantics, but deterministic values remain sourced from the PPTX.

### `ContentIR`

Normalized user material needed for planning: sections, statements, metrics, series, comparisons, chronology, entities, processes, tables, images, and other useful content units.

### `DeckPlan`

Narrative decisions only:

- slide order;
- slide purpose;
- takeaway;
- supporting content references;
- semantic visual type;
- target density.

`DeckPlan` does not contain free-form absolute geometry.

### `SlideSpec`

A renderable presentation decision:

- stable slide/variant id;
- selected template layout/layout family;
- slot-to-content mapping;
- text/content;
- visual-slot references;
- style references;
- lock state;
- lineage/version metadata.

Any custom geometry introduced by deterministic layout code must remain constrained by template rules.

### `VisualSlotSpec`

One semantic visual type plus candidates of that same type. Candidate selection can change content/treatment; it cannot silently change the slot type.

### `AuditFinding`

A structured finding tied to slide/object ids with deterministic/contextual provenance and an optional local repair action. See `AUDIT.md`.

### `SupervisorDecision`

A structured runtime review result tied to an immutable checkpoint version. It may contain pass/warn/repair/local-replan status, target ids, findings, and bounded patch operations.

A `SupervisorDecision` is advisory until validated by the application/mutation layer. Stale-version and lock-conflicting decisions are rejected.

## Layer responsibilities

### 1. Ingest and template compiler

Responsibilities:

- validate PPTX input;
- unzip/parse OOXML safely;
- build stable ids for masters/layouts/slides/placeholders/assets;
- preserve relationships needed for native output;
- render source-slide previews when useful;
- derive semantic layout/composition labels;
- emit `TemplateIR` and `PresentationDesignSystem`.

Prefer round-trip-safe handling. Unknown XML/features should be preserved when possible rather than deleted because the parser does not understand them.

### 2. Content compiler

Normalize the supplied content package into `ContentIR`. Keep this bounded to information needed by presentation planning; do not grow it into a generic research platform.

### 3. Deck planner / worker

The worker produces structured `DeckPlan` data: narrative, slide intents, takeaway-style titles, content allocation, and semantic visual types.

Planning occurs before expensive slide rendering. Batch decisions where practical so the runtime does not spend the five-minute budget on dozens of tiny semantic calls.

### 4. Supervisor review

The supervisor reviews versioned checkpoints using the same semantic model weights with a separate instruction/context and separate KV-cache namespace.

It is allowed to:

- detect semantic inconsistencies and likely design failures;
- review screenshots when visual evidence matters;
- prioritize deterministic findings that need semantic repair;
- propose bounded patch operations;
- request a local re-plan when a repair changes meaning or visual type.

It is not allowed to:

- create a competing full deck;
- bypass lock/mutation validation;
- write OOXML;
- invent unrestricted coordinates;
- turn every worker operation into a mandatory serial review.

See `MODELS.md` and `INFERENCE.md`.

### 5. Layout resolver and variant engine

For each planned slide:

1. retrieve layouts compatible with the slide intent and slots;
2. reject candidates that violate deterministic constraints;
3. rank/select valid structures;
4. build A/B/C `SlideSpec` variants with controlled differences.

A/B/C variants share meaning but differ in composition/density/grouping/visual treatment. Keep coherent track labels so Deck A/B/C can also be reconstructed.

Do not generate three unrelated decks independently.

### 6. Visual engine

After a visual slot type is fixed, create/select up to three candidates inside that type.

Examples:

- image slot -> image A/B/C;
- chart slot -> chart treatment A/B/C;
- diagram slot -> diagram A/B/C.

The system selects a default candidate. Type changes route back through planning/layout resolution.

Only image/photo slots should require the image-generation model. Charts, tables, diagrams, icons, and SmartArt-like structures should remain native/deterministic where practical.

### 7. Native renderer

The renderer is deterministic. It consumes validated specs and template references, then creates native PPTX objects.

Prefer original masters/layouts and reusable template assets. HTML may be generated for preview/export, but HTML DOM/CSS is not the canonical representation for PPTX.

Whole-slide rasterization is prohibited as a normal export strategy. Isolated raster assets are acceptable when the semantic object is inherently raster or unsupported and the slide remains structurally editable.

### 8. Audit and repair

Run deterministic checks after rendering and contextual checks against the rendered slide/spec where needed.

Deterministic audit should run before expensive supervisor review so the supervisor sees focused evidence instead of rediscovering machine-checkable failures.

Repair operates on specific findings and returns a new local spec/render. It must preserve locks and unrelated selections.

### 9. Export/preflight

Preflight validates file integrity, template compliance, geometry, editability, and unresolved blocking findings. Export produces native PPTX and derivative PDF/HTML.

## Two-agent inference boundary

The worker and supervisor are two logical agents, not two model processes.

Required invariant:

```text
one Qwen3.8-27B weight set
        |
        +-- worker request history / KV cache
        +-- supervisor request history / KV cache
```

Mutable cache/history is isolated. Shared immutable model weights are required. Engine-level immutable prefix reuse is acceptable only when it does not merge agent histories.

The application service owns checkpoint versions and state transitions. The model server never becomes the source of truth for project/deck state.

## GPU scheduler and deadline boundary

All semantic/media inference goes through a small GPU scheduler/arbiter described in `INFERENCE.md`.

The scheduler must:

- distinguish worker, supervisor, and media workloads;
- preserve cache/session isolation;
- prioritize worker forward progress;
- cancel stale requests;
- bound supervisor token/retry budgets;
- expose deadline remaining;
- collect latency/KV/VRAM telemetry.

A normal 10–15 slide deck has a hard 300-second generation budget. Treat this as an architectural requirement, not a late optimization.

The runtime must be warm before accepting timed generation. Cold startup is measured separately.

## Mutation and lock semantics

All regeneration/repair mutations must pass through a lock-aware mutation boundary.

A lock identifies stable object/slide ids, not ephemeral array indexes. Mutation code must either preserve the lock or return a conflict explaining why the requested operation cannot be completed.

Do not rely on prompt wording alone to preserve locks.

Supervisor repair uses the same mutation boundary; it has no privileged path around locks.

## Model boundary

Models are semantic components, not renderers.

Allowed model decisions include narrative, wording, semantic layout ranking, visual type, candidate ranking, contextual audit, and bounded repair suggestions.

Programmatic code owns exact template values, layout compatibility, geometry, object construction, persistence, locks, deterministic audit, deadline accounting, and export.

See `MODELS.md`.

## Persistence

A project should be able to persist, at minimum:

```text
original template
derived template/design-system state
source content
brief
DeckPlan
slide variants
visual candidates
current selections
locks
audit results
checkpoint versions
supervisor findings/accepted repairs
export metadata
prompt/skill/model versions used
inference profile + media profile
```

Persist stable ids and version metadata so local regeneration does not invalidate unrelated state.

Do not persist opaque mutable KV-cache blobs as canonical product state. Agent caches are runtime acceleration/state and may be rebuilt from structured checkpoints when necessary.

## Performance

A normal 10–15 slide deck must complete within 300 seconds.

Use concurrency where work is independent:

- render/analyze independent source slides;
- generate slide candidates after the shared plan exists;
- render/audit independent slides in parallel;
- batch compatible image-generation jobs;
- let supervisor review completed batches while the worker continues when the scheduler has capacity.

Do not parallelize work that duplicates planning, creates conflicting state, or causes GPU thrash.

Prefer one shared semantic model instance with two bounded caches over two replicas. Choose FP8/BF16/FP16 from end-to-end benchmark evidence as defined in `INFERENCE.md`.

## Target module layout

The exact files may change, but the dependency shape should converge toward:

```text
apps/daemon/src/presentation/
  domain/
  template/
  content/
  planning/
  variants/
  visuals/
  render/
  audit/
  repair/
  export/
  application/
  adapters/

services/inference/             # optional Python/service boundary
  semantic/
  scheduler/
  media/
  telemetry/
```

`services/inference/` is a logical boundary, not a requirement to create a new workspace before needed. The implementation may live elsewhere if the same dependency direction is preserved.

Domain contracts should not import HTTP, React, CUDA, Diffusers, or provider SDKs. HTTP routes call application services; application services orchestrate domain engines and adapters.

## Architectural change policy

An implementation is free to choose algorithms and local abstractions. A change requires documentation review when it alters:

- a source of truth;
- a domain boundary;
- model-vs-code responsibility;
- worker/supervisor role boundaries;
- cache/session isolation;
- GPU scheduling or deadline semantics;
- variant/visual semantics;
- lock behavior;
- native export strategy;
- audit/preflight gating;
- a major runtime dependency/service or model.

If a rule proves important repeatedly, prefer encoding it in tests or structural checks instead of adding more prose to `AGENTS.md`.
