# AGENTS.md

## Mission

Build LCT as a presentation compiler for arbitrary corporate PPTX templates. The product turns a template, source materials, and a brief into a recommended editable deck with controlled alternatives, audit, repair, and export.

## Repository map

Read the smallest relevant source of truth before changing code:

- `CONTEXT.md` — product behavior and non-negotiable UX.
- `ARCHITECTURE.md` — layer boundaries, canonical data flow, and technical invariants.
- `MODELS.md` — runtime model responsibilities, prompt/skill policy, and offline optimization.
- `AUDIT.md` — deterministic/contextual checks, repair, and preflight.
- `TESTING.md` — verification strategy and definition of done.
- `skills/README.md` — skill boundaries and versioning.
- `design-systems/README.md` — template-derived design-system contract.
- `craft/README.md` — reusable presentation craft rules.

`README.md` is the operator entry point; it is not the product specification.

## Non-negotiable product invariants

- Unknown PPTX templates must work without template-specific code.
- Produce a complete recommended deck first; alternatives never block progress.
- Generate A/B/C alternatives for every slide from one shared deck plan.
- Preserve coherent whole-deck A/B/C tracks for the hackathon requirement.
- A visual slot has one planned semantic type. Offer three candidates inside that type; changing type is an explicit re-plan.
- Locks/pins protect approved slides or blocks from unrelated regeneration and repair.
- Prefer local regeneration over rebuilding the deck.
- Audit is built into generation and supports user-selected repair.
- PPTX export must contain native editable objects. A full-slide raster image is not an acceptable slide implementation.
- HTML is a preview/export surface, never the source of truth for PPTX structure.
- Do not build a heavy external research/fact-checking product; use the supplied content package correctly.

## Architecture invariants

- `apps/web` owns interaction and presentation of state; it does not implement PPTX parsing, layout math, model orchestration, or export rules.
- `apps/daemon` owns presentation domain services, persistence, model/media adapters, audit, rendering, and export.
- Keep the uploaded PPTX immutable. Compile it into an internal template representation and retain stable references to masters/layouts/assets.
- Models make semantic decisions. Deterministic code owns exact geometry, constraints, native object construction, locks, persistence, validation, and export correctness.
- Never ask a model to invent unrestricted slide coordinates when a valid template layout/slot can be selected.
- Prompts, skills, examples, and policy are versioned files, not large hard-coded strings in application code.
- Keep the top-level orchestrator thin; specialized skills should have narrow inputs and structured outputs.
- Parse/validate model output at boundaries before it reaches deterministic engines.
- New provider or library integrations must sit behind a small adapter and must not leak provider-specific types through the domain.

## Working agreement

Act as an autonomous senior engineer: inspect the relevant code and docs, make reasonable implementation choices, implement end-to-end, validate, and refine without waiting for approval at every step.

Within the invariants above, choose data structures, algorithms, refactors, and local module organization freely. Ask only when a decision changes product behavior, breaks a documented invariant, introduces a major dependency/service, or cannot be inferred safely.

Prefer the smallest complete vertical slice over speculative framework work. Avoid generic platform features that do not serve the presentation workflow.

When architecture or product behavior changes, update the corresponding source-of-truth document in the same change. Do not duplicate long rules across documents; link to the canonical one.

Do not claim tests or builds passed unless they were actually run.

## Validation

Run the narrowest relevant checks after changes and fix failures before finishing:

```bash
pnpm check:boundary
pnpm lint:craft        # when skills/craft references change
pnpm typecheck         # when TypeScript changes
pnpm build             # when runtime/UI/build behavior changes
```

Also run targeted tests for the subsystem changed. Presentation parser, renderer, audit, lock, and export work must add or update automated coverage as described in `TESTING.md`.

If the environment prevents a required check, state exactly what was not run and why.
