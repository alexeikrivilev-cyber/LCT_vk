# Models, prompts, and skills

## Runtime policy

The semantic runtime uses `Qwen/Qwen3.8-27B` through one logical inference service. Worker and supervisor share the same semantic weights and keep isolated mutable session/KV state.

`INFERENCE.md` is canonical for physical GPU profiles, precision, sharding, prefix-cache warmup, scheduling, media inference, and the 300-second deadline. Do not duplicate those deployment details here.

## Agent roles

### Worker

Worker owns forward semantic generation and user-requested semantic edits:

- understand the brief and supplied content;
- build the narrative and `DeckPlan`;
- write conclusion-style titles and slide copy;
- label template/layout semantics when exact parsing cannot provide meaning;
- rank valid layout candidates;
- choose semantic visual types;
- create A/B/C decisions for each slide pack from one shared plan;
- request/select same-type visual candidates;
- perform local regeneration and scoped re-plans.

Worker is the only role that initiates broad planning/re-planning. After the plan exists, it keeps producing the next slide pack until the deck is complete unless application state explicitly pauses/cancels or invalidates future plan scope.

### Supervisor

Supervisor is a bounded critic/repair role over the same model weights with separate instructions and mutable context.

It reviews versioned checkpoints, rendered screenshots, structured specs, deterministic findings, locks, and deadline state. It should catch high-value semantic/compositional mistakes and return a small structured repair or local-replan request.

Supervisor must not independently regenerate a deck, maintain a competing plan, bypass validation/locks, mutate PPTX structure directly, or become a serial approval gate between slide packs.

Supervisor output is a validated `SupervisorDecision` tied to a checkpoint version. Stale/invalid/lock-conflicting decisions are rejected by code.

## Responsibility split

Use the model for semantic decisions:

- narrative and slide purpose;
- wording;
- semantic template/layout labeling;
- ranking among valid structures;
- visual-type choice;
- treatment choice inside allowed structures;
- recommended candidate selection;
- contextual review;
- bounded semantic repair.

Use deterministic/programmatic logic for:

- exact PPTX geometry/colors/fonts/relationships;
- hard layout constraints/compatibility;
- stable ids, checkpoint versions, and generation queue state;
- locks and conflict detection;
- native PPTX construction;
- deterministic audit;
- persistence/event publication;
- deadline accounting and scheduling;
- export integrity.

The goal is to constrain model search space, not ask a 27B model to be the renderer or state machine.

## Structured outputs

Every model operation has a narrow machine-validated contract.

Prefer stable ids, enums, bounded lists, expected checkpoint versions, and explicit patch operations. Validate before committing state. Malformed prose never reaches rendering or mutation.

Model responses may reference only ids supplied in context. Supervisor patches must identify exact targets and expected source version.

## Prompt and context architecture

Separate **static instructions** from **mutable project evidence**.

### Static instructions

Guaranteed worker/supervisor pipeline instructions, role rules, stage prompts, tool/schema contracts, and stable architecture constraints are versioned assets. They should be prewarmed into immutable prefix-cache entries as defined in `INFERENCE.md`.

This means a stage does not repeatedly pay the cost of prefilling instructions that are known in advance to be required during every normal generation.

### Mutable/project context

Each call still receives only the project evidence needed for that decision:

Worker examples:

- brief/content slice;
- relevant `PresentationDesignSystem` rules;
- compatible layouts/slots;
- current plan/selection/locks for the affected scope.

Supervisor examples:

- checkpoint under review;
- concise source/plan context;
- screenshot(s) where visual judgment matters;
- deterministic findings;
- locks;
- deadline remaining.

Do not put raw PPTX XML, the whole content package, every layout, all project history, or optional craft material into every call. Eagerly cache stable instructions; keep changing evidence narrow.

Project-specific immutable summaries may be prefix-cached after compilation when reuse is measurable, but they remain project/version scoped.

## Skill architecture

Use a thin orchestration layer and narrow specialized skills/capabilities.

