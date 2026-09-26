# Готовность продукта к live qualification

**STATUS: PRODUCT_READY_FOR_LIVE**
Базовая release acceptance: 2026-09-26. Дополнительный final pre-live hardening: 2026-09-27, Windows, local fake OpenAI-compatible endpoint, Office Kit. RunPod, GPU, Qwen, VK inference и любые внешние inference-запросы не запускались. Commit/push не выполнялись.

## CASE COMPLIANCE

- Этот отчёт подтверждает локальный product flow и не переобъявляет полную organizer acceptance. Трассировка требований и статусы находятся в [CASE_REQUIREMENTS.md](./docs/compliance/CASE_REQUIREMENTS.md); unknown/partial строки остаются таковыми до отдельных доказательств.
- Organizer source: официальный 7-страничный PDF прочитан ранее; SHA-256 и provenance без выдуманной ссылки записаны в CASE_REQUIREMENTS.md. Самого PDF в Git нет; organizer source/version ещё нужно закрепить в tracked source register.
- В qualification использованы обязательная задача без загруженных source files; для VK Tech добавлен явно синтетический контекст. WorkSpace, Education и held-out AIOS проверены task-only. Контекст и файлы остаются optional.
- VK inference, фактическое качество Qwen и open-weight image-provider deployment остаются вне этой локальной проверки.

## ONE-CLICK FLOW / STATE

- Основное действие — «Сгенерировать презентацию». Один persisted operation выполняет analysis/profile шаблона, ContentIR/план, review, варианты A/B/C, deterministic audit и один deck-level contextual audit.
- Duplicate request возвращает текущую операцию; status/pipeline сохраняются и восстанавливаются после refresh/restart. Автоматические тесты также проверяют resume после сохранённых стадий.
- Windows reliability fix: временная блокировка target при замене `.workflow/state.json` больше не сразу завершает workflow; `EPERM`, `EACCES` и `EBUSY` повторяются ограниченное число раз с backoff. Другие ошибки не повторяются.
- Contextual output проходит строгую schema и reference validation, локализуется по message codes и не может отменить deterministic errors или изменить исходные факты.

## INPUT / IMAGE GENERATION

- Qualification: VK Tech + задача + синтетический контекст + 0 файлов; WorkSpace/Education/AIOS + задача + 0 контекста + 0 файлов.
- Image generation выключена по умолчанию: без явных `LCT_IMAGE_BASE_URL` и `LCT_IMAGE_MODEL` модели не перечисляются, сетевого обращения нет. `OPENAI_*` не служат fallback. Реальный image request требует также `LCT_IMAGE_API_KEY`.
- В qualification: `configured=false`, image network requests `0`.

## QUALIFICATION MATRIX

Актуальный machine-readable отчёт и артефакты лежат в ignored каталоге `.lct/product-completion-final-acceptance-2026-09-26/`.

| Шаблон | Вход | Слайды | Варианты | Экспорт/reopen | Результат |
|---|---|---:|---:|---|---|
| VK Tech | задача + синтетический контекст, 0 файлов | 12 | A/B/C, 36 ready | selected/A/B/C PPTX; PDF 12 страниц; HTML 12 секций | PASS |
| WorkSpace | задача, 0 контекста/файлов | 3 | A/B/C, 9 ready | selected/A/B/C PPTX | PASS |
| Education | задача, 0 контекста/файлов | 3 | A/B/C, 9 ready | selected/A/B/C PPTX | PASS |
| AIOS held-out | задача, 0 контекста/файлов | 3 | A/B/C, 9 ready | selected/A/B/C PPTX; source residue: 80 уникальных фраз × 4 режима, совпадений 0 | PASS |

В исторической acceptance-матрице было 16 fake semantic calls: по 1 profiler, Worker, planning Supervisor и contextual audit на каждый из четырёх шаблонов. Внешних запросов — 0. Её persisted contextual results содержат 9 правил v1 и теперь считаются stale evidence; это не текущая проверка v2. На всех reopened PPTX проверены число слайдов, native editable text на каждом слайде, отсутствие notes и ошибок package validation. PDF повторно открыт и содержит 12 страниц; HTML содержит 12 slide sections.

## AUDIT / EXPORT

- Deterministic audit прошёл без ошибок во всех четырёх workflow runs; каждая A/B/C variant была ready.
- Исторические runs использовали contextual audit v1/9 rules; см. текущие versioned v2 runs ниже.
- PPTX структурно прошёл package reopen; визуальное открытие/сохранение в PowerPoint или LibreOffice не выполнялось.
- PDF построен из approximate preview и прошёл reopen/page-count проверку. HTML прошёл escaping/структурные тесты и содержит все slide sections; проверка в браузере не выполнялась. Они не заявляются как pixel-identical PowerPoint output.

## PERFORMANCE

Предыдущий canonical fake one-click run на 54-слайдовом VK Tech template завершился за 87.597 s; он superseded более свежим pre-live run ниже. Это offline pipeline measurement, не latency настоящего inference.

## DUAL-MODE RUNNER

