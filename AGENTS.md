# AGENTS.md

## Mission

Build LCT as a presentation compiler. It converts an arbitrary corporate PPTX template, supplied content, and a brief into a recommended editable presentation with controlled alternatives, continuous background generation, audit, repair, and export.

The current UI/design is temporary and replaceable. Preserve product contracts, domain behavior, and architecture boundaries; do not preserve legacy visual decisions for their own sake.

## Source-of-truth map

Read only what the task needs:

- `CONTEXT.md` — product behavior and user workflow.
- `ARCHITECTURE.md` — domain boundaries, state flow, and incremental generation.
- `MODELS.md` — worker/supervisor responsibilities and prompt/skill policy.
- `INFERENCE.md` — GPU profiles, cache/prefix strategy, scheduling, media inference, and the five-minute budget.
- `AUDIT.md` — findings, repair, and preflight.
- `TESTING.md` — verification and release gates.
- `skills/README.md`, `craft/README.md`, `design-systems/README.md` — reusable authoring rules.

Do not duplicate long rules here.

## Product invariants

- The final product is an autonomous presentation compiler, not a slide editor or image generator.
- Unknown PPTX templates must work without template-specific code.
- The system produces a complete recommended deck without requiring user decisions.
- Every slide has A/B/C alternatives derived from one shared deck plan; coherent whole-deck A/B/C tracks must remain reconstructable.
- After planning, generation runs continuously. A ready slide pack means A/B/C for one slide; publish packs progressively and continue with the next slide without waiting for acknowledgement.
- The UI may surface unobtrusive progress/new-slide notifications, but generation stops only on completion, explicit pause/cancel, or a true blocking failure.
- Visual alternatives stay inside one planned semantic type; type changes require re-planning.
- Users can inspect, switch, or lock already-ready slides while later slides continue generating. Local changes must not restart unrelated work.
- Audit and repair are part of the generation workflow. Supervisor review must not become a serial approval gate for every slide.
- Export must produce editable native presentation objects. Full-slide raster output is invalid.
- The uploaded PPTX is immutable source material.

## Runtime and architecture invariants

- `apps/web` owns interaction and presentation of state only.
- `apps/daemon` owns presentation domain logic, persistence, rendering, audit, export, orchestration, and adapters.
- Runtime semantic inference uses one logical `Qwen/Qwen3.8-27B` model service. Its weights may reside on one GPU or be sharded across multiple GPUs; worker and supervisor do not get separate model replicas.
- Worker drives forward generation. Supervisor reviews versioned checkpoints and proposes bounded repairs/local re-plans.
- Worker and supervisor calls carry independently supplied application messages/context. The semantic adapter is stateless and does not provide persistent sessions or distinct KV namespaces; serving-side prefix reuse is an optimization and must not affect correctness.
- Guaranteed runtime instructions/pipeline prefixes should be prewarmed before timed generation where the selected serving runtime supports it; mutable project context remains scoped and validated.
- The normal 10–15 slide deck must complete within 300 seconds. Do not add model/media work without accounting for latency, VRAM, and scheduler impact.
- Models make semantic decisions. Deterministic code owns exact geometry, constraints, native object construction, locks, persistence, validation, scheduling state, and export correctness.
- Keep integrations behind adapters and validate structured model output before mutation/rendering.

## Autonomous execution

Work as a senior engineer: inspect, decide, implement, verify, and refine. Within documented invariants choose local algorithms, data structures, refactors, and module layout freely.

Ask only when a decision changes product behavior, breaks an invariant, introduces a major dependency/service, or cannot be safely inferred. Prefer the smallest complete vertical slice over speculative framework work.

For substantial work, define acceptance from the request and canonical docs, inspect the current Git state and affected behavior, and run a baseline before editing. Deliver the smallest runnable, observable end-to-end slice that meets that acceptance; avoid speculative frameworks and unrelated cleanup. Do not rewrite a functioning subsystem without a measurable reason and evidence for the replacement.

Delegate only bounded work with an explicit owner, scope, expected output, and read-only/editable status. The root agent owns shared contracts, integration, final diff review, and verification. Give each shared file one editor at a time; parallelize independent read-only reviews. Check reviewer claims against the repository before relying on them.

Treat this repository's canonical docs and accepted contracts as authoritative. Research or donor repositories are evidence only; validate any proposed behavior or interface against this repository before carrying it over. Use an independent read-only verifier for substantial changes and add a skeptic for risky or cross-cutting changes; resolve findings in the root review.

Report evidence with these states: `DOCUMENTED TARGET`, `IMPLEMENTED`, `VERIFIED`, `PARTIALLY VERIFIED`, or `BLOCKED`. Use `VERIFIED` only for behavior covered by an executed check, and name the check. For substantial work, summarize changed files, behavior, checks and outcomes, limitations, exact next step, and final Git status.

## Required self-checks

Before declaring work complete:

1. Re-read the relevant source-of-truth docs.
2. Check that the change improves the final product goal, not only a local implementation detail.
3. Check for contradictions across product UX, architecture, model roles, audit/export, and the 300-second runtime contract.
4. If generation flow changed, verify progressive slide-pack publication, no per-pack user gate, stable A/B/C semantics, and local edits that do not reset unrelated pending work.
5. If inference changed, verify one logical model boundary and independent Worker/Supervisor request contexts. Mark serving-specific sessions, prefix warmup, VRAM headroom, hardware behavior, and deadline degradation as unverified until measured at that layer.
6. Update the canonical document when behavior or architecture changes; avoid copying the same policy into multiple files.
7. Run the narrowest meaningful validation and report only checks actually executed.

```bash
pnpm check:boundary
pnpm lint:craft        # when skills/craft/design rules change
pnpm test              # when behavior or verification tooling changes
pnpm typecheck         # when TypeScript changes
pnpm build             # when runtime/UI/build behavior changes
```

If a required check cannot run, state the exact limitation.
