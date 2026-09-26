# RELEASE READINESS

**STATUS: BLOCKED**  
**Scope:** final offline acceptance before live Qwen/VK. No RunPod, GPU, live model, external inference, commit, or push.

## CASE COMPLIANCE

- Organizer source: official 7-page local PDF was read in full, including appendix. SHA-256 in [`CASE_REQUIREMENTS.md`](./docs/compliance/CASE_REQUIREMENTS.md) matches the local source. PDF is not tracked in Git and has no source URL printed in it; provenance is recorded without an invented link. Organizer source/version should later be added to a tracked source register.
- Current traceability count: **PASS 6/25, PARTIAL 15/25, FAIL 4/25**. Do not interpret this as organizer acceptance.
- The organizer content pack and brief are not available locally. Current 3×3 is synthetic.
- Blocking case items include text-to-image path (C07), exact 9 deliverables (C15), held-out full E2E (C16), and VK inference requirement (C21).

## UI

- Russian typed message catalog is used by customer-facing UI.
- Deterministic audit findings map internal `ruleId` to Russian text. The UI also avoids rendering arbitrary Supervisor reasons, parser warnings, or template diagnostic prose; it shows Russian summaries instead. Regression tests check every deterministic audit rule and prohibit direct display of those untrusted text fields.
- Targeted localization tests: **7/7 PASS**. Full suite/browser walkthrough status is in TESTS below; visual UI acceptance remains unverified.

## DOCUMENTATION

| Document | Status |
|---|---|
| README.md | Present; safe local start and known blockers stated |
| ARCHITECTURE.md | Present; provider boundary and known limits stated |
| MODELS.md | Present; model/license boundaries stated |
| AUDIT.md | Present; checked and unknown gates distinguished |
| Эксплуатация | Runbook-документы есть; публичное развёртывание не заявляется |
| Security | SECURITY.md present with known gaps |
| Troubleshooting | `docs/getting-started/troubleshooting.md` present |
| Version metadata | RELEASE_NOTES.md records package, dependency, schema, prompt and expected model pins; final SHA remains unfrozen because worktree is dirty |
| Демонстрация и выступление | `docs/DEMO_RUNBOOK.md` и `docs/PITCH_OUTLINE.md` подготовлены; тайминг демо не репетировался |

Safe config example: `.env.example` (no credentials; loopback and fake endpoint). Clean-room install/start from config was verified before this release pass; commands are repeated below.

## EXPORT

| Format | Evidence | Acceptance |
|---|---|---|
| PPTX | Smoke and six generated matrix files passed package reopen; structural reports show editable native text, no raster slides and no speaker notes | Structural PASS; not opened/saved in PowerPoint or LibreOffice; 9-deck release acceptance BLOCKED |
| PDF | Pinned adapter and PDF reopen/page-count tests exist | Structural test only; no release-candidate PDF matrix or browser/visual inspection; acceptance not confirmed |
| HTML | Escaping and structural adapter tests exist | Structural test only; no release-candidate HTML matrix or browser matrix; acceptance not confirmed |

## 3×3 DELIVERABLE

- Expected: 9 organizer-template × A/B/C decks from one content package.
- Actual: **6/9** from synthetic content. VK Tech 3/3; WorkSpace 0/3 withheld; Education 3/3.
- Contact sheets and machine-readable quality JSON for all three templates are packaged under `.lct/release-candidate/3x3-synthetic-20260926/contact-sheets/`. The WorkSpace cells remain withheld. This is diagnostic packaging, not the requested final 9-deck deliverable.
- All six PPTX reopened structurally and preserved template parts/source facts. Preview warnings remain. No release PDFs/HTML were produced.

## UNKNOWN TEMPLATE

**FAIL.** Latest held-out candidate AIOS: analyze/profile and plan passed; A/B/C stopped with `VARIANTS_NOT_DISTINCT`; audit and export were not run. Manifest: `.lct/unknown-template-qualification/unknown-template-2026-09-26T141235-629Z-c21878e8/UNKNOWN_TEMPLATE_MANIFEST.json`.

## 10–15 SLIDE

- 12-slide synthetic fake-only product smoke passed creation, selection/lock, 36 variant audits, selected/track PPTX export and reopen; source hash unchanged.
- `generationRenderAndPreview`: **304.077 s**; full smoke: **322.635 s**. This exceeds the 300-second target without live inference.
- Deck-level `trackFacts` and `provenance`: `not-checked`; safe repair: `not-available`; Office-native render: unknown.
- No latency claim is made for live inference. C18 remains unaccepted.

## TESTS

Проверено 2026-09-26 после regression fix: frozen install (`pnpm 10.33.2`) — PASS; test — **181 passed, 0 failed**; typecheck — PASS; build — PASS; boundary — PASS; craft lint — PASS; docs links — PASS (55 required files); `git diff --check` — PASS. `git diff --check` выдал только предупреждения Git о нормализации LF→CRLF на Windows.

Результаты продукта основаны на генерационных прогонах текущей рабочей копии: синтетическая матрица 3×3 — **FAIL 6/9**, held-out AIOS — **FAIL до audit/export**. 12-слайдовый smoke запускался из чистой временной копии актуального тогда исходного кода. После него код генерации не менялся, но документы и отображение audit в UI обновились. Release matrix и unknown-template gate были запущены до последнего изменения русской подписи аудита в UI; затронутый regression-test и полный набор из 181 теста прошли после этого изменения.

## KNOWN LIVE-ONLY RISKS

1. Qwen semantic quality.
2. Strict structured output under the intended serving runtime.
3. Live inference latency.
4. VK endpoint authentication/configuration and model revision.

## NEXT ACTION

First obtain and hash the organizer content pack/brief, then resolve WorkSpace's generic-safe composition failure and demonstrate held-out audit/export without weakening validation. Re-run the 12-slide timing gate and structural/visual export review. Only after those offline blockers clear, perform one bounded live qualification: profiler 1, Worker 1, Supervisor 1, generation 0; total no more than 3 inference requests.
