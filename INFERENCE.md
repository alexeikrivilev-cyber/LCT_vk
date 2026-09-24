# GPU inference runtime

## Purpose

This is the canonical infrastructure contract for semantic and image inference. A normal 10–15 slide deck must complete within 300 seconds with a warm service while preserving the product guarantees in `CONTEXT.md` and `ARCHITECTURE.md`.

The presentation application uses a provider-neutral semantic inference port. Its OpenAI-compatible adapter sends stateless requests to one logical semantic inference service; physical GPU count, precision, sharding, prefix-cache implementation, and serving engine are deployment details selected by benchmark. The local adapter and fake-service tests are implemented. The configured RunPod Qwen endpoint has passed a small strict-schema request and one synthetic ContentIR → Worker → Supervisor pass → persisted planning-state run with request-level thinking disabled. This confirms that live path only; other runtime deployments and production performance remain unverified.

The implemented adapter accepts `LCT_SEMANTIC_BASE_URL`, optional `LCT_SEMANTIC_API_KEY`, `LCT_SEMANTIC_MODEL`, and optional `LCT_SEMANTIC_ENABLE_THINKING` (`true` or `false`). When set, the adapter maps that setting to a request-level chat-template option for calls made by that configured adapter; leaving it unset preserves the provider default. The live planning run used `false`: two earlier thinking-enabled Worker calls returned HTTP 524, while the small strict-schema check and one Worker/Supervisor planning flow passed with thinking disabled. The self-hosted vLLM `qwen3` reasoning parser remains enabled; this request option is separate from server-side parsing. Other adapter instances and configurations retain the provider default unless explicitly configured. The adapter sends a strict JSON Schema request and validates the returned value again with the caller's runtime validator. It bounds request/response sizes, supports deadlines and `AbortSignal`, returns typed failures and prompt-free telemetry, and carries role/operation labels. Caller-provided Worker and Supervisor messages are independent. The adapter does not depend on Cloud.ru, vLLM, or persistent conversation state.

The vLLM container in `services/inference/` is one self-hosted runtime option. RunPod is one self-hosted runtime option. `LCT_MODEL_STORAGE_ROOT` and a persistent model volume apply only to that self-hosted inference container. `/workspace` is an example mount path, is optional, and is not read or required by application or domain code. `SemanticInferenceAdapter` remains provider-neutral. For the top-10 hackathon deployment, configure its remote endpoint to use organizer-provided VK inference serving Qwen 3.8 27B. Switching from RunPod or another self-hosted runtime to the VK remote endpoint requires runtime configuration changes only; Worker, Supervisor, and application/domain logic do not change. Remote VK inference does not require local model storage.

At self-hosted startup, `services/inference/` resolves the profile's immutable Hugging Face revision into a Hub cache under `LCT_MODEL_STORAGE_ROOT` (default `/tmp/lct-model-storage`), validates config/tokenizer files from that snapshot, and passes local model/tokenizer paths to vLLM while retaining the public model alias. For RunPod, `/workspace/lct-models` is an example value for `LCT_MODEL_STORAGE_ROOT`; a provider-configured persistent volume mounted there can survive pod replacement, while the container disk and default `/tmp` root are disposable. The GHCR image contains the serving runtime; model weights are separate files in the Hugging Face cache on the mounted volume. Any selected mount path must be writable by UID 1000. `HF_HOME` and `HF_HUB_CACHE` are derived from the configured root. Optional `HF_TOKEN` is passed to Hugging Face without being logged. `LCT_INFERENCE_PREFLIGHT_ONLY=1` materializes only config/tokenizer assets and skips vLLM. Normal tests use a local fake endpoint. The local Docker build/preflight checks did not download model weights, and no Cloud.ru deployment was performed for that image; the local CPU-only snapshot preflight passed for both profiles. The separate live A100 application smoke is recorded above; this repository does not record whether it used the exact local `persistent-storage-v5` image tag.

## Semantic model

Primary runtime model:

```text
Qwen/Qwen3.8-27B
```

The target runtime has one logical copy of the semantic model weights. Worker and supervisor share those weights and the application supplies each role's messages/context independently. The adapter does not provide persistent sessions or role-specific KV namespaces. If the model spans several GPUs, the weights are partitioned/sharded rather than duplicated per agent.

The serving path must support image inputs because the supervisor may inspect rendered slide screenshots.

## Hardware profiles

### First qualification profile: one A100 80GB

