# GPU inference runtime

## Purpose

This is the canonical infrastructure contract for semantic and image inference. A normal 10–15 slide deck must complete within 300 seconds with a warm service while preserving the product guarantees in `CONTEXT.md` and `ARCHITECTURE.md`.

The presentation domain talks to one logical semantic inference service. Physical GPU count, precision, sharding, prefix-cache implementation, and serving engine are deployment details selected by benchmark.

## Semantic model

Primary runtime model:

```text
Qwen/Qwen3.8-27B
```

The runtime has one logical copy of the semantic model weights. Worker and supervisor share those weights and use isolated mutable session/KV state. If the model spans several GPUs, the weights are partitioned/sharded rather than duplicated per agent.

The serving path must support image inputs because the supervisor may inspect rendered slide screenshots.

## Hardware profiles

### Primary: single H100-class GPU

The first production benchmark profile is a single H100-class GPU with the official `Qwen/Qwen3.8-27B-FP8` checkpoint.

FP8 is the initial profile because Hopper provides native FP8 acceleration and the official FP8 checkpoint leaves materially more memory headroom than a non-FP8 weight set for two agent caches, batching, activations, and media/runtime allocations.

BF16/FP16 remains a benchmark candidate. It replaces FP8 only if end-to-end measurements show equal/better quality and total throughput while preserving two-cache capacity, media scheduling, safety headroom, and the 300-second gate.

Do not choose generic Q8/INT8 merely because it is 8-bit. Benchmark the actual checkpoint, kernels, engine, and workload.

### Fallback: dual RTX 5090-class GPUs

If the single-H100 profile cannot reliably meet the 300-second gate or is unavailable, the next target profile is two RTX 5090-class GPUs serving the **same logical Qwen3.8-27B instance** with weights partitioned across both devices.

The serving engine may use tensor parallelism, pipeline parallelism, or another supported sharding strategy. Choose by end-to-end benchmark. Do not assume two consumer GPUs provide linear speedup; cross-device communication, scheduler behavior, KV placement, and media/model swapping are part of the measurement.

Required invariants for the dual-GPU profile:

- do not run a full worker model replica on one card and a full supervisor replica on the other;
- worker and supervisor still share one logical semantic model and retain isolated mutable caches;
- sharding details stay behind the inference adapter;
- the presentation pipeline and product behavior are unchanged;
- record device topology and parallelism settings in benchmark/release metadata.

Before reducing required product behavior, test the dual-5090 profile if the primary H100 profile misses the time gate.

## Two-agent topology

### Worker

Worker owns forward progress:

- template semantic labeling after deterministic extraction;
- content understanding and `DeckPlan`;
- titles/copy and slide intent;
- ranking among valid layouts;
- semantic visual type;
- A/B/C slide-pack decisions;
- requested local regeneration/semantic edits.

Worker is the only role allowed to initiate broad planning/re-planning.

### Supervisor

Supervisor is a bounded critic/repair role over the same model weights with a separate instruction set and mutable context.

It reviews versioned checkpoints, structured specs, screenshots, deterministic findings, locks, and remaining deadline. Its output is a structured `pass | warn | repair | local-replan` decision tied to a checkpoint version.

Supervisor does not generate a competing deck, write OOXML, bypass locks, invent unrestricted geometry, or force a serial approval after every slide pack. Repairs go through the same validated mutation/rendering path as normal edits.

## Eager instruction and pipeline prefix warmup

Guaranteed runtime instructions should not be re-prefilled from scratch on every call.

Before timed deck generation begins, warm the model and prefill immutable prompt-prefix entries inside the two role namespaces.

Worker prefix set should cover the guaranteed worker pipeline, including:

```text
worker core/system contract
presentation orchestration rules
structured output/tool schemas
template-semantics stage instructions
deck-planning stage instructions
layout/variant stage instructions
visual-planning stage instructions
local repair/re-plan stage instructions
```

Supervisor prefix set should cover:

```text
supervisor core/system contract
review/repair policy
structured output/tool schemas
plan-review stage instructions
slide/contextual-review stage instructions
visual-relevance-review stage instructions
bounded repair/local-replan instructions
```

These may be represented as separate immutable prefix-cache entries inside each role namespace rather than one enormous concatenated prompt. The objective is that every guaranteed stage can start without repeatedly paying the full static instruction prefill cost.

Do **not** confuse preloaded instructions with project context. Raw content packages, all PPTX XML, every layout, optional craft rules, and mutable project history do not belong in a global prefix merely because memory is available.

Use two layers:

1. **eager immutable prefixes** — role instructions, required pipeline/skill instructions, tool/schema contracts, stable safety/architecture rules;
2. **scoped mutable/project context** — current brief/content slice, relevant design-system/layout candidates, locks, checkpoint state, findings, and rendered evidence.

Optional skills/craft/retrieval content remains lazy unless the pipeline guarantees it will be used. Project-specific immutable summaries may receive their own prefix-cache entries after they are compiled, but they stay project-scoped and versioned.

Worker and supervisor mutable histories must never be merged by prefix reuse.

## Cache and context isolation

Required properties:

- distinct worker/supervisor session ids and mutable KV-cache namespaces;
- no cross-project mutable cache reuse;
- no generated-token visibility between roles unless explicitly copied into structured checkpoint state;
- cache eviction/compaction for one role must not corrupt the other;
- every request carries project/generation/checkpoint version information;
- cache/prefix entries are invalidated when their instruction or project-summary version changes.

Do not grow mutable context to the model maximum by default. Stable instructions are prefetched; changing project evidence remains narrow.

## Continuous-generation scheduler

All semantic/media requests go through a small scheduler/arbiter.

Priority is forward user value:

