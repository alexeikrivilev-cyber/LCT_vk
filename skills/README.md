# Skills

Skills contain reusable semantic workflows for the presentation compiler. They are versioned prompt/configuration assets, not a second implementation layer for geometry, persistence, rendering, or export.

## Current inventory

The repository currently keeps two substantive reference skills:

- `pptx-html-fidelity-audit` — presentation fidelity/audit workflow and supporting utilities.
- `reference-design-contract` — evidence-to-design-contract workflow useful when deriving template semantics.

They are starting material, not the final orchestrator architecture.

## Target skill shape

The target runtime has one thin orchestration skill plus narrow specialized skills, for example:

```text
presentation-orchestrator
  -> template-semantics
  -> deck-planner
  -> layout-ranker
  -> visual-planner
  -> contextual-auditor
  -> repair
```

Exact names may change. The responsibility split in `MODELS.md` and `ARCHITECTURE.md` must not.

## Authoring rules

A skill should:

- solve one repeatable semantic task;
- state its inputs, constraints, and structured output clearly;
- reference canonical repository docs instead of copying long product rules;
- operate on stable ids supplied by the application;
- leave exact geometry, OOXML, native object construction, locks, persistence, and deterministic audit to code;
- avoid provider credentials and transport details;
- be small enough to benchmark and version independently.

The top-level orchestrator coordinates stages. Do not turn it into a giant presentation handbook.

Prefer constrained choices over unconstrained design instructions. For example, rank a supplied set of compatible layouts instead of asking the model to invent a slide.

## Versioning

Prompt/skill changes can materially change output and must be traceable. Record a version for accepted runtime instructions and include that version in generation metadata.

Use the benchmark process in `TESTING.md` and `MODELS.md` before promoting a prompt/skill change.

## Craft references

`craft/` contains compact brand-agnostic presentation guidance. A skill may opt into the relevant references using the frontmatter format already supported by the retained skill files.

After changing craft references, run:

```bash
pnpm lint:craft
```

Do not load every craft file into every model call. Use only what the current skill needs.

## Licensing and provenance

Keep any package-level `LICENSE`, source notice, or provenance file intact. If a retained skill has its own license, that license governs that package. Do not remove attribution as part of prompt cleanup.
