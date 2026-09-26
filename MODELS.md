# Модели и versioned instructions

В таблице различаются model checkpoint, публичный model alias и целевая интеграция. Карточки проверены 2026-09-26. Pinned revision фиксирует snapshot, но не подтверждает GPU fit, качество или latency.

## Семантическая модель

| Модель / source | Версия / revision | Размер / license / open-weight | Почему выбрана и роль | I/O и serving requirement | VRAM/profile | Fallback |
|---|---|---|---|---|---|---|
| [Qwen/Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B) | `1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0` | 27B; примерно 55.6 GB Hub files; BF16; Apache-2.0; открытые веса | Ожидаемая семантическая модель кейса; Worker/ Supervisor и опциональный Template Profiler | Brief, TemplateIR/ContentIR evidence → strict JSON Schema. Нужен self-hosted serving container либо совместимый remote endpoint | Self-hosted `A100_BF16`; заявленный GPU profile 80 GB, `max-model-len=16384`. Полный fit/KV/concurrency не квалифицированы | Фактически подтверждённого model fallback нет. Локальный fake — только dev; VK endpoint обязателен для top-10 и пока не проверен |
| [Qwen/Qwen3.8-27B-FP8](https://huggingface.co/Qwen/Qwen3.8-27B-FP8) | `017b9c7af6b5689d5dd426a76e0bc077eb5ca20a` | 27B; примерно 30.9 GB Hub files; FP8; Apache-2.0; открытые веса | Альтернативный проверяемый self-hosted precision profile той же semantic модели; не считается автоматическим fallback | Тот же JSON Schema запрос/ответ; нужен serving runtime с совместимой precision/hardware path | Self-hosted `H100_FP8`; заявленный GPU profile 80 GB, `max-model-len=32768`. Throughput/KV margin не измерены | BF16 profile — другой runtime/precision выбор, его нельзя подставлять молча; VK inference остаётся целевым final route |
| Organizer-provided [VK inference Qwen 3.8 27B](./docs/compliance/CASE_REQUIREMENTS.md) | Точный endpoint/model revision неизвестен до organizer config | Требование кейса — Qwen 3.8 27B с remote VK inference; license/serving metadata нужно подтвердить для предоставленного checkpoint | Выбрана требованием top-10, не локальным benchmark | Те же application requests предполагаются только при подтверждённом adapter protocol, auth и strict schema support | VRAM/provider capacity управляет VK; данные неизвестны | Self-hosted RunPod не выполняет требование VK. Квалифицированного альтернативного provider пока нет |

Размер файлов модели на Hub не равен свободной VRAM: runtime, KV cache, context и одновременные запросы используют дополнительную память. Смотрите [inference profiles](./INFERENCE.md) и [self-hosted runtime](./services/inference/README.md).

### VK endpoint

Организаторский VK inference — целевой, но не проверенный путь. Приложение настраивает базовый URL, model alias и необязательный bearer key; endpoint должен поддерживать используемый OpenAI Chat Completions и strict JSON Schema request. Точные authentication fields, schema support, model revision и SLA нужно подтвердить у организатора. При remote endpoint локальный snapshot и model volume не нужны. При совпадении протокола Worker/Supervisor/application logic не меняются; live-интеграция пока не квалифицирована.

### Image models

| Путь/модель | Параметры / версия | Лицензия / открытые веса | Назначение и вывод |
|---|---|---|---|
| [Qwen/Qwen-Image-2.1](https://huggingface.co/Qwen/Qwen-Image-2.1) | 7B, BF16 по карточке | Qwen Research License Agreement, не Apache-2.0/MIT | Кандидат не включён в базовую поставку и не подходит под документированный license gate |

Image generation не настроена и выключена по умолчанию. Для явного включения нужны все три конфигурационных параметра: `LCT_IMAGE_BASE_URL`, `LCT_IMAGE_MODEL` и `LCT_IMAGE_API_KEY`. `OPENAI_*` не являются fallback и не настраивают image provider. Ни одна image model не считается выбранной по умолчанию; допустимый open-weight image provider и соответствие star task не квалифицированы.

## Граница inference

SemanticInferenceAdapter получает role, operation, messages и schema; приложение валидирует ответ до изменения состояния. Worker и Supervisor — два запроса одного логического model service, не отдельные веса, процесс или persistent KV sessions. Конфигурация: [справочник env](./docs/getting-started/configuration.md) и [INFERENCE.md](./INFERENCE.md).

## Agent / skill / prompt / schema версии

| Роль | Agent и skill | Prompt | Schema | Назначение |
|---|---|---|---|---|
| Worker | deck-plan-worker.v1 / presentation-planning.v1 | worker-deck-plan.v2 | deck_plan_draft_v1 | План презентации из брифа и фактов ContentIR |
| Supervisor | plan-review-supervisor.v1 / bounded-plan-review.v1 | supervisor-plan-review.v1 | supervisor_plan_review_v1 | Bounded review и предложение patch/re-plan |
| Template profiler | template-profiler.v1 / template-semantics.v1 | template-profiler.v1 | template_semantic_profile_v1 | Разметить роли по фактам TemplateIR без выбора макета |

Workflow metadata: [agent-workflows.v1.json](./apps/daemon/src/presentation/contracts/agent-workflows.v1.json) и [template-profiler.v1.json](./apps/daemon/src/presentation/contracts/template-profiler.v1.json). Runtime prompt files: [worker](./apps/daemon/prompts/worker-deck-plan.v2.md), [supervisor](./apps/daemon/prompts/supervisor-plan-review.v1.md), [template profiler](./apps/daemon/prompts/template-profiler.v1.md). Planning fingerprint включает prompt/config hashes; profiler cache разделён по hash шаблона и prompt/config fingerprint.

System prompts сохранены на английском, чтобы локализация справочной документации не меняла поведение модели. Каталог skills/ содержит reference skills для авторской работы; planning runtime не загружает их содержимое автоматически. Agent roles — логические договорённости, а не отдельные процессы.
