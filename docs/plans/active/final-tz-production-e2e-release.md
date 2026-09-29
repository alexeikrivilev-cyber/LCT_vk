# Финальная квалификация production E2E

## Активная цель

Завершить Phase A на существующем браузерном проекте `d3d1975a-cc28-4c2e-831a-d09eeca49f8b`: live plan → A/B/C generation → audits → PPTX/PDF/HTML → structural validation → refresh persistence. Не создавать проект заново и не запускать профилирование.

## Рабочая копия

- Канонический путь: `C:\Projects\GitHub\LCT_vk`
- Ветка: `final-integration`
- HEAD на начало этого продолжения: `68978ac3070894c9d12cdbc0ef1d7697b6df4eac`
- Существующие изменения до этого продолжения: planning fix для объединения fit repair и Supervisor local-replan; regression test; `apps/web/next-env.d.ts` (не менять без необходимости).
- Generation-quality и UI commits не интегрировать до первого реального PPTX.

## Существующий проект и входы

- Проект открыт в браузере: `http://127.0.0.1:3000/project/d3d1975a-cc28-4c2e-831a-d09eeca49f8b`.
- Шаблон: `kompaniya-napravleniya-i-klienty.pptx`.
- Существующий подготовленный semantic profile: READY/degraded-ready; повторное профилирование запрещено.
- Бриф на 10 слайдов уже сохранён.
- Daemon перед этим был перезапущен пользователем из secret-bearing shell; ключ не запрашивался и не читался.

## Фактический прогресс и blocker

- `/health` и `/readiness`: HTTP 200.
- Первый отдельный browser planning submit закончился `GENERATION_INTERRUPTED`; плана и checkpoint нет. Повторной отправки в рамках этого submit не делали.
- Один последующий browser one-click workflow был запущен и корректно сохранял async stage `planning`.
- Workflow завершился `DEADLINE_EXCEEDED` ровно через 300 секунд (`2026-09-29T11:46:24Z` → `2026-09-29T11:51:24Z`). План/checkpoint не сохранён. Ошибка согласуется с общим жёстким planning deadline; HTTP provider response, finish reason и token usage при timeout отсутствуют. Дополнительный inference/retry после этого не выполнялся.
- До успеха одного real PPTX никакие UI/generation-quality commits не интегрировать.

## Ограниченный fix

Общий planning timeout сделать отдельно конфигурируемым через `LCT_PLANNING_TIMEOUT_MS`, по умолчанию 300000 ms и с жёстким максимумом 900000 ms. На следующем квалификационном старте выставить 900000 ms; `LCT_SEMANTIC_REQUEST_TIMEOUT_MS` оставить 300000 ms и `LCT_SEMANTIC_READINESS_TIMEOUT_MS` 120000 ms. Это даёт одной planning attempt ограниченный budget на три последовательных вызова, не меняя per-request timeout.

Локально реализовано: daemon валидирует переменную при старте; все semantic calls одной attempt получают один bounded absolute deadline. Проверки: planning API `12/12`, полный suite `349/349`, frozen install, web/daemon typecheck, production build, `docs:check`, `check:boundary`, `lint:craft`, `git diff --check` — PASS. Первый параллельный boundary scan пересёкся с Next build и попал на временно отсутствующий `.next/required-server-files.js`; повтор после окончания build прошёл. Прямой системный `pnpm` оказался версии 11 и отказал по engine constraint; команды выполнены через `pnpm dlx pnpm@10.33.2`.

Повторная проверка runtime: daemon всё ещё PID `22944`, стартовал до deadline fix; `/health=200`, `/readiness=200`, semantic endpoint `reachable`. Существующие planning/workflow записи остаются terminal `DEADLINE_EXCEEDED`, без плана; template profile всё ещё cached `degraded-ready`. Нового inference не отправлено.

## Следующий шаг

1. Пользователь перезапускает тот же daemon из исходного secret-bearing shell с дополнительным `LCT_PLANNING_TIMEOUT_MS=900000`, сохраняя остальные настройки. Не читать environment или ключ.
3. Проверить health/readiness, затем продолжить в том же браузерном проекте. Перед единственным новым one-click запуском подтвердить cached profile READY и отсутствие активного workflow. Профилирование не запускать.
4. На первом успехе создать и проверить реальный PPTX, PDF и HTML; проверить audit, editability, source immutability и refresh persistence.
5. Только после первого настоящего PPTX: зафиксировать/push planning fix, интегрировать проверенные UI commits по одному, затем два generation-quality commits; пересоздать артефакты, визуально проверить и пройти оставшиеся release phases.

