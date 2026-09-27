# Ограниченная live qualification

**ТЕКУЩИЙ СТАТУС (2026-09-27):** профиль-before-Generate fake lifecycle прошёл WorkSpace (3 output slides), VK Tech (12) и VK Education (3): у всех A/B/C готовы, audit/export PASS, исходный PPTX не изменён. AIOS остаётся отдельным held-out robustness blocker (`VARIANTS_NOT_DISTINCT`), но не является абсолютным stop-критерием для WorkSpace live qualification. Предыдущий 90-секундный timeout подтверждён как client-side: RunPod logs показывали Running (~28.4 tok/s, KV cache ~4%, Waiting=0), без provider 5xx. После расширения batch schema под точные hash/slide/element IDs и добавления safe diagnostics один свежий WorkSpace run остановился на batch 1: HTTP 200, `finish_reason=stop`, 106,640 ms, 4,661 prompt / 3,014 completion tokens, runtime failure `DUPLICATE_ELEMENT_ROLE`. Параллельный batch 2 отменён, остальные batches не запускались; профиль не стал READY, Generate не запускался. Serving runtime не менялся. Больше live-запросов после этого failure не выполнялись.

Profiler batching доходит до провайдера только после планирования всех локальных batches и проверяет каждый ответ до merge. Не повторяйте автоматически ни один live run после отказа.

## Единый product path и режимы

Canonical runner: [`scripts/run-product-e2e.mjs`](./scripts/run-product-e2e.mjs). Fake и external режимы создают один daemon, оборачивают adapter для учёта бюджета и запускают тот же persisted `/api/projects/:id/workflow/generate`, который вызывает UI. Runner не подменяет product workflow прямыми вызовами profiler/planner/generator. `--provider-label runpod|vk` записывается только в manifest и не меняет транспорт или product behavior.

- `--semantic-mode fake`: runner сам поднимает локальный deterministic OpenAI-compatible fake. Сеть внешнего inference не используется.
- `--semantic-mode external`: используется production `OpenAICompatibleSemanticInferenceAdapter`, настроенный через environment. Runner не поднимает model server.
- Нормальный путь в обоих режимах сначала подготавливает и сохраняет `TemplateSemanticProfile`, затем запускает one-click workflow. Generate делает только cache read и не вызывает profiler. Core cap `3` (deck-plan=1, plan-review=1, contextual-deck-audit=1; generation inference=0); profile preparation cap `14`; full workflow cap `17`. Profiler calls during Generate = `0`; retry = 0.
- `--enable-template-profiler` оставлен для совместимости CLI; profile preparation является частью normal flow. AIOS `VARIANTS_NOT_DISTINCT` остаётся held-out robustness blocker, но не запрещает ограниченный WorkSpace live run после локальных gate.

## Ограниченная WorkSpace live qualification (Windows PowerShell)

Выполнять только после отдельного разрешения на внешний inference. RunPod resource этим pass не создавался. Для консоли следуйте [startup runbook](./docs/RUNPOD_STARTUP_RUNBOOK.md): self-hosted profile `A100_BF16`, persistent volume смонтирован до старта, `LCT_MODEL_STORAGE_ROOT=/workspace/lct-models`, сначала `LCT_INFERENCE_OFFLINE_PREFLIGHT=1`. Только после exit `0` и полного exact snapshot PASS отключите offline-preflight env в настройках контейнера и перезапустите serving container. Затем container-local:

```bash
curl --fail --silent http://127.0.0.1:8080/health
curl --fail --silent http://127.0.0.1:8080/v1/models
```

В репозитории нет закреплённого registry image tag. В RunPod console выберите уже выпущенный immutable tag и проверьте, что он содержит current runtime/preflight fix; tag не следует выводить из старой команды или подставлять `latest`.

В локальном PowerShell из корня репозитория:

