# Семантический inference

## Граница приложения

Приложение вызывает один provider-neutral `SemanticInferenceAdapter` с ролью, операцией, сообщениями и ожидаемой JSON Schema. Worker и Supervisor — два независимых запроса; они не означают два процесса, два набора весов или постоянную модельную сессию. После ответа приложение повторно проверяет runtime schema и только затем может обновлять план. Ошибки timeout, transport, JSON и schema не применяются к состоянию проекта.

Адаптер принимает OpenAI-compatible Chat Completions. Схема `json_schema` отправляется как structured output и дополнительно валидируется вызывающим кодом. `LCT_SEMANTIC_ENABLE_THINKING` опционально передаёт настройку на уровне запроса; при отсутствии переменной используется поведение endpoint. Детали переменных — в [справочнике конфигурации](./docs/getting-started/configuration.md).

## Развёртывания

- **Локальная разработка:** fake endpoint отвечает детерминированно и не является моделью, не подтверждает качество и latency Qwen.
- **Self-hosted:** `services/inference/` содержит один vLLM runtime вариант. Его можно запускать на выбранной инфраструктуре; RunPod — необязательный self-hosted runtime. Только этот inference container использует `LCT_MODEL_STORAGE_ROOT` и постоянный model volume. `/workspace` — необязательный пример пути; application/domain code его не использует.
- **VK inference:** для top-10 hackathon deployment должен поддерживаться organizer-provided VK inference, serving Qwen 3.8 27B. Протокол, доступ, schema support и operational limits VK пока не квалифицированы. Remote VK inference не требует локального model storage. При OpenAI-compatible contract переключение — конфигурационное; Worker, Supervisor и application/domain logic остаются provider-neutral и не меняются.

Готовность нельзя вывести из успешного fake-run. Для статуса case и оставшихся live-only проверок см. [READY_FOR_QWEN](./docs/READY_FOR_QWEN.md) и [организаторские требования](./docs/compliance/CASE_REQUIREMENTS.md).

## Self-hosted profiles

| Профиль | Model snapshot | dtype | Пределы по умолчанию | Статус |
|---|---|---|---|---|
| `A100_BF16` | `Qwen/Qwen3.8-27B`, revision `1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0` | `bfloat16` | max model length 16384; max sequences 2 | Настройка и CPU snapshot preflight проверялись; 300-секундный live budget не подтверждён |
| `H100_FP8` | `Qwen/Qwen3.8-27B-FP8`, revision `017b9c7af6b5689d5dd426a76e0bc077eb5ca20a` | `auto` | max model length 32768; max sequences 2 | Конфигурация не равна измеренному runtime; GPU performance не подтверждена |

При запуске контейнер проверяет полный 40-символьный revision, строит локальный pinned snapshot и передаёт локальный путь в vLLM. Полный snapshot не нужен для CPU-only `LCT_INFERENCE_PREFLIGHT_ONLY=1`; строгий `LCT_INFERENCE_OFFLINE_PREFLIGHT=1` запрещает сеть и требует полный кэш. Модельные веса не помещены в Git.

Дополнительные детали image, хранения, preflight и API endpoints: [README self-hosted runtime](./services/inference/README.md) и [операционный runbook](./docs/RUNPOD_STARTUP_RUNBOOK.md). Не запускайте платные ресурсы как часть документированных offline gates.

## Кэш, планирование запросов и бюджет

- `TemplateSemanticProfiler` — normal-quality template preparation stage. Он запускается до Generate через существующий template compile path, проверяет полный профиль и записывает его в существующий project cache. Повторная подготовка с тем же fingerprint может использовать cache hit.
- Generate вызывает только read-only `readPreparedTemplateProfile`: cache miss, read failure или невалидный профиль завершаются `409 TEMPLATE_PROFILE_NOT_READY`. Скрытого cache-miss -> inference нет.
- Профильная подготовка ограничена 32 batches при concurrency 1..2 (до 2 source slides и до 24 KiB evidence на batch). Core path — до 4 операций: обязательные `deck-plan`, `plan-review`, `contextual-deck-audit` и не более одной `deck-plan-revision`. Для `deck-plan`, `plan-review` и `deck-plan-revision` разрешена максимум одна повторная попытка того же strict request после `INVALID_STRUCTURED_OUTPUT`, `SERVICE_UNAVAILABLE` или transient network error; malformed output не принимается, deterministic validation failures не повторяются. Контекстуальный аудит автоматически не повторяется; при его отказе готовая презентация сохраняется, аудит можно запустить явно. Полный предел — 39 provider requests: 32 подготовительных + 4 core + до 3 planning retries. Текущий output cap выбран после fake serialized-size measurements: для одного-двух слайдов — 2,048 tokens; adaptive byte budgeting сохраняет ограничения полного запроса.
- Fake acceptance этого lifecycle: WorkSpace прошёл 3/3 slides, A/B/C 9/9, audits и PPTX/PDF/HTML; exact held-out AIOS профиль подготовил, но Generate остановился с `VARIANTS_NOT_DISTINCT`; VK Tech не запускался в текущем pass. Live qualification заблокирована до полного offline gate без ослабления safety/distinctness.
- Self-hosted vLLM запускается с `--enable-prefix-caching`. Это serving-side оптимизация общего совпадающего prefix; корректность приложения от неё не зависит. Semantic adapter не хранит сессию или отдельный KV namespace Worker/Supervisor, а каждый запрос заново передаёт проверенный контекст.
- `MAX_NUM_SEQS=2` ограничивает serving profile, но не задаёт отдельный GPU или очередь для каждой роли. Worker и Supervisor одного планирования выполняются как независимые вызовы; фактическая очередь, одновременная нагрузка и полезность prefix cache должны оцениваться на выбранном endpoint.
- Требование кейса — сформировать 10–15-слайдовую презентацию в бюджете до 300 секунд. Вклад реального Qwen/VK inference, полный end-to-end бюджет и throughput не измерены; этот target не считается выполненным по локальным fake-smoke или по сумме offline renderer timings.

## Изображения и модели вне базового inference пути

Базовый semantic deployment использует Qwen для текстового планирования, профиля шаблона и ревью. Изображения из пользовательских источников могут учитываться как assets/references; OCR и понимание изображений не заявлены. Image generation не настроена и выключена по умолчанию. Для её явного включения требуются `LCT_IMAGE_BASE_URL`, `LCT_IMAGE_MODEL` и `LCT_IMAGE_API_KEY`; `OPENAI_*` не используются как fallback. Ни один image provider не включён в текущий qualification. Подробности и licensing status перечислены в [MODELS.md](./MODELS.md).
