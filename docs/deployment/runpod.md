# RunPod как временный self-hosted вариант

RunPod — необязательный хостинг self-hosted vLLM container. Это не provider boundary продукта и не обязательная зависимость проекта. RunPod-specific model volume и пример пути `/workspace/lct-models` используются только inference container; приложение не требует `/workspace` и не хранит локальную Qwen-модель.

Эта инструкция не создаёт Pod и не запускает платные ресурсы. До любого live smoke нужны явные runtime settings, лимит запросов, budget и ручная проверка console fields. Cache/preflight/start/stop порядок описан в [RUNPOD_STARTUP_RUNBOOK.md](../RUNPOD_STARTUP_RUNBOOK.md); общая self-hosted configuration — в [services/inference/README.md](../../services/inference/README.md).

Не сохраняйте proxy URL, credentials или токены в репозитории. Переход на remote VK endpoint меняет runtime configuration; Worker/Supervisor/application logic остаются provider-neutral.
