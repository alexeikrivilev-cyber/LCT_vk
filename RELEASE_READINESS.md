# Готовность продукта к live qualification

**STATUS: STRUCTURAL_FALLBACK_BLOCKED**
**OFFLINE CORE E2E: BLOCKED. НОВЫХ LIVE REQUESTS: 0.** Fake core WorkSpace (3 slides, 0 sources, task hash `6f677ef5e815fedb2272d3ffd98d37e9862d9d34ececb04b911e2db2d4daec2a`) passed Worker and planning Supervisor, then stopped before audit/export with `VARIANTS_NOT_DISTINCT` (readySlides=0; profiler=0; 2/3 semantic calls). The same task/template with explicit fake profiler diagnostic passed 3/3 slides, A/B/C 9/9, deterministic audit, contextual audit 11/11, selected/A/B/C PPTX reopen, PDF/HTML, and source immutability. Core VK Tech (12 slides) passed without profiler in 93.531 s, 3 semantic calls, 36/36 variants, audit/export/reopen and unchanged source. Exact held-out AIOS task+context (0 source files) also stopped with `VARIANTS_NOT_DISTINCT` before audit/export. Do not run external qualification until the structural fallback blocker is resolved without weakening fail-closed composition distinctness. Current run artifacts are under `.lct/core-live-e2e-20260927/`.

The older profiler live attempt remains separate historical evidence: WorkSpace batch 1/5 returned HTTP 200 but `finish_reason=length` at `maxOutputTokens=1024`; validation was not reached (38.017 s, no provider token usage). It did not qualify the core flow. The preceding monolithic request returned HTTP 400 context overflow. Pod was not stopped or restarted. `CASE_COMPLIANCE_STATUS: BLOCKED`; required live VK inference is unverified. No commit/push.

## CASE COMPLIANCE

- Этот отчёт подтверждает локальный product flow и не переобъявляет полную organizer acceptance. Трассировка требований и статусы находятся в [CASE_REQUIREMENTS.md](./docs/compliance/CASE_REQUIREMENTS.md); unknown/partial строки остаются таковыми до отдельных доказательств.
- Organizer source: официальный 7-страничный PDF прочитан ранее; SHA-256 и provenance без выдуманной ссылки записаны в CASE_REQUIREMENTS.md. Самого PDF в Git нет; organizer source/version ещё нужно закрепить в tracked source register.
- В qualification использованы обязательная задача без загруженных source files; для VK Tech добавлен явно синтетический контекст. WorkSpace, Education и held-out AIOS проверены task-only. Контекст и файлы остаются optional.
- Qwen был вызван только один раз на template-profile stage и запрос отклонён по context limit; содержательное качество модели не проверялось. VK inference и open-weight image-provider deployment остаются неподтверждёнными.

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

Все PASS в этой таблице — исторические qualification runs с profiler enabled; они не подтверждают текущий core режим с profiler=0. Текущие real-template no-profile результаты и блокер приведены в шапке и ниже.

В исторической acceptance-матрице было 16 fake semantic calls: по 1 profiler, Worker, planning Supervisor и contextual audit на каждый из четырёх шаблонов. Внешних запросов — 0. Её persisted contextual results содержат 9 правил v1 и теперь считаются stale evidence; это не текущая проверка v2. На всех reopened PPTX проверены число слайдов, native editable text на каждом слайде, отсутствие notes и ошибок package validation. PDF повторно открыт и содержит 12 страниц; HTML содержит 12 slide sections.

## AUDIT / EXPORT

- Deterministic audit прошёл без ошибок во всех четырёх workflow runs; каждая A/B/C variant была ready.
- Исторические runs использовали contextual audit v1/9 rules; см. текущие versioned v2 runs ниже.
- PPTX структурно прошёл package reopen; визуальное открытие/сохранение в PowerPoint или LibreOffice не выполнялось.
- PDF построен из approximate preview и прошёл reopen/page-count проверку. HTML прошёл escaping/структурные тесты и содержит все slide sections; проверка в браузере не выполнялась. Они не заявляются как pixel-identical PowerPoint output.

## PERFORMANCE

Предыдущий canonical fake one-click run на 54-слайдовом VK Tech template завершился за 87.597 s; затем результат был superseded более полными прогонами ниже. Самое свежее повторное измерение этого acceptance pass — 95.753 s. Это offline pipeline measurement, не latency настоящего inference.

## DUAL-MODE RUNNER

**LIVE_PATH_STATUS: BLOCKED** — canonical runner budget/regression tests pass, но offline real-template core generation без профиля блокируется на WorkSpace и AIOS. Исторический внешний WorkSpace workflow остановился на profiler batch с `finish_reason=length`; он не достиг Worker. Endpoint URL и credentials в manifest отсутствуют. Предшествовавший HTTP 400 context overflow был на monolithic profiler до batching.

## UI / DOCUMENTATION

