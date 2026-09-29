# Plan: reliable unknown-template preparation

## Goal

Make preparation of any valid PPTX whose structural compilation succeeds independent of one long browser request or one semantic-profiler failure. Keep semantic profiling strict when it succeeds; use bounded recovery and a validated deterministic low-confidence profile only when needed. Preserve all existing renderer, fit, audit, and source-immutability gates.

## Canonical worktree

- Path: `C:\Projects\GitHub\LCT_vk`
- Branch: `main`
- Starting HEAD: `f8883ec23f34fdc53f60f8812c3fad92e3c964f7`
- Pre-existing user changes to preserve and exclude from this task's commit: `apps/web/next-env.d.ts`, `docs/plans/active/live-readiness-dual-mode.md`.
- Current task changes are confined to profiler preparation/recovery, UI state handling, and their tests; no product source/template fixtures are modified.

## Acceptance

- Structural PPTX compilation remains synchronous and source immutable.
- Semantic profile preparation is persisted and idempotently scheduled in the background; the compile endpoint returns a processing response without waiting for model inference.
- The template state endpoint reports persisted processing/ready/degraded-ready/failed truth. Restart recovers a valid interrupted preparation; polling never dispatches inference.
- Profiler recovery is bounded and uses the same per-slide evidence, strict schema, and runtime validation. Two-slide truncation/transport failures split into single-slide requests; a single-slide truncation may receive at most one larger-budget retry within the configured output/request limits.
- Exhausted semantic enrichment uses a deterministic profile derived only from the same template's structural IR and passes the existing profile validator. State and UI explicitly identify reduced confidence; preview, fit, and audit gates remain enabled.
- Invalid/corrupt PPTX still fails structural compilation and cannot enter degraded-ready.
- No template names, hashes, or fixed source IDs in product behavior.
- Offline targeted and relevant full tests/typecheck/build/docs/boundary/lint gates pass before live qualification.
- Live qualification uses the held-out Russian PPTX and one structurally different organizer template through the public UI/API path, with no RunPod lifecycle/image/model changes.
- On verified acceptance, commit only this task's files and fast-forward `main` and `overnight-wow-2026-09-28` to the same commit.

## Live inference confirmation gate

- The user required a stop before the first live inference or RunPod endpoint request. Offline implementation and gates were completed first, then `READY_FOR_RUNPOD_START` was reported.
- The user explicitly confirmed readiness on 2026-09-29 and authorized only a held-out unknown template followed by one structurally different official template.
- The bounded qualification is complete. Do not run additional live templates, generation, or matrices as part of this goal.
- Commit/push is authorized only for the scoped task files after reviewing the diff and verifying the documentation gate.

## Execution

- [x] Implement async semantic preparation, persisted recovery, bounded profiler recovery, and deterministic fallback.
- [x] Keep UI state truthful for processing and degraded-ready; verify refresh/polling.
- [x] Add targeted regressions for all acceptance paths, including malformed PPTX and duplicate-role validation.
- [x] Run targeted gates, then relevant full offline gates.
- [x] After offline gates pass and explicit user confirmation is received, prepare the held-out template and one structurally different official template through the public API; both reached persisted `ready`.
- [x] Review the complete task diff; recheck `docs:check` and `git diff --check`; prepare the task-only commit and push both branches to one SHA.

## Verification notes

Record commands and observed outcomes here as the work proceeds. Do not infer PASS from previous runs or from plan status.

### Offline progress (2026-09-29)