1. keep Worker producing the next slide pack;
2. validate/render/audit completed packs;
3. generate required visual candidates;
4. run Supervisor opportunistically on completed/high-risk checkpoints;
5. spend remaining budget on non-essential polish.

The scheduler must:

- tag `worker`, `supervisor`, and `media` work;
- preserve role/cache isolation;
- maintain the next slide-pack publish index;
- keep generation running without waiting for user acknowledgement;
- use continuous batching or equivalent when supported;
- cancel stale work after checkpoint changes;
- cap Supervisor token budget/concurrency/retries;
- expose deadline remaining;
- publish queue latency, token throughput, prefix-cache hit/pre-fill cost, KV usage, and peak VRAM.

A Supervisor pass for slide N normally runs while Worker advances toward slide N+1. Only a true high-severity blocker should stop forward progress.

## Five-minute deadline

Treat 300 seconds as a hard end-to-end gate after validated inputs are ready and generation starts. The model and guaranteed instruction prefixes must be warm before readiness is reported; cold model load and static-prefix prefill are startup/readiness work, not hidden inside a favorable generation benchmark.

Internally target about 270 seconds to retain final preflight/export/UI headroom.

A useful initial budget envelope is:

```text
0–45 s      deterministic template/content compilation + project setup
45–80 s     worker DeckPlan + bounded supervisor plan review
80–240 s    continuous slide packs, render/audit, visual candidates, targeted supervisor work
240–270 s   remaining local repairs/finalization
270–300 s   preflight/export reserve
```

This is a tuning envelope, not a required serial schedule. Slide packs should become visible during the 80–240 second window rather than waiting for the whole phase to finish.

Track both total wall time and progressive latency:

- time to first ready slide pack;
- time between ready slide packs;
- time to visual-candidate readiness;
- time to complete deck.

### Deadline degradation order

When time is threatened:

1. cancel stale/duplicate work;
2. narrow Supervisor review to blocking/high-risk slides;
3. reduce Supervisor/Worker optional reasoning/retries;
4. reduce media preview resolution/steps before dropping required semantics;
5. defer non-essential upscale/polish/history work;
6. preserve locks, deterministic audit, native PPTX correctness, coherent A/B/C tracks, and continuous forward slide generation.

Never spend the remaining budget on a second full-deck critique while the primary deck is incomplete.

## Media model

Preferred image model:

```text
Qwen/Qwen-Image-2.1
```

The presentation domain requests semantic image jobs through a media adapter; it does not depend on provider/Diffusers request types.

For image/photo slots:

- keep the semantic type fixed before generation;
- produce three useful candidates efficiently;
- batch compatible prompts/seeds when supported;
- generate review-resolution candidates first;
- update the already-visible slide slot when candidates arrive;
- refine only the selected image if time permits.

Charts, tables, diagrams, icons, and SmartArt-like structures should normally remain native/deterministic presentation objects.

## Media residency

Do not assume semantic and image models fit concurrently because raw weight sizes fit.

Benchmark peak memory including:

```text
semantic weights/shards
+ worker KV/session cache
+ supervisor KV/session cache
+ immutable prefix-cache entries
+ batch activations
+ image model weights/activations
+ runtime/render allocations
+ safety margin
```

Support:

- `co-resident` — keep semantic and image models resident only with measured safety headroom;
- `staged` — group semantic/media phases enough to avoid repeated load/unload thrash while preserving progressive slide publication.

On a dual-GPU semantic profile, do not opportunistically move shards around merely to fit one image request. Use an explicit measured media placement/residency strategy.

## License/compliance gate

Qwen-Image-2.1 is the preferred technical media target, but its upstream license must be re-checked against the hackathon's allowed license class before qualification/final freeze.

If it is not permitted and no organizer exception exists, switch through the media adapter to a compliant fallback without changing presentation-domain contracts. Keep the fallback path exercised, not merely documented.

## Serving implementation freedom

The service may use vLLM, SGLang, Transformers, or another compatible engine. Choose by benchmark.

Required capabilities:

- Qwen3.8-27B multimodal inference;
- chosen FP8/BF16/FP16/sharded profile;
- isolated worker/supervisor sessions;
- immutable prefix caching/prefill;
- continuous batching or equivalent;
- request cancellation/deadlines;
- structured-output-friendly API;
- warmup/readiness;
- observability for queue, tokens, prefix/KV cache, VRAM, and device utilization.

The TypeScript daemon talks to the inference host through a small adapter. Python is allowed for GPU serving; runtime-specific types must not leak into domain contracts.

## Telemetry and release metadata

Capture per generation/profile:

- total and per-stage wall time;
- time-to-first-slide-pack and slide-pack cadence;
- worker/supervisor request counts, tokens, TTFT, decode throughput;
- prefix-cache prefill time and hit rate;
- queue latency/cancellations/retries/timeouts;
- KV usage/evictions by role;
- per-device utilization and peak memory;
- media count/latency/residency or swap cost;
- supervisor findings and accepted/rejected repairs;
- final deadline headroom.

Record model revision, precision, serving engine, GPU SKU/count/topology, sharding strategy, CUDA/runtime versions, prompt/prefix versions, context budgets, and scheduler settings.

## Readiness gates

A profile is eligible for final use only when:

- one logical semantic model serves both roles;
- worker/supervisor mutable cache isolation tests pass;
- required role/stage instruction prefixes are prewarmed before timed generation;
- no cross-project context bleed is observed;
- progressive slide packs appear without per-pack approval stalls;
- normal 10–15 slide benchmark decks complete within 300 seconds;
- peak VRAM leaves measured safety headroom;
- Supervisor improves/catches failures without dominating latency;
- required A/B/C slide/visual semantics remain intact;
- final model/license choices satisfy case rules;
- the exact deployment profile is reproducible.
