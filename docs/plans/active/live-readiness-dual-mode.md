# Plan: prepared semantic profile and bounded live qualification

## Current follow-up (2026-09-28)

The user authorized one fresh full live WorkSpace workflow after local P0/P1 gates, using the existing persisted project `e2e-e63dead4205444349c5a7d81` and its READY semantic profile. Do not prepare the template again. Before live inference, finish bounded qualification-only structured-output capture, exact contextual-audit validation diagnostics, and contextual-audit-only recovery; run the affected tests/typecheck/docs/diff gates. If the live contextual audit fails, keep its diagnostic artifact, fix only the proven contract issue, and make at most one audit-only retry. A full rerun is not allowed. On success, freeze sanitized golden fixtures and artifacts under ignored `.lct`, replay downstream processing offline with network disabled, and check the existing successful project in the local UI after refresh without new semantic work. No Pod lifecycle changes, image rebuild, weight download, commit or push.

> **Current scope (2026-09-27): live WorkSpace is BLOCKED.** The first Generate reused an existing READY profile, passed `deck-plan`, `plan-review`, and one `deck-plan-revision`, then failed closed with `VARIANTS_NOT_DISTINCT`; contextual audit/export did not run. After the local deck-level distinctness fix, one POST reused its terminal operation, so retry/idempotency semantics were corrected and tested. One fresh local daemon process then reused project `e2e-e63dead4205444349c5a7d81`: profile and existing 3-slide DeckPlan were READY, and a new workflow operation plus generation ID/idempotency key were persisted. Profiler/planning calls=0; deterministic generation again failed `VARIANTS_NOT_DISTINCT`, before contextual audit/export. No further live calls in this run. No profile preparation, pod/image/model changes, VK Tech live, commit or push. The 18:23 project remains failed without profile cache; the existing 18:44 project retains its READY profile and plan.

## Final live E2E freeze result (2026-09-28; supersedes earlier BLOCKED notes)

- The existing WorkSpace project `e2e-e63dead4205444349c5a7d81` and READY profile were reused; no template preparation occurred during Generate.
- Live calls for the final full workflow: Worker/deck-plan=1, Supervisor/plan-review=1, revision=0, generation inference=0, contextual audit initial=1 (rejected duplicate rule), one bounded audit-only retry=1 (runtime PASS). Earlier preparation of the reused profile used 8 profiler batches. Total across that preparation plus final workflow and audit retry=12 semantic calls; one `/v1/models` preflight GET; no live call during UI acceptance.
- The saved result is 3/3 slides and 9/9 ready A/B/C variants; deterministic audit has 0 errors; contextual audit is READY with 11 findings. A/B/C/selected PPTX reopen in Office Kit; native editable text is present; package validation has 0 errors and no notes. Selected PDF and HTML export validation passed; the source template hash is unchanged.
- Golden bundle: `.lct/golden-live-workspace/workspace-live-2026-09-27T231923-945Z/bundle`. Offline real-fixture replay passed with all three captured request fingerprints exact and external network blocked. UI state was restored after browser refresh, including READY template/profile, task/plan, variants, audit and export links; UI semantic calls=0. The available embedded browser was narrow, so desktop-width visual fit was not assessed.
- Final local verification: full tests 271/271; web and daemon typecheck/build, `docs:check`, boundary check, craft lint, and `git diff --check` passed. The boundary check was rerun after the concurrent builds completed.
- No Pod/image/model changes, additional live inference, VK Tech live, commit or push.

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
- Profile preparation is bounded to 16 batches, at most 4 slides and 24 KiB evidence per batch, plus a 48 KiB conservative full-request byte estimate (system prompt, evidence, generated strict schema, fixed envelope, and output reserve); profiler-only timeout is 180000 ms. Core cap is 4: exactly one each of `deck-plan`, `plan-review`, and `contextual-deck-audit`, plus zero or one `deck-plan-revision`; generation inference is 0. Full preparation+generation cap is 20. Retries are zero. Unexpected operations, a second revision, or profiling after Generate starts are rejected before dispatch.
- WorkSpace, VK Tech and VK Education fake lifecycle passed; AIOS remains a held-out robustness blocker and does not gate this bounded WorkSpace run.
- Targeted runner contract tests, `docs:check`, and `git diff --check` must pass before resuming exactly one WorkSpace Generate on the existing READY project/profile. Do not run preparation again or create a project. VK Tech live is not part of this follow-up.
- [x] After local gates, one bounded Generate reused the existing READY-profile project with an adapter guard forbidding profiler, unknown, and over-budget requests. `deck-plan`, `plan-review`, and one `deck-plan-revision` passed; generation stopped at `VARIANTS_NOT_DISTINCT`. Profiler calls=0; retries=0; no contextual audit or export; stop live qualification.
- [x] Fix terminal-generation idempotency: same key resumes failed state; a different key replaces terminal failed/cancelled/stale state with a fresh pending generation; completed same-input state may be reused; active state conflicts. New persisted workflow operations receive distinct generation keys, while recovery retains the current operation key. Store/service and one-click smoke tests pass.

