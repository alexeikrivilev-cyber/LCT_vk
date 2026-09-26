# Варианты запуска

## Локальная разработка

Рекомендуемый безопасный старт — [fake-only quickstart](../getting-started/quickstart.md): отдельная команда поднимает локальный fake endpoint, а `scripts/dev.mjs` запускает daemon и web. Все слушатели ограничены loopback; Qwen, GPU и credentials не требуются. Это не production deployment.

## Self-hosted inference

Приложение и inference server — отдельные deployable runtimes. Self-hosted вариант использует `services/inference/` и локальное хранение snapshot только внутри inference container. Точная runtime configuration — в [INFERENCE.md](../../INFERENCE.md), [справочнике env](../getting-started/configuration.md) и [startup runbook](../RUNPOD_STARTUP_RUNBOOK.md).

## VK inference

Для целевого hackathon deployment требуется organizer-provided VK inference Qwen 3.8 27B. Конфигурационный путь описан в [INFERENCE.md](../../INFERENCE.md), но credentials, schema compatibility, availability и latency ещё надо квалифицировать. Локальный model volume в этом remote режиме не нужен.

## Публичное развёртывание приложения

Текущий daemon loopback-bound и не имеет authentication. Не публикуйте его непосредственно в сеть. Multi-user access control, remote untrusted upload perimeter и hardened public deployment не заявлены.
