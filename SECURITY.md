# Безопасность

## Модель угроз и границы

Приложение предназначено для локальной разработки/qualification. Daemon привязывается только к loopback и не реализует пользовательскую аутентификацию. Не публикуйте его порт напрямую в сеть. Multi-user authorization, Internet-facing upload hardening и production tenant isolation не реализованы.

Входные PPTX и content files недоверенные. Upload middleware хранит данные запроса в памяти и ограничивает запрос двумя файлами до 64 MiB каждый. Template inspector/compiler применяет собственные пределы; ContentIR ограничивает количество источников, размер каждого и суммарный извлечённый текст. Это снижает ресурсные риски, но не равно полному ZIP-bomb/OOXML parser hardening или malware scanning. Не загружайте конфиденциальные файлы в endpoint, которому вы не доверяете.

Project/file path разрешаются через bounded project-relative helper; имена файлов и project IDs валидируются. Model output проверяется по строгой runtime schema, ID/reference и bounds до persistence. Это не доказывает семантическую истинность содержимого и не устраняет prompt injection: model-produced paths не должны использоваться как произвольные file destinations.

HTML export экранирует текстовые значения и создаёт ограниченную структуру документа; публичный браузерный security review/XSS pen-test не заявлен. CSV/formula-safe export для spreadsheet не является частью текущего flow.

## Секреты и внешние данные

- `.env.example` содержит только локальные значения. Реальные `LCT_SEMANTIC_API_KEY`, `LCT_IMAGE_API_KEY`, `OPENAI_API_KEY` и self-hosted `HF_TOKEN` подавайте через secret manager/локальное окружение.
- Не добавляйте ключи в image, command line, browser client, fixture, commit или screenshot.
- Настроенный semantic/image endpoint получает отправленную ему часть брифа, evidence или prompt. Проверьте правила обработки данных provider перед отправкой исходников.
- Self-hosted inference storage относится к inference container. Remote endpoint не требует локальных весов.
- Request logs могут иметь локальные diagnostics; пользовательский ответ должен быть очищен от stack trace/filesystem paths. Перед отправкой логов всё равно проверьте, что в них нет content/secrets.

## Сообщение о проблеме

Не публикуйте exploit, credential, реальный endpoint URL или пример с персональными данными в публичном issue. Для приватного сообщения используйте доступный вам приватный канал владельца репозитория; отдельный security email в этом проекте не указан. Удалите секрет из окружения/провайдера и сообщите затронутые компоненты/версию без чувствительных payloads.
