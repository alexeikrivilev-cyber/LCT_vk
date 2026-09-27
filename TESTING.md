# Проверки и локальная квалификация

## Базовые gates

Из корня репозитория, Node.js 24 и pnpm 10.33.2:

```powershell
pnpm dlx pnpm@10.33.2 install --frozen-lockfile
pnpm dlx pnpm@10.33.2 test
pnpm dlx pnpm@10.33.2 typecheck
pnpm dlx pnpm@10.33.2 build
pnpm dlx pnpm@10.33.2 check:boundary
pnpm dlx pnpm@10.33.2 lint:craft
pnpm dlx pnpm@10.33.2 docs:check
git diff --check
```

## Canonical one-click product E2E

Release/qualification backend — **Office Kit**. `parsePptxBackend` по умолчанию выбирает `office-kit`; тот же выбор закреплён в `.env.example` и quickstart. Canonical runner не задаёт backend принудительно: он проверяет `pptxBackend` в readiness и persisted generation, записывает backend в `manifest.json` и завершает run ошибкой при drift. `custom` остаётся доступным только как явно заданный legacy/diagnostic/experimental backend.

Для нового qualification используется один runner: он поднимает тот же daemon и вызывает тот же persisted endpoint `/api/projects/:id/workflow/generate`, что и UI. `--semantic-mode fake` сам запускает локальный fake OpenAI-compatible endpoint; отдельный процесс не нужен. Задача обязательна, `--source` необязателен и может повторяться. Markdown не требуется.

```powershell
pnpm dlx pnpm@10.33.2 exec node --import tsx scripts/run-product-e2e.mjs `
  --semantic-mode fake `
  --template "C:\path\to\VK Tech шаблон.pptx" `
  --task "Подготовить презентацию по задаче и выбранному PPTX-шаблону" `
  --slides 12
```

Runner также принимает `--context`, несколько `--source <path>`, `--provider-label`, `--output-dir` и `--max-semantic-requests` (жёсткий максимум 16). Один логический Template Profiler stage делит исходные слайды на последовательные batches: не более 6 слайдов и 24 KiB evidence на batch, не более 13 provider calls; deck plan, plan review и contextual audit — максимум по одному; generation inference — 0. Runner запускает one-click workflow один раз, опрашивает сохранённое состояние, проверяет A/B/C, оба audit, PPTX/PDF/HTML и сохраняет `manifest.json` вместе с экспортами под ignored `.lct/product-e2e/`. Для каждого semantic вызова manifest содержит batch indexes, output budget, HTTP status, latency, token usage, finish reason и результат runtime validation; prompt/context не сохраняются. Runner не вызывает напрямую profiler, planning или generation services.

Текущая verified local matrix: 3 organizer templates × A/B/C = **9/9 локально**, а отдельный held-out AIOS template прошёл fake-only E2E. Самый свежий canonical one-click E2E на 54-слайдовом VK Tech шаблоне с запросом 12 слайдов: **95.753 s**, 4 semantic fake calls, A/B/C 36/36, оба audit и selected/A/B/C PPTX + PDF/HTML structural reopen. Предыдущие 87.597 s и 78.645 s superseded. Эти результаты не являются live Qwen quality/latency PASS. Точные текущие manifests и пределы результатов указаны в [RELEASE_READINESS.md](./RELEASE_READINESS.md); `.lct` игнорируется Git.

Последний offline acceptance (2026-09-27) повторил exact WorkSpace task на 5 слайдах без sources/context и без backend override: Office Kit, 15/15 вариантов, deterministic PASS, contextual audit 11/11, ровно 4 fake calls, selected/A/B/C PPTX reopen и PDF/HTML validation, **36.954 s**. Canonical VK Tech 12-slide повтор прошёл за **95.753 s**, 36/36 вариантов и те же 4 requests / 11 audit rules. Кнопка one-click блокируется во время загрузки исходников; regression проверяет, что workflow не стартует с неполным списком выбранных файлов. Точные SHA, статусы и ignored manifests находятся в `RELEASE_READINESS.md` и `.lct/product-e2e/final-offline-acceptance-*/manifest.json`. Это local fake evidence; реальная model quality/latency остаётся неизвестной.

External mode, preflight и жёсткий request budget описаны в [LIVE_QUALIFICATION.md](./LIVE_QUALIFICATION.md). Не запускайте `--semantic-mode external` без отдельного разрешения на inference.

Команды используют найденный в PowerShell `pnpm` launcher, но для работы закрепляют фактическую версию CLI через `dlx`. В этом shell нет `npx`; в стандартной установке Node/npm возможен `npx` fallback, но он здесь не проверен. Наличие скрипта в документации не равно его результату: актуальный фактический статус — в [READY_FOR_QWEN.md](./docs/READY_FOR_QWEN.md), а benchmark/qualification manifest — в локальном ignored `.lct/`.

## Квалификация входов и шаблонов

Ручной и автоматизированный workflow organizer matrix описан в [CASE_REQUIREMENTS.md](./docs/compliance/CASE_REQUIREMENTS.md). Команды `qualify:case-3x3` и `qualify:unknown-template` остаются специализированными локальными gates; актуальный полный one-click fake path проверяется canonical runner. Текущие offline статусы не следует трактовать как live model acceptance.

В локальном fake endpoint нет Qwen, внешнего вызова, GPU, метрики качества модели или latency прогноза. Реальная Qwen/VK квалификация — отдельный контролируемый шаг и не входит в эти команды.

## Документация

`docs:check` проверяет наличие обязательных файлов и локальных Markdown ссылок. Он не подтверждает фактическую точность технических claims или актуальность внешних требований; эти claims должны ссылаться на код, test, organizer source или официальный model card.