**LIVE_PATH_STATUS: LIVE_PATH_READY** — это статус canonical qualification runner, не результат live Qwen/VK acceptance. Fake и external modes входят через один `/api/projects/:id/workflow/generate`; неиспользованный fifth semantic request отклоняется до adapter; automatic inference retry отсутствует. Regression E2E подтверждает 4 запроса для 3- и 12-слайдового workflow и 0 generation calls. External dry-run дал 0 network requests; models-only preflight проверен на локальном fake test double: один `/v1/models` GET, 0 chat completions. API key и URL проверены на отсутствие в reports/manifests. Настоящий endpoint не вызывался.

## UI / DOCUMENTATION

- Русский typed message catalog; regression test подтверждает отсутствие русских UI literals в app chrome и централизованную локализацию. Полный визуальный browser walkthrough в этой qualification не запускался.
- README, product guide, AUDIT, configuration, RELEASE_READINESS и READY_FOR_QWEN синхронизированы с результатами этого этапа. Конфигурация в `.env.example` не содержит credentials.
- PowerPoint/LibreOffice visual QA, browser rendering review и полный customer-facing rehearsal остаются непроверенными и не подменяются structural PASS.

## TESTS

2026-09-26: `pnpm dlx pnpm@10.33.2 install --frozen-lockfile` — PASS; полный suite — **207 passed, 0 failed**; typecheck — PASS; production build — PASS; boundary — PASS; craft lint — PASS; docs check — PASS (**55 required files**, local Markdown links resolve); `git diff --check` — PASS. Windows показал только предупреждения о нормализации LF→CRLF.

Qualification machine report: `.lct/product-completion-final-acceptance-2026-09-26/qualification.json`; `status=PASS`, `noExternalCalls=true`, 16 fake requests. Файлы артефактов остаются в ignored `.lct`.

## FINAL PRE-LIVE COMPLIANCE HARDENING (2026-09-27)

**STATUS: PRE_LIVE_HARDENING_READY** — только для следующей ограниченной live qualification. Это не полная organizer compliance и не доказательство качества/latency реальной модели. Deterministic audit остался чистой функцией заданных PPTX/ContentIR/TemplateIR inputs; regression проверяет повторяемость report/hash, независимые копии, неизменность входов и изменение audit/hash при blocking geometry change. Contextual auditor versioned, требует ровно 11 правил v2, а legacy 9-rule result не может считаться current. UI показывает раздельные labels; contextual suggestions не запускают ремонт и не отменяют deterministic safety errors.

Свежие local fake runs после hardening: VK Tech 12 слайдов — 78.820 s, 4 requests, 36/36 variants, 11/11 contextual rules; WorkSpace 3 слайда — PASS, 4 requests, 11 rules; held-out AIOS на ранее квалифицированной task-only задаче — PASS, 4 requests, 11 rules. AIOS с другой общей формулировкой завершился на `VARIANTS_NOT_DISTINCT` до audit; он не маскируется успешным запуском. Для AIOS PASS ограничен конкретным template/task input.

VK Tech manifest: `.lct/product-e2e/20260926212925-fake-377db269/manifest.json`; contextual version fingerprint `135a5e30858db509b775baaff00ea1b57eb9a6b161493489a08432076c2fb034`; deterministic aggregate SHA-256 `a3bd9f74b407728e873b72eba015e72e4408e09337fd21d04a1a949bf78272fa`. Selected/A/B/C PPTX прошли structural reopen, PDF 12 страниц и HTML 12 секций прошли структурные проверки. Office Kit text-layout evidence остаётся approximate/low-confidence, не PowerPoint oracle.

Contextual audit text/metadata/evidence based: VLM/pixel review нет. A03/A04 остаются PARTIAL, A05 остаётся FAIL, A13 остаётся FAIL/unknown coverage. T2I star task не реализован; ≤20B star-task wording и ≤35B general model wording остаются open clarification. Qwen quality/schema/latency, VK endpoint, 300-second live run, browser walkthrough и PowerPoint visual acceptance остаются live/manual gates.

Repository gates в этом pass:

- `corepack pnpm@10.33.2 install --offline --frozen-lockfile` — PASS, lockfile актуален, сеть отключена;
- `corepack pnpm@10.33.2 test` — **212/212 PASS**;
- workspace typecheck для `@lct/web` и `@lct/daemon` — PASS;
- build `@lct/web` и `@lct/daemon` — PASS;
- `check:boundary`, `lint:craft`, `docs:check` — PASS; docs check проверил 55 файлов;
- `git diff --check` — PASS.

Вызов root `typecheck` wrapper через `corepack pnpm@10.33.2 typecheck` сначала упёрся в PATH, где вложенный `pnpm` разрешился в 11.19.0; та же workspace-команда `-r --filter @lct/web --filter @lct/daemon run typecheck` выполнена напрямую через pnpm 10.33.2 и прошла. Build package scripts также выполнены напрямую через pnpm 10.33.2, последовательно. Ни один из этих gates не запускал внешний inference. Commit/push не выполнялись; pre-existing untracked `test-content.md` сохранён без чтения или изменения.

## REMAINING LIVE-ONLY RISKS

1. Qwen semantic quality и точность template classification.
2. Strict structured output на целевом serving runtime.
3. Реальная latency и inference timeout.
4. VK endpoint auth/configuration и закреплённая модель/revision.

## NEXT ACTION

Выполнить одну ограниченную live qualification через выбранный provider-neutral endpoint: profiler 1, Worker 1, planning Supervisor 1, contextual audit 1; generation inference requests — 0. Общий бюджет — не более четырёх semantic requests. До отдельной задачи live calls не запускались.
