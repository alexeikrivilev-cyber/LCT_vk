# Models, prompts, and skills

## Runtime policy

The semantic runtime uses `Qwen/Qwen3.8-27B` on the GPU inference host. Two logical agents — worker and supervisor — share one loaded model weight set and use separate mutable KV-cache/session namespaces.

`INFERENCE.md` is the canonical source for precision, GPU residency, scheduling, media inference, and the five-minute deadline. Do not duplicate those details here.

During qualification/final, model and media choices must satisfy the case limits and license requirements. Provider details stay behind adapters.

## Agent roles

### Worker

The worker owns generation and user-requested semantic edits:

- understand the brief and supplied content;
- build the narrative and `DeckPlan`;
- write concise conclusion-style titles and slide copy;
- label template/layout semantics when exact parsing cannot provide meaning;
- rank valid layout candidates;
- choose semantic visual types;
- build A/B/C slide decisions from one shared plan;
- request/select visual candidates;
- perform local regeneration and semantic repairs.

The worker is the only agent that initiates broad planning or re-planning.

### Supervisor

The supervisor is a bounded critic/repair role using the same Qwen3.8-27B weights with a separate instruction set and context.

It reviews versioned checkpoints, rendered screenshots, structured specs, deterministic audit findings, locks, and the remaining deadline. It should:

- catch contradictions between plan, title, content, visual, and template intent;
- identify likely composition/readability mistakes not covered deterministically;
- notice propagation errors early;
- propose a small structured repair or a local re-plan request;
- prioritize blocking/high-value findings under deadline pressure.

It must not independently regenerate the whole deck, maintain a competing plan, bypass deterministic validation, mutate locks, invent unrestricted geometry, or write OOXML.

Supervisor output is a validated `SupervisorDecision` tied to a checkpoint version. Stale or lock-conflicting decisions are rejected by code.

## Responsibility split

Use the semantic model for:

- narrative and slide purpose;
- wording;
- semantic template/layout labeling;
- ranking among valid layouts;
- visual-type choice;
- chart/diagram treatment choice inside allowed structures;
- recommended-candidate selection;
- contextual audit;
- bounded semantic repair.

Use deterministic/programmatic logic for:

- exact PPTX geometry/colors/fonts/relationships;
- hard layout constraints and compatibility;
- stable ids and checkpoint versions;
- locks and mutation conflict detection;
- native PPTX object construction;
- deterministic audit;
- file integrity/export correctness;
- deadline accounting and request scheduling.

The goal is to reduce model search space, not ask a 27B model to act as a renderer.

## Structured outputs

Every model-facing operation has a narrow machine-validated contract.

Prefer schemas with stable ids, enums, bounded lists, and checkpoint versions. Validate before committing state. On invalid output use a bounded repair/retry path; malformed prose never reaches rendering.

Model responses reference ids supplied in context. They do not invent layouts, slots, content ids, or locked-object ids.

Supervisor patches are especially strict: every operation must identify the target object/slide and expected source version.

## Context construction

Give each agent only the context needed for its current decision.

Worker context may include:

- brief/content slice;
- relevant `PresentationDesignSystem` rules;
- compatible layouts/slots;
- current plan/selection/locks for the affected scope.

Supervisor context may include:

- the checkpoint being reviewed;
- concise source/plan context needed to judge it;
- rendered screenshot(s) when visual judgment matters;
- deterministic findings;
- locks;
- deadline remaining.

Do not dump raw PPTX XML, every layout, all skills, or whole project history into either agent. Summarize/checkpoint long-running state instead of growing KV caches without bound.

## Skill architecture

Use a thin orchestrator and narrow specialized skills.

```text
presentation-orchestrator
  -> template semantics
  -> content/deck planning
  -> layout ranking
  -> visual planning
  -> supervisor review
  -> contextual audit
  -> repair
```

Worker and supervisor instructions must be separate versioned files even though they use the same base model.

A skill should:

- solve one repeatable semantic task;
- declare clear inputs/outputs;
- use structured output where possible;
- reference canonical docs instead of copying them;
- avoid credentials and transport logic;
- avoid exact geometry/rendering responsibilities;
- be independently versionable and benchmarkable.

Prompts, few-shot examples, skill instructions, and model configuration belong in versioned files, not large TypeScript strings.

## Prompt style

Prompt for goals, constraints, available choices, evidence, and output schema. Avoid verbose step-by-step micromanagement when code can enforce the rule.

Give the model freedom inside a constrained option set:

- choose among compatible layouts instead of designing arbitrary coordinates;
- fill known semantic slots instead of positioning objects;
- rewrite one headline instead of regenerating a slide;
- ask the supervisor for a targeted finding/patch instead of a full alternative deck.

Prompt instructions should mention locks/selections for local mutations, while programmatic enforcement remains the real boundary.

## Versioning and traceability

Every generated deck records:

- semantic model id/revision and serving profile;
- precision and inference-engine profile;
- worker instruction/skill version;
- supervisor instruction/skill version;
- template compiler version;
- renderer version;
- audit version;
- media model/revision;
- generation timestamp;
- candidate/selection lineage.

Do not require exact stochastic reproducibility when the runtime cannot provide it. Record enough to reproduce the pipeline configuration and diagnose regressions.

## Offline behavioral optimization

A stronger offline critic may be used during development to improve prompts/skills. It is not a runtime dependency and is distinct from the runtime supervisor.

Use a fixed benchmark loop:

```text
runtime model + current skills
  -> generated decks
  -> deterministic metrics + screenshots + audit
  -> offline critic proposes a specific patch
  -> apply candidate patch
  -> rerun full benchmark
  -> accept only if metrics/quality improve without unacceptable regressions
  -> version the accepted skill/prompt
```

Treat this as behavioral distillation into instructions, examples, retrieval, constraints, and validators, not weight distillation.

The runtime supervisor catches/fixes deck-specific errors during generation. The offline critic improves the worker/supervisor skills across many benchmark runs. Do not conflate these roles.

## Benchmark dimensions

Track:

- template/layout compliance;
- overflow/overlap rate;
- native-object/editability checks;
- deck/slide variant validity;
- lock preservation;
- deterministic/contextual audit pass rate;
- supervisor precision/value and repair acceptance;
- total runtime and stage latency;
- GPU/KV-cache pressure;
- failure rate.

Keep benchmark templates separate from held-out unseen-template evaluation enough to detect overfitting.

## Runtime failure behavior

If model output is invalid/unavailable:

1. preserve current project state;
2. cancel stale work;
3. retry only through a bounded policy;
4. fall back to deterministic/default choices when safe;
5. expose an actionable error when semantics cannot be recovered.

Never corrupt the template, selections, locks, or deadline state to make progress.
