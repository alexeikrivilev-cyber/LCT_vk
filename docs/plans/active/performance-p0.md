# План: P0 performance fix

**Статус:** `PERFORMANCE_READY` — offline acceptance и все локальные gates пройдены; commit/push не выполнялись.

## Scope

Снять fake-only generation latency на 12–15 слайдах, сохраняя task/context contract, provenance, template and semantic safety, composition resolver, exact A/B/C identity, slide-level state, audits и editable exports. Никаких Qwen, VK inference, RunPod, GPU, внешнего inference, коммита или push.

## Acceptance

- Зафиксировать воспроизводимую baseline-профильную серию на HEAD `cf620780cfb56f9f794429ae1ea96c4938936700` с точным VK Tech source hash `cbbe3aa6a21d23cebc4d1383b93dd07a9cea460d683de1903567b616c839485d`.
- Найти bottleneck измерением и записать профиль в ignored `.lct/performance-baseline-<timestamp>/profile.json`.
- Устранять только доказанные bottlenecks; переводить rendering на whole-track path только когда profile показывает его главным ограничением и это не ломает progressive slide-level state.
- Сохранять slide-level packs, аудит, previews, восстановление/повтор B-track и не добавлять cache/reuse без безопасного fingerprint и проверяемой инвалидации.
- Выполнить одинаковые fake-only smoke на 3, 12 и 15 слайдах; 12-slide `timeToDecksReady <= 220s`, полный flow `<=240s`; 15-slide `timeToDecksReady <300s` (цель `<=240s`).
- Повторить organizer matrix 9/9 и exact held-out AIOS task-only E2E; exports/reopen PASS, blocking audit errors=0, source templates неизменны.
- Выполнить тесты, typecheck, build, boundary, lint:craft, docs:check и `git diff --check`.

## Исходное состояние

- HEAD ожидается `cf620780cfb56f9f794429ae1ea96c4938936700`; текущая ветка `main`, не трогать существующий untracked `test-content.md`.
- Последний известный offline 12-slide smoke: `generationRenderAndPreview=304077ms`, `total=322635ms`; report лежит в `.lct/release-candidate/qualification-evidence/12-SLIDE-SMOKE-REPORT.json`.
- До измерений изучить generation, renderer, preview и export flows; не менять selection/resolver semantics без доказанного bottleneck.

## Прогресс

- [x] Прочитаны README, docs index, AGENTS и актуальный P0 plan; проверен git status/log.
- [x] Воспроизвести baseline на текущем HEAD и получить scoped timings/counters.
- [x] Реализовать минимальный measured performance path и structural regression checks.
- [x] Запустить 3/12/15-slide fake-only smoke.
- [x] Повторить 3×3 + held-out AIOS regression.
- [x] Прогнать frozen install, полный test suite, typecheck, build, boundary, lint:craft, docs:check и `git diff --check`; выполнить полный просмотр diff.

## Измерения и решения

