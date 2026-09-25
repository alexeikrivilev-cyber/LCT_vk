# Architecture

## Goal

The system is a presentation compiler. It converts an arbitrary PPTX template plus user content into constrained internal state, makes semantic decisions with models, renders native presentation objects deterministically, audits the result, and exports editable deliverables.

Implementation details may evolve. The boundaries and state semantics below are architectural invariants.

## Runtime topology

```text
Browser / Next.js
      |
      | REST + persisted-state polling (current generation UI)
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
- bounded ContentIR v1 compilation for selected text, Markdown, JSON, CSV/TSV, image references, and inventory-only unsupported files;
- validated Brief v1 and narrative-only DeckPlan v1 planning through the semantic adapter, with bounded Supervisor review/repair/re-plan;
- project-local planning persistence, input-fingerprint staleness checks, planning API, and a compact workspace planning panel;
- a replaceable offline presentation-engine experiment that maps a persisted DeckPlan and ContentIR into three template-aware layout tracks, with explainable layout candidates;
- a native OOXML PPTX writer that preserves the source package's master/theme/layout parts and emits editable text plus a native table when referenced CSV cells form a rectangular grid;
- deterministic pre-render geometry/provenance/numeric checks, one bounded alternate-layout repair attempt, and an offline matrix runner for supplied PPTX templates;
- a typed, replaceable contextual-audit port for the existing Supervisor capability, covered by a local fake test and no model invocation;
- live HTML preview with relative resources;
- built-in design-system and skill discovery;
- image-generation adapter;
- provider-neutral semantic inference port and OpenAI-compatible adapter, verified with local fake HTTP tests;
- Cloud.ru Docker RUN development/benchmark artifact (deployment and model serving unverified);
- presentation-oriented Node/TypeScript runtime;
- PPTX/PDF primitives available to the daemon.

The planning vertical slice is implemented through persisted DeckPlan and API/UI presentation. ContentIR v1 deterministically compiles user-supplied `.txt`, `.md`, `.json`, `.csv`, and `.tsv` text; images become references and other binary files are inventory-only with warnings. It does not parse PDF/Office content, create semantic summaries, or perform research. The offline compiler supports source-backed text, rectangular tables, limited numeric charts, KPI/process objects, and PNG/JPEG images through the selectable Office Kit renderer; its custom fallback writes editable text and rectangular tables. Phase 2 connects a ready persisted planning result to application generation: one shared DeckPlan and ContentIR are compiled as ordered A/B/C slide packs, rendered and deterministically audited, then exposed through persisted REST snapshots to the UI. The application can select a default track or per-slide variants, lock ready slides, apply a bounded local layout repair, and export selected/mixed or whole-track PPTX files. This path makes no inference calls after planning. Image generation, PDF/HTML export, semantic slide audit, and native Office visual qualification are not implemented by this slice. Inherited style fidelity, rendered overflow, and final visual quality remain unverified. The inference adapter carries caller-supplied stateless requests; it does not create persistent Worker/Supervisor sessions or KV namespaces. Template understanding v1 is a deterministic structural scan and does not establish universal arbitrary-template compatibility.

### Offline slide compilation spike

The replaceable presentation-engine slice has these boundaries:

```text
persisted ContentIR + Brief + DeckPlan
TemplateIR/PDS
        -> evidence-based layout matcher + A/B/C variant policy
        -> replaceable CompiledPresentation
        -> custom or Office Kit PPTX renderer
        -> deterministic audit + optional Office Kit preview
```

The compiler copies DeckPlan takeaways and referenced ContentIR text/cells without rewriting claims. `DeckPlan` supplies narrative intent and factual references; optional `mediaRefs` point only to image media units and stay separate from factual `contentRefs`. `TemplateIR` supplies measured layout geometry and source parts. `CompiledPresentation` records layout evidence, exact text, source-backed table/chart/KPI/process/image payloads, provenance, and placements. Layout matching uses placeholder types and measured geometry; declared layout names are diagnostics only. A replaceable `TemplateSemanticProfiler` may add semantic archetypes and title/body/visual role hints for real template slides. Its strict output is validated against the exact `TemplateIR` before use and cached in project-owned storage by `TemplateIR.hash`; the profile affects selector ranking and role mapping, while deterministic projection, content-fit, relationship, geometry, duplicate-composition, and audit gates still decide whether a donor is safe. It does not mutate `TemplateIR` or make rendering decisions.

The three policies change layout ranking while a canonical factual payload test proves that claims and provenance remain equal. The offline matrix runner validates and reuses one saved plan across supplied PPTX templates and records native object counts, validation/reopen/preview/preservation status, audit reports, replay metadata, and timings. Deterministic replay makes zero inference calls. Its separate local-semantic qualification mode uses the existing OpenAI-compatible adapter against the local fake endpoint to profile each unique template hash once; it records per-variant selector/candidate evidence for every template, withholds all output for a blocked template, and renders/previews only templates that pass the distinct-safe-composition gate. Five valid synthetic template families exercise 15 outputs. This remains a developer command, not a production API or progressive SlidePack generator.

The default remains the custom OOXML renderer until the reuse gate is met. The pinned Office Kit backend is selectable behind the same replaceable renderer port and uses its document/layout/shape/table/chart/image/connector APIs. Structural evidence and, when available, validated semantic role hints inform the deterministic selector. Only candidates that pass donor mapping, projection safety, content-fit, and relationship gates are duplicated; mapped title/body text is replaced while supported template chrome is retained. Source-specific text and notes are removed. It records a warning when `setShapeText` may collapse secondary mixed-run styling. Unsupported or ambiguous exemplars use the existing generated-slide path only when compilation has a supported measured layout and safe native placeholders; otherwise compilation fails closed. The backend retains and byte-checks masters/layouts/theme/media/opaque package parts, reopens and validates the output, and reports unsupported visuals explicitly. The backend supports source-backed PNG/JPEG images with contain fit; crop authoring exists in the donor API but the current DeckPlan/CompiledPresentation does not carry crop intent. WebP is rejected. Native notes are not generated because the semantic plan has no notes contract.

`OfficeKitPreviewAdapter` provides SVG/PNG and text-layout checks for diagnostics. It is not a PowerPoint visual oracle, and table-cell text overflow remains unaudited. The production-useful offline harness `scripts/compare-pptx-backends.mjs` verifies an immutable template with a no-op save/reopen and a generated slide, then reports preservation and preview evidence. One read-only held-out AIOS deck passed its generation, reopen, package, preview, and source-identity checks using an actual duplicated exemplar; the generated slide remains sparse because source-specific content is cleared. The harness decision remains `SAFE_FOR_OFFICE_KIT_BACKEND=no` until broader held-out coverage and a PowerPoint/LibreOffice open-save pass are available. See [ADR-001](decisions/ADR-001-office-kit-renderer-spike.md) for exact adoption gates.

## Canonical pipeline

```text
PPTX -> deterministic ingest/OOXML parse -> TemplateIR -> PresentationDesignSystem
selected user sources + Brief -> ContentIR

