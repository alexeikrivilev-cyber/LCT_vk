# Архитектура

Это карта текущей реализации. Целевые и непроверенные возможности помечены явно.

## Контекст

```mermaid
flowchart LR
  User[Пользователь] --> Web[apps/web]
  Web -->|HTTP API и опрос состояния| Daemon[apps/daemon]
  Daemon --> Store[(SQLite и проектные файлы)]
  Daemon --> Adapter[SemanticInferenceAdapter]
  Adapter --> Endpoint[Настроенный OpenAI-compatible endpoint]
  Endpoint -. локальный offline .-> Fake[Fake endpoint]
  Endpoint -. self-hosted вариант .-> Qwen[Qwen inference container]
  Endpoint -. целевой, не квалифицирован .-> VK[VK inference endpoint]
```

Веб-приложение отображает состояние и передаёт действия. Daemon владеет workflow, проектным состоянием, инспекцией, компиляцией, проверками, восстановлением и экспортом. Inference endpoint — отдельная зависимость, не application/domain процесс.

## Компоненты

```mermaid
flowchart TB
  UI[Рабочее пространство] --> API[Daemon REST API]
  subgraph D[Один daemon process]
    API --> Project[Проект и файлы]
    API --> Template[Template Compiler]
    API --> Content[ContentIR compiler]
    API --> Planning[Planning Service]
    API --> Generation[Generation Service]
    Generation --> Compile[Детерминированная A/B/C компиляция]
    Compile --> Audit[Safety audit и quality report]
    Audit --> Export[PPTX / PDF / HTML]
  end
  Planning --> Adapter[SemanticInferenceAdapter]
  Template -. необязательная разметка .-> Adapter
  Adapter --> Endpoint[Один semantic endpoint]
```

Worker и Supervisor — разные роли запросов к одному endpoint, не отдельные модели или процессы. Functional modules внутри daemon не означают отдельные сервисы.

## Поток

```mermaid
flowchart LR
  T[PPTX] --> TI[Детерминированная инспекция: TemplateIR / PDS]
  T --> SP[Опциональный Template Semantic Profile]
  C[Исходные материалы] --> CI[ContentIR]
  B[Бриф] --> W[Worker: план]
  TI --> W
  SP --> W
  CI --> W
  W --> DP[Валидированный DeckPlan]
  DP --> S[Supervisor: bounded review]
  S --> G[A/B/C компиляция из общего плана]
  TI --> G
  CI --> G
  G --> R[Native-object renderer]
  R --> A[Детерминированный audit]
  A --> E[PPTX / PDF / HTML]
```

Semantic решение может сформировать план или оценку роли шаблонного слайда. Код проверяет ID, схему, источники и лимиты; владеет геометрией, объектами PowerPoint, очередью, locks, persistence, ремонтом, аудитом и экспортом. Модельный вывод не меняет PPTX или state до runtime validation.

## Состояние, хранение и кэш

LCT_DATA_DIR задаёт data root и по умолчанию указывает на .lct. SQLite хранит project/generation metadata; проектные файлы — исходные и созданные артефакты. В проекте используются .template-compiler/state.json, .template-compiler/semantic-profiles/, .planning/state.json и .generation/. Исходный PPTX не изменяется.

Кэш TemplateIR привязан к hash источника. Semantic profile cache теперь привязан к hash TemplateIR и fingerprints версии/содержимого prompt/config; смена prompt создаёт новый cache entry. Worker/Supervisor planning fingerprint включает prompt hashes и workflow contract. Клиент восстанавливает состояние из daemon snapshots и опрашивает API во время generation; SSE/WebSocket нет. Restart recovery покрыт offline tests.

## Отказы и безопасность границ

- Daemon может стартовать без semantic endpoint; операция, которой нужен inference, вернёт ошибку конфигурации.
- Timeout, malformed output и schema violation прекращают операцию; непроверенный ответ не применяется.
- Небезопасный вариант может быть withheld.
- Отмена запроса к HTTP endpoint не гарантирует отмену вычислений на GPU.
- Выбранный inference endpoint получает отправленные ему бриф, source evidence или TemplateIR evidence; выбирайте endpoint с подходящими условиями обработки данных.
- Daemon привязан к loopback и не имеет аутентификации. Сетевое/публичное развёртывание не поддерживается.
- Upload ограничен двумя файлами по 64 MiB на один запрос. Антивирусный и подтверждённый zip-bomb gate не реализован.

Независимый source of truth по аудитам: [AUDIT.md](./AUDIT.md); полный список security controls и gaps: [SECURITY.md](./SECURITY.md). Реальные qualification blockers: [docs/READY_FOR_QWEN.md](./docs/READY_FOR_QWEN.md).
