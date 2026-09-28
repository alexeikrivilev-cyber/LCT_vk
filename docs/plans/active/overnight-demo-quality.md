# Overnight demo quality plan

**Status:** BLOCKED — morning release verification is incomplete; no further feature work was done in this freeze
**Branch:** `overnight-wow-2026-09-28`
**HEAD at recovery start:** `6b80964fa701d59d5ef6f95f195e480d89c706be` (local changes are present)
**Network boundary:** offline only; 65 local fake semantic calls, zero external/provider/profiler/image network calls.

## Immutable baseline

The real-Qwen golden bundle at `.lct/golden-live-workspace/workspace-live-2026-09-27T231923-945Z/bundle` is a read-only regression fixture. Replay tooling may write reports only to a disposable copy. Never alter golden inputs, expectations, or fingerprints.

## Milestones and acceptance

| Milestone | Acceptance | Status |
| --- | --- | --- |
| M0 Baseline and visual inventory | Golden replay passes from a disposable copy; inventory real templates and source/golden contact sheets; explain donor-selection root cause with code and visual evidence. | BLOCKED — immutable baseline hashes match, but current replay rejects a changed deck-plan prompt against captured request fixtures before generation. |
| M1 Semantic composition resolver | Safe-fit remains a hard constraint; ranking accounts for semantic intent, density/slots, visual richness, source-specific risk, adjacency and deck-level diversity; targeted regressions and rendered evidence pass. | PARTIAL — bounded deck assignment exists; the full one-click regression now fails closed on slide 2 with no complete safe A/B/C assignment. Golden replay itself stops earlier on prompt mismatch. |
| M2 A/B/C strategy | Stable balanced, visual-first, and structured-dense deck strategies yield visibly distinct, safe tracks where candidates permit. | BLOCKED — AIOS is withheld on `VARIANTS_NOT_DISTINCT`; VK Tech/WorkSpace/Education sheets also show weak visual rhythm and empty regions. |
| M3 Realize visual intent | Process/timeline/comparison/diagram use editable native objects or suitable measured donors; KPI/chart/table are evidence-gated; realized/downgraded intent is observable. | PARTIAL — native process path is exercised, but blank visual regions and weak intent realization remain in fresh output. |
| M4 Content quality | Generic takeaway and visual-type prompt/validation improvements have fake/eval coverage; golden fixtures stay backward-compatible; no inference. | PARTIAL — v6 fake qualification passed; golden plan is historical v5 copy and still has section-label takeaways; fresh content quality is not yet fully gated. |
| M5 Cross-template robustness | WorkSpace, VK Tech, Education and held-out AIOS each pass local 3-slide × A/B/C pipeline, preview, audit, reopen, supported exports and source immutability; VK Tech long regression is recorded. | BLOCKED — latest fresh run passes VK Tech/WorkSpace/Education; held-out AIOS fails `VARIANTS_NOT_DISTINCT`. |
| M6 Visual quality loop | Contact sheets are inspected after changes; high-impact hierarchy, empty regions, fit, narrative and strategy defects are fixed generically. | BLOCKED — fresh sheets were inspected; objective issues remain and the runner currently labels output PASS without joining quality errors. |
| M7 Stress deck | 10–15 slide offline plan covers varied semantic forms without invented numeric evidence; 30–45 outputs pass fit, diversity, export and reopen checks with measured timings. | PARTIAL — VK Tech 12-slide task-only run produced 36 ready variants and structural exports; visual quality gate fails and full export flow took 1,390.909 s. |
| M8 Desktop UI | Existing product flow is legible at ~1440×900, with clear progress, A/B/C comparison, audit and exports; refresh persistence is confirmed. | BLOCKED — initial screen and fresh project reload were visually checked at ~1265×720; 1440×900 and saved UI screenshots were not verified. |
| M9 Demo freeze | Golden replay and full gates pass; golden fallback runbook and morning report are accurate and point to local artifacts. | BLOCKED — golden replay and 6 tests fail; current report documents these results. |

