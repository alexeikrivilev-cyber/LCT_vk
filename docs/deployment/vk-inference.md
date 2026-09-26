# Целевой VK inference endpoint

Официальное требование топ-10 — использовать organizer-provided VK inference с Qwen 3.8 27B. Endpoint для проекта пока не квалифицирован. В этом документе не задаются URL, auth scheme, revision, лимиты или service-level guarantees без organizer confirmation.

Когда endpoint будет предоставлен, параметры задаются через `LCT_SEMANTIC_BASE_URL`, `LCT_SEMANTIC_MODEL` и при необходимости секрет `LCT_SEMANTIC_API_KEY`. Проверьте endpoint contract по checklist из [inference-provider](./inference-provider.md). Для remote VK режима скачивать Qwen weights или монтировать model volume локально не требуется.

Source of truth по case requirement — [CASE_REQUIREMENTS.md](../compliance/CASE_REQUIREMENTS.md); открытые вопросы остаются в organizer requirements record. RunPod/self-hosted не подменяет VK final-inference requirement.
