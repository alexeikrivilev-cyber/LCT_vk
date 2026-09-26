# ADR-005: Semantic profile cache привязан к версии evidence instructions

- **Статус:** принято
- **Дата:** 2026-09-26

## Контекст

Template semantic profile зависит не только от TemplateIR, но и от текста instructions и output contract.

## Решение

Prompt и его limits хранятся в versioned Markdown/JSON. Кэшный ключ включает hash TemplateIR, prompt version/content hash и compatibility/config version.

## Последствия

Изменение prompt/contract создаёт новый profile cache entry. Старый entry не переиспользуется автоматически. Cache — replaceable semantic evidence, не source of truth для TemplateIR.
