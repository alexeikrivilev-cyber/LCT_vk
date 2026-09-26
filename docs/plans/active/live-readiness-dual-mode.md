# Live readiness and dual-mode E2E pass

## Goal

Provide one reproducible qualification runner for the existing one-click product workflow in local fake and external OpenAI-compatible modes. Correct only evidenced documentation/configuration gaps and preserve the existing product workflow architecture.

## Constraints

- Local fake endpoint only. No RunPod, GPU, Qwen, VK inference, or other external inference request.
- Do not commit or push.
- Preserve the pre-existing untracked `test-content.md` without reading, editing, staging, or deleting it.
- Keep provider-specific deployment details out of application logic; provider label is report metadata only.
- Runner enters through the public one-click workflow API and does not call planning or generation services directly.

## Acceptance

- Current docs distinguish verified fake/local evidence from live model quality and latency.
- One runner supports fake/external modes, dry-run and models-only preflight without logging secrets.
- External request cap is four; request five is rejected before delegating; errors stop without retries.
- The same one-click API uses exactly four semantic calls for 3-slide and 12-slide cases; generation adds zero semantic calls.
- A local 12-slide run on the available VK Tech template validates A/B/C, audits, selected and variant PPTX, PDF, HTML, reopen, and source immutability.
- Repository install/test/typecheck/build/boundary/lint/docs/diff gates pass.

## Progress

- [x] Confirmed baseline `eabaad52496c230992bcde882f41e1d3a4001abe`, clean tracked diff; preserved pre-existing `test-content.md`.
- [x] Added canonical runner, four-call versioned contract, and tests for fake/external safety and workflow request accounting.
- [x] Updated targeted active docs; corrected model/image configuration claims and request budget.
- [x] Added explicit `enableSemanticProfiling` opt-in for the canonical runner because an injected adapter otherwise leaves template profiling off; the default behavior for existing injected-adapter callers remains unchanged.
- [x] Regression suite now passes: 7/7, including exactly four requests at 3 and 12 slides.
- [x] Run the canonical runner on the available real VK Tech template for 12 slides.
- [x] Run the full suite and repository install/typecheck/build/boundary/lint gates; synchronize verified current performance and test counts.
- [x] Re-ran final docs/diff checks and completed the full diff/status review.

## Results

Canonical fake E2E on the local real VK Tech PPTX (source template has 54 slides; requested output has 12) passed in 87.597 s: 4 semantic requests; 36/36 A/B/C variants; deterministic/contextual audits pass; selected/A/B/C PPTX structurally reopen with native text, notes=0 and package errors=0; PDF has 12 pages; HTML has 12 sections and no active markup; source hash unchanged. Artifacts and manifest are under ignored `.lct/product-e2e/20260926203719-fake-1f45fad3/`.

The runner regression file passed 7/7 targeted tests; full repository suite passed 207/207. Frozen install, typecheck, production build, boundary, craft lint and documentation gates passed when run without overlapping build mutation. External dry-run was verified with zero network requests. External models-only preflight used a local test double only and sent no chat completion. No real external inference, RunPod or GPU was used.

No commit/push. Preserve the pre-existing untracked `test-content.md` unchanged. Remaining acceptance before live qualification: manual browser/UI review and human Office/PowerPoint open-save/visual check; real Qwen/VK semantic quality, strict output and latency remain unverified. Next step requires a separate explicit live-inference authorization.
