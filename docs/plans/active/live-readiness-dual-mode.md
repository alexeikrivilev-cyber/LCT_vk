# Live readiness and bounded-profiler qualification

> **Current scope (2026-09-27):** this plan supersedes the earlier four-call
> qualification limit. A logical Template Profiler stage may now issue up to
> 13 sequential, strictly validated batches (at most 6 slides and 24 KiB of
> serialized evidence each). The runner hard cap is 16 calls: profiler batches
> plus one deck plan, one plan review, and one contextual audit; generation
> inference and automatic retries remain disabled. The four-call results below
> are historical evidence for the earlier single-request profiler, not the
> current qualification contract.

## Goal

Provide one reproducible qualification runner for the existing one-click product workflow in local fake and external OpenAI-compatible modes. Correct only evidenced documentation/configuration gaps and preserve the existing product workflow architecture.

## Constraints

- Preserve the running Pod: no stop, restart, recreation, Docker rebuild, model download, serving-context change, commit, or push. The attached P0 task authorizes only one canonical WorkSpace E2E after every offline gate passes, followed by one VK Tech E2E only if WorkSpace fully passes.
- Do not commit or push.
- Preserve the pre-existing untracked `test-content.md` without reading, editing, staging, or deleting it.
- Keep provider-specific deployment details out of application logic; provider label is report metadata only.
- Runner enters through the public one-click workflow API and does not call planning or generation services directly.

## Acceptance

- Current docs distinguish verified fake/local evidence from live model quality and latency.
- One runner supports fake/external modes, dry-run and models-only preflight without logging secrets.
- External request cap is 16; request 17 is rejected before delegating; errors stop without retries.
- The one-click API uses 1–13 profiler batches plus exactly one deck plan, one plan review, and one contextual audit; generation adds zero semantic calls.
- A local 12-slide run on the available VK Tech template validates A/B/C, audits, selected and variant PPTX, PDF, HTML, reopen, and source immutability.
- Repository install/test/typecheck/build/boundary/lint/docs/diff gates pass.

## Current bounded P0 qualification

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

- [x] Confirmed baseline `eabaad52496c230992bcde882f41e1d3a4001abe`, clean tracked diff; preserved pre-existing `test-content.md`.
- [x] Added canonical runner, versioned bounded-request contract, and tests for fake/external safety and workflow request accounting.
- [x] Updated targeted active docs; corrected model/image configuration claims and request budget.
- [x] Added explicit `enableSemanticProfiling` opt-in for the canonical runner because an injected adapter otherwise leaves template profiling off; the default behavior for existing injected-adapter callers remains unchanged.
- [x] Earlier regression suite passed 7/7 for the single-request profiler; this historical result is superseded by the batching regression suite below.
- [x] Run the canonical runner on the available real VK Tech template for 12 slides.
- [x] Run the full suite and repository install/typecheck/build/boundary/lint gates; synchronize verified current performance and test counts.
- [x] Re-ran final docs/diff checks and completed the full diff/status review.

## Results

Canonical fake E2E on the local real VK Tech PPTX (source template has 54 slides; requested output has 12) passed in 87.597 s: 4 semantic requests; 36/36 A/B/C variants; deterministic/contextual audits pass; selected/A/B/C PPTX structurally reopen with native text, notes=0 and package errors=0; PDF has 12 pages; HTML has 12 sections and no active markup; source hash unchanged. Artifacts and manifest are under ignored `.lct/product-e2e/20260926203719-fake-1f45fad3/`.

The runner regression file passed 7/7 targeted tests; full repository suite passed 207/207. Frozen install, typecheck, production build, boundary, craft lint and documentation gates passed when run without overlapping build mutation. External dry-run was verified with zero network requests. External models-only preflight used a local test double only and sent no chat completion. These are historical pre-batching results.

No commit/push. Preserve the pre-existing untracked `test-content.md` unchanged. Manual browser/UI review and human Office/PowerPoint open-save/visual check remain outside this pass; real Qwen/VK semantic quality, strict output and latency remain unverified. This paragraph records the earlier state before the bounded P0 task explicitly authorized one live run.

Current bounded-profiler result: the one authorized WorkSpace run sent exactly one semantic inference request. Profiler batch 1/5 (source indexes 1–6) returned HTTP 200 with `maxOutputTokens=1024`, `finish_reason=length`, `promptTokens=null`, `completionTokens=null`, and `runtimeSchemaValidation=not-run`; request latency 38,017 ms and total workflow 41,352 ms. The runner recorded one models preflight, one local daemon health request, zero retries, and zero Worker/Supervisor/generation/audit/export calls. The manifest is `.lct/product-e2e/20260927141926-external-7ba30e40/manifest.json`; context headroom is unknown because prompt-token usage was not returned. Status: `LIVE_MODEL_OUTPUT_BLOCKED`. The conditional VK Tech run was not started. No more live requests are authorized by this pass.
