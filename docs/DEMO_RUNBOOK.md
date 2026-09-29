# Runbook демонстрации — 7 минут (не репетирован)

## Текущий release status — 2026-09-29

Последний real browser flow был выполнен на rehearsal-шаблоне `kompaniya-napravleniya-i-klienty.pptx`, не на WorkSpace. Он восстановил существующий проект после refresh и создал A/B/C по 10 слайдов и PPTX/PDF/HTML. PPTX структурно редактируемый. Deterministic audit выдал 21 предупреждение; contextual audit завершился `SERVICE_UNAVAILABLE`, повтор не выполнялся. Contact sheet показывает разреженную композицию. Не обещать clean audit или успешную contextual-проверку.

Последний offline fake smoke: WorkSpace и Education — по 10 слайдов PASS; AIOS held-out — 6 слайдов PASS; VK Tech — BLOCKED на `PREVIEW_LAYOUT_BLOCKED`. Не выдавать старую матрицу из раздела ниже за актуальную. При live сбое не нажимать «Повторить» до просмотра безопасной telemetry и подтверждения владельца бюджета.

Live cost guard: текущая live-квалификация заморожена. Не запускать semantic requests, profiling, планирование, Generate или повтор аудита. Для записи использовать только уже сохранённый результат и готовые файлы. Короткая последовательность показа: [FINAL_DEMO_RUNBOOK.md](runbooks/FINAL_DEMO_RUNBOOK.md).

### Текущий сценарий записи

В этой release-спринт-сессии нельзя продолжать отложенную live-квалификацию: contextual audit уже завершился `SERVICE_UNAVAILABLE`, а повтор запрещён текущим ограничением бюджета. Не предлагать старую последовательность WorkSpace/held-out как шаги записи. Для записи следовать только [короткому runbook финального демо](runbooks/FINAL_DEMO_RUNBOOK.md); он использует сохранённые результаты, не вызывает inference и не расходует баланс RunPod.

Не используйте прежний общий 7-минутный сценарий для текущей записи: он предполагал новый запуск workflow, который сейчас запрещён бюджетным ограничением. Точный безопасный сценарий на 5 минут приведён в [финальном runbook](runbooks/FINAL_DEMO_RUNBOOK.md). Он показывает только сохранённый real browser E2E и не запускает inference.

## Историческая локальная проверка (2026-09-28; superseded)

- Использован fake semantic endpoint; qualification report фиксирует 65 semantic requests и `noExternalCalls=true`. Это проверка pipeline, не оценка Qwen.
- VK Tech: 12 слайдов, A/B/C — 36/36 вариантов; deterministic audit и структурное открытие selected/A/B/C PPTX прошли. PDF повторно открыт с 12 страницами; HTML содержит 12 секций.
- WorkSpace и Education: по 3 слайда и 9/9 вариантов; deterministic audit и структурное открытие selected/A/B/C PPTX прошли.
- Held-out AIOS: generation остановлена fail-closed на `VARIANTS_NOT_DISTINCT`; qualified previews и exports отсутствуют. Не показывать этот шаблон как успешный fallback.
- Визуальные листы обнаруживают повтор hero-визуала на VK Tech, пустые/слабо заполненные области и слабое различие композиций на WorkSpace/Education. Структурный PASS не означает визуальную готовность.
- VK Tech до контекстуального аудита: 62.556 s; последующие экспорты заняли 1,328.353 s, полный flow — 1,390.909 s. Полный семиминутный сценарий не репетирован; экспортный бюджет демонстрации не подтверждён.
- UI проверен на начальном экране и после свежей загрузки проекта: состояние восстановилось, русский текст, варианты, аудит и экспорты видны. Viewport был около 1265×720, а не 1440×900; файловые UI screenshots не сохранены.
- Golden replay заблокирован: текущий deck-plan system prompt не совпадает с immutable captured fixture. Не переписывать golden expectations ради PASS.

Актуальные machine-readable результаты и contact sheets: `.lct/overnight/overnight-wow-2026-09-28/morning-freeze-matrix-v1/`. Подробный статус: [отчёт утренней приёмки](./overnight/MORNING_DEMO_REPORT.md). Время live inference неизвестно.

PowerPoint/LibreOffice visual acceptance и полный 7-minute rehearsal не выполнялись. Не заявлять их результат как PASS.

Актуальный статус: [RELEASE_READINESS.md](../RELEASE_READINESS.md). Детали продуктовых ограничений: [руководство](./product/guide.md).
