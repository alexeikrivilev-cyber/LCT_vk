# Testing and evaluation

## Goal

Tests must prove the system works on unseen templates, preserves domain/runtime contracts, publishes usable results progressively, and completes a normal deck within 300 seconds. Isolated green unit tests are insufficient if the end-to-end product stalls, leaks agent state, or misses the deadline.

The main regression surface is:

```text
unknown PPTX + content + brief
  -> template/design-system compilation
  -> shared DeckPlan
  -> continuous A/B/C slide packs
  -> incremental visual candidates
  -> audit/repair
  -> selected native deck
  -> preflight/export
```

## Repository checks

Run the relevant commands before finishing work:

```bash
pnpm check:boundary
pnpm lint:craft
pnpm test
pnpm typecheck
pnpm build
```

`pnpm lint:craft` is required when skill/craft bindings change. Typecheck/build are required when the corresponding code paths change.

`pnpm test` runs the Node built-in suite for project-file safeguards, ContentIR/Brief/DeckPlan contracts, planning API persistence and review bounds, the private Python inspector, the deterministic TemplateIR/PDS mapper, the template compile API, replaceable slide compilation/layout matching/native OOXML rendering/audit/matrix tooling, craft-reference tooling, the semantic inference adapter, and the inference benchmark harness. Inference and planning tests use fake adapters/local fake HTTP servers; they do not contact Cloud.ru, download model weights, or require a GPU. Planning API coverage includes reload, PASS/WARN/REPAIR/LOCAL-REPLAN, exactly one revision Worker call without recursive Supervisor review, duplicate slide-id rejection, invalid references/repair targets/checkpoints, image metadata exclusion from Worker evidence and factual citations, malformed review output, changed brief/source/template/prompt staleness, and lazy actionable inference-configuration failure. Synthetic Transitional and Strict OOXML fixtures exercise the implemented structural-inspection path, including linked versus ambiguous themes, nested master/layout groups, direct sRGB/scheme/system color observations, slide/master/layout backgrounds and color-map evidence, unresolved rotated group geometry, and notes inventory. These tests do not imply full arbitrary-template compatibility, inherited style resolution, automatic semantic entailment verification, rendered PowerPoint compatibility/visual quality, actual inference quality/serving, progressive SlidePack generation, or production export integration.

The Template Compiler integration test uploads a synthetic PPTX through the project API, compiles and reloads its canonical state across a daemon restart, checks stable hashes and source-byte immutability, detects source changes as stale, and verifies controlled missing/invalid-file behavior, failed-path sanitization, and preservation of the last successful result. Mapper tests separately check deterministic IDs/hashes, exact relationships/placeholders/geometry/style/background facts, unsupported/warning retention, and PDS references to valid TemplateIR entities.

## Planning quality runs

Five small fictional cases for repeatable manual model checks live in `apps/daemon/test/fixtures/planning-scenarios/`. Upload a case's `source.md`, compile a template, and use its `brief.json` for one planning run. Save a copy of the resulting `.planning/state.json` outside the project data folder. Compare one or more saved states with:

```bash
node --import tsx scripts/evaluate-planning-runs.mjs run-1/state.json run-2/state.json
```

The evaluator calls the production ContentIR, Brief, DeckPlan, and Supervisor-review validators and reports slide count, references, persisted readiness, outcome, available request latencies, and Worker/Supervisor `finish_reason` values when present. It leaves unsupported-claim count and subjective content/narrative/visual review as `null`. Historical schemaVersion 1 states without finish reasons report `null`. The evaluator makes no inference requests and writes a result file only when `--out <path>` is supplied.

## Offline compile and replay matrix

The replaceable matrix runner reads one successful persisted planning state, validates its Brief/ContentIR/Worker checkpoint/final DeckPlan/Supervisor result, parses three local PPTX templates, and reuses the same plan for A/B/C compilation against each template. It has no inference adapter. It writes nine PPTX files, per-variant audit reports, `matrix.json`, a secret-filtered `replay.json`, and `diagnostics.json`.