- Русский typed message catalog; regression test подтверждает отсутствие русских UI literals в app chrome и централизованную локализацию. Полный визуальный browser walkthrough в этой qualification не запускался.
- README, product guide, AUDIT, configuration, RELEASE_READINESS и READY_FOR_QWEN синхронизированы с результатами этого этапа. Конфигурация в `.env.example` не содержит credentials.
- PowerPoint/LibreOffice visual QA, browser rendering review и полный customer-facing rehearsal остаются непроверенными и не подменяются structural PASS.

## TESTS

2026-09-26: `pnpm dlx pnpm@10.33.2 install --frozen-lockfile` — PASS; полный suite — **207 passed, 0 failed**; typecheck — PASS; production build — PASS; boundary — PASS; craft lint — PASS; docs check — PASS (**55 required files**, local Markdown links resolve); `git diff --check` — PASS. Windows показал только предупреждения о нормализации LF→CRLF.

Qualification machine report: `.lct/product-completion-final-acceptance-2026-09-26/qualification.json`; `status=PASS`, `noExternalCalls=true`, 16 fake requests. Файлы артефактов остаются в ignored `.lct`.

## Исторический результат: pre-live compliance hardening (2026-09-27)

Этот offline pass был завершён до текущей live попытки и не является актуальным overall status из шапки документа. Его статус `PRE_LIVE_HARDENING_READY` означал готовность только к ограниченной qualification, не полную organizer compliance и не доказательство качества/latency реальной модели. Deterministic audit остался чистой функцией заданных PPTX/ContentIR/TemplateIR inputs; regression проверяет повторяемость report/hash, независимые копии, неизменность входов и изменение audit/hash при blocking geometry change. Contextual auditor versioned, требует ровно 11 правил v2, а legacy 9-rule result не может считаться current. UI показывает раздельные labels; contextual suggestions не запускают ремонт и не отменяют deterministic safety errors.

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

## Исторический результат: final offline product freeze (2026-09-27)

Этот раздел фиксирует offline baseline перед внешней попыткой, а не текущую готовность. На момент этого freeze RunPod, GPU, настоящий Qwen, VK inference и внешние inference-запросы ещё не запускались. Последнее состояние указано в шапке документа.

### Backend и конфигурация

- `parsePptxBackend(undefined|null|'')` → `office-kit`; явные `office-kit` и `custom` сохраняют значение; неизвестная настройка завершается ошибкой.
- `.env.example`, documented quickstart и configuration reference выбирают Office Kit. `custom` остаётся только явно выбранным legacy/diagnostic/experimental backend.
- Readiness сообщает `checks.pptxBackend`; canonical runner проверяет readiness и persisted generation, сохраняет `expectedPptxBackend`/`pptxBackend` в manifest и останавливается при несоответствии. Runner не подменяет backend в environment.
- Regression `release PPTX backend is office-kit across defaults, env example, runner and docs` — PASS.

### Exact WorkSpace 5-slide regression

Команда запускалась с `node --env-file=.env.example`, без backend override. Шаблон `VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx`, SHA-256 `1b8883114486c69dff706e9c4fd9382727c4506c2cfa3ec34f86987f1e852f2f`; task — «Создай презентацию о платформе интеллектуальных ассистентов для корпоративной поддержки. Покажи проблему, решение, принцип работы, преимущества, сценарии использования, безопасность, эффект для бизнеса и следующий шаг.»; context пустой, sources 0, 5 слайдов.

- Backend: Office Kit; workflow: `ready`; 5/5 slides; A/B/C: 15/15; `VARIANTS_NOT_DISTINCT`: отсутствует.
- Deterministic audit: passed, 0 errors, 0 warnings, 15 variants. Contextual audit: `contextual-deck-audit.v2`, 11/11 rules. Fake calls: ровно 4 — template profile, deck plan, plan review, contextual audit; generation model calls: 0.
- Selected/A/B/C PPTX structural reopen: passed, 5 слайдов в каждом, native editable text, 0 raster-only slides, notes, package errors; также прошли selected PDF (5 страниц) и HTML (5 секций). A/B/C raw hashes distinct. Исходный шаблон не изменён.
- Свежий повтор 2026-09-27: **36.954 s**; workflow `ready`, 5/5 слайдов, 15/15 вариантов, deterministic audit 0 errors/0 warnings, contextual v2 11/11, ровно 4 fake calls, generation inference 0. Selected/A/B/C PPTX structural reopen, PDF 5 страниц и HTML 5 секций прошли; hash исходного шаблона не изменился. Manifest: `.lct/product-e2e/final-offline-acceptance-workspace-2026-09-27/manifest.json`.

Request budget для этого run: profiler 1, Worker 1, planning Supervisor 1, contextual audit 1, generation 0; total **4**. VK Tech run использовал тот же budget.

### UI и ручная PowerPoint приёмка