## Current execution checklist

- [x] Reconnect existing template compile, profiler and cache so normal preparation stores a validated semantic profile; Generate uses read-only cache lookup.
- [x] Add UI readiness/polling and failure state so Generate is unavailable until persisted semantic profile is ready.
- [x] Measure deterministic fake response JSON sizes for WorkSpace, VK Tech and Education; select output cap up to 4,096 tokens and preserve batch bounds.
- [x] WorkSpace fake: 29 source slides / 6 profiler batches under the historical 5-slide limit; preparation READY; Generate profiler calls 0; Worker 1, planning Supervisor 1, contextual audit 1; 3/3 slides, A/B/C 9/9, audits, PPTX/PDF/HTML, source unchanged.
- [x] Exact AIOS preparation: 16 source slides / 4 batches; profile READY; Generate failed at `VARIANTS_NOT_DISTINCT` after Worker + planning Supervisor. No contextual audit/export. Manifest: `.lct/prepared-profile-fake-aios-20260927/manifest.json`.
- [x] VK Tech 12-slide and VK Education 3-slide profile-before-Generate fake E2E — PASS in the follow-up lifecycle run; see ignored qualification manifests.
- [x] Full repository gates passed on the prior code baseline; after the budget correction, `docs:check`, `git diff --check` and targeted contract/runner tests passed. Current profiler changes rerun the targeted profiler/adapter/runner tests and docs/diff gates.
- [x] Recalculate the real WorkSpace 29-slide profile batch plan under 4-slide/24-KiB/48-KiB request-estimate/16-batch limits; all 29 source indexes are covered exactly once and in order in 8 batches.
- [x] Make the profiler schema batch-aware: exact TemplateIR hash, expected slide branch, role-specific per-slide ID enums, bounded arrays; keep runtime validation fail-closed and report only safe invariant codes.
- [x] Add runtime diagnostic/token logging for each semantic batch without storing content; targeted profiler/adapter tests 36/36 and runner contract tests 2/2 passed; daemon typecheck, `docs:check`, and `git diff --check` passed.
- [x] Recompute WorkSpace with the generated schema: 8 batches cover slides 1–29 exactly once; max evidence 15,767 bytes, max schema 14,612 bytes, max estimated full request 47,237 bytes (<48 KiB). The previous oversized slides 9–12 batch now splits into slides 9–11 and 12–15.
- [x] Run one fresh WorkSpace profile preparation with concurrency 2 after the schema fix. Batch 1/8 failed runtime validation as `DUPLICATE_ELEMENT_ROLE`; batch 2/8 was cancelled; no retries. Profile was not persisted READY; Generate and all core calls = 0. Historical attempt only; superseded by the role-prompt follow-up below.
- [x] Add the role-exclusivity hard rule to the versioned profiler prompt; verify prompt-content changes produce a new profile cache fingerprint.
- [x] Run one fresh WorkSpace preparation after the prompt fix. Models-only preflight passed. Batch 2/8 returned `SERVICE_UNAVAILABLE` after 10366 ms with no HTTP status; concurrent batch 1 was cancelled. Two profiler requests total, retries=0; profile not READY; Generate/core calls=0. Stop at first failure.
- [x] Run one new sequential WorkSpace preparation with profiler concurrency 1. Models-only preflight passed; batches 1–2/8 passed runtime validation; batch 3/8 failed HTTP 400, `PROVIDER_ERROR`, parameter `input_tokens`, latency 588 ms, finish reason/usage unavailable because request was rejected before inference. Retries=0; profile not READY; Generate/core calls=0. Stop at first failure.