```bash
pnpm dlx pnpm@10.33.2 exec node --import tsx scripts/run-offline-presentation-matrix.mjs --state ".lct/projects/<project-id>/.planning/state.json" --out ".lct/experiments/<run-name>" --templates "./templates/template-1.pptx" "./templates/template-2.pptx" "./templates/template-3.pptx" --run-metadata "./run-metadata.json"
```

The optional metadata file accepts only `providerKind` (`runpod`, `cloudru`, `vk`, `local`, or `unknown`), a known `profile`, and boolean `thinkingEnabled`. It does not copy endpoint URLs or credentials. Worker/Supervisor temperature, token limits, prompt versions, persisted structured results, model alias, timestamps, latency, and `finishReason` are taken from known application settings and the saved state when available; historical states without finish reasons report `null`. `contentParsing`, repair, and separate PDF/HTML export timings remain unknown/not run; the runner records the stages it measures instead of inventing timings.

The current writer keeps the source package's master/theme/layout parts and writes native editable text shapes and native tables from complete rectangular CSV references. The output slide list contains only generated slides; original sample slides are left as unreferenced package parts. Tests reopen generated OOXML with the local PPTX inspector and assert editable text, table rows, slide/layout relationships, and no full-slide picture object. They do not open the artifact in PowerPoint/LibreOffice or validate rendered overflow, inherited style fidelity, chart/image/diagram output, or production API/UI integration. Matrix tests generate their artifacts in a temporary directory and remove them after verification.

## Deterministic unit tests

Prioritize exact programmatic contracts:

- OOXML/PPTX parsing and unit conversion;
- template token/style extraction;
- layout compatibility and slot mapping;
- `DeckPlan`/`SlideSpec`/`SlidePack` validation;
- stable ids/checkpoint/version conflict detection;
- lock-aware mutation;
- generation queue and next-publish-index logic;
- density and deterministic audit rules;
- event/state serialization;
- export relationships/native object construction;
- deadline accounting/scheduler priority rules.

The current compiler tests additionally verify repeated compilation determinism, three whole-deck layout tracks from one plan, template-name independence, explicit source-backed CSV table cells, numeric/provenance findings, one bounded layout repair, generated PPTX reinspection, and exactly nine matrix outputs with zero inference calls.

Use small fixtures and exact assertions.

## Golden template fixtures

Maintain compact PPTX fixtures with known expected extraction results: masters/layouts, placeholder geometry/types, theme colors/fonts, repeated assets, charts/tables, and unusual valid structures.

Compare normalized `TemplateIR`/design-system state, not unstable ZIP timestamps or irrelevant relationship ordering.

## Progressive-generation integration tests

This is a first-class product contract.

Test a multi-slide `DeckPlan` and verify:

- generation starts once and does not require acknowledgement between slides;
- slide packs become visible incrementally before the full deck is complete;
- each published pack contains all three A/B/C structural candidates and one recommended default;
- visible pack order follows deck order even if internal work is pipelined;
- progress is monotonic and reconnect can recover current persisted state;
- Worker begins/continues future slide work after publishing the previous pack;
- local selection/lock/edit on a ready slide does not pause or reset unrelated pending slides;
- a scoped future-plan change invalidates only the affected pending scope;
- explicit pause/cancel stops forward generation cleanly;
- a blocking failure preserves already-ready slide packs/project state.

Test incremental events such as `generation.progress`, `slide-pack.ready`, `visual-candidates.ready`, `audit.updated`, and terminal completion/failure. The exact transport may vary; event meanings/state recovery may not.

## Variant invariants

For every planned slide:

- three candidates exist when the pack is published;
- candidates preserve the same core intent/takeaway;
- each candidate uses an allowed template layout/family;
- coherent Deck A/B/C tracks can be reconstructed;
- a user-selected mixed deck remains valid.

