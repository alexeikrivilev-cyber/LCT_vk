# LCT Presentation Compiler

LCT принимает PPTX-шаблон и задачу, использует необязательные контекст и исходные материалы, строит план презентации, подбирает безопасные композиции и собирает презентацию с редактируемыми объектами. Это компилятор презентаций, а не редактор слайдов.

Основной путь в приложении — кнопка «Сгенерировать презентацию»: анализ шаблона, планирование, варианты A/B/C и обе проверки выполняются одним сохраняемым действием. Контекст и файлы можно не добавлять; результат и стадия восстанавливаются после обновления страницы.

## Возможности

- Структурный анализ PPTX: слайды, макеты, образцы, часть темы и геометрии.
- Чтение TXT, Markdown, CSV/TSV и JSON; изображения сохраняются как вложения/ссылки, неподдерживаемые файлы не считаются разобранным текстом.
- Семантическое планирование через настраиваемый OpenAI-compatible endpoint со строгой проверкой схемы.
- Три варианта A/B/C для каждого слайда из одного плана.
- Детерминированная проверка, ограниченная локальная починка и экспорт в PPTX, PDF или HTML.

Полная совместимость с произвольными PPTX и визуальная точность PowerPoint не заявлены. PDF использует растровое приблизительное превью; HTML — отдельный формат просмотра. Fake-only product qualification подтвердила VK Tech (12 слайдов), WorkSpace, Education и held-out AIOS (по 3 слайда): для каждого reopened selected/A/B/C PPTX; для VK Tech также проверены PDF/HTML и 12 страниц/слайдов. Один deck-level contextual audit использует один fake semantic request. 12-слайдовый flow занял 78.5 s с аудитом и экспортами. Это подготовка к ограниченной live qualification, а не доказательство качества Qwen/VK. Подробности: [статус готовности](./docs/READY_FOR_QWEN.md).

## Архитектура в двух словах

```mermaid
flowchart LR
  U[Пользователь] --> W[Веб-приложение]
  W --> D[Локальный daemon]
  D --> P[Проект и файлы]
  D --> A[Provider-neutral semantic adapter]
  A --> S[Настроенный inference endpoint]
  D --> X[PPTX / PDF / HTML]
```

Подробно: [архитектура](./ARCHITECTURE.md).

## Быстрый локальный запуск

Требуются Node.js 24 и Python 3.12 для структурного инспектора PPTX. Команды проверены на Windows в локальном режиме. Из корня репозитория:

```powershell
pnpm dlx pnpm@10.33.2 install --frozen-lockfile
```

Откройте два терминала. В первом запустите локальный fake endpoint, во втором — веб-приложение и daemon. Файл .env.example содержит только loopback-настройки и не содержит секретов.

```powershell
node --env-file=.env.example scripts/dev-fake-semantic-endpoint.mjs
```

```powershell
node --env-file=.env.example scripts/dev.mjs
```

Откройте http://127.0.0.1:3000. Остановка обоих процессов — Ctrl+C. Пошаговая инструкция: [быстрый старт](./docs/getting-started/quickstart.md).

## Offline demo и live inference

Fake endpoint отвечает локально и детерминированно; он не является моделью и не подтверждает качество Qwen. Для live inference приложение использует один настраиваемый OpenAI-compatible endpoint. Доменный код не зависит от RunPod, Cloud.ru или VK. Подробности и границы совместимости: [INFERENCE.md](./INFERENCE.md).

## Форматы и экспорт

Поддерживаемые входы и гарантии форматов перечислены в [руководстве продукта](./docs/product/guide.md). PPTX — основной редактируемый результат. PDF и HTML проходят структурные проверки, но не являются точной визуальной копией PowerPoint.

## Проверки

```powershell
pnpm dlx pnpm@10.33.2 test
pnpm dlx pnpm@10.33.2 typecheck
pnpm dlx pnpm@10.33.2 build
pnpm dlx pnpm@10.33.2 check:boundary
pnpm dlx pnpm@10.33.2 lint:craft
pnpm dlx pnpm@10.33.2 docs:check
git diff --check
```

Подробности: [TESTING.md](./TESTING.md). Полная карта: [docs/index.md](./docs/index.md).

## Ограничения

Статус этого этапа — `PRODUCT_READY_FOR_LIVE`: локальный one-click fake flow, held-out шаблон, track exports, deterministic/contextual audit и автоматические gates прошли. Настоящие Qwen/VK качество, latency и endpoint integration ещё не проверены; визуальный просмотр в PowerPoint/LibreOffice также не выполнялся. Сводный отчёт: [RELEASE_READINESS.md](./RELEASE_READINESS.md).

## Материалы release acceptance

Текущая оценка приёмки: [RELEASE_READINESS.md](./RELEASE_READINESS.md). Сведения о версии и незавершённом candidate: [RELEASE_NOTES.md](./RELEASE_NOTES.md); порядок демонстрации и тезисы: [runbook](./docs/DEMO_RUNBOOK.md), [pitch outline](./docs/PITCH_OUTLINE.md).

## Лицензия

Код репозитория распространяется по Apache-2.0; лицензии model weights указаны отдельно в [MODELS.md](./MODELS.md).
