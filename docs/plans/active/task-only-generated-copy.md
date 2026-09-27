# Task-only generated presentation copy

## Goal

Support both task/brief-only decks and source-backed decks without treating task instructions as slide copy or factual evidence. Finish the task-only WorkSpace path through A/B/C generation, previews, audits, exports, and UI readiness.

## Constraints

- No source file is required when a user supplies a task/brief.
- `brief-task` and `brief-context` are instructions only and never become exported body copy or source provenance.
- Generated presentation wording is marked `generated-from-brief`; factual refs remain ordinary source-backed ContentIR IDs.
- Preserve strict schema/runtime validation and deterministic factual checks.
- Reuse the existing READY WorkSpace semantic profile; do not reprofile, restart, stop, or recreate RunPod.
- No commit or push. After offline/fake qualification, at most one bounded real planning workflow is allowed in this run.

## Acceptance

- New Worker plans include bounded, concise generated body points for every slide.
- The generated copy is separately attributable from source-backed claims and raw task wording.
- Unsupported quantitative and specifically attributable claims remain blocked/flagged.
- WorkSpace produces 3/3 slides and 9/9 ready A/B/C variants with safe distinct deck compositions.
- First previews are visually readable; deterministic and contextual audits pass; PPTX/PDF/HTML export and UI flow are ready.

## Progress

- [x] Inspect current planning, projection, provenance, audit, profile, and persisted WorkSpace state.
- [x] Add bounded `generated-from-brief` body points to the replaceable Worker planning contract and projection path.
- [x] Exclude task/context instructions from Worker evidence and source-backed projection; add numeric/specific-claim checks.
- [x] Resolve inherited template title typography from Office Kit before composition qualification without changing TemplateIR identity or semantic profile.
- [x] Bound new generated titles and keep older saved plans readable for stale-state recovery.
- [x] Run a fresh fake task-only E2E against the same cached READY profile after the title-fit correction: 3 slides, 9 variants, contextual audit, A/B/C PPTX, PDF/HTML, previews, source unchanged.
- [x] Run one live WorkSpace planning and generation workflow against the existing profile; profiler calls remained zero.
- [x] Export and reopen live-generated A/B/C PPTX, selected PDF, and selected HTML locally without inference.
- [x] Run full local gates after the compatibility fix and title-fit correction.
- [x] Correct the generic title-fit estimate conservatively and constrain newly generated titles to 40 complete characters; add/adjust offline regression coverage.
- [x] Re-run fake/local qualification against the cached profile and inspect previews after the title-fit correction.
- [x] Close the audit loophole where an unrelated evidence reference could mask a generated customer/benchmark/regulatory/financial claim; enforce the generated-title bound on plans carrying generated copy, including repair validation.
- [ ] Obtain a passing live contextual audit and confirm final UI acceptance after renewed live-run authorization; the one-run budget used here is consumed.

## Evidence and current status

- Git baseline: `beaeb532c38f161a422c553e3def67e83cef57b8`; all changes remain uncommitted.
- Existing WorkSpace profile remained `READY` with key `a36dbfff5d66d8066167ec8237246de05f4bbb0a76cc997d49b1a14dd42e47f0`; template profiler provider calls: `0`.
- Fresh fake task-only run: `.lct/product-e2e/20260927184405-external-eee27e71/offline-generated-copy-v6/qualification.json` — cached profile reused (`READY`, profiler calls `0`); prompt v5 created three titles of 24/29/24 characters; 3/3 slides, 9/9 A/B/C variants, contextual audit ready; A/B/C PPTX, A PDF/HTML, previews and source immutability passed. The first three A previews were inspected and titles were complete and uncut.
- Live run: `.lct/product-e2e/20260927184405-external-eee27e71/live-generated-copy-workspace-v3/qualification.json` — Worker and plan review passed; A/B/C generation reached 3/3 slides and 9/9 variants in 10.88 s; deterministic audit had 0 errors. Contextual audit returned HTTP 200, `finish_reason=stop`, then failed strict runtime validation as `INVALID_STRUCTURED_OUTPUT`. The raw response was not retained; the specific invalid field is unknown. No retry was sent.
- Live previews show slide 2 and slide 3 titles ending in partial words (`...р`, `...ш`) and visibly clipped. Offline selector diagnostics returned title fit `1.0` for these text boxes, exposing a false pass in the current approximate glyph-width estimate.
- The offline correction uses a conservative 0.68-em title glyph-width estimate and a new Worker prompt/schema version with a 40-character title bound. It does not change template geometry thresholds, profile cache identity, or persisted-plan readability.
- No inference was used for export verification: `.lct/product-e2e/20260927184405-external-eee27e71/live-generated-copy-workspace-v3-export-validation/qualification.json` — A/B/C and selected PPTX reopened, selected PDF/HTML validated, 0 semantic calls, source template unchanged.
- Earlier no-inference live-export validation: `.lct/product-e2e/20260927184405-external-eee27e71/live-generated-copy-workspace-v3-export-validation/qualification.json` — A/B/C and selected PPTX reopened, selected PDF/HTML validated, 0 semantic calls, source template unchanged.
- Final local gates after the generated-copy audit/repair checks: 266/266 tests; web/daemon typecheck and production build; docs links; presentation boundary; craft lint; `git diff --check` all passed. Targeted planning/audit tests also passed 65/65.
- Specific-claim audit compares generated claim categories with the actual referenced source text; unrelated refs no longer suppress a warning. This is a deterministic heuristic, not semantic entailment verification.
- RunPod was not restarted, stopped, recreated, or rebuilt. No weights were downloaded. No commit/push was made.

## Exact next step

One further bounded live planning-and-generation qualification is required to exercise Worker prompt/schema v5 and resolve the contextual-audit failure. The only authorized live workflow in this run has already been consumed: planning and generation passed, but contextual audit returned HTTP 200 and failed runtime validation as `INVALID_STRUCTURED_OUTPUT`; the raw output was not retained, so the offending field cannot be determined. Do not retry or send another semantic request without renewed authorization. RunPod was not restarted, stopped, recreated, or rebuilt; no weights were downloaded; no commit/push was made.
