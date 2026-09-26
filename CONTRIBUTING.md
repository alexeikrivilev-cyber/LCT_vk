# Участие в разработке

## Настройка

Следуйте [quickstart](./docs/getting-started/quickstart.md); требуется Node.js 24, Python 3.12 для PPTX inspection и доступный `pnpm` launcher; запускаемый CLI закреплён на 10.33.2. Не коммитьте `.lct/`, credentials или пользовательские презентации.

## Границы реализации

- Сначала переиспользуйте API/зависимость, уже принятую репозиторием; проверьте лицензию, maintenance и совместимость до новой dependency.
- Semantic adapter остаётся provider-neutral. Детерминированный code владеет schema validation, geometry, provenance, persistence и audit.
- Не превращайте шаблон организатора в hardcoded имя/slide index. Не делайте пользовательский OOXML или inference response доверенным.
- Не выдавайте fake-only qualification, approximate preview или один held-out deck за production coverage.
- Prompt/agent/schema изменения версионируйте в отдельных files/config и покрывайте fingerprint/invalidation тестом.

## Перед отправкой изменений

Проверьте тесты, типы, сборку, границы и style gate:

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

Для end-to-end smoke нужны локальный PPTX и тестовый Markdown. Подставьте их пути в PowerShell-переменные и запустите команду из [TESTING.md](./TESTING.md). Скрипт сам использует локальный fake endpoint. Live inference, платный GPU/cloud и удалённый endpoint требуют отдельного bounded plan и явного разрешения владельца задачи; не включайте их в обычный PR gate.

В pull request укажите scope, связанные ADR/требования, команды и их фактический результат, блокеры и не проверенные claims. Не пишите `PASS` по намерению.