- На HEAD `cf620780`: 3-slide task/context-only VK Tech smoke PASS; generation/render/preview `76,357ms`, full flow `92,082ms`, blocking audit errors `0`, template SHA совпал.
- На HEAD `cf620780`: 12-slide task/context-only VK Tech smoke PASS; generation/render/preview `301,132ms`, full flow `318,578ms`, 36/36 A/B/C audit checks без errors, PPTX и A/B/C track exports reopened, template SHA совпал.
- Исходный 12-slide file-source baseline из candidate: `304,077ms` generation/render/preview, `322,635ms` full. Новый baseline task/context-only близок по wall time, несмотря на иной источник; это подтверждает P0 regression.
- Scoped profile на HEAD `cf620780` локализовал blocker не в resolver assignment или PPTX renderer, а в повторной чистой `visualClassification()` для кандидатов: 12-slide `generation.compositionAssignment=252802ms`, при этом `renderer.total=34099ms`, `preview.total=20549ms`. `applyVariantCompositionAssignment` занимал менее миллисекунды на 3-slide profile; его validation не ослаблялась.
- Для 12-slide baseline вызвано 1 944 построения candidate, из которых повторялись 1 890 классификаций одних и тех же immutable source slides/profile mappings. Добавлен generation-scoped bounded memoization по `templateHash/sourcePart/index/profileVisualIds`; алгоритм, порядок кандидатов, оценка, gate и assignment не меняются. Cache живёт только в одном `run()` и не переживает смену проекта/шаблона/профиля.
- Структурный baseline: по 16 renderer/template/source-ZIP loads и saves, 28 presentation reopens и 36 preview full-deck loads. После фикса на 12 слайках renderer/template/save/reopen counts остались теми же, а preview full-deck loads снизились с 36 до 12; суммарные renderer+preview deck loads снизились с 52 до 28 (−46%). Главным latency bottleneck оставалась классификация, поэтому весь renderer lifecycle не переводился на tracks.
- 3-slide smoke PASS после оптимизации: `generationRenderAndPreview=20153ms`, `total=36042ms`, resolver assignment `7227ms`, preview deck loads `3`, audit errors `0`; A/B/C exports reopened.
- 12-slide smoke PASS: `generationRenderAndPreview=53091ms`, `total=70753ms`, resolver assignment `7644ms`, preview deck loads `12` вместо 36, audit errors `0`; selected export и A/B/C track exports reopened.
- 15-slide smoke PASS с отдельным 15-section synthetic task/context fixture: `generationRenderAndPreview=64783ms`, `total=82962ms`, resolver assignment `7867ms`, preview deck loads `15` вместо 45, audit errors `0`; selected export и A/B/C track exports reopened.
- Smoke runner делает structural assertions: не более одного render-pack на planned slide плюс одна targeted repair; preview-deck-loads не более одного на slide плюс targeted repair; каждый slide из template не классифицируется более одного раза за generation. Результаты остаются в ignored `.lct/local-product-smoke-*`; aggregate profile — `.lct/performance-baseline-20260926T210754/profile.json`.
- Перепроверка после основного cache показала, что полный-track renderer redesign не нужен для заданного fake-only ceiling: 12/15-slide complete flows занимают 71/83s. Перевод generation на треки изменил бы progressive state, тогда как measured bottleneck устранён. Сохраняется текущий validated one-render-pack-per-slide путь; repair остаётся targeted.
- Повтор organizer matrix с `LCT_PPTX_BACKEND=office-kit` и локальным fake semantic endpoint: 9/9 вариантов, все три шаблона PASS, все PPTX переоткрыты, сохранение шаблонов PASS, blocking audit errors=0. Артефакты: `.lct/performance-p0-regression-20260926/case-3x3-officekit`.
- Повтор exact held-out AIOS task/context-only qualification на исходном PPTX, без source uploads: PASS; 3 fake inference calls, audit/export/reopen PASS, residue checks PASS. Манифест: `.lct/unknown-template-qualification/unknown-template-2026-09-26T181652-238Z-ab8baa03/UNKNOWN_TEMPLATE_MANIFEST.json`.
- Финальный 15-slide resource smoke с полным preview substage timing и 100ms RSS sampling: PASS; generation/render/preview `64,316ms`, complete flow `82,631ms`, peak process RSS `777,302,016 bytes` (~741 MiB), largest selected/A/B/C PPTX `16,186,391 bytes`, renderer jobs max `1`, 15 preview deck loads, audit errors `0`; preview decode/load `1,708ms`, render `19,057ms`, write artifacts `53ms`; выбранный экспорт и все track exports переоткрыты. Артефакты: `.lct/local-product-smoke-2026-09-26T182643-686Z-912ad489`.
- Проверки: frozen install PASS; полный suite `187/187` PASS; typecheck PASS; build PASS; `check:boundary` PASS; `lint:craft` PASS; `docs:check` PASS (55 files); `git diff --check` PASS (Git сообщил только ожидаемые LF→CRLF warnings на изменённых файлах).

## Итог

- Performance acceptance выполнен: 12-slide complete flow `70.8s` против baseline `319.6s`, 15-slide — `82.6s`; оба ниже целевого ceiling `240s` для smoke и 15-slide `<300s`.
- Resolver caching не меняет выборы и ограничен одним generation/template scope; regression тест сравнивает cached и uncached результаты и проверяет повторные hits.
- Full-track renderer redesign не выбран: measured bottleneck был в повторной классификации, а после её устранения generation сохраняет progressive slide-level packs с достаточным запасом по latency.
- Readiness отдельно от previews по-прежнему не измеряется: persisted product state публикует pack ready после preview, поэтому оба временных значения совпадают. Указанное `timeToDecksReady` — консервативная верхняя граница полного процесса, а не отдельно наблюдённое событие deck-ready. Это остаётся ограничением измерения, не блокером целевых latency thresholds.
- Следующий шаг: передать отчёт пользователю для review; commit и push не выполнять.

**Точный следующий шаг:** пользователь review; live inference не запускать в рамках этой работы.
