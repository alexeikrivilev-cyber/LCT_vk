# Architecture

## Goal

The system is a presentation compiler. It converts an arbitrary PPTX template plus user content into constrained internal state, makes semantic decisions with models, renders native presentation objects deterministically, audits the result, and exports editable deliverables.

Implementation details may evolve. The boundaries and state semantics below are architectural invariants.

## Runtime topology

```text
Browser / Next.js
      |
      | HTTP + incremental generation events
      v
Presentation daemon / Express
      |
      +-- project + file persistence
      +-- presentation application service
      |     +-- template compiler
      |     +-- content compiler
      |     +-- deck planner
      |     +-- slide-pack generator
      |     +-- visual engine
      |     +-- renderer
      |     +-- deterministic audit
      |     +-- repair / preflight / export
      |
      +-- semantic inference adapter
      |        |
      |        v
      |   logical Qwen3.8-27B service
      |     +-- Worker request/context (supplied by caller)
      |     +-- Supervisor request/context (supplied by caller)
      |     +-- optional shared immutable prefix reuse
      |     +-- scheduler/deadline manager
      |
      +-- image adapter
               |
               v
          Qwen-Image media service
```

`apps/web` is a client. Presentation-domain logic belongs in `apps/daemon` or presentation-specific services, not in React components.

The semantic inference service may run on one physical GPU or span multiple GPUs. Physical placement, precision, sharding, prompt-prefix warmup, and scheduler policy are defined in `INFERENCE.md`; domain code must see one logical inference boundary.

## Current foundation

Implemented today:

- project persistence and safe project files;
- source upload and text-source editing;
- deterministic PPTX structural inspection, canonical `TemplateIR` v1 mapping, and a structural `PresentationDesignSystem` summary;
- on-demand project template compilation through the daemon API, persisted in a project-local hidden JSON sidecar with source-hash invalidation;
- a workspace panel for observed canvas, slides, masters/layouts, theme/style facts, assets, unsupported features, and warnings;
- live HTML preview with relative resources;
- built-in design-system and skill discovery;
- image-generation adapter;
- provider-neutral semantic inference port and OpenAI-compatible adapter, verified with local fake HTTP tests;
- Cloud.ru Docker RUN development/benchmark artifact (deployment and model serving unverified);
- presentation-oriented Node/TypeScript runtime;
- PPTX/PDF primitives available to the daemon.

Content ingestion, narrative planning, progressive generation, native rendering, audit/export, and actual GPU serving/orchestration described below remain target architecture. The inference adapter carries caller-supplied stateless requests; it does not create persistent Worker/Supervisor sessions or KV namespaces. Template understanding v1 is implemented as a deterministic structural scan; it does not establish universal arbitrary-template compatibility.

## Canonical pipeline

```text
PPTX -> deterministic ingest/OOXML parse -> TemplateIR -> PresentationDesignSystem
content package -> ContentIR

TemplateIR + PresentationDesignSystem + ContentIR + brief
  -> worker DeckPlan
  -> bounded supervisor plan review
  -> continuous slide-pack pipeline
       slide 1: A/B/C -> validate/render/audit -> publish
       slide 2: A/B/C -> validate/render/audit -> publish
       ...
       slide N: A/B/C -> validate/render/audit -> publish
  -> visual candidates arrive/update slots asynchronously
  -> targeted supervisor review/repair of completed checkpoints
  -> SelectedDeck
  -> preflight
  -> PPTX / PDF / HTML
```

Do not implement this as one giant agent call or as three unrelated full-deck generations.

## Progressive slide-pack pipeline

A `SlidePack` is the A/B/C candidate set for one `DeckPlan` slide. It is the unit of progressive publication.

Required behavior:

1. create a shared `DeckPlan` first;
2. generate one slide pack from that plan;
3. validate its three `SlideSpec` candidates;
4. render enough state for inspection and run required deterministic checks;
5. persist the pack atomically;
6. emit `slide-pack.ready`/progress state;
7. immediately continue forward generation without waiting for user acknowledgement.