## Fake serialized response sizing (current profile contract)

Sizing was measured with the deterministic local fake, not an inference call. Serialized fake completion maxima: WorkSpace 4,519 bytes (29 source slides / 6 historical batches), VK Tech 5,739 bytes (54 / 14), Education 3,829 bytes (55 / 11). Historical batches stayed within 5 slides and 24 KiB evidence; fake responses ended with `finish_reason=stop`. The current profiler config changes the maximum batch to 4 slides and request timeout to 180000 ms; output remains capped at 4,096 tokens with a bounded estimate (minimum 2,048, up to 1,024 tokens/source slide), no automatic retries. Fake sizing does not prove live Qwen will fit or meet latency.

## Current WorkSpace plan (deterministic, before live inference)

The organizer WorkSpace PPTX has 29 slides and 68,280 bytes of full compact evidence. The current planner creates 8 batches under the 48 KiB full-request estimate; all evidence is within 24 KiB, each batch has at most 4 slides, and source indexes 1–29 are covered exactly once. Batch 3—the previous provider rejection—now contains slides 9–11; slide 12 moves to the next batch.

| Batch | Source slide indexes | Slides | Evidence bytes | Schema bytes | Estimated request bytes | maxOutputTokens |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 1–4 | 4 | 7,896 | 11,219 | 40,066 | 4,096 |
| 2 | 5–8 | 4 | 9,735 | 13,286 | 43,972 | 4,096 |
| 3 | 9–11 | 3 | 15,767 | 14,612 | 47,234 | 3,072 |
| 4 | 12–15 | 4 | 11,195 | 13,485 | 45,631 | 4,096 |
| 5 | 16–19 | 4 | 6,119 | 10,283 | 37,353 | 4,096 |
| 6 | 20–23 | 4 | 6,780 | 9,854 | 37,585 | 4,096 |
| 7 | 24–27 | 4 | 10,158 | 12,664 | 43,773 | 4,096 |
| 8 | 28–29 | 2 | 1,617 | 3,838 | 18,214 | 2,048 |

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

Latest adaptive-request-budget run: after targeted profiler/adapter/qualification-runner tests, daemon typecheck, docs check and diff check passed, one models-only preflight passed (`/v1/models`: one GET, zero chat completions). The deterministic 29-slide WorkSpace plan had 8 batches; the prior 4-slide batch 9–12 split into 9–11 and 12–15, with max estimated request 47,234 bytes under 48 KiB. Sequential run used concurrency 1, profiler timeout 180000 ms, `thinking=false`, strict schema, retries 0. Batch 1/8, slides 1–4: HTTP 200, stop, 71,050 ms, 4,799/2,005 tokens, runtime PASS, estimate 40,066 bytes. Batch 2/8, slides 5–8: HTTP 200, stop, 77,240 ms, 5,645/2,183 tokens, runtime PASS, estimate 43,972 bytes. Batch 3/8, slides 9–11: HTTP 200, stop, 107,702 ms, 9,611/2,967 tokens, runtime PASS, estimate 47,234 bytes. Batch 4/8, slides 12–15: HTTP 200, stop, 80,321 ms, 6,698/2,220 tokens, runtime FAIL `DUPLICATE_ELEMENT_ROLE`, estimate 45,631 bytes. The first runtime failure stopped qualification: no retries, batches 5–8, or Generate/core calls followed. Profile cache is not READY. Manifest `.lct/product-e2e/20260927182307-external-b16a7020/manifest.json` was finalized before batch 4 telemetry arrived; it records that request as running and the outer preparation as `PRODUCT_E2E_FAILED`, while the adapter subsequently logged the batch's actual HTTP/runtime result above. No further live requests were sent.

