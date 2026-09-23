# GPU inference runtime

## Purpose

This document is the canonical infrastructure contract for semantic and image inference. The product must generate a normal 10–15 slide presentation within 300 seconds, while preserving the product and native-PPTX guarantees in `CONTEXT.md` and `ARCHITECTURE.md`.

The design assumes a high-memory NVIDIA Hopper-class GPU server, with an H100-class device as the primary target. Exact serving software and GPU SKU are implementation choices; the contracts below are not.

## Semantic model

Primary runtime model:

```text
Qwen/Qwen3.8-27B
```

Use one loaded model weight set per GPU serving unit. Two agents do **not** mean two model replicas.

The serving layer must support image inputs because the supervisor may inspect rendered slide screenshots in addition to structured state.

### Precision policy

The first production benchmark profile is the official `Qwen/Qwen3.8-27B-FP8` checkpoint on H100-class hardware.

Reasoning:

- H100 has native FP8 Tensor Core support.
- An official FP8 checkpoint exists for Qwen3.8-27B.
- FP8 materially reduces resident weight memory versus the non-FP8 checkpoint, leaving room for two agent KV caches, batching, rendering buffers, and media inference.
- The five-minute limit favors throughput and memory headroom over an unmeasured preference for FP16.

BF16/FP16 remains a supported benchmark candidate. It may replace FP8 only when an end-to-end benchmark shows that quality, throughput, peak VRAM, two-cache capacity, and media scheduling all fit the required budget with safety headroom.

Do not treat generic Q8/INT8 as the default merely because it is 8-bit. On Hopper, benchmark the actual kernels/checkpoints used. Precision is a deployment parameter selected by evidence.

Record the selected model revision, precision, serving engine, CUDA/runtime versions, and benchmark profile with every release candidate.

## Two-agent topology

The runtime has exactly two logical semantic agents for a deck generation.

### Worker agent

The worker owns forward progress. It performs the semantic tasks required to build the deck:

- template semantic labeling after deterministic PPTX extraction;
- content understanding and `DeckPlan`;
- slide intent/title/copy decisions;
- layout ranking within allowed candidates;
- visual-type planning;
- A/B/C slide-spec decisions;
- local regeneration and requested semantic edits.

The worker is the only agent allowed to initiate broad generation/re-planning. It should make batched decisions whenever that reduces calls without creating an oversized context.

### Supervisor agent

The supervisor is a bounded critic/repair agent using the same model weights with a different system instruction and independent context.

It observes immutable checkpoints and looks for mistakes while generation is in progress. Typical inputs are:

- validated `TemplateIR` / design-system summaries;
- `DeckPlan`;
- batches of `SlideSpec` candidates;
- rendered slide screenshots;
- deterministic audit findings;
- locks/selections;
- remaining deadline budget.

It returns a structured decision such as:

```text
status: pass | warn | repair | local-replan
severity
checkpointVersion
targetIds[]
findings[]
patchOps[]
```

The supervisor does **not** generate a second deck in parallel. It does not rewrite OOXML, bypass locks, invent geometry, or perform unrestricted global replanning.

Repairs are applied by the normal validated mutation/rendering path. If a supervisor patch targets a stale checkpoint or conflicts with a lock, reject it. A local semantic issue may be repaired directly through a validated patch; a material narrative/visual-type change is routed back to the worker as a local re-plan.

### Review checkpoints

Use the supervisor where it has leverage, not continuously:

1. after template semantic compilation when ambiguity is material;
2. after `DeckPlan`;
3. after slide-spec/render batches, especially slides with deterministic findings or low-confidence decisions;
4. after media is inserted for visual relevance/composition checks;
5. before final preflight only for unresolved contextual blockers.

Deterministic audits run independently and should filter what needs supervisor attention.

## Cache and context isolation

Worker and supervisor use separate mutable KV-cache/session namespaces.

Required properties:

- no mutable conversation history is shared between agents;
- no cross-project cache reuse that can leak context;
- each generation has stable worker/supervisor session ids;
- cache eviction/compaction for one agent must not corrupt the other;
- both agents receive explicit project/checkpoint versions in their inputs.

The serving engine may reuse an immutable prompt prefix internally, but this must not merge agent histories or make one agent's generated tokens visible to the other.

Do not use the model's maximum context length by default. Keep context compact with structured state, retrieval, and checkpoint summaries. Context budgets are tuning parameters and must be chosen from latency/VRAM benchmarks.

## GPU scheduler

Place a small scheduler/arbiter in front of the inference engine.

Responsibilities:

- tag requests as `worker`, `supervisor`, or `media`;
- preserve separate semantic-agent sessions;
- prioritize worker forward progress;
- cap supervisor concurrency, token budget, and retries;
- use continuous batching when the serving engine supports it;
- expose deadline remaining to orchestration;
- cancel stale requests after a newer checkpoint supersedes them;
- publish queue latency, token throughput, KV-cache use, and peak VRAM.

The supervisor should run opportunistically between/alongside worker steps. It may block forward progress only for a high-severity issue whose repair is cheaper than allowing the error to propagate.

Do not create a permanent serial chain `worker -> supervisor -> worker -> supervisor` for every tiny operation; that would waste the five-minute budget.

## Five-minute deadline

