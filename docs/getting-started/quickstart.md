# Быстрый старт

Quickstart запускает веб-интерфейс, daemon и fake semantic endpoint только на loopback. Он не использует Qwen, внешний inference, GPU или учётные данные.

## Требования

- Windows, PowerShell 7, Node.js 24 и Python 3.12. Python используется локальным PPTX inspector; `LCT_PYTHON` можно задать, если автоматический поиск не находит интерпретатор.
- доступный `pnpm` launcher; точная версия CLI вызывается через `pnpm dlx pnpm@10.33.2`.

## Установка и запуск

Из корня репозитория:

```powershell
pnpm dlx pnpm@10.33.2 install --frozen-lockfile
```

Создайте локальный `.env` копированием `.env.example` при необходимости, затем откройте два терминала. В примере зафиксирован release backend `LCT_PPTX_BACKEND=office-kit`; обычный запуск не требует PowerShell override. Backend виден в безопасном диагностическом поле `pptxBackend` ответа `/readiness`.

Терминал 1 — локальные ответы fake endpoint:

```powershell
node --env-file=.env.example scripts/dev-fake-semantic-endpoint.mjs
```

Терминал 2 — daemon и web:

```powershell
node --env-file=.env.example scripts/dev.mjs
```

Откройте `http://127.0.0.1:3000`. Проверка liveness daemon: `http://127.0.0.1:7456/health`; проверка готовности SQLite, каталогов записи и renderer: `http://127.0.0.1:7456/readiness`. Завершите процессы сочетанием `Ctrl+C` в каждом терминале. Fake endpoint не оценивает качество модели и не является production сервисом.

Фактические требования и проверки фиксируются в [TESTING.md](../../TESTING.md). При проблемах со стартом см. [troubleshooting](./troubleshooting.md).