```powershell
$Repo = (git rev-parse --show-toplevel).Trim()
Set-Location $Repo
$WorkspaceTemplate = Join-Path $env:USERPROFILE 'Downloads\VK_WorkSpace_Клиентская_конференция_Шаблон_03.pptx'
$VkTechTemplate = Join-Path $env:USERPROFILE 'Downloads\VK Tech шаблон.pptx'
if (-not (Test-Path -LiteralPath $VkTechTemplate)) {
  $VkTechTemplate = Join-Path $Repo '.lct\product-e2e\final-offline-acceptance-vktech-twelve-2026-09-27\runtime-data\projects\e2e-2c00c78c6bb649f8bcd02f53\VK Tech шаблон.pptx'
}
$Task = 'Создай презентацию о платформе интеллектуальных ассистентов для корпоративной поддержки. Покажи проблему, решение, принцип работы, преимущества, сценарии использования, безопасность, эффект для бизнеса и следующий шаг.'
$ExpectedWorkspaceHash = '1b8883114486c69dff706e9c4fd9382727c4506c2cfa3ec34f86987f1e852f2f'
$ExpectedVkTechHash = 'cbbe3aa6a21d23cebc4d1383b93dd07a9cea460d683de1903567b616c839485d'
if (-not (Test-Path -LiteralPath $WorkspaceTemplate)) { throw 'WorkSpace PPTX is missing.' }
if (-not (Test-Path -LiteralPath $VkTechTemplate)) { throw 'VK Tech PPTX is missing; restore the organizer source before the 12-slide run.' }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $WorkspaceTemplate).Hash.ToLowerInvariant() -ne $ExpectedWorkspaceHash) { throw 'WorkSpace template hash mismatch.' }
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $VkTechTemplate).Hash.ToLowerInvariant() -ne $ExpectedVkTechHash) { throw 'VK Tech template hash mismatch.' }
$env:LCT_SEMANTIC_BASE_URL = Read-Host 'OpenAI-compatible endpoint base URL ending in /v1'
$env:LCT_SEMANTIC_MODEL = 'Qwen/Qwen3.8-27B'
$env:LCT_SEMANTIC_ENABLE_THINKING = 'false'
$env:LCT_TEMPLATE_PROFILE_CONCURRENCY = '2'
$env:LCT_PPTX_BACKEND = 'office-kit'
# If the endpoint requires a key, load LCT_SEMANTIC_API_KEY from the local secret store for this process only.

# Dry run: validates inputs/config; it starts no daemon and sends no network request.
pnpm dlx pnpm@10.33.2 exec node --import tsx scripts/run-product-e2e.mjs `
  --semantic-mode external --provider-label runpod `
  --template $WorkspaceTemplate --task $Task --slides 3 --dry-run
if ($LASTEXITCODE -ne 0) { throw 'External dry-run failed; stop here.' }

# Endpoint preflight: one GET /v1/models, zero chat completions. Stop on failure; do not retry.
pnpm dlx pnpm@10.33.2 exec node --import tsx scripts/run-product-e2e.mjs `
  --semantic-mode external --provider-label runpod `
  --template $WorkspaceTemplate --task $Task --slides 3 --preflight-only
if ($LASTEXITCODE -ne 0) { throw 'Models preflight failed; do not start product qualification.' }

# One canonical 3-slide WorkSpace run: profile prep cap 14, core cap 3, full workflow cap 17; profiler calls during Generate = 0.
pnpm dlx pnpm@10.33.2 exec node --import tsx scripts/run-product-e2e.mjs `
  --semantic-mode external --provider-label runpod `
  --template $WorkspaceTemplate --task $Task --slides 3
if ($LASTEXITCODE -ne 0) { throw '3-slide live qualification failed; stop without retry.' }

# Run only after the first test passes the schema, quality, audit, export, and Office checks below.
pnpm dlx pnpm@10.33.2 exec node --import tsx scripts/run-product-e2e.mjs `
  --semantic-mode external --provider-label runpod `
  --template $VkTechTemplate --task $Task --slides 12
if ($LASTEXITCODE -ne 0) { throw '12-slide live qualification failed; stop without retry.' }
```

Не печатайте и не записывайте API key или частный endpoint в отчёт/manifest. Если endpoint требует auth, загрузите `LCT_SEMANTIC_API_KEY` из локального secret store в текущий process environment перед командами. Не сохраняйте ключ в `.env.example`, docs или PowerShell script.

### Live evaluation checklist