User-visible pack order follows deck order. Internal scheduling may precompute/pipeline adjacent work when that improves throughput, but it must not expose incoherent ordering or partial candidate groups.

The generator stops only when:

- the planned deck is complete;
- the user explicitly pauses/cancels;
- an explicit user change invalidates future plan state and requires a scoped re-plan;
- a blocking failure prevents safe continuation.

Switching a candidate, locking a ready object, or editing a completed slide locally does not pause unrelated future work.

## Incremental state and events

Generation state is durable application state, not model-chat state. The daemon should expose incremental events; transport may be SSE, WebSocket, streaming HTTP, or another suitable mechanism.

Canonical event meanings include:

```text
generation.started
generation.progress
slide-pack.ready
visual-candidates.ready
audit.updated
slide.updated
generation.completed
generation.failed
```

Event payloads carry project/generation/checkpoint ids and stable slide/object ids. The client treats events as state notifications and can always recover current state from persisted project data after reconnect.

Do not make the browser connection the source of truth for a running generation.

## Sources of truth

### Original template

The uploaded PPTX is immutable. Never destructively normalize the only copy.

### `TemplateIR`

Implemented v1 records exact source identity, slide dimensions, master/layout/slide relationships, placeholder identity, observed direct and resolved geometry with provenance, selected direct style facts, partial theme colors/fonts, explicit or scheme-reference backgrounds and color-map observations, notes/media part inventories, unsupported details, and warnings under deterministic source-scoped IDs. Background fills preserve basic kind, attributes, color nodes, and image relationship identity; gradient/image fill geometry and nested color transforms are not fully represented, and theme system colors retain their fallback color only. Master/layout nested group members are inventoried; geometry affected by unsupported group rotation/reflection remains unresolved. Theme/style coverage is partial; chart/table internals and inherited style cascades are not interpreted, and missing facts remain unknown. The uploaded PPTX remains immutable.

### `PresentationDesignSystem`

The implemented v1 is a deterministic structural summary referencing `TemplateIR`: canvas/aspect ratio, observed fonts and sizes, recurring direct colors, source layouts with placeholder/element counts and usage, and asset references. It does not assign semantic layout labels or infer a typography hierarchy. Future rules may extend this derivative when supported by evidence.

### `ContentIR`

Normalized user material needed for planning: sections, claims, metrics, series, comparisons, chronology, processes, tables, images, and supporting content units.

### `DeckPlan`

Narrative decisions only: slide order, purpose, takeaway, content references, semantic visual type, and target density. No unrestricted absolute geometry.

### `SlideSpec`

Renderable decision for one slide variant: stable ids, selected template layout/family, slot mapping, text/content, visual-slot refs, style refs, lock state, and lineage/version metadata.

### `SlidePack`

Three validated `SlideSpec` variants for one planned slide plus a recommended candidate and track labels A/B/C. Pack publication is atomic from the product's point of view.

### `VisualSlotSpec`

One semantic visual type plus candidate state. Candidate selection may change content/treatment, not silently change semantic type.

### `SupervisorDecision`

Structured review result tied to an immutable checkpoint version. It is advisory until validated by the normal mutation layer; stale and lock-conflicting patches are rejected.

### `AuditFinding`

Structured deterministic/contextual finding tied to stable slide/object ids. See `AUDIT.md`.

## Layer responsibilities

### Template and content compilation

Parse exact PPTX facts deterministically, preserve round-trip-relevant unknown structure where practical, derive semantic template labels where useful, and normalize the supplied content package. Do not grow content compilation into a generic research system.

### Worker / deck planning

The worker owns forward semantic generation: narrative, slide intent/takeaway, wording, layout ranking among valid candidates, visual type, A/B/C slide decisions, and requested local semantic edits.

It may batch decisions when useful, but persistent `DeckPlan`/`SlidePack` state remains the application source of truth.

### Supervisor

The supervisor reviews versioned checkpoints using the same logical semantic model. The application supplies its request context independently from Worker calls; the adapter does not provide persistent role sessions or guarantee serving-side KV isolation. It may detect semantic/compositional problems and propose bounded patch operations or local re-plan requests.

