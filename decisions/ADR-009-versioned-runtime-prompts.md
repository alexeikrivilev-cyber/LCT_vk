# ADR-009: Runtime prompts и workflow config хранятся отдельными версиями

- **Статус:** принято
- **Дата:** 2026-09-26

## Контекст

Prompt поведения модели должен быть аудируемым, изменяемым без поиска длинной строки в TypeScript и связанным с schema/agent version.

## Решение

Worker, Supervisor и template-profiler system instructions находятся в `apps/daemon/prompts/*.md`; version/role/schema/output bounds — рядом в JSON contract. Runtime читает prompt asset из package-relative path; qualification fingerprint включает prompt identity/content.

## Последствия

Build/package должен включать prompt files и config assets. Отсутствующий prompt должен давать явную ошибку. Каталог `skills/` содержит authoring references; он не загружается динамически в runtime.