## Ограничения

- Не выполнять blind retry; сначала получать фактические safe telemetry и причину.
- Не менять semantic profile, model, endpoint contract или template.
- Не выполнять live matrix.
- Не начинать quality tuning и не заявлять `QUALITY_READY` по старым артефактам.

## Продолжение 2026-09-29 после нового старта daemon

- Проверен listener PID `21640`, старт `2026-09-29T12:21:48.9402493Z`; `/health=200`, `/readiness=200`, semantic `reachable`.
- В том же `FINAL_LIVE_TEST` с тем же сохранённым brief/profile выполнена ровно одна browser workflow attempt: operation `844efa05-03c8-41ac-af3b-412375ee5392`. Профиль не запускался повторно.
- Plan стал `ready`; live semantic calls: Worker `54.3 s` (3746/1830 tokens), Supervisor `36.5 s` (2931/1282), один revision Worker `52.3 s` (5956/1830). Всего planning `143.7 s`, все `finish_reason=stop`.
- Deterministic generation завершился `VARIANTS_NOT_DISTINCT` на слайде 3 до создания previews/export. Safe failure detail: ни один A/B/C вариант не получил qualified composition; available safe families `0`. Новый inference не отправлялся.
- Подтверждён generic contract mismatch: compiled `diagram`/`timeline` превращаются renderer-ом в editable process steps, но `templateDerivedCompositionSupported` отбрасывал любой тип, кроме `none`, `process` и `comparison`. Исправлено: sequence fallback разрешён только для `process`/`diagram`/`timeline` с минимум двумя шагами; существующие fit, chrome и renderer preview gates остаются обязательными.
- Regression test проверяет `diagram` и `timeline`, отказывает при пустых шагах, назначает distinct A/B/C fallback и рендерит/preview-валидирует native shapes. Затронутые tests `slide-compilation` + `presentation-generation-api`: `86/86 PASS`; daemon typecheck, daemon build, `docs:check`, `git diff --check`: PASS.
- Listener по-прежнему PID `21640` с тем же start time после source edit; значит текущий процесс не загрузил selector fix. Для следующего детерминированного Generate нужен restart существующего daemon из исходного shell с сохранённой конфигурацией. Не запускать workflow, пока исправленный код не загружен.
- После перезапуска использовать этот же проект, READY план и cached profile. Планирование должно быть read-only/cache hit, профилирование — `0`; затем одна новая browser Generate attempt, без blind retry и без изменения brief/template.

## Проверка после заявленного перезапуска 2026-09-29 13:01 UTC

- Повторная проверка listener обнаружила прежний PID `21640` и прежний start time `2026-09-29T12:21:48.9402493Z`; новый процесс не подтверждён.
- `/health=200`; `/readiness=200`, но semantic status=`warming`.
- В существующем браузерном проекте осталась предыдущая terminal generation `VARIANTS_NOT_DISTINCT`, `0/10`; новая попытка не запускалась.
- Поскольку запущенный процесс старше сборки selector fix, он не может подтвердить новый код. Следующий шаг: перезапустить daemon именно из исходного shell с сохранённой live-конфигурацией, затем проверить новый PID и readiness. До этого live Generate запрещён; проект, template, plan и cached profile сохраняются.

### Повторная проверка 2026-09-29 13:02 UTC

- Listener по-прежнему PID `21640`, start time `12:21:48.9402493Z`.
- `/health=200`; `/readiness=200`, semantic status теперь `reachable`.
- Скомпилированный `exemplar-slide-selector.js` содержит regression fix и имеет время изменения `12:54:05.7189289Z`, то есть он был собран ПОСЛЕ запуска listener. Текущий процесс не может загрузить эту сборку без перезапуска; Generate на нём не тестировал.
- Проверены доступность четырёх заявленных UI/generation-quality commit SHAs и их файлы. Интеграцию отложить до первого реального PPTX согласно release sequence.