- Normal mode оставляет видимыми выбор PPTX-шаблона, задачу, необязательные поля брифа, число слайдов и одну кнопку «Сгенерировать презентацию». Кнопка блокируется на время текущей загрузки, чтобы workflow не стартовал раньше добавления загруженного материала. Загрузка исходных файлов выбирает их по умолчанию в пределах существующего лимита; список, ручные Analyze/Plan/Variants и raw editor/preview/design-system controls скрыты в расширенном/техническом режиме.
- При переходе workflow в `ready` или `failed` перечитываются persisted template/planning snapshots. Helper regression проверяет оба terminal state и отсутствие reload для `running`; reload не вызывает generation/inference. UI one-click wiring покрыт локальным regression, backend путь — canonical fake E2E.
- Ручное Microsoft PowerPoint evidence **передано пользователем** для конкретного WorkSpace 5-slide fake deck: открытие без Repair/Recover; текст и native shapes редактируются; сохранение, закрытие и повторное открытие прошли; branding сохранён; A/B/C визуально различались. Это scoped acceptance, не pixel-perfect claim. Protected View не считается повреждением.
- Visual status: STRUCTURAL — PASS; MANUAL OFFICE — PASS только для указанного output; SEMANTIC CONTENT — N/A под fake; VISUAL POLISH — PARTIAL. У длинных заголовков остаётся title-density риск; некоторые донорские композиции оставляют пустые области карточек. Существующий projected-fit уже участвует в отборе, но Office Kit text-layout evidence approximate/low-confidence; безопасный порог для текущего наблюдения не обоснован. Generic empty shape нельзя уверенно классифицировать как replaceable без новых shape semantics. Backlog: `title-fit`, `empty-content-region quality`. Алгоритмы генерации и fake Worker не тюнились.

### Canonical VK Tech 12-slide fake regression

Шаблон `VK Tech шаблон.pptx`, SHA-256 `cbbe3aa6a21d23cebc4d1383b93dd07a9cea460d683de1903567b616c839485d`, исходно 54 слайда. Источник взят из сохранённой ignored копии после сверки SHA; исходник не изменён. Свежий Office Kit run: `ready`, 12/12; A/B/C: 36/36; ровно 4 fake semantic calls; deterministic audit 0 errors/0 warnings; contextual v2 audit 11/11. Selected/A/B/C PPTX, 12-страничный PDF и 12-секционный HTML прошли structural validation. Время **95.753 s**, ниже локального regression limit 150 s; это не подтверждение live budget 300 s. Manifest: `.lct/product-e2e/final-offline-acceptance-vktech-twelve-2026-09-27/manifest.json`.

### Репозиторные gates

- `pnpm dlx pnpm@10.33.2 install --frozen-lockfile --offline` — PASS; lockfile актуален, 0 downloaded.
- Текущая targeted regression suite — **25/25 PASS**. Полный suite/typecheck/build/boundary/lint/docs gates не запускались после обнаружения offline real-template blocker; ранее записанные 233 теста/gates относятся к предыдущему состоянию и не квалифицируют новый core путь.
- `corepack pnpm@10.33.2 --filter @lct/web run typecheck` и аналогичная команда для daemon — PASS.
- Web и daemon build через pnpm 10.33.2 — PASS; пользовательские изменения `apps/web/next-env.d.ts` и `apps/web/tsconfig.json` сохранены после сборки.
- `check:boundary`, `lint:craft`, `docs:check` — PASS; docs check: 56 required files, локальные ссылки разрешаются.
- `git diff --check` — PASS.

Offline/fake checks не подтверждают Qwen quality или latency. Один live profiler completion завершился `finish_reason=length` до runtime schema validation, поэтому Worker/Supervisor contracts и <300-second target остаются непроверенными; VK integration не запускалась.

### Handoff — после остановки live qualification

1. Не повторять live запрос в рамках этой qualification: WorkSpace batch 1/5 исчерпал лимит вывода в 1,024 tokens.
2. Следующий технический шаг — offline установить, почему completion усёкся при текущем bounded output budget; не менять serving context/runtime.
3. Новый WorkSpace run возможен только в отдельной задаче; VK Tech 12-slide run допустим после полного WorkSpace PASS.
4. RunPod результат не закрывает обязательный VK inference requirement; отдельная VK endpoint qualification остаётся необходимой.

Текущий RunPod runbook намеренно не закрепляет registry image tag: перед стартом оператор должен выбрать уже опубликованный immutable tag в console. Этот репозиторий не содержит значения, поэтому tag не выдуман и не записывается в документацию.

## REMAINING LIVE-ONLY RISKS

1. Qwen semantic quality и точность template classification.
2. Strict structured output на целевом serving runtime.
3. Реальная latency и inference timeout.
4. VK endpoint auth/configuration и закреплённая модель/revision.

## NEXT ACTION

Остановлена после двух real-template fake core failures с `VARIANTS_NOT_DISTINCT` (WorkSpace, AIOS). Следующий шаг: исследовать evidence/selector compatibility для structural no-profile path и закрыть WorkSpace + held-out AIOS offline без изменения fail-closed safety gate; затем повторить full offline gates. До этого не запускать live inference. Serving context/runtime не менялись; новых live запросов не было.
