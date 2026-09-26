# ADR-001: повторное использование и квалификация Office Kit

- **Статус:** backend доступен для выбора в offline qualification; принятие в основной export path отложено
- **Дата:** 2026-09-25; evidence дополнено 2026-09-26

## Контекст

Существующий custom renderer формирует PPTX package и редактируемые DrawingML objects. TemplateIR/PDS, semantic provenance, layout policy, audit, persistence и API принадлежат LCT. Замена renderer вместе с этими границами смешала бы повторное использование пакета с непроверенной продуктовой логикой.

## Решение

Office Kit используется как replaceable selectable backend за внутренним renderer/document adapter. Текущие точные pins: `@office-kit/pptx@0.21.0` (runtime) и `@office-kit/pptx-preview@0.11.0` (preview). В `LCT_PPTX_BACKEND=office-kit` package API применяется для открытия/сохранения презентаций, добавления слайдов на template layout и поддерживаемых native объектов. Custom остаётся default. Выбор Office Kit не означает production adoption.

LCT сохраняет IR, mapping, provenance, composition, policy audit, persistence и application contract. Preview — диагностический, не PowerPoint fidelity oracle. Текущий replaceable projection трактует входной PPTX как дизайн/template source: активные исходные слайды и speaker notes не становятся output slides; package masters/layouts/theme/media/opaque parts сохраняются в поддержанных тестах. Это экспериментальная projection policy, не внешний API contract.

## Локальные свидетельства и ограничения

Synthetic corpus покрывает корпоративный, split visual, data/dashboard, editorial и stress family; round-trip сохранял package parts, сохранял native title/table/image/chart/connector, открывался повторно и сообщал ноль validation issues для fixtures. Held-out AIOS deck прошёл ограниченный exemplar projection/reopen, но один deck не квалифицирует arbitrary templates.

Последняя organizer matrix остаётся BLOCKED на 6/9. PowerPoint/LibreOffice open-save/render gate не проведён; preview approximate; text mutation может терять mixed-run formatting, а unsupported links и OOXML требуют fail-closed fallback. Нельзя считать package reopen доказательством native application compatibility.

## Совместимость, лицензия и повторное использование

На записанную дату версии Office Kit отмечены как MIT, ESM и требуют Node `>=22.18`; проект использует Node 24. Пакет до 1.0: сохраняйте точные pins и проверяйте public API при upgrade. Исследованные проекты OpenDesign, slides и pptx-masters дали изолированные идеи, но их runtime/schema/UI не приняты как dependency. Копирование upstream code не выполнялось.

## Последующие gates

1. Прогнать несколько разнообразных held-out/organizer templates с multiple masters/layouts, inherited styles, media и unsupported parts.
2. Проверить package ECMA-376/Open XML валидатором и открыть/сохранить/отрендерить в PowerPoint или LibreOffice.
3. Просмотреть реальный text-fit, theme inheritance, notes и table cells; проверить source immutability.
4. Сравнить custom и Office Kit на одинаковых inputs и только затем решать, менять ли основной backend.
