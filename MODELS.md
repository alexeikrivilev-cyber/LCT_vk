# Models, prompts, and skills

## Runtime policy

The final product must run with the model resources permitted by the hackathon. The primary runtime LLM target is the Qwen 3.8 27B model provided through VK inference for the final/top-team environment, as named in the case materials.

During qualification, any alternative runtime model must remain within the case limits for open-weight models and licensing/model size. Keep provider details behind an adapter so the presentation domain does not depend on one HTTP schema.

Image generation is a separate media capability. Keep it behind the existing thin image adapter or a replacement with the same small boundary.

A visual-language model may be used only when visual semantics materially help; deterministic PPTX facts must still come from parsing.

## Responsibility split

Use the LLM for semantic decisions:

- understand the brief and supplied content;
- build the narrative and `DeckPlan`;
- write concise conclusion-style titles and slide copy;
- label template/layout semantics when exact parsing cannot provide meaning;
- rank valid layout candidates;
- choose the semantic visual type;
- propose chart/diagram treatment within allowed choices;
- select recommended candidates;
- perform contextual audit;
- propose local semantic repairs.

Do not delegate these responsibilities to the LLM:

- extracting exact PPTX geometry/colors/fonts/relationships;
- inventing arbitrary slide coordinates;
- enforcing hard layout constraints;
- preserving locks;
- editing OOXML directly as unvalidated free text;
- constructing native PPTX objects;
- deterministic audit;
- file integrity and export correctness.

The goal is to reduce the model's search space, not to ask a 27B model to behave like a full presentation engine.

## Structured outputs

Every model-facing operation should have a narrow contract and a machine-validated result.

Prefer JSON-like schemas with stable ids and enums over prose parsing. Validate before committing state. On invalid output, use a bounded repair/retry path; do not let malformed model text leak into rendering.

Model responses reference known ids for layouts, slots, content items, and candidates. They do not invent references that have not been supplied.

## Context construction

Give the model only the context needed for the current decision:

- compact brief/content slice;
- relevant `PresentationDesignSystem` rules;
- a small set of compatible layouts/slots;
- existing locks/selections relevant to the mutation;
- current audit findings when repairing.

Do not dump the entire raw PPTX XML, every layout, every skill, and every craft file into every call.

Use progressive disclosure: retrieval/selection narrows the choice set before the model decides.

## Skill architecture

Use one thin top-level presentation orchestrator and narrow specialized skills.

Target responsibilities:

```text
presentation-orchestrator
  -> template semantics
  -> content/deck planning
  -> layout ranking
  -> visual planning
  -> contextual audit
  -> repair
```

The orchestrator coordinates state and calls capabilities; it should not contain the full domain handbook.

A skill should:

- solve one repeatable semantic task;
- declare clear inputs/outputs;
- use structured output where possible;
- reference canonical docs instead of copying them;
- avoid provider credentials and transport logic;
- avoid exact geometry/rendering responsibilities;
- be independently versionable and benchmarkable.

Prompts, few-shot examples, skill instructions, and model configuration belong in versioned files. Do not hide large prompts inside TypeScript string literals.

## Prompt style

Prompt for goals, constraints, available choices, and output schema. Avoid verbose step-by-step micromanagement when deterministic code can enforce the requirement.

Give the runtime model freedom inside a constrained option set:

- "choose one of these compatible layouts" is preferred to "design a beautiful slide";
- "fill these semantic slots" is preferred to "position every object";
- "rewrite this title under the stated constraint" is preferred to regenerating the slide.

Prompts should explicitly preserve existing selections/locks for local mutations, while programmatic enforcement remains the real safety boundary.

## Versioning and traceability

Every generated deck should be traceable to:

- runtime model id/provider profile;
- prompt/skill version;
- template compiler version;
- renderer version;
- audit version;
- generation timestamp;
- candidate/selection lineage.

Do not require exact stochastic reproducibility when the provider cannot offer it, but keep enough metadata to reproduce the pipeline configuration and diagnose regressions.

## Offline behavioral optimization

A stronger offline critic may be used during development to improve prompts/skills. It is not a runtime dependency.

Use a fixed benchmark loop:

```text
runtime model + current skills
  -> generated decks
  -> deterministic metrics + screenshots + audit
  -> stronger critic proposes a specific patch
  -> apply candidate patch
  -> rerun full benchmark
  -> accept only if metrics/quality improve without unacceptable regressions
  -> version the accepted skill/prompt
```

Treat this as behavioral distillation into instructions, examples, retrieval, constraints, and validators. Do not claim weight distillation.

Never accept critic edits solely because they sound better. Regression evidence decides whether a prompt/skill change ships.

## Benchmark dimensions

Track metrics that reflect the case:

- template/layout compliance;
- overflow/overlap rate;
- native-object/editability checks;
- deck/slide variant validity;
- lock preservation;
- audit pass rate;
- contextual slide quality;
- runtime and failure rate.

Keep benchmark templates separated from the unseen-template evaluation workflow enough to detect overfitting.

## Runtime failure behavior

If model output is invalid or unavailable:

1. preserve current project state;
2. retry only through a bounded policy;
3. fall back to deterministic/default choices when safe;
4. expose an actionable error when semantics cannot be recovered.

Never corrupt the template, selections, or locks to "make progress."
