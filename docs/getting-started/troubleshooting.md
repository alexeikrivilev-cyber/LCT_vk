# Устранение неполадок

| Симптом | Проверка | Возможная причина | Действие |
|---|---|---|---|
| `pnpm` не найден в PowerShell | Установлены ли Node.js/npm; доступен ли launcher `pnpm` | Нет package manager launcher в `PATH` | При наличии npm запустите `npx --yes pnpm@10.33.2`; эта fallback команда в текущем Codex shell не проверена, так как `npx` отсутствует. В этом workspace проверена `pnpm dlx pnpm@10.33.2` |
| `Python 3.12 is unavailable` при открытии PPTX | `py -3.12 --version` или `python3.12 --version`; проверьте `LCT_PYTHON` | Нет подходящего interpreter в автопоиске | Укажите абсолютный путь к Python 3.12 executable в `LCT_PYTHON`; аргументы командной строки в переменную не добавляйте |
| Не удаётся подключиться к приложению | Проверить `http://127.0.0.1:7456/api/health` и порт web `3000` | daemon/web не поднялись или порт занят | Посмотреть вывод терминала `scripts/dev.mjs`; устранить конфликт и перезапустить оба процесса |
| Semantic операция сообщает `INFERENCE_NOT_CONFIGURED` | Наличие fake endpoint на `8787` и `LCT_SEMANTIC_BASE_URL` в daemon process | Daemon запущен без URL или fake server не работает | Запустите fake endpoint и daemon с `.env.example`; проверьте, что порт совпадает |
| Semantic endpoint возвращает timeout, 500/524 или invalid schema | URL/model alias, доступность endpoint, код ответа без вывода ключа | endpoint недоступен либо ответ не соответствует строгой схеме | Не повторяйте live запрос циклически; проверьте конфигурацию, затем повторите одну операцию в локальном fake режиме |
| PPTX отклонён как слишком большой или malformed | Размер входного PPTX; локальный ограниченный upload; сообщения `TEMPLATE_TOO_LARGE`/`INVALID_PPTX` | Лимит template 64 MiB или повреждённый OOXML | Уменьшите файл либо используйте валидный PPTX; не извлекайте архив вручную в общий каталог |
| Unicode/кириллическое имя файла не открывается | Имя и расположение исходника, версия Python и локальный file picker | Ошибка выбранного пути/runtime, а не модельной классификации | Переименовывать файл не требуется по контракту; проверьте абсолютный путь и повторите offline smoke |
| Вариант withheld | Открыть русское сообщение, затем локальные audit/quality findings | Не найден безопасный layout, профиль неоднозначен или композиции недостаточно различны | Выберите другой шаблон/слайдовый план; не включайте withheld artifact в export |
| Preview предупреждает об overflow | Сравнить native PPTX и approximate preview; открыть quality report | Preview renderer приближённо оценивает шрифты и переносы | Treat preview как диагностический ориентир; критичный результат проверить в PowerPoint/LibreOffice вручную |
| PDF export завершился `PDF_EXPORT_UNAVAILABLE` | Ошибка стадий preview/PDF в daemon logs | Внутренняя preview/PDF зависимость упала или не готова | Проверить исходный PPTX и повторить локальный smoke; внешний converter не требуется/не настраивается этим продуктом |
| Self-hosted model startup собирает snapshot заново | `LCT_MODEL_STORAGE_ROOT`, mount, profile и строки `snapshot.*` | Volume не смонтирован, revision отличается или snapshot неполный | Использовать [startup runbook](../RUNPOD_STARTUP_RUNBOOK.md); strict offline preflight выявляет incomplete cache без загрузки |

Не вставляйте в тикеты токены, частные endpoint URL, исходный текст клиента или полный prompt. См. [SECURITY.md](../../SECURITY.md).
