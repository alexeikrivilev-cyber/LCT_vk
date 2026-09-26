# План: P0 core generation fix

## Scope and safety

Довести workflow `PPTX template + required task + optional context + optional source files -> plan -> safe distinct A/B/C -> audit -> editable PPTX` до проверяемого состояния. Использовать только local fake OpenAI-compatible endpoint; не вызывать RunPod, GPU, Qwen, VK или внешний inference. Не добавлять template-name/index rules и не ослаблять safety gates. В рамках implementation run не выполнять commit/push.

## Acceptance

- Task-only planning валидирует и сохраняет детерминированный ContentIR/provenance; uploaded files остаются необязательным дополнительным evidence; изменение task/context/files делает состояние stale.
- Один Worker body block можно детерминированно сегментировать в 1–4 native body regions с exact text/provenance coverage, если source composition поддерживает эти регионы; geometry, overlap и per-chunk fit остаются hard gates.
- A/B/C resolver рассматривает все прошедшие hard gates exemplar и native-layout варианты как общий ограниченный пул; совместный поиск детерминирован, assignment доходит без повторного greedy выбора до renderer и reopen.
- Для exact organizer templates VK Tech, WorkSpace, Education: 9/9 A/B/C, package reopen, без blocking audit errors и без изменения источников.
- Exact held-out `AIOS_Онбординг (4) (1) (1).pptx`, SHA-256 `18198cc08df9fc3ea5aee5f509d89e70a4ade68bb539fed61a957581ee365ad1`, 16 slides / 2 masters / 2 layouts: task-only A/B/C, source residue gate, audit, export/reopen. `AIOS_Лекция` не является substitute.
- Relevant automated gates pass; в финальном отчёте `CORE_GENERATION_READY` допускается только при выполнении каждого пункта.

## Baseline подтверждён до изменения алгоритма

- Git: `main`, HEAD `4a97c9104c6e0108811885a32f52260b465ee103`, tracked worktree clean; есть только untracked `test-content.md`.
- WorkSpace exact file `VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx` из локальной папки Downloads: SHA-256 `1b8883114486c69dff706e9c4fd9382727c4506c2cfa3ec34f86987f1e852f2f`; 13,381,000 bytes; 29 slides / 1 master / 15 layouts. Предыдущий current-HEAD matrix соответствует этому SHA. По пяти planned intents: title имеет 6 прошедших donor diagnostic rows, но только 1 available signature; data/visual/summary имеют по 6 gate-passed rows, но только 2 signatures. Доноры 7 и 15 имеют по 4 profile-mapped body regions, но selector назначает 1 при одном Worker body block.
- Правильный held-out AIOS найден по точному имени/хешу в Downloads; 319,026 bytes, 16 slides / 2 masters / 2 layouts. Local fake-only smoke на точном файле: project/upload/template/profile/plan/reload PASS, generation FAIL `VARIANTS_NOT_DISTINCT`, 3 fake inference requests; audit/export не запускались.
- Предыдущий `.lct` held-out manifest подтверждал только `AIOS_Лекция (1).pptx` (3 slides, SHA `c849…`); он исключён из квалификации текущей задачи.

## Выполнение и статус

### Подтверждённые причины текущего сбоя

- На baseline global resolver не получал все safe exemplar options: per-variant selector сводил кандидатов к одному локально ранжированному выбору до совместного A/B/C assignment. WorkSpace baseline имел несколько gate-passed donor rows, но после проекции оставалось только 1–2 distinct signatures; четыре body regions при одном Worker body block использовались не полностью.
- Совместный assignment не сохранялся как точный donor identity в generation state. Export заново компилировал slides и мог выбрать другой donor; внешний render мог схлопнуть различия после assignment.
- Task/context-only требовал отдельного ContentIR source flow. Локальный fake planner также ошибочно выдавал task source за содержимое слайда, из-за чего дублирующий takeaway удалялся из body.

### Изменения

- Task обязателен; context и source files optional. Task/context включены в deterministic ContentIR/provenance и planning fingerprint; временные файлы не создаются; task используется как инструкция, не как источник неподтверждённых числовых фактов.
- Worker body детерминированно сегментируется по существующим block/paragraph/sentence boundaries в максимум четыре части; сохраняются exact text, source hash, region mapping и provenance, а каждый chunk проходит capacity/geometry checks.
- Exemplar assessment возвращает все safe options; global resolver выбирает три варианта совместно из exemplar и native-layout pool. Renderer/output recheck требует три реальные signatures. Selection identity persisted/revalidated и повторно используется при export/reopen.
- Unknown-template runner принимает expected exact filename+SHA, прокидывает forbidden text assertions и не ставит PASS без успешного residue gate, когда он запрошен.
- Текущие docs исправлены: отдельного organizer content package не ожидается, а source-file ingestion описан как optional. Старый release-acceptance план помечен superseded. Архивные run notes сохранены как история.