The first development and hackathon qualification profile uses the official `Qwen/Qwen3.8-27B` BF16 checkpoint at revision `1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0` under Apache-2.0. The official [Qwen model card](https://huggingface.co/Qwen/Qwen3.8-27B/tree/1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0) marks the checkpoint BF16. The [vLLM recipe](https://github.com/vllm-project/recipes/blob/main/models/Qwen/Qwen3.8-27B.yaml) estimates 67 GB minimum VRAM for this checkpoint, but its model-specific verified GPU list does not include A100. This is a qualification target, not a claim that this exact model/profile has been verified on A100.

The Docker runtime's `A100_BF16` profile starts with `max-model-len=16384`, `max-num-seqs=2`, and `gpu-memory-utilization=0.90`. Keep this limit for the first run. Measure memory use, structured output, concurrency, and end-to-end performance before changing it. The BF16 profile's 55.6 GB weight files and the recipe's 67 GB VRAM estimate leave less operating margin than the FP8/H100 option; actual Cloud.ru allocation behavior and runtime buffers are still unknown.

Worker and Supervisor use the same vLLM process and model instance. `max-num-seqs=2` allows two active sequences; do not deploy two model processes or replicas on one A100. A runtime smoke test must confirm the two application calls work through one endpoint.

### Performance option: one H100 with FP8

The retained `H100_FP8` profile uses the official `Qwen/Qwen3.8-27B-FP8` checkpoint at revision `017b9c7af6b5689d5dd426a76e0bc077eb5ca20a` under Apache-2.0. The vLLM recipe lists H100 for this variant and estimates 38 GB minimum VRAM. The H100 profile uses `dtype=auto` so the engine follows the checkpoint's FP8 quantization configuration. [Pinned checkpoint](https://huggingface.co/Qwen/Qwen3.8-27B-FP8/tree/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a).

The H100 remains a performance/fallback option; relative and absolute LCT latency are unknown until measured. Neither profile is confirmed against the 300-second product gate. For either profile, benchmark actual context, batching, activations, media/runtime allocations, peak VRAM, and cold/warm serving behavior before accepting it.

Do not choose generic Q8/INT8 merely because it is 8-bit. Benchmark the actual checkpoint, kernels, engine, and workload.

### Fallback: dual RTX 5090-class GPUs

If the single-H100 profile cannot reliably meet the 300-second gate or is unavailable, the next target profile is two RTX 5090-class GPUs serving the **same logical Qwen3.8-27B instance** with weights partitioned across both devices.

The serving engine may use tensor parallelism, pipeline parallelism, or another supported sharding strategy. Choose by end-to-end benchmark. Do not assume two consumer GPUs provide linear speedup; cross-device communication, scheduler behavior, KV placement, and media/model swapping are part of the measurement.

Required invariants for the dual-GPU profile:

- do not run a full worker model replica on one card and a full supervisor replica on the other;
- worker and supervisor still share one logical semantic model and receive independent application contexts;
- correctness does not depend on persistent sessions, role-specific KV namespaces, or cache persistence;
- sharding details stay behind the inference adapter;
- the presentation pipeline and product behavior are unchanged;
- record device topology and parallelism settings in benchmark/release metadata.

Before reducing required product behavior, test the dual-5090 profile if the A100/H100 profiles miss the time gate.

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

Before timed deck generation begins, the serving deployment should warm the model and any reusable immutable prompt prefixes it supports. The current adapter has no warmup API and does not create role namespaces.

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

The serving runtime may reuse identical immutable prefixes to reduce prefill work. This is an optimization: it does not provide role-specific cache namespaces, restore history, or establish application context isolation.

Do **not** confuse preloaded instructions with project context. Raw content packages, all PPTX XML, every layout, optional craft rules, and mutable project history do not belong in a global prefix merely because memory is available.

Use two layers:

1. **eager immutable prefixes** — role instructions, required pipeline/skill instructions, tool/schema contracts, stable safety/architecture rules;
2. **scoped mutable/project context** — current brief/content slice, relevant design-system/layout candidates, locks, checkpoint state, findings, and rendered evidence.

Optional skills/craft/retrieval content remains lazy unless the pipeline guarantees it will be used. Project-specific immutable summaries may benefit from exact-prefix reuse after compilation, but their source stays project/version scoped in application state; do not treat a serving cache entry as an application object.

Worker and supervisor messages are built independently by the application and sent with each request. Prefix reuse must not merge or restore mutable history.

## Cache and context isolation

Application-level context isolation is required: callers build Worker and Supervisor messages independently and include only the evidence needed by that call. The current stateless adapter has no persistent sessions or explicit KV namespaces. Correctness must not rely on per-role cache identities, prefix persistence, or eviction behavior. A serving runtime may reuse exact immutable prefixes to reduce prefill work, but cache reuse is not a history or isolation boundary. Include project/generation/checkpoint metadata where available and keep project evidence scoped and versioned.

Do not grow mutable context to the model maximum by default. The serving runtime may prefill stable instructions; changing project evidence remains narrow.

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
- preserve independent application request contexts and avoid relying on serving cache placement;
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
+ serving KV allocation for concurrent requests
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
- independent Worker/Supervisor request contexts;
- serving-side session isolation only if a selected runtime provides and verifies it;
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
- serving KV usage/evictions and any runtime role attribution it exposes;
- per-device utilization and peak memory;
- media count/latency/residency or swap cost;
- supervisor findings and accepted/rejected repairs;
- final deadline headroom.

Record model revision, precision, serving engine, GPU SKU/count/topology, sharding strategy, CUDA/runtime versions, prompt/prefix versions, context budgets, and scheduler settings.

## Readiness gates

A profile is eligible for final use only when:

- one logical semantic model serves both roles;
- application tests confirm independent Worker/Supervisor request contexts;
- any serving-side session/cache guarantees relied on by a deployment are verified at that runtime;
- required role/stage instruction prefixes are warmed before timed generation where the serving runtime supports reusable prefixes;
- no cross-project context bleed is observed;
- progressive slide packs appear without per-pack approval stalls;
- normal 10–15 slide benchmark decks complete within 300 seconds;
- peak VRAM leaves measured safety headroom;
- Supervisor improves/catches failures without dominating latency;
- required A/B/C slide/visual semantics remain intact;
- final model/license choices satisfy case rules;
- the exact deployment profile is reproducible.
