# Overnight demo quality plan

**Status:** IN PROGRESS — M0 verified; first M1 selector/renderer/profiler slice implemented; fresh matrix pending
**Branch:** `overnight-wow-2026-09-28`
**Base:** `de8611175313a132559e46ac4a6ab77ec2142f55`
**Network boundary:** offline only; semantic/provider/profiler/image calls = 0.

## Immutable baseline

The real-Qwen golden bundle at `.lct/golden-live-workspace/workspace-live-2026-09-27T231923-945Z/bundle` is a read-only regression fixture. Replay tooling may write reports only to a disposable copy. Never alter golden inputs, expectations, or fingerprints.

## Milestones and acceptance

| Milestone | Acceptance | Status |
| --- | --- | --- |
| M0 Baseline and visual inventory | Golden replay passes from a disposable copy; inventory real templates and source/golden contact sheets; explain donor-selection root cause with code and visual evidence. | VERIFIED |
| M1 Semantic composition resolver | Safe-fit remains a hard constraint; ranking accounts for semantic intent, density/slots, visual richness, source-specific risk, adjacency and deck-level diversity; targeted regressions and rendered evidence pass. | IMPLEMENTED; targeted tests pass, fresh matrix pending |
| M2 A/B/C strategy | Stable balanced, visual-first, and structured-dense deck strategies yield visibly distinct, safe tracks where candidates permit. | NOT STARTED |
| M3 Realize visual intent | Process/timeline/comparison/diagram use editable native objects or suitable measured donors; KPI/chart/table are evidence-gated; realized/downgraded intent is observable. | NOT STARTED |
| M4 Content quality | Generic takeaway and visual-type prompt/validation improvements have fake/eval coverage; golden fixtures stay backward-compatible; no inference. | NOT STARTED |
| M5 Cross-template robustness | WorkSpace, VK Tech, Education and held-out AIOS each pass local 3-slide × A/B/C pipeline, preview, audit, reopen, supported exports and source immutability; VK Tech long regression is recorded. | NOT STARTED |
| M6 Visual quality loop | Contact sheets are inspected after changes; high-impact hierarchy, empty regions, fit, narrative and strategy defects are fixed generically. | NOT STARTED |
| M7 Stress deck | 10–15 slide offline plan covers varied semantic forms without invented numeric evidence; 30–45 outputs pass fit, diversity, export and reopen checks with measured timings. | NOT STARTED |
| M8 Desktop UI | Existing product flow is legible at ~1440×900, with clear progress, A/B/C comparison, audit and exports; refresh persistence is confirmed. | NOT STARTED |
| M9 Demo freeze | Golden replay and full gates pass; golden fallback runbook and morning report are accurate and point to local artifacts. | NOT STARTED |

## Decisions

- **REUSE Office Kit/current adapters.** Keep the existing package parser, native renderer, preview, package inspector and exporters. No new deck model, parser, renderer, or dependency unless a concrete compatibility gap is demonstrated.
- **ADAPT OpenDesign concepts only.** Use semantic-intent dispatch, archetype fit, and visual/narrative critique ideas; do not copy code/prompts or introduce another agent stack.
- Keep safety/fit as hard constraints; improve candidate scoring/assignment rather than weakening validation.
- Synthetic/fake semantic fixtures only. Golden Qwen responses are replay fixtures, not invitations to call the provider.

## Regressions and evidence log

