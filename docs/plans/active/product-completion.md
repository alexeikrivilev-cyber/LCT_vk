# Product completion pass

## Goal

Собрать пользовательский путь «PPTX-шаблон + задача → готовая презентация» на уже существующих compiler, profiler, planner, generator, audit и export компонентах. Добавить один persisted backend operation, deck-level contextual audit на fake/production SemanticInferenceAdapter, русский основной flow и закрыть implicit external image-model default. Не менять generation architecture, формат PPTX compiler и product semantics без доказанной необходимости.

## Constraints

- Только local fake semantic endpoint; без RunPod, GPU, Qwen, VK и внешнего inference.
- Не делать commit/push.
- Не открывать, менять, добавлять в индекс и удалять существующий untracked `test-content.md`.
- Не менять публичные planning/generation contracts; новый orchestration route является product operation boundary и хранит только bounded stage metadata/input fingerprint, переиспользуя существующее persisted состояние.
- Contextual audit — одно bounded textual request на выбранную собранную deck revision; его вывод не меняет контент и не отменяет deterministic audit.

## Acceptance

- Один backend operation запускает/переиспользует template compile + semantic profile + planning + A/B/C generation, сохраняет текущую стадию и возвращает тот же operation при дубле.
- Контекстный аудит одного выбранного deck проходит через существующий semantic adapter, имеет строгую schema/runtime ref validation и не может пометить deck deterministic-clean.
- Русский primary UI запускает operation одной кнопкой, показывает сохранённый прогресс и после refresh восстанавливает variants/selection/audits/exports.
- Image generation не рекламируется и не вызывается без явной `LCT_IMAGE_BASE_URL` и `LCT_IMAGE_MODEL`; `OPENAI_*` не является скрытым default.
- Fake-driven VK Tech 12 slides, WorkSpace/Education 3 slides, exact AIOS held-out 3 slides; PPTX selected/A/B/C, PDF, HTML; весь offline gates.

## Baseline and current findings

- Git baseline: `115c014 perf: reduce generation and preview overhead`; existing worktree contains unrelated untracked `test-content.md` and no tracked diff.
- Baseline `pnpm dlx pnpm@10.33.2 test`: PASS, 187 tests, 0 failures.
- Existing code has separate template, planning and generation routes. Planning and generation persist their own state; generation recovers pending packs. There is no aggregate product operation.
- Contextual audit port is dormant, per-slide and requires rendered image input; it does not match the requested text-only deck audit. Replaceable internal boundary may be revised.
- At baseline, image discovery/adapter had an implicit OpenAI env/default `gpt-image-1`; this pass removed that fallback from model listing and the image endpoint. Explicit provider configuration is required.
- Latest pre-pass evidence is recorded in `RELEASE_READINESS.md`; prior 12-slide flow was 322.635s, so this run must measure current implementation rather than assume the prompt's 70.8s.

## Work plan

1. [x] Implement persisted one-click operation by composing existing services; idempotency and stage projection; add API tests.
2. [x] Add deck-level contextual audit boundary/prompt/strict schema and persistence; run one fake audit request after deterministic generation.
3. [x] Integrate one primary Russian UI action with persisted polling/recovery; retain lower-level actions as existing workflow controls.
4. [x] Disable implicit image model and test configuration/API behavior.
5. [x] Add one-click qualification script using real templates/fake endpoint; validate all selected/A/B/C exports, VK Tech PDF/HTML, request counts, and held-out residue.
6. [x] Update targeted docs and release status from executed evidence.
7. [x] Run frozen install, tests, typecheck, build, boundary, craft lint, docs check, diff check. Review full diff and preserve no-commit/no-push constraint.

## Progress

- [x] Source/diff review and baseline test.
- [x] Backend workflow and contextual audit.
- [x] Primary UI flow.
- [x] Image default compliance.
- [x] Fake product qualification/regressions/exports.
- [x] Docs and complete verification.

## Results

- Product orchestration, contextual audit, UI flow, image config default, qualification runner, and targeted docs completed. No product generation architecture redesign or external inference was used.
- Adversarial qualification exposed an intermittent Windows file-lock failure while replacing persisted workflow state: `rename(temp, state.json)` raised `EPERM`, causing a false workflow failure after planning. `renameWithTransientRetry` now retries only `EPERM`/`EACCES`/`EBUSY` with bounded backoff; non-transient errors fail immediately. Regression test covers both paths.
- The fake planner now handles a newline-delimited task-only brief as one source with distinct task steps. Regression test proves each slide refs the same task unit and no extra source is introduced.
- Final fake qualification PASS: `.lct/product-completion-final-acceptance-2026-09-26/qualification.json`; 4 templates, 12/3/3/3 slides, 16 local fake requests, 0 external requests. Selected/A/B/C PPTX reopened on all templates; AIOS source residue 80 phrases × 4 modes, 0 matches. VK Tech PDF=12 pages, HTML=12 sections.
- Adversarial review found table/numeric ContentIR values were omitted from contextual audit text/evidence because they live in `cellValue`/`numericLexeme`; audit now sends source-backed `{id, kind, text}` evidence and fails closed on a missing evidence unit. Regression tests cover both paths.
- VK Tech 12-slide flow: 54.714 s through contextual audit; 23.931 s for exports; 78.645 s total, fake-only and below 180 s.
- Final gates: frozen install PASS; 200/200 tests; typecheck/build/boundary/craft lint/docs check (55 links) PASS; `git diff --check` PASS. UI visual walkthrough in a browser, Office visual QA, and all live Qwen/VK behavior remain unverified.
- `test-content.md` was pre-existing and untouched. No commit/push.

## Final state

The bounded product completion criteria are satisfied: `PRODUCT_READY_FOR_LIVE`. Next step is one explicitly authorized live qualification, limited to profiler 1, Worker 1, planning Supervisor 1, contextual audit 1, generation 0. Do not infer that Qwen/VK quality or latency is verified from fake tests.
