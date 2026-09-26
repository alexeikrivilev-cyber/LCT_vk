# Операционный runbook

## Локальный offline demo

Поднимите fake semantic endpoint и приложение по [quickstart](../getting-started/quickstart.md). Проверьте `GET /health` для liveness и `GET /readiness` для локальных зависимостей; readiness не делает model completion. Закройте оба процесса через Ctrl+C. Локальные данные хранятся в `.lct/` по умолчанию и игнорируются Git. Структура данных и recovery описаны в [failure recovery](./failure-recovery.md).

## Сбой операции

Сообщите пользователю короткий продуктовый текст и stable error code; stack trace/path остаются локальной диагностикой. Перепроверьте source snapshot, endpoint reachability, schema/validation code и проектный checkpoint. Не повторяйте автоматически платный inference без ограниченного retry policy.

## Self-hosted inference

Для container startup, snapshot reuse, offline preflight и безопасной остановки смотрите [RUNPOD_STARTUP_RUNBOOK.md](../RUNPOD_STARTUP_RUNBOOK.md). Он относится только к self-hosted image. Не выполняйте шаги платного deployment без отдельного разрешения и бюджета.
