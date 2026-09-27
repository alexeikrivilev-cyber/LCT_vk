# Plan: prepared semantic profile and bounded live qualification

> **Current scope (2026-09-27):** final product decision is to prepare and persist a complete `TemplateSemanticProfile` before Generate, then use cache-only reads during generation. The profile-before-Generate WorkSpace fake E2E passed; exact held-out AIOS profile preparation passed but Generate failed closed with `VARIANTS_NOT_DISTINCT`. Stop condition triggered. VK Tech matrix and live inference were not run. Do not weaken distinctness or launch live before resolving this offline blocker.

## Goal

Подготовка шаблона выполняет structural TemplateIR/PDS inspection, затем `TemplateSemanticProfiler`, validation и запись профиля в существующий cache. Generate использует только read-only profile lookup и возвращает `409 TEMPLATE_PROFILE_NOT_READY` при missing/invalid cache entry. Подтвердить этот lifecycle real-template fake E2E, затем полными локальными gates; live WorkSpace разрешён только после полного fake и local PASS.

## Constraints

- Preserve the running Pod: no stop, restart, recreation, Docker rebuild, model download, or serving-context/runtime/precision change. Only the bounded WorkSpace qualification is authorized after local gates; VK Tech 12 slides is conditional on the complete WorkSpace PASS.
- Do not commit or push for this task.
- Preserve all pre-existing user changes, especially `test-content.md`; do not reset, clean, checkout, or overwrite them.
- Keep provider-specific deployment details out of application logic; provider label is report metadata only.
- Runner enters through public template preparation and one-click workflow APIs; it does not call planning or generation services directly.

## Acceptance

- Template preparation may infer on cache miss, validates the complete profile, and persists it with the existing TemplateIR hash/prompt/config fingerprint.
- Generate never calls the profiler; cache miss or invalid profile fails with `TEMPLATE_PROFILE_NOT_READY`. Structural fallback does not substitute for the normal quality path.
- Profile preparation is bounded to at most 14 batches; full fake/live flow budget is at most 17 calls (14 profiler + Worker + planning Supervisor + contextual audit), retries zero.
- Exact WorkSpace, AIOS and VK Tech fake flows must prove ready workflow, A/B/C, audits, reopenable exports and unchanged sources before any live run.
- Offline repository gates pass before any live request; WorkSpace live PASS gates the conditional VK Tech live run.

## Current execution checklist

- [x] Reconnect existing template compile, profiler and cache so normal preparation stores a validated semantic profile; Generate uses read-only cache lookup.
- [x] Add UI readiness/polling and failure state so Generate is unavailable until persisted semantic profile is ready.
- [x] Measure deterministic fake response JSON sizes for WorkSpace, VK Tech and Education; select output cap up to 4,096 tokens and preserve batch bounds.
- [x] WorkSpace fake: 29 source slides / 6 profiler batches; preparation READY; Generate profiler calls 0; Worker 1, planning Supervisor 1, contextual audit 1; 3/3 slides, A/B/C 9/9, audits, PPTX/PDF/HTML, source unchanged.
- [x] Exact AIOS preparation: 16 source slides / 4 batches; profile READY; Generate failed at `VARIANTS_NOT_DISTINCT` after Worker + planning Supervisor. No contextual audit/export. Manifest: `.lct/prepared-profile-fake-aios-20260927/manifest.json`.
- [ ] VK Tech 12-slide profile-before-Generate fake E2E — not run after AIOS stop condition.
- [ ] Full repository gates — not run after AIOS stop condition. Focused tests pass: daemon 25/25; adapter 16/16; runner + UI messages 22/22; `git diff --check` pass.
- [x] Stop before live WorkSpace/VK because all-template fake acceptance did not pass. No live requests, Pod lifecycle actions, rebuild or downloads.

## Fake serialized response sizing (current profile contract)

Sizing was measured with the deterministic local fake, not an inference call. Serialized fake completion maxima: WorkSpace 4,519 bytes (29 source slides / 6 batches), VK Tech 5,739 bytes (54 / 14), Education 3,829 bytes (55 / 11). Every batch stayed within 5 slides and 24 KiB evidence; fake responses ended with `finish_reason=stop`. The versioned profiler config uses a maximum output cap of 4,096 tokens and a bounded per-batch estimate (minimum 2,048, up to 1,024 tokens/source slide), with no automatic retries. This is a fake sizing choice, not proof that live Qwen will fit or meet latency.

## Historical live profile qualification (earlier protocol)

- [x] Offline sizing on the canonical WorkSpace and VK Tech source PPTX files; bounded batch plans fit the 6-slide/24-KiB limits and the 13-batch cap.
- [x] Targeted profiler/adapter/runner regressions and full repository checks pass before external inference.
- [x] Run exactly one canonical WorkSpace 3-slide external one-click E2E; it failed on batch 1/5 and stopped without retry.
- [ ] Run the conditional canonical VK Tech 12-slide E2E only after full WorkSpace acceptance; not run because WorkSpace failed.
- [x] Record the provider call’s batch, status, latency, token counts, output budget, finish reason, and runtime-schema result; preserve previous work and do not commit/push.

Offline measurements use SHA-256 `1b8883114486c69dff706e9c4fd9382727c4506c2cfa3ec34f86987f1e852f2f` for WorkSpace and `cbbe3aa6a21d23cebc4d1383b93dd07a9cea460d683de1903567b616c839485d` for VK Tech. Evidence-byte counts are serialized UTF-8 bytes; output budget is per provider call.

