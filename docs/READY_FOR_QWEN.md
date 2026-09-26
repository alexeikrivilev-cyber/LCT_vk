# Готовность к ограниченной Qwen qualification

**STATUS: READY_FOR_QWEN**
Базовая product acceptance проверена 2026-09-26; final pre-live hardening — 2026-09-27. Полный отчёт: [RELEASE_READINESS.md](../RELEASE_READINESS.md). Требования и organizer provenance: [CASE_REQUIREMENTS.md](./compliance/CASE_REQUIREMENTS.md).

## Локальный one-click product flow

- Кнопка «Сгенерировать презентацию» запускает и сохраняет шаблонный analysis/profile, planning + review, A/B/C generation, deterministic audit и один contextual audit на готовую выбранную deck.
- Task-only input работает с 0 source files; контекст также optional. Запрошенный slide count соблюдён: VK Tech — 12; WorkSpace, Education, AIOS — по 3.
- Повторный запрос идемпотентен; этап операции восстанавливается через API после refresh/restart. Ошибки замены workflow state при временном Windows file lock имеют ограниченный retry; regression tests подтверждают retry и отказ без retry для permanent error.
- Image generation по умолчанию не настроена: image models пусты и сетевых image calls нет. Для включения необходимы явные `LCT_IMAGE_BASE_URL`, `LCT_IMAGE_MODEL`, а image request также требует `LCT_IMAGE_API_KEY`. `OPENAI_*` не используются как fallback.

## Template qualification

Итоговые артефакты: `.lct/product-completion-final-acceptance-2026-09-26/qualification.json`.

| Шаблон | Запрос слайдов | A/B/C | Reopened PPTX | Контекстная проверка | Дополнительно |
|---|---:|---:|---|---|---|
| VK Tech | 12 | 36/36 готовы | selected/A/B/C, native text, notes 0, structural validation PASS | Текущий run: 1 request, 11 правил v2 | 78.820 s; PDF 12 страниц; HTML 12 секций; deterministic SHA записан |
| WorkSpace | 3 | 9/9 готовы | selected/A/B/C, structural validation PASS | Свежий run: 1 request, 11 правил v2 | Task-only, 0 файлов; run PASS |
| Education | 3 | 9/9 готовы | selected/A/B/C, structural validation PASS | Только исторический audit v1: 9 правил, теперь stale | Текущий contextual v2 audit не запускался |
| AIOS held-out | 3 | 9/9 готовы | selected/A/B/C, structural validation PASS | Свежий run по прежней task-only задаче: 1 request, 11 правил v2 | 80 source phrases были проверены прежней qualification; другая общая task-формулировка сейчас завершилась `VARIANTS_NOT_DISTINCT` |

Историческая 4-template matrix имела 16 локальных fake calls и 0 external requests; её persisted contextual v1/9-rule findings теперь stale и не используются как current v2 evidence. Дополнительные текущие hardening runs VK Tech/WorkSpace/AIOS прошли через local fake endpoint с 4 requests на run, 11/11 contextual rules и 0 generation calls. Fake findings подтверждают технический pipeline/schema, не семантическое качество Qwen.

## Performance и экспорт

Последний canonical runner на 54-слайдовом VK Tech template собрал 12 слайдов: template analysis 1.393 s, planning 0.485 s, generation 52.512 s, exports/reopen 21.509 s, полный fake flow **78.820 s**. Выполнены ровно четыре fake requests (profiler/Worker/planning Supervisor/contextual audit), 36/36 A/B/C готовы; deterministic audit без ошибок, contextual audit 11/11. Selected/A/B/C PPTX structurally reopened: editable native text, notes=0, package errors=0; PDF=12 страниц; HTML=12 секций; исходный шаблон не изменён. Manifest: `.lct/product-e2e/20260926212925-fake-377db269/manifest.json`; deterministic aggregate SHA-256 `a3bd9f74b407728e873b72eba015e72e4408e09337fd21d04a1a949bf78272fa`. Это не прогноз live latency.

PPTX прошли структурный reopen и содержат редактируемый native text на каждом слайде; notes и package validation errors отсутствуют. PDF собран из approximate previews и прошёл reopen/page-count check. HTML прошёл structural/escaping checks. PowerPoint/LibreOffice и browser visual walkthrough здесь не выполнялись.

## Offline checks

Предыдущие repository gates от 2026-09-26 дали 207 тестов; это исторический набор. Final pre-live hardening gates от 2026-09-27: pnpm 10.33.2 offline frozen install — PASS; **212/212 tests**; workspace typecheck — PASS; web/daemon builds — PASS; boundary/craft lint/docs check — PASS (55 docs); `git diff --check` — PASS. Подробности и способ вызова workspace typecheck указаны в [RELEASE_READINESS.md](../RELEASE_READINESS.md). Сам этот документ не запускает inference автоматически.

## Dual-mode runner

`LIVE_PATH_STATUS: LIVE_PATH_READY` означает только готовность инструмента к отдельно разрешённой qualification. Canonical runner вызывает тот же one-click workflow endpoint, fake и external mode имеют hard cap 4, generation model calls — 0, пятый запрос блокируется до adapter. Regression tests подтверждают ровно четыре семантических запроса для 3 и 12 слайдов. External dry-run не выполняет сетевых запросов; preflight проверен на локальном test double и отправляет только models GET, без completion. В этой сессии настоящий external inference не запускался.

## Live-only risks

1. Qwen classification/semantic quality.
2. Strict schema compliance на целевом runtime.
3. Реальная inference latency.
4. VK endpoint auth/configuration и revision.

## Следующее действие

Одна ограниченная live qualification: profiler 1, Worker 1, planning Supervisor 1, contextual audit 1; generation inference requests — 0; максимум четыре semantic requests. Для этого нужны отдельные пользовательские инструкции на целевой endpoint.
