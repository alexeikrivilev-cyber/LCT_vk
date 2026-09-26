# Локальная разработка

Скрипт `scripts/dev.mjs` собирает daemon, ждёт `/api/health` и запускает Next.js web. Fake semantic endpoint запускается отдельной командой `scripts/dev-fake-semantic-endpoint.mjs`. Переменные портов и все остальные параметры описаны в [конфигурационном справочнике](./configuration.md).

Команды из корня:

```powershell
pnpm dlx pnpm@10.33.2 run dev
pnpm dlx pnpm@10.33.2 run dev:fake-inference
```

Откройте два терминала и выполните по одной команде в каждом. Эквивалентный запуск с явно подключённым safe `.env.example` приведён в [quickstart](./quickstart.md). Переменная `LCT_SEMANTIC_BASE_URL` требуется только для операций, вызывающих semantic inference; если она отсутствует, daemon может стартовать, но semantic operation завершится с `INFERENCE_NOT_CONFIGURED`.

Для изолированной проверки без долгоживущих процессов:

```powershell
$templatePath = "C:\\path\\to\\template.pptx" # замените на путь к локальному PPTX
$sourcePath = "C:\\path\\to\\source.md" # замените на путь к локальному Markdown
node --import tsx scripts/run-local-product-smoke.mjs --template $templatePath --source $sourcePath --slides 3
```

Скрипт сам поднимает fake semantic endpoint; подставьте собственный локальный PPTX и безвредный тестовый Markdown. В этой проверке использовались уже имеющиеся локальные файлы из ignored `.lct/`. Fake-only режим не является live-model test. Не помещайте рабочие credentials или пользовательские исходные материалы в тестовые отчёты.