```text
worker
  presentation-orchestrator
    -> template-semantics
    -> deck-planner
    -> layout-ranker / slide-pack planner
    -> visual-planner
    -> local-repair / re-plan

supervisor
  supervisor-review
    -> plan-review
    -> slide/contextual-review
    -> visual-relevance-review
    -> bounded-repair proposal
```

These capabilities do not create more runtime agent personas. Runtime semantic roles remain exactly Worker and Supervisor.

Worker and Supervisor instructions are separate versioned files even though they share base-model weights.

A skill should:

- solve one repeatable semantic task;
- define inputs, constraints, checkpoint expectations, and structured output;
- reference canonical docs rather than copy long product rules;
- avoid credentials/transport details;
- avoid exact geometry/render/export responsibilities;
- be independently benchmarkable/versionable.

Prompts, few-shot examples, instruction bundles, and model configuration belong in versioned files, not large TypeScript literals.

## Prompt style

Prompt for goal, evidence, allowed choices, constraints, and output schema. Avoid verbose hidden workflows that deterministic code can enforce.

Prefer:

- choose among supplied compatible layouts, not invent coordinates;
- fill known semantic slots, not position arbitrary objects;
- rewrite one target, not regenerate unrelated slides;
- return one bounded Supervisor finding/patch, not a replacement deck.

Prompt text may remind the model about locks/selections, but programmatic enforcement remains the real boundary.

## Continuous generation semantics

Model orchestration must align with the product's progressive flow:

- one shared `DeckPlan` precedes slide generation;
- produce A/B/C as one logical slide pack;
- commit/publish a valid pack and immediately continue toward the next planned slide;
- do not wait for user selection before continuing;
- allow Supervisor to review completed checkpoints opportunistically while Worker moves forward;
- allow visual candidates to update already-published slots asynchronously;
- local edits to ready slides do not restart unrelated pending generation.

The model is not responsible for event delivery or queue correctness; the application scheduler/state machine is.

## Versioning and traceability

Every generated deck should record:

- semantic model id/revision and serving profile;
- Worker instruction/skill bundle version;
- Supervisor instruction/skill bundle version;
- immutable prompt-prefix versions;
- template compiler/renderer/audit versions;
- media model/revision;
- generation timestamp;
- candidate/selection lineage.

Do not require exact stochastic reproducibility when unavailable. Preserve enough configuration to diagnose regressions.

## Offline behavioral optimization

A stronger offline critic may improve prompts/skills during development. It is not a runtime dependency and is distinct from Supervisor.

Use a fixed benchmark loop:

```text
runtime model + current instructions
  -> generated decks
  -> deterministic metrics + screenshots + audit + runtime telemetry
  -> offline critic proposes a specific patch
  -> apply candidate patch
  -> rerun full benchmark
  -> accept only if aggregate quality improves without hard-gate regression
  -> version accepted instructions
```

This is behavioral distillation into instructions/examples/retrieval/constraints/validators, not weight distillation.

Runtime Supervisor fixes deck-specific issues. Offline critic improves the system across benchmark runs. Do not conflate them.

## Benchmark dimensions

Track:

- template/layout compliance;
- overflow/overlap and native editability;
- A/B/C slide/visual validity;
- progressive time-to-first-pack and pack cadence;
- lock/local-edit preservation during background generation;
- deterministic/contextual audit quality;
- Supervisor repair value versus latency;
- total runtime and failure rate;
- prefix/KV cache pressure.

Keep held-out unseen-template evaluation separate enough to detect overfitting.

## Runtime failure behavior

If model output is invalid/unavailable:

1. preserve current project/ready-slide state;
2. cancel stale work;
3. retry through a bounded policy;
4. use deterministic/default choices when safe;
5. keep unrelated slide generation moving where possible;
6. expose an actionable failure when semantics cannot be recovered safely.

Never corrupt the template, selections, locks, ready packs, or deadline state merely to make progress.
