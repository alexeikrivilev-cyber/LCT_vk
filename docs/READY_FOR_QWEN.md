# Готовность к ограниченной Qwen qualification

**STATUS: LIVE_GENERATION_BLOCKED (пред-live fake gate)**
**Текущая profile-before-Generate acceptance: BLOCKED; новых live requests в этом pass: 0.** WorkSpace (29 source slides, SHA-256 `1b8883114486c69dff706e9c4fd9382727c4506c2cfa3ec34f86987f1e852f2f`) прошёл подготовку профиля в 6 batches; затем Generate без profiler calls прошёл 3/3 slides, A/B/C 9/9, audits, PPTX/PDF/HTML validation и сохранил исходный шаблон неизменённым. Manifest: `.lct/prepared-profile-fake-workspace-20260927/manifest.json`. Exact held-out AIOS (16 source slides, SHA-256 `18198cc08df9fc3ea5aee5f509d89e70a4ade68bb539fed61a957581ee365ad1`) подготовил профиль в 4 batches; Worker и planning Supervisor завершились, но Generate fail-closed остановился с `VARIANTS_NOT_DISTINCT` (0/3 variants; contextual audit/export не запускались). Manifest: `.lct/prepared-profile-fake-aios-20260927/manifest.json`. По stop condition VK Tech fake и любые live requests не запускались; RunPod не останавливался/перезапускался, image не пересобирался, weights не скачивались. Подробности: [активный план](./plans/active/live-readiness-dual-mode.md), [RELEASE_READINESS.md](../RELEASE_READINESS.md), [LIVE_QUALIFICATION.md](../LIVE_QUALIFICATION.md).

Ниже приведены исторические результаты прежних стратегий; они не заменяют текущий stop status.

Предыдущая попытка с монолитным profiler остаётся историческим evidence: HTTP 400 `input_tokens` context overflow при запрошенных 2,784 output tokens. В текущем run наблюдалось усечение ответа; qualification не завершена.

Profiler evidence boundary сократила сериализованный WorkSpace evidence с 134,049 до 69,034 байт (−48.5%), но этого недостаточно для текущего context window. Данные provider usage для отклонённого запроса отсутствуют; нижняя граница по заданному output budget — более 13,600 input tokens. Это не точный tokenizer estimate.

## Последний offline freeze (исторический baseline до текущего pass)

- Release/default/qualification PPTX backend — Office Kit. `parsePptxBackend` default, `.env.example`, quickstart, readiness и canonical runner согласованы; runner завершает проверку ошибкой при backend drift. `custom` оставлен только для явного legacy/diagnostic/experimental выбора.
- Exact WorkSpace regression: шаблон SHA-256 `1b8883114486c69dff706e9c4fd9382727c4506c2cfa3ec34f86987f1e852f2f`; task «Создай презентацию о платформе интеллектуальных ассистентов для корпоративной поддержки. Покажи проблему, решение, принцип работы, преимущества, сценарии использования, безопасность, эффект для бизнеса и следующий шаг.»; 5 слайдов, без content files и context; `ready`, 15/15 вариантов, deterministic audit без errors/warnings, contextual audit v2 11/11, ровно 4 fake calls; selected/A/B/C PPTX structural reopen, PDF и HTML validation прошли. Свежий повтор — 36.954 s. Manifest: `.lct/product-e2e/final-offline-acceptance-workspace-2026-09-27/manifest.json`.
- Canonical VK Tech regression: 54-слайдовый шаблон SHA-256 `cbbe3aa6a21d23cebc4d1383b93dd07a9cea460d683de1903567b616c839485d`, выход 12 слайдов; 36/36 вариантов, 4 fake calls, deterministic audit без errors/warnings, contextual audit v2 11/11, selected/A/B/C PPTX, 12-страничный PDF и 12-секционный HTML прошли structural validation; свежий повтор — 95.753 s, ниже offline regression limit 150 s. Manifest: `.lct/product-e2e/final-offline-acceptance-vktech-twelve-2026-09-27/manifest.json`.
- One-click workflow не требует ручного анализа, создания плана или запуска вариантов. Новые source files включаются при загрузке в пределах действующего лимита 12; основная кнопка ждёт завершения загрузки. Изменить список можно в расширенном режиме. Terminal `ready` и `failed` перечитывает сохранённые template/planning snapshots; generation/inference при этом не запускается.

### Ручная приёмка в Microsoft PowerPoint

Для конкретного пятислайдового WorkSpace fake deck передано пользователем evidence `PASS`: PowerPoint открыл файл без Repair/Recover; в нём 5 слайдов, редактируемый текст и native shapes; `Ctrl+S`, закрытие и повторное открытие прошли без Repair/Recover; branding сохранился; варианты A/B/C визуально различались. Это scoped manual evidence, не автоматическая или pixel-perfect оценка. Protected View не считается повреждением файла.

Статусы качества разделены: **STRUCTURAL — PASS**; **MANUAL OFFICE — PASS** только для проверенного WorkSpace output; **SEMANTIC CONTENT — N/A** для fake; **VISUAL POLISH — PARTIAL**. Долгие заголовки могут выглядеть плотными, а в некоторых донорских композициях остаются пустые области карточек. Безопасное универсальное исправление не подтверждено: projected-fit уже влияет на отбор, а Office Kit text-layout evidence приблизительно; для произвольной пустой фигуры нет достаточной validated replaceable-slot metadata. Backlog для live review: `title-fit`, `empty-content-region quality`.

## Локальный one-click product flow (текущее правило)