For visual slots:

- candidate type equals the planned semantic type;
- candidate switching does not silently change type/layout semantics;
- explicit type change goes through re-plan;
- image generation is used only for image/photo slots unless a documented exception exists;
- a structural slide pack may be ready while an image slot is still `generating`, then updates in place when three candidates arrive.

## Lock and concurrent-mutation tests

Verify:

- locked slide survives unrelated background generation;
- locked visual survives slide-local regeneration;
- Worker/Supervisor repair targeting another object does not alter locks;
- conflicting mutations fail/retry by checkpoint version rather than overwrite newer state;
- save/reload preserves lock ids and generation progress;
- user edits on completed slides and background generation of later slides can coexist safely when scopes do not overlap.

## Worker/Supervisor tests

The local adapter tests exercise separately constructed Worker/Supervisor requests against a fake service. They do not prove model quality, remote request routing, persistent sessions, or GPU overlap. Full product tests should verify Supervisor is bounded and asynchronous to normal forward progress.

Verify:

- one logical semantic model serves both roles;
- Worker/Supervisor messages and mutable application context are supplied independently;
- do not infer distinct serving sessions or KV-cache namespaces from application role labels;
- Supervisor output is tied to a checkpoint version;
- stale/invalid/lock-conflicting patches are rejected;
- `local-replan` routes through Worker/application state;
- Supervisor cannot bypass deterministic validation/render/export;
- low-value repeated warnings are bounded/deduplicated;
- Supervisor can inspect screenshots where visual context matters;
- normal Supervisor review does not become a mandatory gate between slide packs.

Maintain positive/negative benchmark examples and measure useful accepted fixes versus false positives/latency, not finding count.

## Audit/export tests

Follow `AUDIT.md` for rule coverage.

Export validation should confirm:

- PPTX ZIP/OOXML opens;
- slide relationships resolve;
- text remains text;
- images remain image objects;
- supported charts/tables remain native where expected;
- no normal slide is one full-slide image;
- dimensions/master/layout references are valid;
- the exported presentation can be reopened by the parser.

Visual rendering comparison may supplement structural checks; it never replaces them.

## Browser/product smoke test

Cover the redesigned product behavior rather than legacy pixels:

1. create project;
2. upload template/content and brief;
3. inspect template understanding;
4. view/accept outline;
5. start generation once;
6. observe progress/new slide packs appearing continuously;
7. switch/lock a ready slide while later slides keep generating;
8. observe visual candidates update a ready slot;
9. perform local regeneration;
10. open audit and repair one issue;
11. export.

Anchor tests on stable roles/state/test ids, not current styling. The UI is expected to be redesigned.

## Prompt-prefix and cache tests

`INFERENCE.md` defines the serving cache target. The adapter sends complete stateless requests; local tests do not prove serving-side prefix reuse, persistent KV state, or per-role cache namespaces.

Before an inference profile is accepted, verify:

- Worker and Supervisor required role/stage instruction prefixes are warmed before timed generation readiness when supported by the chosen serving runtime;
- measure whether normal stages reuse warmed immutable prefixes instead of re-prefilling static instructions;
- instruction-version changes invalidate stale prefix entries;
- Worker generated tokens do not enter Supervisor requests unless the application explicitly copies them into structured checkpoint evidence;
- no cross-project mutable application context is sent after requests overlap or serving caches are reused/evicted;
- project-scoped cached summaries respect project/checkpoint versioning;
- optional craft/retrieval content is not blindly injected into every call;
- prefix-cache pressure/eviction affects performance only and does not alter application context or correctness.

Record prefix-prefill latency/hit behavior when the serving engine exposes it.

## Hardware-profile benchmark

Do not choose precision, GPU count, or sharding by intuition.

Benchmark the same representative deck workload for candidate profiles.

### Primary profile

```text
1 x H100-class
Qwen/Qwen3.8-27B-FP8 initially
```

