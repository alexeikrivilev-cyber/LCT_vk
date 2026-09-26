# ADR-003: Semantic decisions отделены от deterministic geometry

- **Статус:** принято
- **Дата:** 2026-09-26

## Контекст

План и роль элемента требуют semantic classification; геометрия, schema, provenance и package mutation должны быть воспроизводимы и проверяемы.

## Решение

Model output предлагает план/оценку в рамках schema. Детерминированный код проверяет references и limits, выбирает допустимую композицию, создаёт native objects, сохраняет состояние и проводит safety audit.

## Последствия

Fake model output может квалифицировать интерфейс и safety gates, но не semantic quality. Неизвестная/небезопасная композиция завершается отказом/withheld, а не неконтролируемым fallback.
