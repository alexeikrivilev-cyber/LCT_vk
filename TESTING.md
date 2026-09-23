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
pnpm typecheck
pnpm build
```

`pnpm lint:craft` is required when skill/craft bindings change. Typecheck/build are required when the corresponding code paths change.

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

Supervisor is bounded and asynchronous to normal forward progress.

Verify:

- one logical semantic model serves both roles;
- Worker/Supervisor mutable session/cache identities are distinct;
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

`INFERENCE.md` defines the cache contract.

Before an inference profile is accepted, verify:

- Worker and Supervisor required role/stage instruction prefixes are warmed before timed generation readiness;
- the first normal stage can reuse the warmed prefix instead of re-prefilling all static instructions;
- instruction-version changes invalidate stale prefix entries;
- Worker generated tokens never leak into Supervisor history and vice versa;
- no cross-project mutable context leakage occurs after cache reuse/eviction;
- project-scoped cached summaries respect project/checkpoint versioning;
- optional craft/retrieval content is not blindly injected into every call;
- cache pressure/eviction for one role does not corrupt the other.

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
- Worker + Supervisor KV/prefix-cache footprint;
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