It does not create a competing deck, bypass locks, write OOXML, invent unrestricted coordinates, or require approval after every pack. Except for genuine blocking issues, its work is asynchronous to forward slide-pack generation.

### Layout/variant engine

For each planned slide, retrieve compatible layouts, reject invalid candidates deterministically, rank valid structures, and build A/B/C `SlideSpec` variants that preserve meaning while differing in controlled composition/density/grouping/visual treatment.

### Visual engine

Fix semantic visual type first, then produce/select up to three candidates inside that type. Image/photo slots may call the image model. Charts, tables, diagrams, icons, and SmartArt-like structures should remain native/deterministic where practical.

Visual candidate completion is independent of slide-pack publication. A ready structural pack may carry a `generating` image slot; when candidates arrive, persist them and emit `visual-candidates.ready` without blocking generation of later slides.

### Renderer, audit, repair, export

Rendering is deterministic and uses validated specs/template references. Deterministic audit runs as soon as renderable state exists. Repairs are local, lock-aware mutations. Preflight verifies integrity, template compliance, editability, and blocking findings before export.

HTML is a preview/export surface, not the canonical PPTX representation. Whole-slide rasterization is prohibited as a normal export strategy.

## Mutation, locks, and concurrent generation

All mutations use stable ids and expected checkpoint versions.

A local edit to a ready slide and background generation of a future slide may proceed concurrently when their state scopes do not overlap. Conflicting mutations must fail/retry through version checks rather than silently overwrite newer state.

Locks are programmatic constraints, not prompt suggestions. Supervisor repair has no privileged bypass.

## Inference boundary

Models are semantic components, not renderers.

Allowed semantic decisions: narrative, wording, semantic labeling/ranking, visual type, recommended candidate, contextual review, and bounded semantic repair.

Programmatic code owns exact template values, layout compatibility, geometry, native object construction, locks, state/versioning, deterministic audit, scheduler/deadline state, and export correctness.

`MODELS.md` defines role/prompt policy. `INFERENCE.md` defines physical serving/cache/performance policy.

## Persistence

Persist enough structured state to resume/reconnect without relying on model KV cache:

```text
original template
derived template/design-system state
source content + brief
DeckPlan
generation state / next publish index
slide packs A/B/C
visual candidates + generating/ready state
current selections
locks
checkpoint versions
supervisor findings/accepted repairs
audit results
export metadata
prompt/skill/model/inference versions
```

KV caches are runtime acceleration/state only and are never canonical project storage.

## Performance

A normal 10–15 slide deck must complete within 300 seconds with a warm inference service.

Optimize end-to-end flow, not isolated calls:

- precompute/cache guaranteed prompt prefixes as defined in `INFERENCE.md`;
- keep worker forward progress prioritized;
- pipeline deterministic render/audit with semantic generation;
- publish completed slide packs immediately instead of waiting for the full deck;
- batch media jobs where practical;
- review completed checkpoints with the supervisor opportunistically;
- cancel stale work and avoid GPU/model thrash.

Track time-to-first-slide-pack, steady pack cadence, total generation time, media latency, supervisor overhead, queue latency, KV pressure, and peak VRAM.

## Target module shape

Exact files may change; dependency direction should converge toward:

```text
apps/daemon/src/presentation/
  domain/
  template/
  content/
  planning/
  generation/
  variants/
  visuals/
  render/
  audit/
  repair/
  export/
  application/
  adapters/

services/inference/             # optional service boundary
  semantic/
  scheduler/
  media/
  telemetry/
```

Domain contracts do not import React, HTTP transport, CUDA, Diffusers, or provider SDK types.

## Architectural change policy

Review/update documentation when a change alters a source of truth, domain boundary, progressive publication semantics, model-vs-code responsibility, worker/supervisor roles, cache/session isolation, GPU scheduling, variant/visual semantics, lock behavior, native export strategy, audit/preflight gating, or a major runtime dependency/model.

If a rule repeatedly matters, encode it in tests or structural checks instead of expanding `AGENTS.md` indefinitely.