| Date | Finding | Evidence / resolution |
| --- | --- | --- |
| 2026-09-28 | Golden visual baseline reportedly projects all 9 variants from one donor and shows empty repeated cards. | To reproduce in M0 from immutable bundle; do not assume fix until source and rendered evidence agree. |
| 2026-09-28 | Replayed golden workflow using a disposable copy of the bundle; exact captured request fixtures matched, offline network guard passed, 3 slides / 9 variants / audit / PPTX-PDF-HTML passed. | Command: `node --import tsx scripts/replay-golden-live-e2e.mjs .lct/overnight/overnight-wow-2026-09-28/golden-baseline-copy/bundle`. Original golden manifest hash stayed `49c7c07a…6793e`; source PPTX hash stayed `1b888311…852f2f`. |
| 2026-09-28 | Visual review confirms the reported failure: the 3-slide A track shows 2×3 gray card grids with large empty cells; slide titles are section labels. All tracked baseline donor assignments use slide 7. | Inspected original immutable `previews/slide-01-A.png`, `slide-02-A.png`, `slide-03-A.png` and `composition-assignments.json`; generated read-only review evidence remains at the original golden bundle. |
| 2026-09-28 | Selector root cause is confirmed: per-slide A/B/C assignment maximizes distinct *projected signatures*, then minimizes local rank cost; each planned slide is resolved independently. Variant family preferences are weak score nudges, and no deck-wide donor/family reuse penalty exists. | `exemplar-slide-selector.ts`: `candidateFor`, `semanticCandidates`, `assessExemplarSelection`, `assignSafeVariantCompositions`, `assessVariantCompositionDistinctness`; `generation-service.ts` calls this per slide then checks deck hashes. Profile archetype counts are not safe-projection counts. Saved golden lacks per-candidate diagnostics, so we cannot claim other donor slides failed safety rather than ranked lower. |
| 2026-09-28 | Golden task-only plan contains 3–4 generated-from-brief points per slide, no source/media refs; all outputs reuse the six-region grid. Slide 1 is content-heavy rather than an opening cover. | DeckPlan and rendered preview review; profile has 29 rows (1 cover, 21 content, 2 table-data, 2 visual-led, 3 closing). Sparse body slots explain the blank cards; requested process/KPI intent is not realized by current donor projection. |
| 2026-09-28 | Existing qualification contact sheets expose other template risks: VK Tech 21/21 previews with title/logo collision and sparse layouts; Education leaves large empty tiles; WorkSpace 0/21 withheld in earlier matrix; AIOS 0/21 withheld because unsafe source visuals. | Read-only independent visual inventory of `.lct/final-offline-qualification/contact-sheets-office-kit` and its matrix. Re-run against current code after fixes. |
| 2026-09-28 | Rendered and visually inspected original source templates through existing Office Kit preview adapter. | `.lct/overnight/overnight-wow-2026-09-28/source-contact-sheets/`: VK Tech 54 slides, WorkSpace 29, Education 55, AIOS held-out (lecture) 60; all preview status passed. Families include cover/closing, photo/visual-led, 3/4/6/8-card, timeline, statistic/KPI, table, charts and diagrams. These are source template families, not generated content or hardcoded slide indexes. |
| 2026-09-28 | Implemented the first selector/rendering slice: strategy-aware safe candidate ranking, sparse aligned body-slot selection, removal of unused top-level donor panels, native process/comparison realization and auditable visual-intent outcomes. Profiler now bounds evidence/schema together and plans contiguous batches with dynamic programming; prompt v3 is fingerprinted. | Full offline test suite passed 274/274; daemon and web typechecks, web production build, presentation-boundary, craft-reference, docs-link and `git diff --check` passed. Targeted composition/profiler regressions passed. This verifies code gates, not visual matrix acceptance. |

## Visual evidence paths

Source-template sheets and index: `.lct/overnight/overnight-wow-2026-09-28/source-contact-sheets/`; golden baseline gallery: `.lct/golden-live-workspace/workspace-live-2026-09-27T231923-945Z/bundle/preview-gallery.html`; individually inspected preview PNGs: `bundle/previews/slide-01-A.png`, `slide-02-A.png`, `slide-03-A.png`. These are local ignored artifacts, not release source files. M0 replay passed from a disposable bundle copy; original manifest/source hashes remained unchanged.

## Final status

Pending. Do not claim `OVERNIGHT_DEMO_READY` until all user-defined DONE WHEN criteria are verified. M0 is verified: original sources were rendered with Office Kit (no new dependency), golden replay passed in an isolated copy, and selector root cause matches golden assignment evidence. The first M1 implementation is in place and code gates pass, but its visual effect is not yet verified across fresh templates. Exact next step: rerun the offline matrix after the prompt-v3 batch reduction, inspect new contact sheets, and resolve any remaining generic blockers before moving to M2–M9.\n
