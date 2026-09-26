# ADR-002: Provider-neutral semantic inference

- **Статус:** принято
- **Дата:** 2026-09-26

## Контекст

Self-hosted vLLM, local fake и organizer-provided VK inference — разные runtime окружения. Product workflow не должен кодировать адрес или process contract конкретного provider.

## Решение

Worker/Supervisor вызывают `SemanticInferenceAdapter` с логической ролью, запросом и output schema. OpenAI-compatible adapter получает endpoint/model/key из environment. Provider endpoint обязан пройти protocol/schema qualification; интерфейс не гарантирует, что любой OpenAI-compatible server поддерживает strict JSON Schema.

## Последствия

Переключение runtime при совместимом протоколе конфигурационное. Credentials остаются внешней конфигурацией. VK endpoint ещё не квалифицирован.
