# ADR-008: Fake endpoint для повторяемой offline проверки

- **Статус:** принято только для development/test
- **Дата:** 2026-09-26

## Контекст

Unit и product smoke должны проверять API mapping, validation, persistence, audit и export без сетевой модели или GPU.

## Решение

Локальный deterministic fake endpoint реализует ограниченные OpenAI-compatible ответы для фиксированного набора smoke/test сценариев.

## Последствия

Fake не измеряет Qwen quality, strict output reliability реальной модели, latency или VK compatibility. Нельзя представлять fake results как model acceptance.