| Template | Source slides | Full compact evidence | Batch | Source indexes | Batch slides | Evidence bytes | maxOutputTokens |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| WorkSpace | 29 | 68,280 | 1 | 1–6 | 6 | 12,179 | 1,024 |
| WorkSpace | 29 | 68,280 | 2 | 7–12 | 6 | 19,832 | 1,024 |
| WorkSpace | 29 | 68,280 | 3 | 13–18 | 6 | 9,942 | 1,024 |
| WorkSpace | 29 | 68,280 | 4 | 19–24 | 6 | 10,098 | 1,024 |
| WorkSpace | 29 | 68,280 | 5 | 25–29 | 5 | 10,256 | 1,024 |
| VK Tech | 54 | 304,167 | 1 | 1–6 | 6 | 6,181 | 1,024 |
| VK Tech | 54 | 304,167 | 2 | 7–12 | 6 | 17,734 | 1,024 |
| VK Tech | 54 | 304,167 | 3 | 13–16 | 4 | 23,274 | 1,024 |
| VK Tech | 54 | 304,167 | 4 | 17–22 | 6 | 22,875 | 1,024 |
| VK Tech | 54 | 304,167 | 5 | 23–28 | 6 | 21,201 | 1,024 |
| VK Tech | 54 | 304,167 | 6 | 29–33 | 5 | 23,253 | 1,024 |
| VK Tech | 54 | 304,167 | 7 | 34 | 1 | 18,617 | 1,024 |
| VK Tech | 54 | 304,167 | 8 | 35 | 1 | 18,781 | 1,024 |
| VK Tech | 54 | 304,167 | 9 | 36 | 1 | 19,033 | 1,024 |
| VK Tech | 54 | 304,167 | 10 | 37–40 | 4 | 23,098 | 1,024 |
| VK Tech | 54 | 304,167 | 11 | 41–46 | 6 | 19,954 | 1,024 |
| VK Tech | 54 | 304,167 | 12 | 47–52 | 6 | 21,589 | 1,024 |
| VK Tech | 54 | 304,167 | 13 | 53–54 | 2 | 15,150 | 1,024 |

## Progress

- [x] Historical structural-core qualification (superseded strategy): no-profiler WorkSpace and AIOS failed `VARIANTS_NOT_DISTINCT`; VK Tech 12-slide passed. These results do not qualify the current prepared-profile lifecycle. Manifests: `.lct/core-no-profiler-workspace-confirmed-20260927/`, `.lct/core-no-profiler-vktech12-20260927/`, `.lct/core-no-profiler-aios-capture-20260927/`.
- [x] Current stop condition: profile-before-Generate AIOS fake failed closed; no VK fake continuation and no live WorkSpace/VK requests. Distinctness gate remains unchanged.

- [x] Historical prior-run note: baseline was `eabaad52496c230992bcde882f41e1d3a4001abe`. This pass started at `94a355240bc2e144b88f5df539e4802a58db7107` with existing worktree changes; preserved them, including untracked `test-content.md`.
- [x] Added canonical runner, versioned bounded-request contract, and tests for fake/external safety and workflow request accounting.
- [x] Updated targeted active docs; corrected model/image configuration claims and request budget.
- [x] Canonical runner performs profile preparation by default before the persisted one-click workflow; profiler calls are measured separately from calls during Generate.
- [x] Earlier regression suite passed 7/7 for the single-request profiler; this historical result is superseded by the batching regression suite below.
- [x] Run the canonical runner on the available real VK Tech template for 12 slides.
- [x] Run the full suite and repository install/typecheck/build/boundary/lint gates; synchronize verified current performance and test counts.
- [x] Re-ran final docs/diff checks and completed the full diff/status review.

## Results

Canonical fake E2E on the local real VK Tech PPTX (source template has 54 slides; requested output has 12) passed in 87.597 s: 4 semantic requests; 36/36 A/B/C variants; deterministic/contextual audits pass; selected/A/B/C PPTX structurally reopen with native text, notes=0 and package errors=0; PDF has 12 pages; HTML has 12 sections and no active markup; source hash unchanged. Artifacts and manifest are under ignored `.lct/product-e2e/20260926203719-fake-1f45fad3/`.

The runner regression file passed 7/7 targeted tests; full repository suite passed 207/207. Frozen install, typecheck, production build, boundary, craft lint and documentation gates passed when run without overlapping build mutation. External dry-run was verified with zero network requests. External models-only preflight used a local test double only and sent no chat completion. These are historical pre-batching results.

No commit/push. Preserve the pre-existing untracked `test-content.md` unchanged. Manual browser/UI review and human Office/PowerPoint open-save/visual check remain outside this pass; real Qwen/VK semantic quality, strict output and latency remain unverified. This paragraph records the earlier state before the bounded P0 task explicitly authorized one live run.

Current bounded-profiler result: the one authorized WorkSpace run sent exactly one semantic inference request. Profiler batch 1/5 (source indexes 1–6) returned HTTP 200 with `maxOutputTokens=1024`, `finish_reason=length`, `promptTokens=null`, `completionTokens=null`, and `runtimeSchemaValidation=not-run`; request latency 38,017 ms and total workflow 41,352 ms. The runner recorded one models preflight, one local daemon health request, zero retries, and zero Worker/Supervisor/generation/audit/export calls. The manifest is `.lct/product-e2e/20260927141926-external-7ba30e40/manifest.json`; context headroom is unknown because prompt-token usage was not returned. Status: `LIVE_MODEL_OUTPUT_BLOCKED`. The conditional VK Tech run was not started. No more live requests are authorized by this pass.
