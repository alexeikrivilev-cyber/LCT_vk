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

Для нового qualification используется один runner: он поднимает тот же daemon и вызывает тот же persisted endpoint `/api/projects/:id/workflow/generate`, что и UI. `--semantic-mode fake` сам запускает локальный fake OpenAI-compatible endpoint; отдельный процесс не нужен. Задача обязательна, `--source` необязателен и может повторяться. Markdown не требуется.

```powershell
pnpm dlx pnpm@10.33.2 exec node --import tsx scripts/run-product-e2e.mjs `
  --semantic-mode fake `
  --template "C:\path\to\VK Tech шаблон.pptx" `
  --task "Подготовить презентацию по задаче и выбранному PPTX-шаблону" `
  --slides 12
```

Runner также принимает `--context`, несколько `--source <path>`, `--provider-label`, `--output-dir` и `--max-semantic-requests` (максимум 4). Он загружает шаблон и optional source files, запускает one-click workflow один раз, опрашивает сохранённое состояние, проверяет A/B/C, оба audit, PPTX/PDF/HTML и сохраняет `manifest.json` вместе с экспортами под ignored `.lct/product-e2e/`. Runner не вызывает напрямую profiler, planning или generation services.

Текущая verified local matrix: 3 organizer templates × A/B/C = **9/9 локально**, а отдельный held-out AIOS template прошёл fake-only E2E. Canonical runner дополнительно прошёл полный one-click E2E на настоящем 54-слайдовом VK Tech шаблоне с запросом 12 слайдов: **87.597 s**, 4 semantic fake calls, A/B/C 36/36, обе проверки и selected/A/B/C PPTX + PDF/HTML reopen. Более раннее измерение 78.645 s предшествует этому более полному canonical runner и не является текущим результатом. Эти результаты не являются live Qwen quality/latency PASS. Подробности: локальный manifest `.lct/product-e2e/20260926203719-fake-1f45fad3/manifest.json`, [CASE_REQUIREMENTS.md](./docs/compliance/CASE_REQUIREMENTS.md) и [RELEASE_READINESS.md](./RELEASE_READINESS.md). `.lct` игнорируется Git.

External mode, preflight и жёсткий request budget описаны в [LIVE_QUALIFICATION.md](./LIVE_QUALIFICATION.md). Не запускайте `--semantic-mode external` без отдельного разрешения на inference.

Команды используют найденный в PowerShell `pnpm` launcher, но для работы закрепляют фактическую версию CLI через `dlx`. В этом shell нет `npx`; в стандартной установке Node/npm возможен `npx` fallback, но он здесь не проверен. Наличие скрипта в документации не равно его результату: актуальный фактический статус — в [READY_FOR_QWEN.md](./docs/READY_FOR_QWEN.md), а benchmark/qualification manifest — в локальном ignored `.lct/`.

## Квалификация входов и шаблонов

Ручной и автоматизированный workflow organizer matrix описан в [CASE_REQUIREMENTS.md](./docs/compliance/CASE_REQUIREMENTS.md). Команды `qualify:case-3x3` и `qualify:unknown-template` остаются специализированными локальными gates; актуальный полный one-click fake path проверяется canonical runner. Текущие offline статусы не следует трактовать как live model acceptance.

В локальном fake endpoint нет Qwen, внешнего вызова, GPU, метрики качества модели или latency прогноза. Реальная Qwen/VK квалификация — отдельный контролируемый шаг и не входит в эти команды.

## Документация

`docs:check` проверяет наличие обязательных файлов и локальных Markdown ссылок. Он не подтверждает фактическую точность технических claims или актуальность внешних требований; эти claims должны ссылаться на код, test, organizer source или официальный model card.
