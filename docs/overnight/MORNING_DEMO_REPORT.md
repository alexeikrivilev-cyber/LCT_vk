# Morning submission freeze report

**STATUS: BLOCKED — do not label this checkout submission-ready.**

Run date: 2026-09-28. Branch: `overnight-wow-2026-09-28`. HEAD: `6b80964fa701d59d5ef6f95f195e480d89c706be`. Existing worktree changes were preserved; no commit or push was made. RunPod was off. Live inference, external provider calls, image generation, pod changes, and Docker rebuilds: **0**.

## Offline matrix

Run: `.lct/overnight/overnight-wow-2026-09-28/morning-freeze-matrix-v1/qualification.json`.
Mode: local fake OpenAI-compatible endpoint; 65 semantic requests; `noExternalCalls=true`; image network requests 0.

| Template | Requested | Variants | Audit / export | Result |
|---|---:|---:|---|---|
| VK Tech | 12 slides | 36/36 | Deterministic audit passed; selected/A/B/C PPTX structurally reopened; PDF reopened with 12 pages; HTML has 12 slide sections. | Pipeline PASS; visual quality BLOCKED |
| WorkSpace | 3 slides | 9/9 | Deterministic audit passed; selected/A/B/C PPTX structurally reopened. | Pipeline PASS; visual quality BLOCKED |
| Education | 3 slides | 9/9 | Deterministic audit passed; selected/A/B/C PPTX structurally reopened. | Pipeline PASS; visual quality BLOCKED |
| AIOS held-out | 3 slides | withheld | Generation failed closed with `VARIANTS_NOT_DISTINCT`; no audit or export. | BLOCKED |

All four supplied template files remained unchanged: their SHA-256 values matched the captured inputs (VK Tech `cbbe3aa6a21d23cebc4d1383b93dd07a9cea460d683de1903567b616c839485d`; WorkSpace `1b8883114486c69dff706e9c4fd9382727c4506c2cfa3ec34f86987f1e852f2f`; Education `9ef2323ed5f49f464aee5ae7065f1f57bb92c8be3a635be507d59819e285cfe0`; AIOS `c84943644b71a22ee9e155b16f061d75f643c5244744b50f8a176b9b99d117a1`). The qualification was task-only: no uploaded content files; VK Tech used a synthetic context. It does not qualify semantic truth or Qwen quality.

## Visual review and artifacts

Contact sheets were generated from local Office Kit previews and visually inspected:

- VK Tech: `.lct/overnight/overnight-wow-2026-09-28/morning-freeze-matrix-v1/contact-sheets/00-vk-tech/contact-sheet.png`
- WorkSpace: `.lct/overnight/overnight-wow-2026-09-28/morning-freeze-matrix-v1/contact-sheets/01-workspace/contact-sheet.png`
- Education: `.lct/overnight/overnight-wow-2026-09-28/morning-freeze-matrix-v1/contact-sheets/02-education/contact-sheet.png`
- AIOS withheld grid: `.lct/overnight/overnight-wow-2026-09-28/morning-freeze-matrix-v1/contact-sheets/03-aios/contact-sheet.png`

Visible defects: VK Tech repeats the same hero art across many slides, sometimes with very sparse text; WorkSpace reuses near-identical layouts across tracks and leaves large regions unused; Education contains substantial whitespace and low track differentiation; AIOS has no generated variants. The sheets and per-sheet JSON are visual evidence only; they do not establish a quality PASS.

The VK Tech 12-slide stress run yielded 36 variants. Time through contextual audit was 62.556 s; post-audit exports took 1,328.353 s; full measured flow was 1,390.909 s. These are local fake measurements and show the full export flow is not demo-ready within seven minutes. PDF is an approximate preview export; HTML is a separate viewing format.

PPTX, PDF, and HTML artifacts are in the same ignored `.lct/.../morning-freeze-matrix-v1/` directory. `README.txt` lists the files. No binary deliverables were added to Git.

## UI and refresh check

The initial project screen was observed, then an existing ready WorkSpace project was opened in a fresh browser tab. The refreshed state restored the template, plan, ready A/B/C variants, audit and export links; visible UI copy was Russian. The embedded browser viewport was approximately 1265×720, not the requested 1440×900. The screenshots were reviewed through computer use but not saved as filesystem artifacts; therefore the screenshot-path/target-resolution acceptance item remains **BLOCKED**. The UI exercise did not replay every click from project creation through export.

## Golden replay

The disposable replay failed before generation because the captured deck-plan system prompt no longer matches current code: expected 3305 bytes (SHA-256 prefix `46251f…69b0`), actual 3398 bytes (prefix `9f1b8e…0112`). External attempts were denied (0). The original golden bundle was not altered. This is a compatibility blocker, not evidence of model/provider failure.

## Repository gates

- `pnpm dlx pnpm@10.33.2 install --frozen-lockfile` — PASS (existing checkout; not a fresh clone).
- `pnpm dlx pnpm@10.33.2 test` — **FAIL: 282/288**. Five fake endpoint tests expect obsolete English slide titles; one one-click workflow fails `VARIANTS_NOT_DISTINCT` on slide 2.
- `pnpm dlx pnpm@10.33.2 typecheck` — PASS for web and daemon.
- `pnpm dlx pnpm@10.33.2 build` — PASS for web and daemon. Next.js rewrote `apps/web/next-env.d.ts`; it was restored to the exact pre-build bytes. Existing `apps/web/tsconfig.json` remained unchanged.
- `pnpm dlx pnpm@10.33.2 docs:check` — PASS (62 required files and local Markdown links).
- `pnpm dlx pnpm@10.33.2 check:boundary` — PASS.
- `pnpm dlx pnpm@10.33.2 lint:craft` — PASS.
- `git diff --check` — PASS; Git emitted only LF-to-CRLF working-tree warnings.

## Next required work

1. Reconcile the five stale fake-output expectations and diagnose the one-click slide-2 safe-composition failure without weakening gates.
2. Resolve the golden replay prompt mismatch without editing the immutable golden bundle or its captured expected outputs.
3. Requalify AIOS, then inspect refreshed cross-template sheets and fix only generic, evidence-backed visual blockers.
4. Capture UI screenshots at 1440×900 and complete the UI refresh walk-through.
5. Re-run frozen install, the complete test suite, typecheck, build, docs, boundary, lint, golden replay, and final matrix after the fixes.

RunPod remains off. A future prepared-profile live core needs at least 3 calls (deck-plan, plan-review, contextual audit), with at most 1 optional deck-plan revision. If a matching READY profile is not available, add the 8 WorkSpace profiler batches measured in the latest preparation: minimum 11 total calls, maximum 12 with one bounded revision. Profiler calls during Generate must remain 0. This is a budget estimate, not a live qualification result.
