# Plan: prepared semantic profile and bounded live qualification

> **Current scope (2026-09-27):** prepare and persist a complete `TemplateSemanticProfile` before Generate, then use cache-only reads during generation. Fake lifecycle passed for WorkSpace, VK Tech (12 slides), and VK Education; AIOS remains a separate held-out `VARIANTS_NOT_DISTINCT` blocker, not an absolute stop for WorkSpace live qualification. The profiler uses 4-slide batches, a 180 s timeout, concurrency 1 for the latest sequential qualification, and retries 0. The batch-aware JSON Schema binds the exact TemplateIR hash and per-slide element IDs; runtime validation remains fail-closed. A hard prompt rule now makes the five semantic roles mutually exclusive; prompt-content SHA-256 is part of the cache fingerprint, and the targeted test verified that changing the prompt changes the key. The latest WorkSpace attempt passed batches 1–2/8 and stopped on batch 3/8 with HTTP 400 / `PROVIDER_ERROR`, provider parameter `input_tokens`, latency 588 ms, because prompt plus requested output exceeded the provider context limit. Profile was not READY, so Generate did not run. No further live calls are authorized by this attempt; do not run VK Tech live or commit/push.

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
- Profile preparation is bounded to 14 batches, at most 4 slides and 24 KiB evidence per batch, with profiler-only timeout 180000 ms; core cap is 3 and full preparation+generation cap is 17. Retries are zero.
- WorkSpace, VK Tech and VK Education fake lifecycle passed; AIOS remains a held-out robustness blocker and does not gate this bounded WorkSpace run.
- Targeted profiler/adapter/contract tests, `docs:check`, and `git diff --check` must pass before one WorkSpace live run. VK Tech live is not part of this follow-up.

## Current execution checklist

- [x] Reconnect existing template compile, profiler and cache so normal preparation stores a validated semantic profile; Generate uses read-only cache lookup.
- [x] Add UI readiness/polling and failure state so Generate is unavailable until persisted semantic profile is ready.
- [x] Measure deterministic fake response JSON sizes for WorkSpace, VK Tech and Education; select output cap up to 4,096 tokens and preserve batch bounds.
- [x] WorkSpace fake: 29 source slides / 6 profiler batches under the historical 5-slide limit; preparation READY; Generate profiler calls 0; Worker 1, planning Supervisor 1, contextual audit 1; 3/3 slides, A/B/C 9/9, audits, PPTX/PDF/HTML, source unchanged.
- [x] Exact AIOS preparation: 16 source slides / 4 batches; profile READY; Generate failed at `VARIANTS_NOT_DISTINCT` after Worker + planning Supervisor. No contextual audit/export. Manifest: `.lct/prepared-profile-fake-aios-20260927/manifest.json`.
- [x] VK Tech 12-slide and VK Education 3-slide profile-before-Generate fake E2E — PASS in the follow-up lifecycle run; see ignored qualification manifests.
- [x] Full repository gates passed on the prior code baseline; after the budget correction, `docs:check`, `git diff --check` and targeted contract/runner tests passed. Current profiler changes rerun the targeted profiler/adapter/runner tests and docs/diff gates.
- [x] Recalculate the real WorkSpace 29-slide profile batch plan under 4-slide/24-KiB/14-batch limits; all 29 source indexes are covered exactly once in 8 batches.
- [x] Make the profiler schema batch-aware: exact TemplateIR hash, expected slide branch, role-specific per-slide ID enums, bounded arrays; keep runtime validation fail-closed and report only safe invariant codes.
- [x] Add runtime diagnostic/token logging for each semantic batch without storing content; targeted profiler/adapter tests 36/36 and runner contract tests 2/2 passed; daemon typecheck, `docs:check`, and `git diff --check` passed.
- [x] Recompute WorkSpace with the generated schema: 8 batches cover slides 1–29 exactly once; max evidence 21,058 bytes, max schema 19,845 bytes (<64 KiB).
- [x] Run one fresh WorkSpace profile preparation with concurrency 2 after the schema fix. Batch 1/8 failed runtime validation as `DUPLICATE_ELEMENT_ROLE`; batch 2/8 was cancelled; no retries. Profile was not persisted READY; Generate and all core calls = 0. Historical attempt only; superseded by the role-prompt follow-up below.
- [x] Add the role-exclusivity hard rule to the versioned profiler prompt; verify prompt-content changes produce a new profile cache fingerprint.
- [x] Run one fresh WorkSpace preparation after the prompt fix. Models-only preflight passed. Batch 2/8 returned `SERVICE_UNAVAILABLE` after 10366 ms with no HTTP status; concurrent batch 1 was cancelled. Two profiler requests total, retries=0; profile not READY; Generate/core calls=0. Stop at first failure.
- [x] Run one new sequential WorkSpace preparation with profiler concurrency 1. Models-only preflight passed; batches 1–2/8 passed runtime validation; batch 3/8 failed HTTP 400, `PROVIDER_ERROR`, parameter `input_tokens`, latency 588 ms, finish reason/usage unavailable because request was rejected before inference. Retries=0; profile not READY; Generate/core calls=0. Stop at first failure.

## Fake serialized response sizing (current profile contract)

Sizing was measured with the deterministic local fake, not an inference call. Serialized fake completion maxima: WorkSpace 4,519 bytes (29 source slides / 6 historical batches), VK Tech 5,739 bytes (54 / 14), Education 3,829 bytes (55 / 11). Historical batches stayed within 5 slides and 24 KiB evidence; fake responses ended with `finish_reason=stop`. The current profiler config changes the maximum batch to 4 slides and request timeout to 180000 ms; output remains capped at 4,096 tokens with a bounded estimate (minimum 2,048, up to 1,024 tokens/source slide), no automatic retries. Fake sizing does not prove live Qwen will fit or meet latency.

