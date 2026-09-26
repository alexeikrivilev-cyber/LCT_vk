# Справочник конфигурации

`.env.example` — безопасный fake-only пример, а не production secret store. Пример содержит только локальные loopback values. Не коммитьте `.env` или credentials. `PORT` имеет разный смысл в web и в inference container — смотрите scope.

Обозначения: **нет** — значение необязательное; **условно** — нужно только для указанной операции/режима. «Секрет» означает, что значение должно поступать из secret store окружения и не попадать в репозиторий/логи.

## Приложение и local development

| Переменная | Обязательна | Значение по умолчанию / пример | Scope / секрет | Назначение |
|---|---|---|---|---|
| `LCT_BIND_HOST` | Нет | `127.0.0.1` | daemon; нет | Адрес daemon. Реализация допускает только loopback |
| `LCT_WEB_HOST` | Нет | `127.0.0.1` | local dev; нет | Адрес web dev server. Допускается только loopback, поскольку локальный UI не имеет аутентификации |
| `LCT_PORT` | Нет | `7456` | daemon и web proxy; нет | Порт HTTP API daemon. При заданном значении принимается только целое число 1–65535; некорректная настройка завершает запуск с ошибкой |
| `PORT` | Нет | `3000` в локальном web; `8080` в inference image | scoped process; нет | Web port либо serving container port; эти значения не взаимозаменяемы. Dev launcher проверяет диапазон 1–65535 |
| `LCT_DATA_DIR` | Нет | `.lct` относительно корня репозитория | daemon; нет | SQLite, проекты, исходники и результаты. Абсолютный путь тоже допустим |
| `LCT_PPTX_BACKEND` | Нет | `custom`; допустимы `custom`, `office-kit` | daemon; нет | Выбор PPTX backend |
| `LCT_PYTHON` | Нет | auto-discovery Python 3.12 | daemon; абсолютный executable path, не секрет | Явный Python 3.12 для структурного PPTX inspector |
| `LCT_NEXT_DIST_DIR` | Нет | `.next/dev-<PORT>` в dev script | web dev; нет | Изолированный Next.js build directory |
| `NODE_ENV` | Нет | задаётся Next/Node runtime | web/diagnostics; нет | Разделяет development/production diagnostics и режим Next.js |

## Семантический endpoint

| Переменная | Обязательна | Значение по умолчанию / пример | Scope / секрет | Назначение |
|---|---|---|---|---|
| `LCT_SEMANTIC_BASE_URL` | Условно | fake: `http://127.0.0.1:8787/v1` | daemon; обычно URL не секрет, но внутренний endpoint не публикуйте | OpenAI-compatible API base URL. Нужен при вызове semantic операции |
| `LCT_SEMANTIC_MODEL` | Нет | `Qwen/Qwen3.8-27B` | daemon; нет | Model alias, передаваемый endpoint |
| `LCT_SEMANTIC_API_KEY` | Нет/условно | отсутствует в fake-only конфигурации | daemon; **секрет** | Bearer credential endpoint. Требует HTTPS, кроме loopback |
| `LCT_SEMANTIC_ENABLE_THINKING` | Нет | не задано; допустимы `true`/`false` | daemon; нет | Опциональная request-level chat-template setting. Unset сохраняет provider default |
| — | — | — | — | Таймаут semantic adapter фиксирован кодом: 120 секунд; env override отсутствует |

## Необязательная генерация изображений

| Переменная | Обязательна | Значение по умолчанию / fallback | Scope / секрет | Назначение |
|---|---|---|---|---|
| `LCT_IMAGE_API_KEY` | Условно | отсутствует | daemon; **секрет** | Текущий image adapter требует явный ключ для запроса. Не входит в fake-only старт |
| `LCT_IMAGE_BASE_URL` | Условно | отсутствует | daemon; URL может быть внутренним | Явный OpenAI-compatible endpoint; без переменной image generation не настроена |
| `LCT_IMAGE_MODEL` | Условно | отсутствует | daemon; alias, не секрет | Явный model alias; без переменной image generation не настроена |

Без `LCT_IMAGE_BASE_URL` и `LCT_IMAGE_MODEL` приложение не перечисляет image models и не делает запросов. У `OPENAI_API_KEY` и `OPENAI_BASE_URL` нет fallback-поведения и они игнорируются image adapter. При явной настройке endpoint prompt отправляется этому провайдеру и может создавать расходы; для фактического image request сейчас также необходим `LCT_IMAGE_API_KEY`. Не задавайте image-параметры для обычного fake-only старта. Лицензии и scope — в [MODELS.md](../../MODELS.md).

## Fake, тесты и qualification

| Переменная | Обязательна | Default | Scope / секрет | Назначение |
|---|---|---|---|---|
| `LCT_FAKE_SEMANTIC_PORT` | Нет | `8787` | fake endpoint; нет | Порт локального deterministic fake. Dev launcher проверяет диапазон 1–65535 |
| `LCT_SMOKE_RESULT_FILE` | Нет | отсутствует | product smoke; локальный путь | Куда записать smoke summary |
| `LCT_BENCHMARK_TIMEOUT_MS` | Нет | `300000` | benchmark; нет | Timeout benchmark runner, не product timeout |
| `LCT_BENCHMARK_GPU` | Нет | `unspecified` | benchmark metadata; нет | Описательная метка GPU для отчёта |

## Self-hosted inference container

Таблица относится только к `services/inference/`. Worker/Supervisor и application/domain code не читают эти переменные. Подробности — в [INFERENCE.md](../../INFERENCE.md).