Treat 300 seconds as a hard end-to-end generation deadline for a normal 10–15 slide deck once validated inputs are ready and generation starts. The inference service must be warm before it reports ready; cold model startup is measured separately and is not allowed to surprise a live generation.

Internally target completion by about 270 seconds to keep a final buffer for preflight/export/UI jitter.

Use a deadline-aware budget rather than fixed sleeps. A practical initial budget envelope is:

```text
0–45 s      deterministic ingest/template/content compilation
45–80 s     worker deck planning + bounded supervisor plan review
80–210 s    A/B/C slide specs + deterministic rendering/audit, batched/parallel
210–260 s   media candidates + targeted supervisor visual review/repairs
260–300 s   preflight/export reserve
```

These are starting budgets, not protocol boundaries. Measure and rebalance them.

### Degradation order

When the deadline is threatened:

1. cancel stale/duplicate model work;
2. reduce supervisor breadth to only blocking/high-risk slides;
3. reduce reasoning/token budgets and retries;
4. reduce image preview resolution/steps before reducing required candidate semantics;
5. defer non-essential polish/upscale/history work;
6. preserve deterministic audit, locks, native PPTX correctness, and coherent A/B/C slide variants.

Never spend the remaining budget on a second full-deck critique while the primary deck is incomplete.

## Media model

Preferred image model:

```text
Qwen/Qwen-Image-2.1
```

Use it behind the media adapter. The presentation domain should request semantic image jobs; it must not depend on Diffusers/provider-specific request objects.

For an image slot, create the required same-type candidate set efficiently:

- batch compatible prompts/seeds when supported;
- generate at review-appropriate resolution first;
- avoid generating image alternatives for slots whose semantic type is not image;
- avoid repeated model swaps for one image at a time;
- allow selected-media refinement only if the deadline permits.

Charts, tables, diagrams, icons, and SmartArt-like structures should normally be rendered as native/deterministic presentation objects rather than sent to the image model.

### GPU residency

Do not assume both models fit safely just because raw weight files fit.

At startup/release benchmarking, measure:

```text
LLM weights
+ worker KV cache
+ supervisor KV cache
+ max semantic batch activations
+ image-model weights/activations
+ rendering/runtime allocations
+ safety margin
```

Support two deployment modes:

- `co-resident` — semantic and image models stay resident only when measured peak VRAM leaves a safe margin;
- `staged` — group semantic work, run a batched image phase, then restore semantic inference for final supervisor checks. Avoid repeated load/unload thrashing.

If the server later has more than one GPU, the media adapter may move to another device without changing presentation-domain contracts.

## License/compliance gate

There is a current hackathon-compliance risk that must not be hidden.

As of 2026-09-23, the upstream `Qwen/Qwen-Image-2.1` model card declares the Qwen Research License, while the case materials supplied to this project require generative model licenses in the Apache-2.0/MIT class. Therefore:

- keep Qwen-Image-2.1 as the preferred technical media target;
- do not treat it as an automatically valid final-submission dependency;
- re-check the upstream license immediately before the qualification/final freeze;
- obtain explicit organizer confirmation if the license remains outside the stated case rule;
- keep the adapter capable of switching to a compliant fallback without domain changes.

`Qwen/Qwen-Image` is currently an Apache-2.0 fallback candidate if the final rules reject Qwen-Image-2.1. This fallback is a compliance escape hatch, not a change to the preferred product model.

## Serving implementation freedom

The serving implementation may use vLLM, SGLang, Transformers, or another compatible engine. Choose by benchmark.

Required capabilities:

- Qwen3.8-27B multimodal inference;
- FP8/BF16/FP16 profile support as benchmarked;
- separate worker/supervisor request/session identities;
- continuous batching or equivalent efficient scheduling;
- request cancellation/deadlines;
- structured-output-friendly API;
- observability for token throughput, queue time, KV-cache pressure, and VRAM;
- warmup/readiness;
- OpenAI-compatible HTTP is preferred but not an architectural requirement.

The TypeScript daemon talks to the inference host through a small adapter. Python may be used for GPU serving; provider/runtime-specific types must not leak into presentation domain contracts.

## Required telemetry

Capture per generation:

- total wall time and time by pipeline stage;
- worker vs supervisor request count;
- prompt/output tokens and reasoning settings;
- time-to-first-token and tokens/second;
- queue latency;
- KV-cache usage/evictions per agent;
- peak GPU memory;
- media generation count and latency;
- supervisor findings/repairs and their accepted/rejected status;
- retries/cancellations/timeouts;
- final deadline headroom.

Performance work is evaluated end-to-end. A faster isolated model call does not matter if model swaps, oversized contexts, supervisor loops, or image generation make the deck exceed five minutes.

## Readiness gates

An inference configuration is eligible for final use only when:

- one semantic weight set serves both agents;
- worker/supervisor cache isolation tests pass;
- no cross-project context bleed is observed;
- normal 10–15 slide benchmark decks complete within 300 seconds;
- peak VRAM leaves measured safety headroom;
- A/B/C slide variants and required media candidates are produced;
- supervisor improves/catches failures without becoming the dominant latency source;
- final model/license choices satisfy the hackathon rules;
- the exact configuration is recorded and reproducible.