- **План:** разные цели слайдов; неповторяющиеся выводы; связное развитие истории; запрошенное число слайдов; осмысленные visual types.
- **Текст:** короткие выводящие заголовки; презентационные формулировки; нет эха промпта; нет выдуманных неподтверждённых фактов.
- **Композиция:** нет overlap или очевидного overflow; нет бессмысленных пустых зон; плотность читаема.
- **A/B/C:** композиции действительно различаются, используют одинаковые подтверждённые факты и соответствуют шаблону.
- **Audit:** contextual findings полезны, evidence references относятся к реальным source/slide; deterministic audit не пропускает блокирующие ошибки.
- **Время:** записать semantic, deterministic и total elapsed отдельно; 10–12-slide live target — менее 300 s, измерение fake сюда не засчитывается.
- **PowerPoint:** открыть без Repair/Recover; проверить редактируемый текст/фигуры и branding; сохранить, закрыть, открыть повторно.

**Abort:** нет matching model в `/v1/models`, timeout/5xx/524, `finish_reason=length`, пустой или schema-invalid ответ, withheld A/B/C, deterministic audit error или export/reopen failure. Не повторять автоматически; сохранить manifest с failure. Второй 12-slide run запускать только после полного PASS первого теста, включая ручную Office проверку.

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
  --slides 3
```

Для текущего profiler protocol каждый batch содержит не более 4 slides и 24 KiB evidence; WorkSpace profile preparation ограничена 14 batches, request timeout — 180000 ms. На этот qualification run задаётся `LCT_TEMPLATE_PROFILE_CONCURRENCY=2` через уже существующий configuration path (допустимые значения 1–2); это не provider-specific application behavior. `maxOutputTokens` остаётся до 4096, `thinking=false`, strict JSON Schema, retries=0.

Нормальный run отправляет до 14 profile batch requests во время подготовки шаблона (profile preparation cap `14`), затем до трёх core requests: по одному deck-plan, plan-review и contextual-deck-audit (core cap `3`; generation inference `0`). Полный предел подготовки и Generate — `17` (full workflow cap `17`). profiler calls during Generate = `0`. Каждый batch фиксирует source slide indexes, размер evidence в bytes, `maxOutputTokens`, HTTP status, latency, token usage при наличии, `finish_reason`, JSON Schema и runtime-validation outcome. Timeout, 5xx/524, усечение, невалидный JSON/schema или runtime validation failure останавливают run без retry.

Число downstream calls не зависит от числа output slides. Profile batching, byte/slide bounds, total budget и fake one-click flow покрыты regression tests.

### 3. Измерение рабочего объёма

Только после PASS дешёвого smoke и отдельного разрешения:

```powershell
pnpm dlx pnpm@10.33.2 exec node --import tsx scripts/run-product-e2e.mjs `
  --semantic-mode external `
  --provider-label runpod `
  --template "C:\path\to\same-template.pptx" `
  --task "Подготовить презентацию по предоставленной задаче" `
  --slides 12
```

Фиксируйте полный elapsed time и отдельно `semanticTotalMs`/`deterministicTotalMs`. Пять минут для live Qwen/VK не считаются выполненными до измеренного product run.

Старый [`scripts/run-live-quality-suite.mjs`](./scripts/run-live-quality-suite.mjs) — низкоуровневая диагностическая проверка модели, а не главный product acceptance. Он не заменяет canonical one-click endpoint.

## Запросный бюджет и manifest

[`scripts/lib/live-qualification-contract.json`](./scripts/lib/live-qualification-contract.json) задаёт core cap `3`, profile preparation cap `14` и full workflow cap `17`. Совместимое поле `profilerDiagnosticMaxSemanticRequests` — alias full workflow cap, а `maxProfilerRequests` — alias profile preparation cap. По умолчанию runner сохраняет в `.lct/product-e2e/<timestamp>-<mode>-<random-id>/manifest.json`; `--output-dir` задаёт отдельный пустой каталог:

- semantic calls по `operation`, model alias, batch number/source indexes, HTTP status, timestamp, wall time, strict schema/runtime validation, finish reason и доступным token usage;
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
6. После PASS WorkSpace, VK Tech и VK Education fake lifecycle и локальных gates выполнить одну WorkSpace template preparation, затем один Generate; core cap — 3, profile preparation cap — 14, full workflow cap — 17, profiler calls during Generate = 0. AIOS held-out `VARIANTS_NOT_DISTINCT` фиксируется отдельно и не блокирует этот ограниченный WorkSpace run.
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