## Deterministic duplicate-role normalization and latest WorkSpace run

The narrowly-scoped normalizer runs only when the batch validator diagnoses `DUPLICATE_ELEMENT_ROLE`. It removes cross-role repeats by precedence `title > body > visual > preserved > replaceable`, then invokes the existing validator. Same-role duplicates, unknown IDs, foreign-slide IDs and invalid replaceable IDs remain failures. Safe profiler telemetry adds only `roleConflictResolved` and a count.

Targeted gates passed before live use: profiler 21/21, adapter 17/17, daemon typecheck, `docs:check` and `git diff --check`.

One sequential WorkSpace preparation reused the existing 4-slide/24-KiB/48-KiB limits, 180,000 ms profiler timeout, concurrency 1, `thinking=false`, strict JSON Schema and retries 0. Every batch returned HTTP 200, `finish_reason=stop` and runtime validation PASS:

| Batch | Source slides | Latency | Prompt/completion tokens | Resolved role conflict | Estimated request bytes |
|---|---:|---:|---:|---:|---:|
| 1/8 | 1–4 | 71,112 ms | 4,799 / 2,005 | no / 0 | 40,066 |
| 2/8 | 5–8 | 78,341 ms | 5,645 / 2,183 | no / 0 | 43,972 |
| 3/8 | 9–11 | 105,369 ms | 9,611 / 2,967 | no / 0 | 47,234 |
| 4/8 | 12–15 | 78,893 ms | 6,698 / 2,220 | yes / 1 | 45,631 |
| 5/8 | 16–19 | 62,248 ms | 3,662 / 1,737 | no / 0 | 37,353 |
| 6/8 | 20–23 | 71,686 ms | 4,203 / 2,008 | no / 0 | 37,585 |
| 7/8 | 24–27 | 82,720 ms | 6,175 / 2,294 | no / 0 | 43,773 |
| 8/8 | 28–29 | 21,495 ms | 1,330 / 594 | no / 0 | 18,214 |

The persisted profile is `READY`; preparation duration recorded in its status file is 571,927 ms. The first one-click runner manifest had already recorded `PRODUCT_E2E_FAILED` with batch 4 still `running`; the same in-flight server preparation continued after that manifest write and eventually validated batches 4–8 and persisted the complete profile. No second preparation was started.

One earlier Generate passed `deck-plan` and `plan-review` but hit the former request cap before `deck-plan-revision`; that result is superseded by the corrected-contract run below.

## Latest bounded WorkSpace Generate (corrected contract)

Local gates passed first: targeted runner tests 14/14, `docs:check`, and `git diff --check`. Daemon preflight on the already-existing project `e2e-e63dead4205444349c5a7d81` confirmed profile `READY`, cached=true, with the same WorkSpace template/profile fingerprint. No project or profile preparation was created. A single guarded Generate used the saved inputs: `deck-plan` passed HTTP 200 (`finish_reason=stop`, 19,943 ms, 2,946/543 tokens); `plan-review` passed HTTP 200 (`stop`, 13,324 ms, 3,412/351 tokens); one `deck-plan-revision` passed HTTP 200 (`stop`, 20,280 ms, 3,974/536 tokens). All three passed runtime validation. Profiler calls=0; automatic retries=0; core semantic calls=3 of 4 permitted. Deterministic A/B/C generation then failed `VARIANTS_NOT_DISTINCT`; workflow persisted `failed` at `generating`. Contextual audit was not dispatched, no ready A/B/C packs were produced, and PPTX/PDF/HTML exports did not run. Stop live qualification; do not retry. No pod/image/model changes, VK Tech live, commit or push.

