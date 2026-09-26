# RELEASE READINESS

**STATUS: BLOCKED**  
**Scope:** final offline acceptance before live Qwen/VK. No RunPod, GPU, live model, external inference, commit, or push.

## CASE COMPLIANCE

- Organizer source: official 7-page local PDF was read in full, including appendix. SHA-256 in [`CASE_REQUIREMENTS.md`](./docs/compliance/CASE_REQUIREMENTS.md) matches the local source. PDF is not tracked in Git and has no source URL printed in it; provenance is recorded without an invented link. Organizer source/version should later be added to a tracked source register.
- Current traceability count: **PASS 9/25, PARTIAL 14/25, FAIL 2/25**. C15 3×3 and C16 held-out now pass the bounded local qualification; this is not full organizer acceptance.
- Organizer clarification for this run: a separate content package is not expected; the user task is required, context and source files are optional. The latest matrix uses one persisted task/context-only plan across all three templates.
- Remaining failed/unknown case items include text-to-image path (C07), the unverified 300-second live workload (C18), and VK inference requirement (C21).

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
| PPTX | Smoke and all nine current matrix files passed package reopen; structural reports show editable native text, no raster slides and no speaker notes | Structural PASS; not opened/saved in PowerPoint or LibreOffice; native visual acceptance BLOCKED |
| PDF | Pinned adapter and PDF reopen/page-count tests exist | Structural test only; no release-candidate PDF matrix or browser/visual inspection; acceptance not confirmed |
| HTML | Escaping and structural adapter tests exist | Structural test only; no release-candidate HTML matrix or browser matrix; acceptance not confirmed |

## 3×3 DELIVERABLE

- Expected: 9 organizer-template × A/B/C decks from one shared task/context plan; no separate organizer content package is expected under the supplied clarification.
- Actual: **9/9** in `.lct/core-generation-fix-20260926/case-3x3/`, Office Kit backend, one shared three-slide task/context-only plan. VK Tech 3/3; WorkSpace 3/3; Education 3/3. Every PPTX reopened, passed factual-equivalence and template-preservation gates, had zero deterministic audit findings, zero notes, and zero raster slides.
- This is a local fake-only qualification artifact set, not a manually reviewed final demo deck. Preview text-metric warnings remain (10 total, low-confidence approximation); no PowerPoint/LibreOffice visual review was performed.

## UNKNOWN TEMPLATE

**PASS for the bounded local fake E2E.** Exact held-out `AIOS_Онбординг (4) (1) (1).pptx`, SHA-256 `18198cc08df9fc3ea5aee5f509d89e70a4ade68bb539fed61a957581ee365ad`, 16 slides / 2 masters / 2 layouts. Task+context only, 0 source files; A/B/C, audit, export/reopen passed. Five forbidden source-specific phrases were absent from the selected deck and all three track exports. Manifest: `.lct/unknown-template-qualification/unknown-template-2026-09-26T164941-924Z-ceef591a/UNKNOWN_TEMPLATE_MANIFEST.json`. Native Office visual fidelity and live-model behavior remain unverified.

## 10–15 SLIDE

- 12-slide synthetic fake-only product smoke passed creation, selection/lock, 36 variant audits, selected/track PPTX export and reopen; source hash unchanged.
- `generationRenderAndPreview`: **304.077 s**; full smoke: **322.635 s**. This exceeds the 300-second target without live inference.
- Deck-level `trackFacts` and `provenance`: `not-checked`; safe repair: `not-available`; Office-native render: unknown.
- No latency claim is made for live inference. C18 remains unaccepted.

## TESTS

Повторно проверено 2026-09-26 после P0 Core Generation Fix: frozen install (`pnpm 10.33.2`) — PASS; test — **187 passed, 0 failed**; typecheck — PASS; build — PASS; boundary — PASS; craft lint — PASS; docs links — PASS (55 required files); `git diff --check` — PASS. Git выдал только предупреждения о нормализации LF→CRLF на Windows.

Текущие продуктовые результаты: task/context-only organizer-template matrix — **PASS 9/9**, exact held-out AIOS onboarding local fake E2E — **PASS** с audit/export/reopen и source-residue gate. Отдельный 12-слайдовый smoke из предыдущего этапа занимал 322.635 s; он не входит в P0 acceptance и остаётся performance blocker. Матрица и held-out run выполнены Office Kit/fake-only без external inference.

## KNOWN LIVE-ONLY RISKS

1. Qwen semantic quality.
2. Strict structured output under the intended serving runtime.
3. Live inference latency.
4. VK endpoint authentication/configuration and model revision.

## NEXT ACTION

The missing organizer content package is not a blocker under the supplied clarification. Remaining offline work is to review the 9-deck/AIOS output visually in native Office software and address or accept preview approximation warnings; the 12-slide synthetic flow still exceeds 300 seconds. Then perform one bounded live qualification: profiler 1, Worker 1, Supervisor 1, generation 0; total no more than 3 inference requests.
