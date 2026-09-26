# План выступления по кейсу

Тезисы ниже ограничены тем, что реализовано и проверено локально. Не представлять fake inference как модельный результат и не утверждать, что organizer acceptance уже пройдена.

## 1. Проблема

- Организатор просит сервис, который формирует презентации из задачи и заданных PPTX-шаблонов.
- Важное ограничение: итог должен учитывать структуру/оформление входного шаблона и оставаться редактируемой презентацией.
- Организатор уточнил для текущей qualification: отдельного content package не будет; задача обязательна, контекст и source files optional. Зафиксированный локальный smoke использует тестовую задачу и контекст, не выдавая их за финальный demo prompt.

## 2. Подход

- Загрузить PPTX и ввести задачу; при необходимости добавить контекст и исходные материалы.
- Структурно разобрать шаблон в TemplateIR/PDS, а задачу/материалы — в ContentIR.
- Сформировать и проверить DeckPlan до генерации слайдов.
- Компилировать A/B/C из общих фактов и плана; неподтверждённые/небезопасные композиции блокировать.
- Применить deterministic audit, выбрать допустимое исправление и экспортировать.

## 3. Pipeline и границы

- React/Next.js UI вызывает TypeScript daemon; daemon хранит project state и управляет pipeline.
- SemanticInferenceAdapter отделяет application от OpenAI-compatible endpoint; Worker/Supervisor — роли вызовов одного настроенного адаптера.
- Геометрия, provenance checks, OOXML output, audit и экспорт валидируются кодом.
- Редактируемые native objects создаются там, где renderer их поддерживает; полный произвольный OOXML/Office fidelity не заявлен.

## 4. Живое демо

- Показать выбранный шаблон, исходный текст, бриф, план, три стратегии и экспорт.
- По умолчанию статус должен ссылаться на [RELEASE_READINESS.md](../RELEASE_READINESS.md).
- Если используется fake endpoint, обозначить его как детерминированную локальную имитацию. Live Qwen/VK не заявлять до bounded qualification.

## 5. Аудит

- Детерминированные проверки находят некоторые geometry, placeholder, numeric provenance, table/chart, density и duplicate-content проблемы.
- Безопасный repair ограничен локальной проекцией/layout; модель не получает право произвольно редактировать OOXML.
- После генерации запускается один bounded text-only contextual audit на готовую deck через semantic adapter. Он проверяет выводы заголовков, соответствие содержания, provenance, смысловой тип визуализации, язык, повторения, мусор и связность повествования. Findings не обходят deterministic gate и не меняют содержимое автоматически.
- Fake-only schema/runtime flow проверен; оценки настоящего Qwen и визуальное качество изображения/слайдов не подтверждены. Нужен human review.

## 6. Результаты и выводы

- Fake-only one-click qualification прошла для VK Tech (12 слайдов), WorkSpace, Education и held-out AIOS (по 3 слайда, task-only); selected/A/B/C PPTX были повторно открыты на каждом шаблоне.
- AIOS source-residue gate проверил 80 уникальных template-specific фраз в selected/A/B/C: совпадений нет. VK Tech PDF прошёл проверку 12 страниц; HTML содержит 12 секций.
- VK Tech 12-slide fake flow занял 78.645 s до завершения contextual audit и экспортов. Это измерение не включает реальный Qwen/VK inference.
- Структурный local PASS не подтверждает визуальное качество в PowerPoint/LibreOffice или работу настоящей модели. Следующий этап — один ограниченный live qualification; его бюджет указан в [RELEASE_READINESS.md](../RELEASE_READINESS.md).
