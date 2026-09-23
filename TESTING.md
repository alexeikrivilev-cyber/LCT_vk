# Testing and evaluation

## Goal

Tests must prove the system works on unseen templates, preserves the architectural contracts, and meets the five-minute runtime budget. Passing isolated unit tests is not sufficient if the end-to-end deck misses the deadline or the two-agent runtime violates cache/state isolation.

The most important regression surface is:

```text
unknown PPTX + content + brief
  -> design system
  -> worker plan
  -> supervisor review
  -> A/B/C variants
  -> native render
  -> audit/repair
  -> media candidates
  -> preflight/export
```

## Repository checks

Run the relevant commands before finishing work:

```bash
pnpm check:boundary
pnpm lint:craft
pnpm typecheck
pnpm build
```

`pnpm lint:craft` is required when skills/craft bindings change. Typecheck/build are required when their corresponding code paths change.

Add subsystem tests as the compiler modules land; do not defer all verification to one final E2E demo.

## Test layers

### Unit tests

Prioritize deterministic code:

- OOXML/PPTX parsing helpers;
- geometry and unit conversion;
- template token/style extraction;
- layout compatibility;
- slot mapping;
- lock-aware mutation;
- checkpoint/version conflict detection;
- density calculations;
- deterministic audit rules;
- export relationship/object construction;
- deadline accounting and scheduler priority rules.

Tests should use small fixtures and exact assertions.

### Golden template fixtures

Maintain several compact PPTX fixtures with known expected extraction results:

- masters/layout ids and counts;
- placeholder geometry/types;
- theme colors/fonts;
- repeated assets;
- chart/table examples;
- unusual but valid structures.

Golden output should compare normalized `TemplateIR`/design-system data, not unstable ZIP timestamps or relationship ordering that has no semantic meaning.

### Integration tests

Exercise boundaries:

- upload template/source files;
- compile template;
- persist/reload project state;
- plan deck from structured content;
- run supervisor plan review;
- generate A/B/C slide specs;
- generate same-type visual candidates;
- render native PPTX;
- run audit;
- apply a local worker or supervisor repair;
- export/reopen result.

### Variant invariants

For every planned slide:

- three candidates exist when requested;
- candidates preserve the same core slide intent/takeaway;
- each candidate uses an allowed template layout/family;
- coherent Deck A/B/C tracks can be reconstructed;
- user-selected mixed deck remains valid.

For visual slots:

- candidate type equals planned slot type;
- switching candidate does not change layout semantics unexpectedly;
- explicit type change goes through re-plan;
- image generation is used only for image/photo slots unless a documented exception exists.

### Lock tests

Locks require dedicated regression coverage:

- locked slide survives unrelated regeneration;
- locked visual survives slide regeneration;
- worker repair targeting another object does not alter locks;
- supervisor repair targeting another object does not alter locks;
- conflicting worker/supervisor action returns a conflict instead of mutating the lock;
- save/reload preserves lock ids.

### Supervisor tests

The supervisor is a bounded runtime role, not a second deck generator. Test that:

- its output is tied to a checkpoint version;
- stale decisions are rejected;
- invalid target ids are rejected;
- lock-conflicting patches are rejected;
- `local-replan` routes back through the worker rather than mutating broad state directly;
- repeated low-value warnings are bounded/deduplicated;
- it can inspect screenshots where visual context is required;
- it cannot bypass deterministic validation/render/export contracts.

Maintain benchmark examples where the supervisor should catch a clear contextual error and examples where it should pass a good slide. Measure false-positive/repair value rather than rewarding finding count.

### Audit tests

Follow `AUDIT.md`.

Deterministic findings use exact fixture assertions. Contextual checks use a benchmark set with expected pass/fail tendencies and reviewable outputs.

### Native PPTX/export tests

Validate the exported file structurally:

- ZIP/OOXML opens;
- slide relationships resolve;
- text remains text;
- images remain image objects;
- supported charts/tables remain native where expected;
- slide is not one full-slide image;
- dimensions/master/layout references are valid;
- presentation can be reopened by the parser.

Where practical, render exported slides to images and compare with expected geometry/tolerance; visual comparison supplements structural checks and never replaces them.

### Browser smoke tests

Cover the main desktop journey:

- create project;
- upload template/content;
- inspect template;
- view outline;
- view/switch slide alternatives;
- switch a visual candidate;
- lock;
- local regenerate;
- open audit;
- repair selected issue;
- export.

Do not preserve tests for the current visual design when the product UI is redesigned. Browser tests should anchor on behavior, stable roles/labels/test ids, and product state rather than brittle styling or pixel-perfect legacy screens.

## Two-agent inference tests

`INFERENCE.md` defines the runtime contract. Before an inference configuration is accepted, verify:

- one semantic model weight set serves both worker and supervisor;
- worker and supervisor use distinct session/cache identities;
- worker history cannot appear in supervisor context unless explicitly supplied as structured checkpoint data;
- supervisor history cannot leak into worker requests;
- no cross-project context leakage occurs after cache reuse/eviction;
- cache pressure/eviction for one role does not corrupt the other's active state;
- request cancellation rejects stale supervisor work;
- worker progress has scheduler priority under contention;
- supervisor token/retry limits are enforced;
- the model server is warm before readiness is reported.

If the serving engine has an immutable prefix cache, test that prefix reuse does not merge mutable agent histories.

## Precision and VRAM benchmark

Do not choose FP8, BF16/FP16, or any quantization profile by intuition.

For every candidate serving profile measure the same representative workload:

- model load/resident memory;
- peak memory with worker + supervisor KV caches;
- representative context lengths;
- time-to-first-token and decode throughput;
- continuous-batch behavior with both agents active;
- semantic quality on fixed prompts/decks;
- media coexistence or model-swap cost;
- end-to-end deck wall time.

The initial H100 target is `Qwen/Qwen3.8-27B-FP8`. BF16/FP16 may replace it only if the full benchmark is better while retaining VRAM safety margin and the five-minute SLO.

A release profile must record model revision, precision, inference engine, GPU SKU, CUDA/runtime versions, context budgets, and scheduler settings.

## Media inference tests

For the preferred `Qwen/Qwen-Image-2.1` media profile measure:

- load/residency memory;
- single-image and batched candidate latency;
- target aspect-ratio behavior;
- candidate diversity/relevance;
- impact on semantic model KV/VRAM headroom;
- co-resident versus staged residency;
- model-swap overhead when staged.

The media adapter must be swappable without presentation-domain changes.

Before qualification/final freeze, explicitly re-check the media-model license against the case rules. If Qwen-Image-2.1 remains outside the permitted license class and no organizer exception exists, the compliant fallback path must be exercised, not merely documented.

## Five-minute performance gate

A normal 10–15 slide benchmark is a release gate, not a stretch goal.

Measure from generation start with validated inputs and a warm inference service through a usable generated deck, required A/B/C slide variants, media candidates required by the scenario, audit/repair pass, and preflight/export readiness.

Hard gate:

```text
wall time <= 300 s
```

Engineering target:

```text
wall time <= 270 s
```

The remaining buffer protects the live demo from export/UI jitter.

Track per stage:

- deterministic ingest/template/content compilation;
- worker calls;
- supervisor calls;
- render/audit;
- media generation;
- repairs/replans;
- preflight/export;
- queue/model-swap overhead.

Also report cold startup separately. The service must pre-warm models before accepting timed generation; cold startup cannot be silently included only in favorable benchmark runs.

Test deadline degradation policy by injecting slow calls. Confirm that the system cancels stale work, narrows supervisor review, reduces optional polish, and preserves native export/locks/A-B-C semantics instead of looping past the deadline.

## Hackathon benchmark

Maintain a repeatable benchmark separate from ad-hoc demos.

At minimum include:

- multiple structurally different templates;
- text-heavy, data-heavy, and visual content packs;
- tables/charts/diagrams;
- long/short titles and edge-case density;
- at least one template intentionally held out from prompt/skill tuning.

Qualification/final rehearsal should cover three layout variants on the same content across three templates, producing the required nine variant outputs.

Track:

- generation success rate;
- total runtime and deadline headroom;
- worker/supervisor call counts and latency;
- deterministic audit pass rate;
- overflow/overlap counts;
- template compliance;
- native-object/editability checks;
- lock preservation;
- contextual audit/supervisor quality;
- peak VRAM/KV-cache pressure;
- failures by pipeline stage.

## Prompt/skill regression

Prompt and skill changes are code changes.

For a candidate change:

1. run the fixed benchmark with the current version;
2. run the candidate version;
3. compare deterministic metrics, runtime, and reviewed contextual quality;
4. inspect regressions by failure class;
5. accept only when aggregate quality improves without violating hard gates such as native export, locks, or 300-second runtime;
6. record the new version.

Benchmark worker and supervisor instructions separately where possible. A supervisor prompt that catches more issues but doubles runtime or creates noisy repairs is a regression.

Do not tune only on the live demo templates.

## Definition of done

A feature is done when:

- the requested behavior works end-to-end;
- relevant deterministic contracts have tests;
- failure states are handled without corrupting project state;
- locks and selections remain stable where applicable;
- supervisor/checkpoint semantics are covered when affected;
- audit/preflight implications are covered;
- inference changes have measured cache/VRAM/deadline behavior;
- source-of-truth documentation is updated if behavior/architecture changed;
- applicable repository checks have run successfully, or the exact blocked checks are reported.

A screenshot or one successful manual run is not sufficient evidence for parser, renderer, audit, export, or inference-scheduler changes.
