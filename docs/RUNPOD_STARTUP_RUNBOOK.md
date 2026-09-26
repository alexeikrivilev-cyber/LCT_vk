# RunPod startup runbook для self-hosted inference

Этот runbook относится только к self-hosted vLLM container. Он не создаёт Pod, не обращается к RunPod API и не запускает оплачиваемые ресурсы. Он не относится к provider-neutral application adapter или remote VK inference. Здесь нет конкретного proxy URL.

## Перед запуском

1. Зафиксируйте immutable inference image tag; не используйте плавающий `latest`.
2. Если потребуется постоянное хранение, подключите volume до старта container. `/workspace` — лишь пример mount path, а пример storage root — `/workspace/lct-models`.
3. Задайте `LCT_INFERENCE_PROFILE=A100_BF16` или другой профиль и `LCT_MODEL_STORAGE_ROOT` на абсолютный путь внутри inference container. `PORT` для этого контейнера по умолчанию `8080`.
4. Убедитесь, что volume доступен на запись UID 1000 и имеет место для snapshot. Не считайте путь на ephemeral container disk persistent.
5. `HF_TOKEN` при необходимости задавайте только как secret; не помещайте его в image, команду или log.

Ожидаемый snapshot для A100:

```text
/workspace/lct-models/huggingface/hub/models--Qwen--Qwen3.8-27B/snapshots/1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0
```

## Проверка snapshot без скачивания и запуска vLLM

Следующий блок — шаблон будущей операторской команды, а не проверенная в этой сессии команда. Для исполнения потребуются уже созданный self-hosted container/image и подключённый volume; RunPod ресурс не создавался. Замените placeholder image/path на значения из своей конфигурации.

```bash
docker run --rm \
  -e LCT_INFERENCE_PROFILE=A100_BF16 \
  -e LCT_MODEL_STORAGE_ROOT=/workspace/lct-models \
  -e LCT_INFERENCE_OFFLINE_PREFLIGHT=1 \
  -v /path/to/persistent-volume:/workspace \
  <immutable-inference-image>
```

Preflight не обращается к сети и не загружает модель. Ожидается exit code `0`, `snapshot.status=ready_offline` и успешный config/tokenizer/shard/writable-storage check. Missing root, wrong revision, unwritable storage или incomplete shard set — FAIL. Исправьте mount/cache до serving start.

## Cache-first решение startup

При полном exact snapshot ожидаются `snapshot.local_required_files_missing=0`, `snapshot.bytes_required=0` и `snapshot.download_decision=use_exact_local_snapshot_no_hub_request`. Snapshot проверяется по config, tokenizer, weight index и каждому перечисленному shard.

Признаки возможной повторной materialization: `download_decision=download_missing_pinned_files`, положительные `snapshot.files_missing`/`snapshot.bytes_required`, сообщение проверки remote plan или иной storage root/revision. Сначала проверьте mount, profile и revision. Код не удаляет snapshot; неполный cache может возобновить pinned download при полном startup.

## Health и модельный alias

После намеренного запуска serving container проверьте container-local endpoints:

```bash
curl --fail --silent http://127.0.0.1:8080/health
curl --fail --silent http://127.0.0.1:8080/v1/models
```

`/v1/models` должен показывать ожидаемый `SERVED_MODEL_NAME`. Health подтверждает процесс/serving path, но не end-to-end качество DeckPlan.

## Подключение приложения и безопасная остановка

Application adapter получает значения `LCT_SEMANTIC_BASE_URL`, `LCT_SEMANTIC_MODEL` и при необходимости секрет `LCT_SEMANTIC_API_KEY` через app environment. При VK remote endpoint локальный model volume не нужен; смена endpoint не требует изменений Worker/Supervisor/application logic, если protocol/schema совместим.

GPU можно безопасно остановить после ограниченной qualification, когда нет активных запросов/операций, использующих endpoint, и snapshot находится на нужном persistent volume. Compile caches остаются временными. Для общего описания deployment см. [INFERENCE.md](../INFERENCE.md).