## Phase A browser E2E, 2026-09-29

- Повторно использован тот же проект `d3d1975a-cc28-4c2e-831a-d09eeca49f8b`, сохранённые template profile и plan. Нового проекта и профилирования не было.
- Plan reuse: READY; генерация `05aa55f4-35b4-4ce2-95ef-09a476b585e4` завершилась: A/B/C — 10/10 каждый, всего 30/30. Deck signatures различаются попарно; каждая пара стратегий различается по композиции на всех 10 слайдах. Время Generate до готовности A/B/C: 6.755 s.
- Semantic calls в использованном generation workflow: 0; plan был готов и переиспользован. Template profiler during Generate: 0. Один contextual-deck-audit был отправлен, но завершился `SERVICE_UNAVAILABLE` через 178675 ms; HTTP status и finish reason отсутствуют, retries не было. Контекстный аудит остаётся FAIL/неподтверждённым, live readiness сейчас проверяется отдельно.
- Deterministic audit: 0 errors, 21 warnings (18 `geometry.visual-slot-overlap`, 3 `fidelity.unsupported-specific-claim`). Это не clean audit; entailment, inherited style/contrast и rendered overflow остаются неизвестными проверками.
- Из UI сгенерированы и сохранены PPTX/PDF/HTML, по 10 слайдов. PPTX SHA-256 `1d49f4c79a540abb29b416029be469bb3fc8906e194edc5a25a494a204b453a6`; structural reopen PASS, 10 slides, 1 master, theme present, 0 notes, editable native text objects (2–3 на слайд). Office display/visual fidelity не проверены.
- PDF reopened with pdf-lib: 10 pages; HTML has doctype and 10 slide sections. Export hashes: PDF `21b716a3735be050c42b5d4b06d1c68d13fb87d2b69312b8feaf986736c4e115`; HTML `61afd9667b3065cfbee72bc32c0930998f59aa964c8a06fc1b2bc67cc2cbf551`.
- Источнику соответствует hash snapshot/compiler `7c34dd3f5b09607a9334b46898d1951b9a4217196109cffcd02e997e0b26414d`; текущий файл оригинала имеет тот же hash.
- После нового открытия того же URL в браузере состояние восстановилось: 10 слайдов, варианты и три export records видимы. Browser-level refresh persistence подтверждён повторным открытием проекта.
- Contact sheet и preview PNG находятся в `.lct/final-tz-live-e2e/05aa55f4-35b4-4ce2-95ef-09a476b585e4/visual-review/00-final-live-test-10-слайдов/` и `previews/`. Ручной осмотр показал слабую, разреженную композицию; это не quality pass. Экспортный warning: native Office rendering не проверено; diagram rendering остаётся unresolved.
- Targeted planning/slide-compilation tests: 85/85 PASS. PDF/HTML reopen checks PASS. `/health` после перезапуска отвечал 200; `/readiness` один раз превысил 15 s probe timeout; повторная проверка выполняется с настроенным 120 s readiness deadline, без model completion.
- Readiness probe после первого локального 15 s timeout завершился HTTP 200 за ~16 s: store available, writable directories, renderer initialized, semantic `reachable`. Health HTTP 200.
- Тот же проект открыт повторно в браузере: UI восстановил все 10 слайдов, A/B/C previews, выбранный A и записи PPTX/PDF/HTML. Это подтверждает browser reload/open persistence.
- В UI contextual audit по-прежнему показывает ошибку; persisted failure code `SERVICE_UNAVAILABLE`, telemetry wall time `178675 ms`, finish reason отсутствует. Deterministic audit виден как passed, но warning totals выше относятся к persisted generation audit report и остаются в отчёте. Повторная попытка из UI не дала наблюдаемого перехода в running/ready, поэтому дополнительных запусков не делаю.
- Targeted tests завершились окончательно: `planning-api.test.mjs` + `slide-compilation.test.mjs` — 85/85 PASS, 0 skipped. PDF/HTML reopened checks PASS. Browser-level persistence PASS.
- Следующее: сохранить summary артефакт; закоммитить/push проверенные planning/selector fixes в `final-integration`, интегрировать UI commits и generation-quality commits по одному, затем пройти полный offline gate/matrix. Contextual audit остаётся live blocker; main пока не менять.
