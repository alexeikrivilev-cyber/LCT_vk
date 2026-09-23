# Skills

Skills are versioned semantic workflows for the presentation compiler. They are prompt/configuration assets, not a second implementation layer for geometry, persistence, scheduling, rendering, or export.

## Current inventory

The repository currently keeps two substantive reference skills:

- `pptx-html-fidelity-audit` — presentation fidelity/audit workflow and supporting utilities.
- `reference-design-contract` — evidence-to-design-contract workflow useful when deriving template semantics.

They are starting material, not the final orchestrator architecture.

## Target skill shape

The runtime has two logical semantic roles over the same base model weights.

Worker-oriented capabilities:

```text
presentation-orchestrator
  -> template-semantics
  -> deck-planner
  -> layout-ranker / slide-pack planner
  -> visual-planner
  -> local-repair / re-plan
```

Supervisor-oriented capabilities:

```text
supervisor-review
  -> plan-review
  -> slide/contextual-review
  -> visual-relevance-review
  -> bounded-repair proposal
```

These are skills/capabilities, not extra agents. Contextual audit belongs to Supervisor rather than introducing a third model persona.

Exact names may change. Responsibility boundaries in `MODELS.md`, `ARCHITECTURE.md`, and `INFERENCE.md` must not.

## Authoring rules

A skill should:

- solve one repeatable semantic task;
- state inputs, constraints, checkpoint/version expectations, and structured output;
- reference canonical docs rather than copy long product rules;
- operate on stable ids supplied by the application;
- leave exact geometry, OOXML, native object construction, locks, persistence, deadline scheduling, and deterministic audit to code;
- avoid provider credentials and transport details;
- be independently benchmarkable/versionable.

The top-level orchestrator coordinates stages; it must not become a giant presentation handbook.

Prefer constrained choices over unconstrained design instructions. Rank supplied valid layouts instead of asking the model to invent a slide.

Supervisor skills return targeted findings/patch operations, never a replacement deck. They treat locks, checkpoint versions, and deadline remaining as explicit constraints.

## Instruction bundles and prefix warmup

Guaranteed normal-generation skills are known in advance. Their stable instruction/schema prefixes should be packaged so the inference runtime can prewarm them before timed generation, as defined in `INFERENCE.md`.

This is a serving optimization, not permission to concatenate every skill into every request.

Keep two concepts separate:

- **required static skill prefixes** — prewarmed because the normal pipeline will use them;
- **optional/retrieved guidance** — loaded only when relevant, such as specialized craft sections or unusual repair instructions.

Worker and Supervisor instruction bundles remain separate and independently versioned. Prefix/cache reuse must never imply shared mutable conversation history.

## Progressive-generation contract

Skills that produce slide decisions must operate on the shared `DeckPlan` and one slide scope at a time or in bounded batches that preserve slide-pack semantics.

A slide pack contains A/B/C for the same planned slide. Once the application validates/publishes a pack, the orchestrator should continue toward the next planned slide without requiring user approval.

Local edits to an already-ready slide are separate mutations and must not reset unrelated pending generation.

## Context discipline

Prewarm stable instructions; keep mutable evidence narrow.

Pass required facts through structured project/checkpoint state. Do not stuff raw project history, every layout, every craft file, or the complete content package into each skill call.

Project-specific summaries may be cached after compilation when useful, but remain project/version scoped.

## Versioning

Prompt/skill changes can materially change output. Record accepted Worker/Supervisor instruction-bundle versions and include them in generation metadata.

Use the benchmark process in `TESTING.md` and `MODELS.md` before promoting a change.

## Craft references

`craft/` contains compact brand-agnostic presentation guidance. A skill may opt into relevant references using the supported frontmatter format.

After changing craft references, run:

```bash
pnpm lint:craft
```

Do not load optional craft files merely because they exist; use them when the active skill needs them.

## Licensing and provenance

Keep package-level `LICENSE`, source notices, and provenance files intact. A retained skill's own license governs that package.
