# AGENTS.md

## Mission

Build LCT as a presentation compiler. The product converts an arbitrary corporate PPTX template, supplied content, and a brief into a recommended editable presentation with controlled alternatives, audit, repair, and export.

The current UI/design implementation is replaceable. Do not preserve existing visual decisions when implementing the new product experience. Preserve product contracts, domain behavior, and architecture boundaries.

## Source of truth map

Read only the documents relevant to the task:

- `CONTEXT.md` — product behavior and acceptance flow.
- `ARCHITECTURE.md` — runtime boundaries and data contracts.
- `MODELS.md` — model responsibilities and two-agent orchestration.
- `INFERENCE.md` — GPU serving, precision, cache isolation, scheduling, media model, and the five-minute budget.
- `AUDIT.md` — findings, repair, and preflight.
- `TESTING.md` — verification requirements.
- `skills/README.md`, `craft/README.md`, `design-systems/README.md` — reusable rules.

Do not duplicate large product rules here.

## Product invariants

- The final goal is an autonomous presentation compiler, not a slide editor or image generator.
- Unknown PPTX templates must work without template-specific code.
- The system produces a complete recommended deck first.
- Every slide has A/B/C alternatives derived from one shared plan.
- Visual alternatives stay inside one planned semantic type; type changes require re-planning.
- Users can lock approved slides or blocks. Regeneration and repair must respect locks.
- Prefer local regeneration over full regeneration.
- Audit and repair are part of the generation workflow.
- Export must produce editable native presentation objects. Full-slide raster output is invalid.
- The uploaded PPTX is an immutable source artifact.
- The current product UI is not a source of truth; a future redesign must implement the documented workflow, not replicate old screens.

## Runtime and architecture invariants

- `apps/web` owns interaction and state presentation only.
- `apps/daemon` owns presentation domain logic, persistence, rendering, audit, export, and adapters.
- Runtime semantic inference uses one shared `Qwen/Qwen3.8-27B` model instance per GPU serving unit, not one model copy per agent.
- There are two logical agents over that model: the worker drives generation; the supervisor reviews checkpoints and proposes bounded repairs.
- Worker and supervisor must use separate mutable conversation/KV-cache namespaces. They may share immutable model weights and engine-level immutable prefix optimizations only.
- The five-minute generation limit is an architectural constraint. Do not add model/media work without accounting for the deadline and GPU memory budget.
- Models decide semantic things: narrative, wording, ranking, classification, and repair suggestions.
- Deterministic code owns geometry, constraints, object creation, locks, persistence, validation, and export.
- Never delegate exact layout calculations or PPTX structure to a model.
- Keep integrations behind adapters and validate structured model output before use.
- Keep orchestration thin; use specialized skills/modules with narrow contracts.

## Autonomous execution

Work as a senior engineer: inspect, decide, implement, verify, and refine.

Within documented invariants choose implementation details freely. Ask only when a decision changes product behavior, breaks an invariant, introduces a major dependency, or cannot be safely inferred.

Prefer the smallest complete vertical slice over speculative infrastructure.

## Required self-checks

Before declaring work complete:

1. Re-read the relevant source-of-truth documents.
2. Check that the change improves the final product goal, not only the local implementation.
3. Check for contradictions with architecture, UX, model boundaries, export rules, and the five-minute runtime contract.
4. If inference is affected, verify: one shared weight set, two isolated agent caches, bounded supervisor work, VRAM headroom, and deadline behavior.
5. Update documentation when behavior or architecture changes.
6. Run the narrowest meaningful validation commands.
7. Report checks actually executed; never claim unrun checks passed.

Validation:

```bash
pnpm check:boundary
pnpm lint:craft        # when skills/craft/design rules change
pnpm typecheck         # when TypeScript changes
pnpm build             # when runtime/UI/build behavior changes
```

If a check cannot run, state the exact limitation.
