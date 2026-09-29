# Статус release candidate

**Video demo: YES, только по сохранённому E2E ниже.** Полная live acceptance: **BLOCKED**. Запись не должна утверждать, что все проверки прошли или что показан WorkSpace.

## Реальный browser E2E

- Проект: `FINAL_LIVE_TEST`, `d3d1975a-cc28-4c2e-831a-d09eeca49f8b`.
- Фактический шаблон: rehearsal unknown-template `kompaniya-napravleniya-i-klienty.pptx`, SHA-256 `7c34dd3f5b09607a9334b46898d1951b9a4217196109cffcd02e997e0b26414d`; это не WorkSpace.
- Сохранённый план: READY, повторно использован. Генерация: 10 слайдов, A/B/C — 10/10 каждый, 30/30; пара вариантов deck-level различаются. Во время Generate semantic calls и profiler calls — 0. Зафиксированное время Generate — 6.755 s.
- Детерминированный аудит: 0 ошибок, 21 предупреждение (18 `geometry.visual-slot-overlap`, 3 `fidelity.unsupported-specific-claim`).
- Контекстный аудит: один вызов завершился `SERVICE_UNAVAILABLE` через 178.675 s; успешная проверка не подтверждена, повтора нет.
- PPTX: 10 слайдов, редактируемые native text objects, master/theme присутствуют, 0 notes и package errors; PowerPoint/LibreOffice визуальное открытие не проверялось. PDF: 10 страниц. HTML: 10 секций. Источник не изменён.
- Refresh persistence: проект, варианты и записи экспортов восстановились.
- Контактный лист показывает разреженные слайды и не является визуальным PASS: `.lct/final-tz-live-e2e/05aa55f4-35b4-4ce2-95ef-09a476b585e4/visual-review/00-final-live-test-10-слайдов/contact-sheet.png`.

## Текущая интеграция

- Ветка `final-integration`, HEAD `31664cb99e5cd72480a2de81db8157e1b3dd0b2e`, на четыре интеграционных коммита впереди `origin/final-integration` до freeze.
- Четыре предоставленных SHA исходных UI/generation-quality коммитов не являются предками HEAD. Их изменения присутствуют в эквивалентных интеграционных коммитах `e642338`, `0a3d902`, `44cf193`, `31664cb`; patch-id сравнение подтверждает совпадение каждого изменения.
- Offline qualification с текущего HEAD: WorkSpace 10 слайдов PASS, Education 10 PASS, AIOS 6 PASS; локальный VK Tech fallback — `PREVIEW_LAYOUT_BLOCKED`. Fallback не является подтверждённым organizer attachment.
- По attachment inventory точный `VK Tech.pptx` отсутствовал в ожидаемом месте; похожую локальную копию нельзя считать authoritative organizer input. Официальный PDF требует три шаблона, но не даёт надёжного подтверждения имён третьей пары в имеющихся локальных материалах. Не заявлять полную 3-шаблонную organizer matrix.

## UI и запись

- Текущий web UI открыл главную страницу (18 сохранённых проектов) и существующий `FINAL_LIVE_TEST`; русский интерфейс показывает 10 слайдов, варианты A/B/C и три сохранённые ссылки экспорта.
- Изменение состояния live-проекта или повтор semantic-операций не выполнялось.
- В этом спринте требуемые размеры окна 1440×900 и 1366×768 отдельно не измерялись. Не считать responsive review пройденным.
- Пятиминутная инструкция: [FINAL_DEMO_RUNBOOK.md](./docs/runbooks/FINAL_DEMO_RUNBOOK.md). Сценарий показывает только сохранённый результат и явно раскрывает неуспешный contextual audit.

## Проверки

- Полный Node test suite: **357/357 PASS** (pnpm 10.33.2, 69.6 s).
- Web и daemon typecheck: PASS.
- Production build web и daemon: PASS.
- `docs:check`: PASS, 63 обязательных документа и локальные Markdown-ссылки.
- `check:boundary`: PASS. `lint:craft`: PASS. `git diff --check`: PASS; Git сообщил только о нормализации LF/CRLF при следующей записи файлов.
- Специальной команды для hardcode audit в package scripts нет. Поиск имён конкретных шаблонов в selector и preview-layout evidence не нашёл совпадений.
- Browser smoke на текущем UI: главная страница и существующий проект открываются, список показывает 18 проектов, в E2E — 10 слайдов, A/B/C и сохранённые export links. Отдельные размеры 1440×900 и 1366×768 не измерялись.

## Ограничения

1. Contextual audit live не прошёл.
2. Редкие/слабые композиции и PowerPoint visual fidelity не приняты.
3. Точный authoritative VK Tech organizer attachment не подтверждён; локальный fallback заблокирован preview gate.
4. Настоящие Qwen latency/quality и VK endpoint integration не считать полностью квалифицированными.
5. Никаких новых Qwen/RunPod запросов в final sprint не выполнялось; для записи использовать только сохранённый проект и экспорт.
