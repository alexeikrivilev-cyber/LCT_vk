# Self-hosted inference container

Этот каталог — один вариант self-hosted запуска vLLM для provider-neutral `SemanticInferenceAdapter`. RunPod — необязательный self-hosted runtime. `LCT_MODEL_STORAGE_ROOT` и persistent model volume относятся только к этому container. `/workspace` — необязательный пример mount point; application/domain code не зависит от пути. Remote VK inference не требует локального model storage. При совместимом adapter protocol переход на VK не меняет Worker, Supervisor и application/domain logic.

Для top-10 hackathon deployment должен поддерживаться organizer-provided VK inference Qwen 3.8 27B; этот target endpoint ещё не квалифицирован.

Пример mount-конфигурации self-hosted inference: `LCT_MODEL_STORAGE_ROOT=/workspace/lct-models`. Это не обязательный application path.

При смене на совместимый remote endpoint Worker, Supervisor и application/domain logic не меняются.

## Профили

| Profile | Model | Revision | dtype | max model length |
|---|---|---|---|---:|
| `A100_BF16` | `Qwen/Qwen3.8-27B` | `1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0` | `bfloat16` | 16384 |
| `H100_FP8` | `Qwen/Qwen3.8-27B-FP8` | `017b9c7af6b5689d5dd426a76e0bc077eb5ca20a` | `auto` | 32768 |

Это параметры запуска, не доказательство VRAM fit, concurrency, throughput или 300-second product budget. Полная конфигурация переменных — [единый справочник](../../docs/getting-started/configuration.md); модельные источники/лицензии — [MODELS.md](../../MODELS.md).

В serving image зафиксированы `transformers==5.8.0`, `tiktoken==0.13.0` и `huggingface-hub==1.27.0`. `sentencepiece` намеренно не добавлен: build-time tokenizer sanity check проверяет заданный tokenizer stack без загрузки модельных весов. Изменение этой зависимости требует повторной проверки обоих профилей.

## Snapshot startup

`entrypoint.sh` проверяет profile, полный 40-символьный `MODEL_REVISION` и абсолютный `LCT_MODEL_STORAGE_ROOT`. `model_snapshot.py` использует exact pinned revision. Если нужные config/tokenizer/index/shard files есть локально, vLLM стартует из local snapshot без обращения к Hub. При неполном snapshot разрешено resumable materialization pinned revision; cache не удаляется. Пути и decision логируются без token.

Публичный `SERVED_MODEL_NAME` остаётся model alias. vLLM получает локальный путь модели и tokenizer; reasoning parser Qwen, prefix caching, seq/token limits и serving port задаются entrypoint. Это конфигурация одного служебного image, не контракт application layer.

## CPU preflight modes

- `LCT_INFERENCE_PREFLIGHT_ONLY=1`: скачивает только необходимые lightweight config/tokenizer assets при отсутствии их cache, выполняет tokenizer/config sanity check и завершает процесс до vLLM/GPU initialization. Не загружает model weights.
- `LCT_INFERENCE_OFFLINE_PREFLIGHT=1`: запрещает Hub/Transformers network, требует полного локального snapshot и проверяет config/tokenizer/shard inventory/writable storage; ничего не materialize-ит и заканчивает процесс до vLLM.

Unit tests используют mock Hub/download paths. Они не скачивают веса. Для проверки реального смонтированного self-hosted volume используйте [startup runbook](../../docs/RUNPOD_STARTUP_RUNBOOK.md). Этот документ не требует и не выполняет запуск платного облака.

## Запуск и ограничения

Image слушает `PORT` (default `8080`) и предоставляет serving health endpoint `/health` и OpenAI-compatible API, включая `/v1/models`. Это health самого inference процесса; он не является проверкой end-to-end product readiness или model quality. Модельное приложение подключается через `LCT_SEMANTIC_BASE_URL`, alias и optional secret `LCT_SEMANTIC_API_KEY`.

По умолчанию `LCT_MODEL_STORAGE_ROOT=/tmp/lct-model-storage`; этот root disposable и не переживает замену container без внешнего persistent mount. Сам факт существования directory не делает его persistent. `HF_TOKEN` — optional secret для snapshot download: задавайте только через provider secret config, не записывайте его в image, shell history или logs.

Torch/Triton/vLLM compile caches остаются временными: version/profile-compatible persistent key не подтверждён. Только snapshot может быть вынесен на постоянный volume. Live compatibility каждого GPU/provider/endpoint надо квалифицировать отдельно; image build или CPU preflight не подтверждают GPU serving.