## Decisions

- **REUSE Office Kit/current adapters.** Keep the existing package parser, native renderer, preview, package inspector and exporters. No new deck model, parser, renderer, or dependency unless a concrete compatibility gap is demonstrated.
- **ADAPT OpenDesign concepts only.** Use semantic-intent dispatch, archetype fit, and visual/narrative critique ideas; do not copy code/prompts or introduce another agent stack.
- Keep safety/fit as hard constraints; improve candidate scoring/assignment rather than weakening validation.
- Synthetic/fake semantic fixtures only. Golden Qwen responses are replay fixtures, not invitations to call the provider.

## Regressions and evidence log

## Independent recovery status (2026-09-28; supersedes older status summaries below)

This recovery was checked against branch/HEAD, current worktree diff, actual JSON and rendered images. Historical entries below are retained as chronology, not current proof.

| Check | Current evidence | Result |
| --- | --- | --- |
| Branch/source | `overnight-wow-2026-09-28`, HEAD `6b80964fa701d59d5ef6f95f195e480d89c706be`; existing edits are preserved. | Verified |
| Golden fixture immutability | Baseline manifest SHA-256 `49C7C07A24756509DC45D1395A435508B3585F6D69C9F1FE966263566766793E`; source PPTX SHA-256 `1B8883114486C69DFF706E9C4FD9382727C4506C2CFA3EC34F86987F1E852F2F`. | Baseline identity verified; replay currently fails, so M0 is not complete. |
| Latest local fake qualification | `.lct/overnight/overnight-wow-2026-09-28/morning-freeze-matrix-v1/qualification.json`: BLOCKED, 65 local fake semantic calls, external calls 0. VK Tech 12/12 slides and 36 variants; WorkSpace/Education 3 slides and 9 variants each; AIOS withheld on `VARIANTS_NOT_DISTINCT`. | Three pipeline outputs structurally passed; held-out matrix failed. |
| Latest contact sheets | `.lct/overnight/overnight-wow-2026-09-28/morning-freeze-matrix-v1/contact-sheets/`. VK Tech repeats a hero visual; WorkSpace/Education have weak differentiation, unused space and sparse regions; AIOS is explicitly withheld. | Visual gate failed. |
| Golden replay | `.lct/overnight/overnight-wow-2026-09-28/golden-replay-v4/bundle`: current deck-plan system prompt differs from captured immutable request fixture (3305 vs 3398 bytes). | Failed before generation; keep fixture unchanged. |
| Repository gates | Frozen install, web/daemon typecheck and build, docs, boundary, lint and diff check pass; suite is 282/288 with 6 failures. | Overall release gate failed. |
| UI / reload | Russian initial screen and a fresh project reload show persisted template, plan, variants, audit and exports. Current embedded viewport about 1265×720. | Reload smoke passed; required 1440×900 and saved UI screenshots absent. |
| Qualification accuracy | The older v18 matrix's `inferenceRequests=4` counts four template-level callbacks, while its fake-server diagnostics show 54 actual profiler HTTP calls. Its status also omits some rendered text-fit errors. | Reporting/gate mismatch to correct before using matrix PASS. |

### Recovery map

| Milestone | State | Next bounded action |
| --- | --- | --- |
| M0 | BLOCKED | Diagnose the prompt-fixture mismatch without modifying the immutable golden bundle. |
| M1 | PARTIAL | Keep fail-closed fit/safety; targeted code gates pass, but one-click regression fails on slide 2. |
| M2 | BLOCKED | AIOS remains held-out `VARIANTS_NOT_DISTINCT`; WorkSpace/Education track quality is weak. |
| M3 | PARTIAL | Fresh previews show repeated hero visuals and unused/weakly filled regions. |
| M4 | PARTIAL | 5 fake prompt tests still expect old English titles; do not treat test suite as green. |
| M5 | BLOCKED | Current matrix: 3 templates structurally pass; AIOS fails. |
| M6 | BLOCKED | Contact sheets contain visible visual defects; no product code changed during freeze. |
| M7 | PARTIAL | 12-slide/36-variant VK Tech structural run passed, but visual audit fails; 1,390.909 s full measured flow. |
| M8 | BLOCKED | Fresh reload restores state; 1440×900 review and saved UI screenshots remain missing. |
| M9 | BLOCKED | Full test suite and golden replay fail; see `docs/overnight/MORNING_DEMO_REPORT.md`. |