### Результаты qualification

- Вход contract проверен task-only + context, source files = 0. ContentIR: 2 provenance sources, 7 units. Planning state hash: ContentIR `c17e25e9ec489ff504f9362688fea2266521301e908c0060fafb9dc923652eb6`; DeckPlan `0db26fe86449c354e6e007454571a48ceedafc3616a2a277c595e57c1e710ce4`.
- WorkSpace: `VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx`, SHA-256 `1b8883114486c69dff706e9c4fd9382727c4506c2cfa3ec34f86987f1e852f2f`, 13,381,000 bytes, 29 slides / 1 master / 15 layouts. Pre-fix baseline diagnostics: 6 passing donor rows for title but 1 available signature; data/visual/summary had 6 passing rows and 2 signatures; donors with four profile-mapped regions used one region for one source block. Current matrix: 40 safe exemplar options and 3 signatures for each tested title/narrative/summary slide; A/B/C all pass.
- VK Tech: SHA-256 `cbbe3aa6a21d23cebc4d1383b93dd07a9cea460d683de1903567b616c839485d`; current matrix observed at least 54 source candidates and 21 safe layout options per planned intent, with 3 signatures and A/B/C pass.
- Education: SHA-256 `9ef2323ed5f49f464aee5ae7065f1f57bb92c8be3a635be507d59819e285cfe0`; current matrix observed at least 120 source candidates, 36 safe exemplar and 20 safe layout options per planned intent, with 3 signatures and A/B/C pass.
- 3×3 Office Kit matrix: `.lct/core-generation-fix-20260926/case-3x3/`; **9/9 PASS**, package reopen, factual equivalence, template preservation; 0 deterministic audit findings/errors, notes=0, raster slides=0. 10 approximate preview text-metric warnings (8 VK Tech, 2 WorkSpace, 0 Education). All three original source template hashes still match.
- Exact held-out `AIOS_Онбординг (4) (1) (1).pptx`: SHA-256 `18198cc08df9fc3ea5aee5f509d89e70a4ade68bb539fed61a957581ee365ad`, 319,026 bytes, 16 slides / 2 masters / 2 layouts. Fake-only task/context E2E, no source files: template analysis/profile, plan, A/B/C, audit, selected+track PPTX export/reopen, source immutable all passed; audit errors=0; five source-specific phrases absent in all 4 output presentations. Manifest: `.lct/unknown-template-qualification/unknown-template-2026-09-26T164941-924Z-ceef591a/UNKNOWN_TEMPLATE_MANIFEST.json`.
- Matrix manifest: `.lct/core-generation-fix-20260926/case-3x3/CASE_QUALIFICATION_MANIFEST.json`; task-only/content context shared across the exact 3 organizer templates; 3 fake profiler requests, external inference=false; measured matrix qualification total 175,710 ms. No product performance optimization was attempted.

### Проверки

- `pnpm dlx pnpm@10.33.2 install --frozen-lockfile` — PASS.
- Full `pnpm dlx pnpm@10.33.2 test` — **187/187 PASS**.
- `typecheck`, `build`, `check:boundary`, `lint:craft`, `docs:check` — PASS; docs check resolved 55 required files.
- Targeted P0 test selection — **86/86 PASS**; includes task-only planning, segmentation/provenance, multi-region selection, exact export donor persistence and residue gate.
- `git diff --check` — PASS; Git printed only expected Windows LF→CRLF normalization warnings.
- No Qwen, VK inference, external endpoint, RunPod, GPU, commit, or push.

## Итог

`CORE_GENERATION_READY` по ограниченному локальному P0 definition of done: task-only planning, WorkSpace/VK Tech/Education 3/3, matrix 9/9, exact held-out AIOS E2E, source residue PASS, deterministic audit 0 errors, template hashes unchanged, automated gates PASS.

Это не live-release readiness. Остаются непроверенными real Qwen semantic quality/structured output/latency, native PowerPoint/LibreOffice visual fidelity и общий 300-second budget; ранее измеренный 12-slide fake smoke занимал 322.635 s и не оптимизировался в этом scope.

Точный следующий шаг: отдельный bounded real-model qualification только после явного разрешения на live inference; до этого сохранять текущие fake-only evidence artifacts и не менять template-specific rules.
