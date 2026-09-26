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

Продуктовый fake-only smoke требует два локальных входа: PPTX и Markdown с тестовым содержимым. Скрипт сам поднимает локальный fake semantic endpoint; отдельный endpoint для этой команды запускать не нужно.

```powershell
$templatePath = "C:\\path\\to\\template.pptx" # замените на путь к локальному PPTX
$sourcePath = "C:\\path\\to\\source.md" # замените на путь к локальному Markdown
node --import tsx scripts/run-local-product-smoke.mjs --template $templatePath --source $sourcePath --slides 3
```

В документационном проходе эта команда была выполнена с локальным VK Tech PPTX и Markdown из ignored `.lct/`; путь к ним не является частью репозитория. Скрипт проверяет продуктовый поток, но результат на одном шаблоне не подтверждает универсальную совместимость.

Команды используют найденный в PowerShell `pnpm` launcher, но для работы закрепляют фактическую версию CLI через `dlx`. В этом shell нет `npx`; в стандартной установке Node/npm возможен `npx` fallback, но он здесь не проверен. Наличие скрипта в документации не равно его результату: актуальный фактический статус — в [READY_FOR_QWEN.md](./docs/READY_FOR_QWEN.md), а benchmark/qualification manifest — в локальном ignored `.lct/`.

## Квалификация входов и шаблонов

Ручной и автоматизированный workflow организаторской матрицы описан в [CASE_REQUIREMENTS.md](./docs/compliance/CASE_REQUIREMENTS.md). Команды `qualify:case-3x3` и `qualify:unknown-template` требуют caller-supplied real PPTX/content/state; они не загружают данные организатора из сети и не используют live inference при параметре `--fake-semantic`. Нынешняя case qualification — BLOCKED: результаты 6/9 и остановка held-out generation нельзя выдавать за успешную сдачу.

В локальном fake endpoint нет Qwen, внешнего вызова, GPU, метрики качества модели или latency прогноза. Реальная Qwen/VK квалификация — отдельный контролируемый шаг и не входит в эти команды.

## Документация

`docs:check` проверяет наличие обязательных файлов и локальных Markdown ссылок. Он не подтверждает фактическую точность технических claims или актуальность внешних требований; эти claims должны ссылаться на код, test, organizer source или официальный model card.