## Historical recovery map (superseded by morning freeze above)

This map was reconstructed from the current branch, golden fixture, and latest saved matrix, not from the previous handoff text.

| Milestone | Recovered state | Evidence / next action |
| --- | --- | --- |
| M0 baseline/inventory | DONE | Golden manifest and source PPTX hashes match the recorded immutable values; disposable golden replay is in the passing test suite. |
| M1 composition resolver | PARTIAL | Selector ranking and targeted tests are present. VK Tech B exposes a real process-node overlap/fit defect; fix with hard measured geometry/fit gates and rerun. |
| M2 A/B/C strategies | PARTIAL | Deck signatures differ where rendered, but visual inspection does not yet prove balanced / visual-first / structured-dense strategies. |
| M3 visual intent | PARTIAL | Native process/comparison paths are tested; saved WorkSpace/Education previews do not prove reliable realization of requested intent. |
| M4 content contracts | PARTIAL | Task-only generated copy and provenance exist; current titles are section labels and content-quality improvement remains. |
| M5 cross-template matrix | PARTIAL | Fresh v5: VK Tech, WorkSpace, Education rendered/reopened; AIOS has safe local options but A/C deck signatures collide. Fix global assignment without relaxing safety. |
| M6 visual loop | PARTIAL | Fresh v5 contact sheets inspected. VK Tech B process text overlaps title; WorkSpace/Education retain empty panels and strategy repetition. |
| M7 stress deck | NOT STARTED | No current 10–15-slide / 30–45-output stress evidence found. |
| M8 desktop UI | NOT STARTED | No current 1440×900 refresh-persistence smoke evidence found. |
| M9 demo freeze | NOT STARTED | `docs/overnight/MORNING_DEMO_REPORT.md` and `docs/overnight/DEMO_RUNBOOK.md` do not exist. |