Also benchmark BF16/FP16 when practical. Replace FP8 only if end-to-end quality/performance and memory headroom are better while still passing the 300-second gate.

### Fallback profile

If the primary profile misses the gate or is unavailable, benchmark:

```text
2 x RTX 5090-class
one logical Qwen3.8-27B instance
weights sharded/partitioned across devices
```

Test supported tensor/pipeline/other sharding modes. Do not assume linear speedup. Measure communication overhead, per-device memory, KV placement, batching behavior, and media residency/swap cost.

A fallback profile must preserve the same Worker/Supervisor and product semantics; it is not permission to assign a full independent model to each role.

For every profile record:

- model revision/precision;
- serving engine/runtime/CUDA versions;
- GPU SKU/count/topology and sharding strategy;
- resident and peak memory per device;
- serving KV/prefix-cache footprint under Worker + Supervisor workload;
- TTFT/decode throughput/continuous batching;
- queue latency;
- semantic quality on fixed cases;
- time-to-first-slide-pack and pack cadence;
- end-to-end deck time;
- media coexistence or model-swap overhead.

## Media inference tests

For preferred `Qwen/Qwen-Image-2.1`, measure:

- load/residency memory;
- single/batched candidate latency;
- aspect-ratio behavior;
- candidate diversity/relevance;
- impact on semantic KV/prefix/VRAM headroom;
- co-resident versus staged behavior;
- swap overhead where staged;
- incremental update latency for already-published image slots.

The media adapter must remain swappable without domain changes.

Before qualification/final freeze, re-check the media-model license against case rules and exercise a compliant fallback if needed.

## Five-minute performance gate

Measure from generation start with validated inputs and a warm model/prefix state through complete usable deck and preflight/export readiness.

Hard gate:

```text
wall time <= 300 s
```

Engineering target:

```text
wall time <= 270 s
```

Also track progressive UX metrics:

- time to first `slide-pack.ready`;
- inter-pack cadence;
- percentage of deck available over time;
- time to image-candidate readiness;
- Supervisor latency contribution;
- remaining deadline headroom.

Cold model load and static instruction-prefix warmup are measured separately as readiness/startup costs and must not be hidden inconsistently across runs.

Inject slow calls to test degradation policy. Confirm stale work is cancelled, Supervisor breadth/optional polish are reduced first, and required A/B/C/native/lock semantics plus forward slide generation survive.

## Hackathon benchmark

Maintain repeatable cases across structurally different templates and text/data/visual-heavy content. Include tables/charts/diagrams, density edge cases, and at least one held-out template not used for skill tuning.

Rehearsal must demonstrate the required three full variants on the same content across multiple templates while also validating the product's per-slide A/B/C experience.

Track generation success, total/progressive latency, audit pass/failures, template compliance, native editability, lock preservation, Supervisor value, peak VRAM/cache pressure, and failures by pipeline stage.

## Prompt/skill regression

Prompt/skill changes are code changes.

For a candidate change:

1. run fixed baseline benchmark;
2. run candidate;
3. compare deterministic quality, reviewed semantic quality, progressive latency, and total runtime;
4. inspect failure-class regressions;
5. reject any change that violates hard gates even if prose quality improves;
6. version accepted instructions/prefix bundles.

Benchmark Worker and Supervisor instruction changes separately where possible.

## Definition of done

A feature is done when:

- requested behavior works end-to-end;
- deterministic contracts have relevant tests;
- failure states preserve project/ready-slide state;
- progressive generation semantics remain correct when affected;
- locks/version conflicts are covered;
- audit/preflight/export implications are covered;
- inference changes include measured cache/VRAM/profile/deadline behavior;
- canonical documentation is updated without conflicting duplicates;
- applicable repository checks actually pass, or blocked checks are reported precisely.

One screenshot or one successful manual run is not sufficient evidence for parser, generator, renderer, audit, export, or inference changes.
