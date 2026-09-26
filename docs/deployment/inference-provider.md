# Подключение semantic inference provider

Приложение принимает `LCT_SEMANTIC_BASE_URL`, model alias и optional API key; детали — в [INFERENCE.md](../../INFERENCE.md). Протокол OpenAI-compatible — существующая adapter contract. Не добавляйте RunPod/vendor checks в domain/application logic.

Перед реальным подключением квалифицируйте endpoint: authentication без утечки секретов, `GET /v1/models`, content-vs-reasoning mapping, `content=null`, finish reason, strict JSON Schema, timeout/cancellation и один Worker/Supervisor flow. Наличие HTTP health не означает совместимость схемы. Точный live budget должен быть ограничен до запросов и записан в qualification report.
