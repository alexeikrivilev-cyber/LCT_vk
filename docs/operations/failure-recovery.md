# Сохранение состояния и восстановление

`LCT_DATA_DIR` (по умолчанию `.lct/`) содержит `app.sqlite` и каталоги проектов. Для проекта используются:

- исходные файлы в `<LCT_DATA_DIR>/projects/<id>/`;
- результат анализа шаблона в `.template-compiler/state.json`;
- semantic profile cache в `.template-compiler/semantic-profiles/<template-hash>.json`;
- бриф, ContentIR, checkpoints и planning snapshot в `.planning/state.json`;
- previews, временные PPTX и exports в `.generation/<generation-id>/`;
- ограниченный по полям `run-manifest.json` рядом с результатами generation.

Исходный шаблон читается без изменения байтов и проверяется по hash до/после компиляции. Preview и profile cache воспроизводимы и не считаются backup. Штатное удаление проекта сначала блокирует новые project requests, отменяет planning/generation и ждёт до 5 секунд окончания generation, repair и export. При таймауте API возвращает `503` и оставляет проект на месте; повторите удаление после завершения операций.

Daemon shutdown закрывает HTTP listener, отправляет cancellation активному planning/generation и выполняет bounded drain до 5 секунд, сохраняя текущий generation cursor. Если процесс завершится, пока renderer ещё работает, recovery переводит `rendering` slide обратно в `pending` и продолжает generation после старта. Незавершённый planning state распознаётся при следующем чтении как `GENERATION_INTERRUPTED`; успешный предыдущий plan остаётся доступен.

Проверяйте `/health` для процесса и `/readiness` для локальных зависимостей. Перед экспериментом с изменённой базой сохраните отдельную копию data root. Не удаляйте вручную неизвестные подкаталоги проекта: используйте daemon API.

Эти механизмы не дают disaster recovery, backup retention или cross-host replication.