TemplateIR + PresentationDesignSystem + ContentIR + Brief
  -> Worker -> canonical DeckPlan -> bounded Supervisor plan review
  -> persisted planning state / API / UI

  -> persisted PresentationGenerationState
  -> continuous slide-pack pipeline (implemented)
       slide 1: A/B/C -> validate/render/audit -> publish
       slide 2: A/B/C -> validate/render/audit -> publish
       ...
       slide N: A/B/C -> validate/render/audit -> publish
  -> image candidates (target; not implemented)
  -> targeted semantic review/repair (target; current repair is deterministic layout-only)
  -> SelectedDeck
  -> PPTX assembly, reopen and package validation (implemented)
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

Generation state is durable SQLite application state, not model-chat state. The current daemon exposes it through REST snapshots, and the web client polls while generation is active. The persisted snapshot is authoritative after reconnect or restart. No SSE/WebSocket event bus is used in this slice.

The current daemon has no authentication boundary and rejects non-loopback bind addresses. Exposing its project, upload, inference, media, or export API to another machine requires authentication before the bind policy can change.

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

The snapshot carries project/generation ids, revision and monotonic ready-slide progress, plus stable slide ids. A future streaming transport may notify the client of these state changes, but it must not replace persisted state as the source of truth.

Do not make the browser connection the source of truth for a running generation.

## Sources of truth

### Original template

The uploaded PPTX is immutable. Never destructively normalize the only copy.

### `TemplateIR`

Implemented v1 records exact source identity, slide dimensions, master/layout/slide relationships, placeholder identity, observed direct and resolved geometry with provenance, selected direct style facts, partial theme colors/fonts, explicit or scheme-reference backgrounds and color-map observations, notes/media part inventories, unsupported details, and warnings under deterministic source-scoped IDs. Background fills preserve basic kind, attributes, color nodes, and image relationship identity; gradient/image fill geometry and nested color transforms are not fully represented, and theme system colors retain their fallback color only. Master/layout nested group members are inventoried; geometry affected by unsupported group rotation/reflection remains unresolved. Theme/style coverage is partial; chart/table internals and inherited style cascades are not interpreted, and missing facts remain unknown. The uploaded PPTX remains immutable.

### `PresentationDesignSystem`

The implemented v1 is a deterministic structural summary referencing `TemplateIR`: canvas/aspect ratio, observed fonts and sizes, recurring direct colors, source layouts with placeholder/element counts and usage, and asset references. It does not assign semantic layout labels or infer a typography hierarchy. Future rules may extend this derivative when supported by evidence.

### `ContentIR`

Implemented v1 is a deterministic, provenance-preserving compilation of selected user-supplied files. It keeps exact source identity/hash and byte locators; extracts bounded text/Markdown heading units, JSON values with lexical numbers, CSV/TSV cells, and image references. Unsupported files retain metadata/hash and a warning. It performs no model interpretation or web research. Rich semantic structures such as inferred claims, comparisons, chronology, or processes remain future work.

### `DeckPlan`

Implemented v1 persists a strictly validated narrative plan: working title, narrative summary, and slides with app-assigned ids/order, narrative role, purpose, takeaway, valid ContentIR references, bounded semantic visual type, and target density. It contains no unrestricted absolute geometry or renderer objects.

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

The replaceable compiler profile uses explicit measured layout slots first. If those are absent, it may derive title/body/visual slots from repeated slide-level geometry and typography observed in `TemplateIR`, retaining confidence and source evidence without mutating `TemplateIR` or `PresentationDesignSystem`. Insufficient or ambiguous evidence makes the layout incompatible; there is no generic coordinate fallback.

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