After the first deck-level retry returned the old terminal operation, generation-store/service and workflow-key semantics were fixed. Targeted checks passed: store retry cases 6/6; generation same-key retry/new-key retry and one-click fake workflow 2/2; daemon typecheck, `docs:check`, and `git diff --check` passed. One fresh local daemon process (PID 15672) confirmed the existing project profile `READY`/cached and planning `READY` with the saved matching 3-slide DeckPlan. Exactly one new workflow POST created a different operation ID, generation ID, and idempotency key; the row began with 0/3 ready slides. Profiler calls=0, planning calls=0, semantic operations=0, automatic retries=0. Deterministic A/B/C generation failed again with `VARIANTS_NOT_DISTINCT` and 0/3 ready slides. No contextual audit, preview or export was reached. Qualification artifact: `.lct/product-e2e/20260927184405-external-eee27e71/resumed-generate-idempotency-fix/qualification.json`. Stop live work here; review the unchanged distinctness failure before another live attempt.

## Autonomous offline recovery pass — 2026-09-27

The existing WorkSpace project was rechecked from an isolated copy of its persisted data; the original project, READY profile, READY plan, and source template were not modified. No profiler, planning, or other external inference was called.

Root cause and fixes:

- `ContentIR` for the saved project contains only one 405-byte `brief-task` source. The saved plan references those instruction units, not uploaded or independently sourced content. Treating the task as slide copy had leaked prompt wording into body/process regions and could make task-only numbers look like factual provenance. Projection and deterministic fact audit now exclude `brief-task`; supplied context and ordinary content remain eligible.
- Trusted semantic profiles can map more body regions than the projector fills. The prior precheck rejected a profile with more than four mappings before the existing bounded selector could choose up to four and clear the remaining mapped sample text. That arbitrary precheck is removed; projection remains capped at four and unselected mapped copy must still be explicitly cleared.
- A local one-slide preview of the prior selector output showed the inherited-size title overflowing its box by 36.8 px while the estimate was 0.798. For titles without a direct size, fit is now estimated relative to mapped body typography and the minimum is 0.9; direct-sized titles retain 0.72. Native placeholder fallback uses the same rule. No font-size or source-safety gate was weakened.

Verification:

- Fresh isolated API generation used the persisted READY profile and matching READY 3-slide DeckPlan, a new idempotency key, and an inference adapter that throws on any semantic request. Result: `VARIANTS_NOT_DISTINCT`, semantic calls 0, ready slides 0. The current diagnostic matrix is `.lct/product-e2e/20260927184405-external-eee27e71/offline-titlefit-diagnostic-matrix.json`: all A/B/C assignments have zero safe exemplar and zero safe native-layout options. Slides 2 and 3 fail projected title fit; slide 1 also has candidates rejected for unknown-font fit and source-specific visuals. Deck signatures are therefore unavailable; this is not an optimizer/signature collision.
- `apps/daemon/test/slide-compilation.test.mjs`: 58/58; full suite: 263/263; daemon typecheck, web+daemon production build, `docs:check`, boundary, craft lint, and `git diff --check`: PASS.
- The earlier generated PPTX/preview is diagnostic evidence only, not a qualified output; the preview warning was addressed by the stricter inherited-title fit gate. No A/B/C packs, contextual audit, or exports passed in this pass.
- HEAD and `origin/main` remain `9bac6063421825af6f5b142d84e2aaa40a4c096f`. No commit or push.

Next step: add source-backed content to this same WorkSpace project (or provide appropriate source material for upload). Then rerun a fresh offline deterministic generation against the unchanged READY profile/DeckPlan inputs first. Do not request contextual audit until all 3×A/B/C packs pass. The present brief-only state cannot support a truthful content deck or qualify generation, audit, and exports.
