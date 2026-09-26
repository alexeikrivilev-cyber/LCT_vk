# Ограниченная live qualification

Этот runbook — инструкция для будущего запуска, не разрешение на inference. Этот documentation pass не обращался к RunPod, GPU, Qwen, VK или внешнему endpoint. Перед любым `--semantic-mode external` требуется отдельная явная команда пользователя.

## Единый product path и режимы

Canonical runner: [`scripts/run-product-e2e.mjs`](./scripts/run-product-e2e.mjs). Fake и external режимы создают один daemon, оборачивают adapter для учёта бюджета и запускают тот же persisted `/api/projects/:id/workflow/generate`, который вызывает UI. Runner не подменяет product workflow прямыми вызовами profiler/planner/generator. `--provider-label runpod|vk` записывается только в manifest и не меняет транспорт или product behavior.

- `--semantic-mode fake`: runner сам поднимает локальный deterministic OpenAI-compatible fake. Сеть внешнего inference не используется.
- `--semantic-mode external`: используется production `OpenAICompatibleSemanticInferenceAdapter`, настроенный через environment. Runner не поднимает model server.

External environment: `LCT_SEMANTIC_BASE_URL` и `LCT_SEMANTIC_MODEL` обязательны; `LCT_SEMANTIC_API_KEY` optional, если endpoint не требует bearer auth; `LCT_SEMANTIC_ENABLE_THINKING=false` рекомендуется для qualification. База URL должна быть OpenAI-compatible `/v1` без credentials, query и fragment. Значения передаются только через environment, не через CLI. Runner не помещает base URL, API key или Authorization в manifest.

PowerShell setup для отдельного разрешённого external run:

```powershell
$env:LCT_SEMANTIC_BASE_URL = "https://<предоставленный-endpoint>/v1"
$env:LCT_SEMANTIC_MODEL = "Qwen/Qwen3.8-27B"
$env:LCT_SEMANTIC_API_KEY = "<секрет; задайте только если endpoint требует ключ>"
$env:LCT_SEMANTIC_ENABLE_THINKING = "false"
```

Если ключ не требуется, не задавайте `LCT_SEMANTIC_API_KEY`; adapter отправит запрос без `Authorization`.

## Команды по стадиям

### 0. Проверить команду без daemon и сети

```powershell
pnpm dlx pnpm@10.33.2 exec node --import tsx scripts/run-product-e2e.mjs `
  --semantic-mode external `
  --provider-label runpod `
  --template "C:\path\to\organizer-template.pptx" `
  --task "Подготовить презентацию по предоставленной задаче" `
  --slides 3 `
  --dry-run
```

Dry run проверяет аргументы, локальные input paths и external environment. Он не запускает daemon, не обращается к endpoint и отправляет 0 chat completions.

### 1. Дешёвый endpoint preflight

```powershell
pnpm dlx pnpm@10.33.2 exec node --import tsx scripts/run-product-e2e.mjs `
  --semantic-mode external `
  --provider-label runpod `
  --template "C:\path\to\organizer-template.pptx" `
  --task "Подготовить презентацию по предоставленной задаче" `
  --slides 3 `
  --preflight-only
```

Preflight делает один `GET /v1/models`, проверяет, что model alias опубликован, и отправляет 0 chat completions. Результат сообщает только `endpointConfigured`, model alias, `authConfigured` и `modelsReachable`; полный URL, credentials и заголовки не записываются. Если endpoint недоступен или model alias не совпадает — остановитесь. Не запускайте product E2E и не повторяйте запрос автоматически.

### 2. Один ограниченный 3-slide product run

Только после отдельного разрешения на live inference:

```powershell
pnpm dlx pnpm@10.33.2 exec node --import tsx scripts/run-product-e2e.mjs `
  --semantic-mode external `
  --provider-label runpod `
  --template "C:\path\to\organizer-or-held-out-template.pptx" `
  --task "Подготовить презентацию по предоставленной задаче" `
  --slides 3 `
  --max-semantic-requests 4
```

Это один one-click run: profiler 1, Worker 1, planning Supervisor 1, contextual deck audit 1, generation 0. Hard cap берётся из [`scripts/lib/live-qualification-contract.json`](./scripts/lib/live-qualification-contract.json); пятый semantic request блокируется до вызова adapter. При timeout, 5xx/524, невалидной схеме, `finish_reason=length` или пустом ответе runner сохраняет failure и останавливается без retry.

Ожидаемый запросный профиль не зависит от числа слайдов: и 3-slide, и 12-slide product flow делают те же 4 semantic calls; число слайдов влияет на generation/render/export, но не создаёт inference call на каждый slide. Это покрыто runner regression tests и fake E2E.

### 3. Измерение рабочего объёма

Только после PASS дешёвого smoke и отдельного разрешения:

```powershell
pnpm dlx pnpm@10.33.2 exec node --import tsx scripts/run-product-e2e.mjs `
  --semantic-mode external `
  --provider-label runpod `
  --template "C:\path\to\same-template.pptx" `
  --task "Подготовить презентацию по предоставленной задаче" `
  --slides 12 `
  --max-semantic-requests 4
```

Фиксируйте полный elapsed time и отдельно `semanticTotalMs`/`deterministicTotalMs`. Пять минут для live Qwen/VK не считаются выполненными до измеренного product run.

Старый [`scripts/run-live-quality-suite.mjs`](./scripts/run-live-quality-suite.mjs) — низкоуровневая диагностическая проверка модели, а не главный product acceptance. Он не заменяет canonical one-click endpoint.

## Запросный бюджет и manifest

`scripts/lib/live-qualification-contract.json` задаёт cap `4` и ожидаемые операции. По умолчанию runner сохраняет в `.lct/product-e2e/<timestamp>-<mode>-<random-id>/manifest.json`; `--output-dir` задаёт отдельный пустой каталог:

- semantic calls по `operation`, model alias, timestamp, wall time, finish reason и доступным token usage;
- хеш запроса вместо prompt/context;
- counts profiler/Worker/planning Supervisor/contextual audit/generation и отдельные health/models requests;
- реальные наблюдённые стадии product workflow и времена template analysis, planning, generation, contextual audit и exports;
- hashes входных файлов, число слайдов, audit summary, выбранные экспорты и результат.

Audit provenance в manifest содержит deterministic rule-set version и canonical SHA-256 всех проверенных A/B/C variant reports, а также contextual rule-set/schema versions, версии auditor contract и число ожидаемых/фактических правил. Current contextual schema `contextual_deck_audit_v2` требует ровно 11 правил. Старое persisted audit v1 с 9 правилами не считается свежим и должен быть запущен повторно. Deterministic report вычисляется только из явных `CompiledPresentation`, `ContentIR` и `TemplateIR` inputs; его hash не включает run-specific presentation ID.

Проверка contextual — текстовая и metadata/evidence based. Runner не отправляет preview images и не вызывает VLM; поэтому `visualSemanticFit` не является pixel review и не заменяет PowerPoint visual gate. Контекстная подсказка не может отменить deterministic safety finding и не запускает автоматический rewrite.

Manifest не содержит task/context text, prompt, endpoint URL, API key или Authorization. Fake/full E2E также проверяет image provider как незапущенный: image endpoint не вызывается.

## RunPod и self-hosted startup — отдельная последовательность

RunPod является только одним self-hosted runtime вариантом. Не смешивайте startup модели в container с локальным product runner:

1. Запустить уже настроенный self-hosted container с persistent model volume.
2. В container выполнить `LCT_INFERENCE_OFFLINE_PREFLIGHT=1`; ожидаемые model/revision и exact mount описаны в [startup runbook](./docs/RUNPOD_STARTUP_RUNBOOK.md).
3. Продолжать только при полном snapshot точной revision; затем отдельно запустить vLLM и дождаться model readiness.
4. На локальном компьютере задать `LCT_SEMANTIC_BASE_URL`, `LCT_SEMANTIC_MODEL` и при необходимости secret `LCT_SEMANTIC_API_KEY`.
5. Выполнить runner `--preflight-only`; это models GET без chat completion.
6. После отдельного разрешения выполнить один 3-slide external product E2E с hard cap 4.
7. Если qualification завершена и нет активных запросов, безопасно остановить GPU.

Переход self-hosted/RunPod → VK inference остаётся конфигурационным при совместимом OpenAI-compatible contract. Local model volume относится только к self-hosted container; remote VK endpoint локальное model storage не требует.

## После backend E2E: ручной UI acceptance

1. Запустить `pnpm dev` и открыть приложение.
2. Создать проект и загрузить тот же PPTX.
3. Ввести ту же задачу, оставить source files пустыми.
4. Нажать «Сгенерировать презентацию» и дождаться сохранённого состояния A/B/C.
5. Просмотреть несколько слайдов, выбрать варианты и открыть deterministic/contextual audit.
6. Экспортировать PPTX/PDF/HTML, обновить страницу и проверить восстановление состояния.

Это отдельная ручная проверка интерфейса; backend runner не управляет браузером.

## PowerPoint gate после live run

Откройте `selected.pptx` в PowerPoint: приложение не должно предлагать Repair, все слайды должны открыться, текст и shapes остаются редактируемыми, logo/chrome не смещены и исходный sample text не остался в generated slides. Проверьте очевидный overlap, сохраните Ctrl+S, закройте и откройте файл повторно. Для финальной оценки повторите gate на organizer templates и held-out template. Это ручная проверка; package reopen в runner её не заменяет.
