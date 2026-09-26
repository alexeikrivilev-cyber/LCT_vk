# Спецификация продукта и текущая реализация

Этот документ фиксирует продуктовую цель, а не подтверждает, что каждая возможность уже реализована. Текущий acceptance и проверенные ограничения — в [READY_FOR_QWEN.md](./docs/READY_FOR_QWEN.md) и [CASE_REQUIREMENTS.md](./docs/compliance/CASE_REQUIREMENTS.md).

## Определение продукта

LCT — компилятор презентаций, не слайдовый редактор. Пользователь задаёт PPTX-шаблон, исходные материалы и brief. Система анализирует доступную структуру, планирует повествование, строит варианты в рамках источников/шаблона, проверяет результат и выдаёт редактируемый PPTX с PDF/HTML viewing exports.

## Принципы

- План задаёт смысл до компоновки. Источники и факты остаются привязанными к ContentIR references.
- A/B/C показывают разные композиционные стратегии одного DeckPlan; model output не меняет факты ради новой композиции.
- Шаблон рассматривается как структура: layouts, placeholders, styles, theme, assets, geometry и package relationships, а не просто screenshot.
- Результат должен оставаться нативно редактируемым. Полнослайдовая растеризация не является допустимой заменой.
- Lock/repair ограничиваются указанным slide/variant scope. Изменение смысла не происходит незаметно.
- Небезопасная или неподдерживаемая композиция должна быть явно withheld, а не выдана за готовую.

## Целевой workflow

1. Создать проект и загрузить шаблон/исходные материалы.
2. Проанализировать структуру шаблона и задать аудиторию, цель, результат и размер deck.
3. Создать и проверить редактируемый DeckPlan.
4. Сгенерировать слайдовые A/B/C packs, показывая честное состояние прогресса.
5. Выбрать/закрепить варианты, изучить audit, выполнить ограниченный repair.
6. Проверить и скачать PPTX/PDF/HTML.

Текущий UI и backend реализуют ограниченную часть этого процесса; progressive generation, contextual audit/review и end-to-end acceptance не считать полностью подтверждёнными без evidence в readiness report.

## Границы

- Product/domain code не зависит от RunPod или конкретного model vendor.
- Semantic inference — внешний адаптер; геометрия, OOXML, schema/provenance validation, persistence и deterministic audit принадлежат локальному коду.
- PPTX compatibility ограничена реализованными структурными случаями. Arbitrary Office fidelity не обещается.
- PDF/HTML являются view exports; основной editable deliverable — PPTX.
- Целевые 10–15 slides, live 300-second budget, неизвестный шаблон и organizer 3×3 acceptance нуждаются в подтверждённых qualification runs.

Непосредственная карта кода — [ARCHITECTURE.md](./ARCHITECTURE.md); audit contract — [AUDIT.md](./AUDIT.md).