| Переменная | Обязательна | Default | Scope / секрет | Назначение |
|---|---|---|---|---|
| `LCT_INFERENCE_PROFILE` | Нет | `A100_BF16`; также `H100_FP8` | self-hosted; нет | Выбор согласованного profile ID/revision/dtype/length |
| `MODEL_ID` | Нет | из profile | self-hosted; нет | Hub repository identifier snapshot |
| `MODEL_REVISION` | Нет | pinned SHA из profile | self-hosted; нет | Полный 40-char commit SHA |
| `MODEL_DTYPE` | Нет | из profile | self-hosted; нет | Должен совпасть с dtype profile |
| `SERVED_MODEL_NAME` | Нет | `Qwen/Qwen3.8-27B` | self-hosted; нет | Public alias `/v1/models`/OpenAI API |
| `MAX_MODEL_LEN` | Нет | A100 `16384`; H100 `32768` | self-hosted; нет | Model context limit |
| `MAX_NUM_SEQS` | Нет | `2` | self-hosted; нет | Лимит serving sequences |
| `MAX_NUM_BATCHED_TOKENS` | Нет | `4096` | self-hosted; нет | Batch token limit |
| `GPU_MEMORY_UTILIZATION` | Нет | `0.90` | self-hosted; нет | Доля VRAM для vLLM, должна быть >0 и <1 |
| `PORT` | Нет | `8080` | self-hosted; нет | Порт model serving container, не web port |
| `LCT_MODEL_STORAGE_ROOT` | Нет | `/tmp/lct-model-storage` | self-hosted; абсолютный путь, не секрет | Корень snapshot; постоянный mount — конфигурация runtime, не application contract |
| `LCT_INFERENCE_PREFLIGHT_ONLY` | Нет | `0` | self-hosted; нет | `1`: облегчённая config/tokenizer preflight; не стартует vLLM |
| `LCT_INFERENCE_OFFLINE_PREFLIGHT` | Нет | `0` | self-hosted; нет | `1`: строгая no-network проверка полного локального snapshot |
| `HF_TOKEN` | Нет/условно | отсутствует | self-hosted; **секрет** | Hub token для gated/rate-limited downloads; не записывать в image или logs |
| `HOME` | Нет | `/tmp/lct-home` | self-hosted; путь | Домашний cache/config root контейнера |
| `VLLM_CACHE_ROOT` | Нет | `/tmp/lct-vllm-cache` | self-hosted; путь | Временная директория vLLM cache |
| `VLLM_CONFIG_ROOT` | Нет | `/tmp/lct-vllm-config` | self-hosted; путь | Временная директория vLLM config |
| `TRITON_CACHE_DIR` | Нет | `/tmp/lct-triton-cache` | self-hosted; путь | Временный Triton cache |

`HF_HOME` и `HF_HUB_CACHE` производны от `LCT_MODEL_STORAGE_ROOT`; в entrypoint они выставляются согласованно. `MODEL_ID`, revision и dtype overrides валидируются профилем; произвольная смесь профилей не поддерживается.

## Benchmark runner

Эти переменные читает `services/inference/benchmark.mjs`. Общие semantic credentials описаны выше; benchmark делает реальный endpoint запрос и не является offline test.

| Переменная | Обязательна | Default | Scope / секрет | Назначение |
|---|---|---|---|---|
| `LCT_INFERENCE_PROFILE` | Нет | `unspecified` | benchmark metadata; нет | Описательный label serving profile |
| `MODEL_ID` | Нет | `unspecified` | benchmark metadata; нет | Описательный checkpoint label |
| `MODEL_REVISION` | Нет | `unspecified` | benchmark metadata; нет | Описательная revision label |
| `MODEL_DTYPE` | Нет | `unspecified` | benchmark metadata; нет | Описательный dtype label |
| `LCT_BENCHMARK_GPU` | Нет | `unspecified` | benchmark metadata; нет | Описательная GPU label |
| `LCT_BENCHMARK_TIMEOUT_MS` | Нет | `300000` | benchmark; нет | Верхний timeout benchmark request |

Не запускайте benchmark на live endpoint или платном GPU без отдельной явной задачи и согласованного request budget.

## Readiness и ресурсные пределы

`GET /health` отвечает только за liveness процесса. `GET /readiness` проверяет SQLite, возможность записи в data/project directories, renderer и semantic `/models` probe, только если semantic endpoint настроен. Probe ограничен по времени и не выполняет completion. В fake/local режиме semantic check имеет статус `not-required`.

Зафиксированные защитные пределы daemon:

| Операция | Текущий предел |
|---|---|
| Multipart upload | 2 файла в запросе, до 64 MiB каждый; не более 2 одновременных upload-запросов |
| JSON API body | до 32 MiB; небольшие generation/control-запросы имеют отдельные меньшие bounds |
| ContentIR | до 12 выбранных источников, 16 MiB на источник, 32 MiB суммарно, 256 KiB извлечённого текста и 4096 units |
| Semantic planning | 256 KiB serialized evidence; Worker 150 s, Supervisor 90 s, общий planning deadline 240 s; максимум 2 одновременных planning jobs |
| DeckPlan / generation | 1–30 слайдов; до 2 одновременных generation jobs |
| Repair / export | максимум 2 одновременных repair jobs и 2 export jobs |
| PPTX inspection | до 64 MiB входного архива, 4096 ZIP members и 256 MiB expanded archive/XML reads; inspector timeout 30 s |
| Semantic adapter | request до 8 MiB, response до 1 MiB, schema до 64 KiB, output до 8192 tokens; общий максимум timeout 300 s |

Upload ограничен в памяти на запрос и по числу параллельных запросов. Постоянного per-project quota для всех сохранённых файлов нет: следите за свободным местом в `LCT_DATA_DIR` и удаляйте проекты штатным API.
