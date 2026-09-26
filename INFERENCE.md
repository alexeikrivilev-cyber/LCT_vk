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

- Self-hosted vLLM запускается с `--enable-prefix-caching`. Это serving-side оптимизация общего совпадающего prefix; корректность приложения от неё не зависит. Semantic adapter не хранит сессию или отдельный KV namespace Worker/Supervisor, а каждый запрос заново передаёт проверенный контекст.
- `MAX_NUM_SEQS=2` ограничивает serving profile, но не задаёт отдельный GPU или очередь для каждой роли. Worker и Supervisor одного планирования выполняются как независимые вызовы; фактическая очередь, одновременная нагрузка и полезность prefix cache должны оцениваться на выбранном endpoint.
- Требование кейса — сформировать 10–15-слайдовую презентацию в бюджете до 300 секунд. Вклад реального Qwen/VK inference, полный end-to-end бюджет и throughput не измерены; этот target не считается выполненным по локальным fake-smoke или по сумме offline renderer timings.

## Изображения и модели вне базового inference пути

Базовый semantic deployment использует только Qwen для текстового планирования, профиля шаблона и ревью. Изображения из пользовательских источников могут учитываться как assets/references; OCR и понимание изображений не заявлены. Необязательная image API-конфигурация (`LCT_IMAGE_*` и legacy `OPENAI_*`) по умолчанию указывает на `gpt-image-1`, который не open-weight и не проходит текущий license gate кейса. Поэтому не включайте её в hackathon qualification. Поддержка и qualification допустимой open-weight image модели отсутствуют; подробности и licensing status перечислены в [MODELS.md](./MODELS.md).
