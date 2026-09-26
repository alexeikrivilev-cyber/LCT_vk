# Диагностика и manifest

Daemon пишет структурированные JSON-события `http.request`, `http.error`, `semantic.request` и `run.manifest`. HTTP-события содержат `requestId`, безопасный `projectId` (если применимо), шаблон маршрута, длительность, HTTP status и error code. Semantic-события содержат роль, операцию, model alias, длительность, `finishReason`, статус и код ошибки. Содержимое запросов/ответов, prompt, исходные документы, credentials и endpoint URL в эти события не записываются.

Разделение probes:

- `/health` и `/api/health` подтверждают, что процесс отвечает.
- `/readiness` и `/api/readiness` проверяют SQLite, доступность записи в обязательные каталоги и инициализацию renderer. Если live semantic endpoint сконфигурирован, readiness делает ограниченный `GET /models`; completion и загрузка модели не выполняются. В fake/local режиме без внешней конфигурации semantic dependency помечена как `not-required`.

После завершения генерации daemon сохраняет runtime `run-manifest.json` в `<LCT_DATA_DIR>/projects/<project-id>/.generation/<generation-id>/` (по умолчанию `.lct/projects/...`). Он содержит версии приложения/Node/workflow/prompt/schema, хеши входов и шаблона, model alias, доступные тайминги, A/B/C selections, сводку audit и метаданные экспортов. Исходные имена и текст, prompt, endpoint, tokens и credentials туда не входят. Manifest обновляется после repair/export; ошибка записи фиксируется событием `run.manifest` и не отменяет уже готовый экспорт.

Offline qualification manifests в `.lct/` дополняют пользовательский manifest сведениями конкретных local runners. Централизованные metrics, tracing backend и удалённая telemetry не реализованы. Перед передачей process logs проверьте их вручную на частный контекст.

Актуальные результаты и ограничения находятся в [READY_FOR_QWEN.md](../READY_FOR_QWEN.md).