| Date | Finding | Evidence / resolution |
| --- | --- | --- |
| 2026-09-28 | Fresh local-fake v5 matrix confirms that compilation/reopen alone overstates quality: VK Tech B process labels render at 47pt in overlapping geometry; WorkSpace/Education retain unused panel fills and repeated track archetypes; AIOS A/C repeat the same whole-deck signature although two safe options exist per slide. | `.lct/overnight/overnight-wow-2026-09-28/offline-matrix-recovery/matrix.json`, `template-1/variant-b/previews/slide-02.png`, and all four inspected contact sheets. Next: ADAPT existing Office Kit role-style, selector fit/safety, and deck-review helpers; do not weaken safety. |
| 2026-09-28 | Golden visual baseline reportedly projects all 9 variants from one donor and shows empty repeated cards. | To reproduce in M0 from immutable bundle; do not assume fix until source and rendered evidence agree. |
| 2026-09-28 | Replayed golden workflow using a disposable copy of the bundle; exact captured request fixtures matched, offline network guard passed, 3 slides / 9 variants / audit / PPTX-PDF-HTML passed. | Command: `node --import tsx scripts/replay-golden-live-e2e.mjs .lct/overnight/overnight-wow-2026-09-28/golden-baseline-copy/bundle`. Original golden manifest hash stayed `49c7c07a…6793e`; source PPTX hash stayed `1b888311…852f2f`. |
| 2026-09-28 | Visual review confirms the reported failure: the 3-slide A track shows 2×3 gray card grids with large empty cells; slide titles are section labels. All tracked baseline donor assignments use slide 7. | Inspected original immutable `previews/slide-01-A.png`, `slide-02-A.png`, `slide-03-A.png` and `composition-assignments.json`; generated read-only review evidence remains at the original golden bundle. |
| 2026-09-28 | Selector root cause is confirmed: per-slide A/B/C assignment maximizes distinct *projected signatures*, then minimizes local rank cost; each planned slide is resolved independently. Variant family preferences are weak score nudges, and no deck-wide donor/family reuse penalty exists. | `exemplar-slide-selector.ts`: `candidateFor`, `semanticCandidates`, `assessExemplarSelection`, `assignSafeVariantCompositions`, `assessVariantCompositionDistinctness`; `generation-service.ts` calls this per slide then checks deck hashes. Profile archetype counts are not safe-projection counts. Saved golden lacks per-candidate diagnostics, so we cannot claim other donor slides failed safety rather than ranked lower. |
| 2026-09-28 | Golden task-only plan contains 3–4 generated-from-brief points per slide, no source/media refs; all outputs reuse the six-region grid. Slide 1 is content-heavy rather than an opening cover. | DeckPlan and rendered preview review; profile has 29 rows (1 cover, 21 content, 2 table-data, 2 visual-led, 3 closing). Sparse body slots explain the blank cards; requested process/KPI intent is not realized by current donor projection. |
| 2026-09-28 | Prior qualification sheets exposed other template risks; v5 now supersedes some stale statuses but not the visual concerns. | Fresh v5 matrix is `.lct/overnight/overnight-wow-2026-09-28/offline-matrix-recovery/matrix.json`; 9 PPTX outputs for VK Tech/WorkSpace/Education, AIOS fail-closed with no output. See contact sheets under `offline-matrix-recovery/contact-sheets/`. |
| 2026-09-28 | Rendered and visually inspected original source templates through existing Office Kit preview adapter. | `.lct/overnight/overnight-wow-2026-09-28/source-contact-sheets/`: VK Tech 54 slides, WorkSpace 29, Education 55, AIOS held-out (lecture) 60; all preview status passed. Families include cover/closing, photo/visual-led, 3/4/6/8-card, timeline, statistic/KPI, table, charts and diagrams. These are source template families, not generated content or hardcoded slide indexes. |
| 2026-09-28 | Implemented the first selector/rendering slice: strategy-aware safe candidate ranking, sparse aligned body-slot selection, removal of unused top-level donor panels, native process/comparison realization and auditable visual-intent outcomes. Profiler now bounds evidence/schema together and plans contiguous batches with dynamic programming; prompt v3 is fingerprinted. | Full offline test suite passed 274/274; daemon and web typechecks, web production build, presentation-boundary, craft-reference, docs-link and `git diff --check` passed. Targeted composition/profiler regressions passed. This verifies code gates, not visual matrix acceptance. |

## Visual evidence paths

Source-template sheets and index: `.lct/overnight/overnight-wow-2026-09-28/source-contact-sheets/`; golden baseline gallery: `.lct/golden-live-workspace/workspace-live-2026-09-27T231923-945Z/bundle/preview-gallery.html`; individually inspected preview PNGs: `bundle/previews/slide-01-A.png`, `slide-02-A.png`, `slide-03-A.png`. These are local ignored artifacts, not release source files. The original manifest and source hashes still match the recorded baseline. A direct replay invocation against the protected original bundle is rejected with `GOLDEN_FIXTURE_IMMUTABLE`; the latest disposable replay fails `VARIANTS_NOT_DISTINCT` on slide 2.

## Final status

`MORNING_SUBMISSION_READY` is **not** established. Exact current blockers: six failing tests, golden replay prompt mismatch, held-out AIOS `VARIANTS_NOT_DISTINCT`, visible visual quality defects, and missing 1440×900/saved UI screenshots. No product code was changed during this verification pass; all pre-existing worktree changes remain intact. Continue only after these blockers are addressed and re-run the full acceptance gates. REUSE: retain Office Kit and existing adapters; SKIP new parser, renderer, dependency, and inference path.