- Canonical path/branch/starting HEAD remain `C:\Projects\GitHub\LCT_vk`, `main`, `f8883ec23f34fdc53f60f8812c3fad92e3c964f7`.
- Targeted profiler tests: PASS (32 tests).
- Targeted semantic adapter tests: PASS (18 tests).
- Template compiler/API tests: PASS (6 tests), including detached preparation, request deduplication, and restart recovery.
- Web template-state, workflow-refresh, and Russian-message tests: PASS (16 tests).
- Daemon and web TypeScript checks: PASS.
- Full offline suite: `corepack pnpm test` PASS, 320/320.
- Async API consumers are covered: `apps/daemon/test/presentation-generation-api.test.mjs` PASS, 13/13; `scripts/product-e2e-runner.test.mjs` PASS, 14/14. The runner accepts `200/202`, polls the persisted template state, and preserves degraded-ready semantics.
- Workspace TypeScript checks: `corepack pnpm --filter @lct/web run typecheck` PASS; `corepack pnpm --filter @lct/daemon run typecheck` PASS. The root `corepack pnpm typecheck` wrapper is blocked by PATH resolving child `pnpm` to 11.19.0; direct package checks use the pinned Corepack pnpm 10.33.2 and pass.
- Production builds: `corepack pnpm --filter @lct/web run build` PASS; `corepack pnpm --filter @lct/daemon run build` PASS.
- `corepack pnpm run docs:check` PASS (63 required files); `corepack pnpm run check:boundary` PASS; `corepack pnpm run lint:craft` PASS; `git diff --check` PASS (only Git CRLF notices).
- Preparation-only product API smoke using the local fake semantic endpoint: held-out `C:\Users\Эдуард\Downloads\kompaniya-napravleniya-i-klienty.pptx`, 10 slides, 3,761,964 bytes, SHA-256 `7c34dd3f5b09607a9334b46898d1951b9a4217196109cffcd02e997e0b26414d`: upload PASS, compile returned 202, state `processing → ready`, profile cached, 5 profiler calls, 990 ms.
- Same preparation-only smoke on `C:\Users\Эдуард\Downloads\VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx`, 29 slides, 13,381,000 bytes, SHA-256 `1b8883114486c69dff706e9c4fd9382727c4506c2cfa3ec34f86987f1e852f2f`: upload PASS, compile returned 202, state `processing → ready`, profile cached, 15 profiler calls, 1,642 ms.
- Both real-file smokes stopped after template preparation; no planning/generation/export was started. They used an injected local fake endpoint only. The application path contains no template-name/hash special case.
- Live held-out preparation on 2026-09-29 used the isolated local daemon/API with the user-provided Qwen endpoint. `kompaniya-napravleniya-i-klienty.pptx`: 10 slides, 3,761,964 bytes, SHA-256 `7c34dd3f5b09607a9334b46898d1951b9a4217196109cffcd02e997e0b26414d`; compile returned 202; profile state persisted `ready`, `cached=true`, no degradation, 375,416 ms. Five planned batches used seven requests because batch 3 returned `finish_reason=length` at 2,048 tokens and bounded two-single-slide recovery passed. All final request outputs passed strict runtime validation; no planning/generation/export was started.
- Live structurally different official-template preparation: `VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx`, 29 slides, 15 layouts, 1 master, 2 themes, 13,381,000 bytes, SHA-256 `1b8883114486c69dff706e9c4fd9382727c4506c2cfa3ec34f86987f1e852f2f`; compile returned 202; profile state persisted `ready`, `cached=true`, no degradation, 875,423 ms. Fifteen planned batches used 18 requests: batch 6 length-truncated and was split; the single-slide 2,048-token response length-truncated and its one 4,096-token retry passed. All final outputs passed strict runtime validation; duplicate-role normalization was exercised and reported safe conflict counts; no planning/generation/export was started.
- The live qualification used exactly two templates and ended after persisted profile readiness. No RunPod lifecycle, image, or model configuration was changed. Compact reports are stored under ignored `.lct/live-template-preparation-20260929/` without endpoint or credential values.
- Offline coverage re-audit confirms explicit tests for client abort, duplicate preparation, GET-only cache reads, restart recovery, invalid PPTX rejection, pair-split on length/transport failure, one bounded single-slide retry, exact slide coverage, no partial cache writes, and degraded fallback.
- Current local refs before release commit remain aligned at `f8883ec23f34fdc53f60f8812c3fad92e3c964f7`; pre-existing user changes listed above remain excluded from the task commit.
- Current worktree summary includes profiler, daemon server, web state/copy, and targeted tests plus this plan. Pre-existing user changes listed above are preserved and excluded.
- Final diff review found only the intended async profile preparation/recovery, bounded profiler retry/split, explicit degraded-ready UI state, corresponding regression coverage, and this plan. The unrelated `apps/web/next-env.d.ts` and `docs/plans/active/live-readiness-dual-mode.md` changes remain excluded. `docs:check` and `git diff --check` pass after this plan update. No live inference is permitted after the two completed preparation smokes.
