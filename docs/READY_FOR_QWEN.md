# Готовность к ограниченной Qwen qualification

**STATUS: READY_FOR_QWEN**
Проверено: 2026-09-26. Полный отчёт: [RELEASE_READINESS.md](../RELEASE_READINESS.md). Требования и organizer provenance: [CASE_REQUIREMENTS.md](./compliance/CASE_REQUIREMENTS.md).

## Локальный one-click product flow

- Кнопка «Сгенерировать презентацию» запускает и сохраняет шаблонный analysis/profile, planning + review, A/B/C generation, deterministic audit и один contextual audit на готовую выбранную deck.
- Task-only input работает с 0 source files; контекст также optional. Запрошенный slide count соблюдён: VK Tech — 12; WorkSpace, Education, AIOS — по 3.
- Повторный запрос идемпотентен; этап операции восстанавливается через API после refresh/restart. Ошибки замены workflow state при временном Windows file lock имеют ограниченный retry; regression tests подтверждают retry и отказ без retry для permanent error.
- Image generation по умолчанию не настроена: image models пусты и сетевых image calls нет. Для включения необходимы явные `LCT_IMAGE_BASE_URL`, `LCT_IMAGE_MODEL`, а image request также требует `LCT_IMAGE_API_KEY`. `OPENAI_*` не используются как fallback.

## Template qualification

Итоговые артефакты: `.lct/product-completion-final-acceptance-2026-09-26/qualification.json`.

| Шаблон | Запрос слайдов | A/B/C | Reopened PPTX | Контекстная проверка | Дополнительно |
|---|---:|---:|---|---|---|
| VK Tech | 12 | 36/36 готовы | selected/A/B/C, native text на каждом слайде, notes 0, structural validation PASS | 1 request, 9 findings | PDF 12 страниц и HTML 12 секций проверены в matrix run |
| WorkSpace | 3 | 9/9 готовы | selected/A/B/C, structural validation PASS | 1 request, 9 findings | task-only, 0 файлов |
| Education | 3 | 9/9 готовы | selected/A/B/C, structural validation PASS | 1 request, 9 findings | task-only, 0 файлов |
| AIOS held-out | 3 | 9/9 готовы | selected/A/B/C, structural validation PASS | 1 request, 9 findings | 80 source phrases проверены во всех 4 режимах; совпадений нет |

На каждом шаблоне deterministic audit прошёл без ошибок. Каждый semantic запрос обслужил локальный fake endpoint. Итого 16 fake calls по всей матрице, external requests — 0. Fake findings подтверждают технический pipeline и schema, а не семантическое качество реального Qwen.

## Performance и экспорт

Для свежей проверки canonical runner на 54-слайдовом реальном VK Tech template собрал 12 слайдов: template analysis 1.468 s, planning 0.558 s, generation 57.550 s, exports/reopen 24.859 s, полный runner flow **87.597 s**. Выполнены четыре fake semantic requests (profiler/Worker/planning Supervisor/contextual audit), 36/36 A/B/C готовы; deterministic и contextual audit прошли. Selected/A/B/C PPTX повторно открыты Office Kit, по 2 editable text shapes на каждый слайд, notes=0, package errors=0; PDF=12 страниц; HTML=12 секций без активной разметки; исходный шаблон неизменён. Manifest: `.lct/product-e2e/20260926203719-fake-1f45fad3/manifest.json`. Более раннее измерение 78.645 s superseded этим полным canonical run. Это не прогноз live latency.

PPTX прошли структурный reopen и содержат редактируемый native text на каждом слайде; notes и package validation errors отсутствуют. PDF собран из approximate previews и прошёл reopen/page-count check. HTML прошёл structural/escaping checks. PowerPoint/LibreOffice и browser visual walkthrough здесь не выполнялись.

## Offline checks

Финальные gates 2026-09-26: frozen install — PASS; **207/207 tests**; typecheck — PASS; build — PASS; boundary — PASS; craft lint — PASS; docs check — PASS (55 files); `git diff --check` — PASS. Детали приведены в [RELEASE_READINESS.md](../RELEASE_READINESS.md). Сам этот документ не запускает inference автоматически.

## Dual-mode runner

`LIVE_PATH_STATUS: LIVE_PATH_READY` означает только готовность инструмента к отдельно разрешённой qualification. Canonical runner вызывает тот же one-click workflow endpoint, fake и external mode имеют hard cap 4, generation model calls — 0, пятый запрос блокируется до adapter. Regression tests подтверждают ровно четыре семантических запроса для 3 и 12 слайдов. External dry-run не выполняет сетевых запросов; preflight проверен на локальном test double и отправляет только models GET, без completion. В этой сессии настоящий external inference не запускался.

## Live-only risks

1. Qwen classification/semantic quality.
2. Strict schema compliance на целевом runtime.
3. Реальная inference latency.
4. VK endpoint auth/configuration и revision.

## Следующее действие

Одна ограниченная live qualification: profiler 1, Worker 1, planning Supervisor 1, contextual audit 1; generation inference requests — 0; максимум четыре semantic requests. Для этого нужны отдельные пользовательские инструкции на целевой endpoint.