## Current WorkSpace plan (deterministic, before live inference)

The organizer WorkSpace PPTX has 29 slides and 68,280 bytes of full compact evidence. The current planner creates 8 batches; all evidence is within 24 KiB, each batch has at most 4 slides, and source indexes 1–29 are covered exactly once.

| Batch | Source slide indexes | Slides | Evidence bytes | maxOutputTokens |
| ---: | --- | ---: | ---: | ---: |
| 1 | 1–4 | 4 | 7,896 | 4,096 |
| 2 | 5–8 | 4 | 9,735 | 4,096 |
| 3 | 9–12 | 4 | 21,058 | 4,096 |
| 4 | 13–16 | 4 | 8,304 | 4,096 |
| 5 | 17–20 | 4 | 4,245 | 4,096 |
| 6 | 21–24 | 4 | 7,632 | 4,096 |
| 7 | 25–28 | 4 | 9,065 | 4,096 |
| 8 | 29 | 1 | 1,332 | 2,048 |

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
- [x] Prior AIOS held-out failure remained `VARIANTS_NOT_DISTINCT`; the distinctness gate is unchanged. WorkSpace/VK Tech/Education fake lifecycle now passes; AIOS is tracked separately and does not block WorkSpace live qualification.

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

Historical bounded-profiler results (superseded protocol): an earlier WorkSpace request returned HTTP 200 with `maxOutputTokens=1024`, `finish_reason=length`, and 38,017 ms latency. The later five-slide/4,096-token request timed out at the client after 90,013 ms while RunPod logs showed it still Running, with no provider 5xx; no Worker/Supervisor/generation/audit/export calls occurred. Its manifest is `.lct/product-e2e/20260927171040-external-7879cc28/manifest.json`. This follow-up replaces the 5-slide/90-second settings; record its one-run outcome below.

## Current live WorkSpace result

The first attempt before batch-aware schema used the same 4-slide/24-KiB/14-batch plan, strict JSON Schema, `maxOutputTokens=4096` for the first seven batches, `thinking=false`, concurrency 2, timeout 180000 ms, and retries 0. Batch 1/8 (slides 1–4, evidence 7,896 bytes) returned HTTP 200, `finish_reason=stop`, 109,340 ms, but failed runtime validation; usage was not captured by the then-current adapter. Batch 2 was cancelled. Manifest: `.lct/product-e2e/20260927172348-external-b264ff89/manifest.json`.

After the local schema/diagnostic fix and green targeted gates, one fresh attempt used the same settings. Batch 1/8 returned HTTP 200, `finish_reason=stop`, latency 106,640 ms, prompt tokens 4,661, completion tokens 3,014, `runtimeSchemaValidation=failed`, `validationFailureCode=DUPLICATE_ELEMENT_ROLE`. The generated schema narrows IDs by slide and role, but it cannot express non-overlap between different role arrays with the endpoint-compatible primitives; the independent runtime validator correctly rejected the response. Batch 2/8 was concurrently dispatched and cancelled; status and schema validation were not run. Batches 3–8 were not dispatched. Profile cache READY=false; Generate profiler/core calls=0. Manifest: `.lct/product-e2e/20260927174048-external-7db02d89/manifest.json`.

After changing only the prompt guidance for mutually exclusive roles, targeted local gates passed and the prompt fingerprint was verified to change. Models-only preflight passed. The fresh WorkSpace preparation used 4 slides/batch, maxOutputTokens=4096, timeout=180000 ms, concurrency=2, thinking=false, retries=0. Batch 2/8 (slides 5–8, 9,735 evidence bytes) failed with `SERVICE_UNAVAILABLE` after 10,366 ms; no HTTP status, finish reason, token usage, or runtime validation result was received. Concurrent batch 1/8 (slides 1–4, 7,896 evidence bytes) was cancelled after 10,369 ms. Two profiler requests were dispatched, no automatic retries occurred, and batches 3–8 were not sent. Profile cache READY=false; Generate profiler/core calls=0. Manifest: `.lct/product-e2e/20260927174938-external-5ca326f5/manifest.json`. The exact cause is unknown because the provider response/status was unavailable; stop at this first failure and do not retry.

A later one-off attempt used the same prompt and fixed profiler settings, with only the explicitly requested concurrency change to 1. Models-only preflight passed. Batch 1/8 (slides 1–4, 7,896 evidence bytes) passed: HTTP 200, `finish_reason=stop`, 70,743 ms, 4,799 prompt / 2,005 completion tokens, runtime validation passed. Batch 2/8 (slides 5–8, 9,735 bytes) passed: HTTP 200, `finish_reason=stop`, 78,579 ms, 5,645 prompt / 2,183 completion tokens, runtime validation passed. Batch 3/8 (slides 9–12, 21,058 bytes) was rejected with HTTP 400 after 588 ms; provider diagnostic: `BadRequestError`, parameter `input_tokens`, “The prompt and requested output exceed the provider context limit.” `finish_reason` and token usage were unavailable; runtime validation was not run. Retries=0; batches 4–8 were not sent; profile cache READY=false; Generate/core calls=0. Manifest: `.lct/product-e2e/20260927180249-external-cc346d39/manifest.json`. Stop at this first failure; no RunPod or model configuration was changed.