- Загрузка/выбор шаблона автоматически выполняет структурный анализ и готовит полный `TemplateSemanticProfile`; Generate доступен только при persisted `semanticProfile.status=ready`.
- Во время Generate профиль читается только из существующего cache; cache miss или invalid profile даёт `409 TEMPLATE_PROFILE_NOT_READY`, без скрытого inference.
- Task-only input работает с 0 source files; контекст также optional. Запрошенный slide count соблюдён: VK Tech — 12; WorkSpace, Education, AIOS — по 3.
- Повторный запрос идемпотентен; этап операции восстанавливается через API после refresh/restart. Ошибки замены workflow state при временном Windows file lock имеют ограниченный retry; regression tests подтверждают retry и отказ без retry для permanent error.
- Image generation по умолчанию не настроена: image models пусты и сетевых image calls нет. Для включения необходимы явные `LCT_IMAGE_BASE_URL`, `LCT_IMAGE_MODEL`, а image request также требует `LCT_IMAGE_API_KEY`. `OPENAI_*` не используются как fallback.

## Template qualification (историческая matrix; см. текущий pass в шапке)

Итоговые артефакты: `.lct/product-completion-final-acceptance-2026-09-26/qualification.json`.

| Шаблон | Запрос слайдов | A/B/C | Reopened PPTX | Контекстная проверка | Дополнительно |
|---|---:|---:|---|---|---|
| VK Tech | 12 | 36/36 готовы | selected/A/B/C, native text, notes 0, structural validation PASS | Текущий run: 1 request, 11 правил v2 | 78.820 s; PDF 12 страниц; HTML 12 секций; deterministic SHA записан |
| WorkSpace | 3 | 9/9 готовы | selected/A/B/C, structural validation PASS | Свежий run: 1 request, 11 правил v2 | Task-only, 0 файлов; run PASS |
| Education | 3 | 9/9 готовы | selected/A/B/C, structural validation PASS | Только исторический audit v1: 9 правил, теперь stale | Текущий contextual v2 audit не запускался |
| AIOS held-out | 3 | 9/9 готовы | selected/A/B/C, structural validation PASS | Свежий run по прежней task-only задаче: 1 request, 11 правил v2 | 80 source phrases были проверены прежней qualification; другая общая task-формулировка сейчас завершилась `VARIANTS_NOT_DISTINCT` |

Историческая 4-template matrix имела 16 локальных fake calls и 0 external requests; её persisted contextual v1/9-rule findings теперь stale и не используются как current v2 evidence. Дополнительные текущие hardening runs VK Tech/WorkSpace/AIOS прошли через local fake endpoint с 4 requests на run, 11/11 contextual rules и 0 generation calls. Fake findings подтверждают технический pipeline/schema, не семантическое качество Qwen.

## Performance и экспорт (исторические measurements)

Последний canonical runner на 54-слайдовом VK Tech template собрал 12 слайдов: template analysis 1.393 s, planning 0.485 s, generation 52.512 s, exports/reopen 21.509 s, полный fake flow **78.820 s**. Выполнены ровно четыре fake requests (profiler/Worker/planning Supervisor/contextual audit), 36/36 A/B/C готовы; deterministic audit без ошибок, contextual audit 11/11. Selected/A/B/C PPTX structurally reopened: editable native text, notes=0, package errors=0; PDF=12 страниц; HTML=12 секций; исходный шаблон не изменён. Manifest: `.lct/product-e2e/20260926212925-fake-377db269/manifest.json`; deterministic aggregate SHA-256 `a3bd9f74b407728e873b72eba015e72e4408e09337fd21d04a1a949bf78272fa`. Это не прогноз live latency.

PPTX прошли structural reopen и содержат редактируемый native text на каждом слайде; notes и package validation errors отсутствуют. PDF собран из approximate previews и прошёл reopen/page-count check. HTML прошёл structural/escaping checks. Browser visual walkthrough в этой qualification не запускался; ручная PowerPoint acceptance ограничена описанным выше WorkSpace output.

## Offline checks

Для текущего change pass после первого fake blocker выполнены только targeted suites: daemon 25/25; runner и web Russian messages 22/22; `git diff --check` PASS. Полный suite/build/boundary/lint/docs gate не запускался после этих изменений. Прежние результаты 239/239 относятся к предыдущему состоянию и не объявляются PASS для текущего diff. Ни один gate не запускает live inference автоматически.

## Dual-mode runner (обновлённая стратегия)

`LIVE_PATH_STATUS: BLOCKED`: runner budget/regression tests проходят. Текущий profile-before-Generate fake gate остановился на held-out AIOS после profile preparation, Worker и planning Supervisor с `VARIANTS_NOT_DISTINCT`; VK Tech fake продолжение и external inference не запускались. Исторический live profile batch завершился `finish_reason=length`; это не является результатом текущего lifecycle. Новые live requests запрещены до полного offline acceptance.

## Live-only risks

1. Причина усечения profiler batch при `maxOutputTokens=1024` неизвестна; prompt/completion usage и context headroom не предоставлены.
2. Worker/Supervisor production schemas, Qwen semantic quality и live latency не квалифицированы.
3. Auth/configuration и revision VK endpoint не проверены в этом RunPod run.

## Следующее действие

Следующий шаг — диагностировать почему точный fake profile-before-Generate AIOS workflow после успешных Worker и planning Supervisor не может выпустить различимые варианты. Сохранять fail-closed `VARIANTS_NOT_DISTINCT`; не запускать VK Tech fake или любой live inference до устранения blocker и прохождения полного offline matrix + repository gates.
