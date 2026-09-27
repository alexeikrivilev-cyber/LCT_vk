# RELEASE NOTES — локальный кандидат релиза

## Версия и состояние

- Версия package: `0.23.1`.
- Проверенный Git baseline: `1d063b4ea70861bb488dfa87304a8e0d24905aea`.
- Рабочее дерево в ходе acceptance изменено; это не фиксированная release revision. Git tag не создавался.
- Статус: **BLOCKED** до устранения препятствий в локальной приёмке и квалификации live-инференса.

## Среда и зависимости

- Node.js: `v24.19.0`.
- Версия pnpm CLI для воспроизводимых команд: `10.33.2` через `pnpm dlx pnpm@10.33.2`. Глобальный запускатель в этой среде показывал другую версию и не является версией проекта.
- `@office-kit/pptx`: `0.21.0`.
- `@office-kit/pptx-preview`: `0.11.0`.
- `pdf-lib`: `1.17.1`.

## Версии workflow

- Workflow contract schema: `1`.
- TemplateIR / ContentIR / DeckPlan schema: `1`.
- Worker prompt: `worker-deck-plan.v2`.
- Supervisor prompt: `supervisor-plan-review.v1`.
- Template profiler prompt/config: `template-profiler.v2` / `template-profiler-config.v2`; semantic output schema remains `template_semantic_profile_v1`.
- Worker output schema: `deck_plan_draft_v1`.
- Supervisor output schema: `supervisor_plan_review_v1`.

## Модельные pins

- Ожидаемый pin self-hosted профиля A100 BF16: `1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0`.
- Ожидаемый pin self-hosted профиля H100 FP8: `017b9c7af6b5689d5dd426a76e0bc077eb5ca20a`.
- VK inference endpoint и revision модели в этой локальной проверке не подтверждались.
- Ни веса, ни endpoint не запускались; указанные pins не означают успешную live-квалификацию.

## Проверенное ограничение

Синтетический fake-only поток на 12 слайдов занял 304.077 s на генерацию/рендер/предпросмотр и 322.635 s целиком. Синтетическая матрица 3×3 завершилась 6/9; проверка AIOS как held-out шаблона остановлена с `VARIANTS_NOT_DISTINCT`. Подробности: [RELEASE_READINESS.md](./RELEASE_READINESS.md).
