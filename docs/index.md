# Документация LCT

Эта карта ведёт к одному источнику истины по каждой теме. Исторические отчёты в `docs/overnight/` сохраняют результаты отдельных прогонов; актуальный статус приёмки записан в [READY_FOR_QWEN.md](./READY_FOR_QWEN.md) и [CASE_REQUIREMENTS.md](./compliance/CASE_REQUIREMENTS.md).

Документы для пользователей, разработчиков и операторов проекта написаны по-русски. Тексты runtime prompts и внутренние авторские `skills`/`craft`/design-system reference assets сохраняют английский язык оригинала: это входы модели и исходные guidance-материалы, а не customer-facing UI или справочные страницы продукта. Архивные отчёты также могут сохранять исходные цитаты для provenance.

## Для разработчика

- [Краткий обзор и запуск](../README.md)
- [Быстрый старт](./getting-started/quickstart.md) и [локальная разработка](./getting-started/local-development.md)
- [Переменные окружения и конфигурация](./getting-started/configuration.md)
- [Решение частых проблем](./getting-started/troubleshooting.md)
- [Вклад в проект и локальные gates](../CONTRIBUTING.md), [проверки](../TESTING.md)

## Продукт и устройство

- [Пользовательский flow, форматы и ограничения](./product/guide.md)
- [Архитектурная карта](../ARCHITECTURE.md) и [компоненты по этапам](./architecture/overview.md)
- [Модели, профили и prompts](../MODELS.md)
- [Аудит и ремонт](../AUDIT.md)

## Запуск и эксплуатация

- [Варианты deployment](./deployment/overview.md)
- [Inference boundary](../INFERENCE.md), [self-hosted runtime](../services/inference/README.md)
- [RunPod startup runbook](./RUNPOD_STARTUP_RUNBOOK.md) — только для необязательного self-hosted варианта
- [Операционный runbook](./operations/runbook.md), [наблюдаемость](./operations/observability.md), [восстановление](./operations/failure-recovery.md)
- [Безопасность](../SECURITY.md), [лицензии и модели](./compliance/licenses-and-models.md)

## Требования, решения и статус

- [Трассировка organizer case](./compliance/CASE_REQUIREMENTS.md)
- [Поддержка браузеров](./compliance/BROWSER_SUPPORT.md), [шаблонная квалификация](./quality/template-qualification.md)
- [ADR index](../decisions/README.md)
- [Текущий readiness status](./READY_FOR_QWEN.md)
- [Финальная оценка release acceptance](../RELEASE_READINESS.md), [release notes](../RELEASE_NOTES.md)
- [7-минутный сценарий демонстрации](./DEMO_RUNBOOK.md), [план выступления](./PITCH_OUTLINE.md)
- [Активный план release acceptance](./plans/active/final-release-acceptance.md)
