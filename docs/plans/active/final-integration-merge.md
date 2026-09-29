# План финальной интеграции

## Цель и приёмка

Собрать reliability baseline, готовый presentation backend и Figma UI в единую ветку без новой архитектуры. Подтвердить полные offline gates, WorkSpace / held-out / Education product E2E, визуальные превью и ручную работу интегрированного UI. RunPod и live inference запрещены.

## Каноническая рабочая копия

- Путь: `C:\Projects\GitHub\LCT_vk`
- Ветка: `final-integration`
- HEAD после интеграционных merge: `329f20ad65a27b226c9c0f94decf99821d3c7d5d`
- База: `origin/main` на `035d2e9712c59d0a628257545f6c67036b561689`
- Источники обеих feature-веток имели тот же merge-base. Ветки влиты обычными merge commit: сначала `origin/overnight-final-hardening`, затем `origin/ui-figma-final`.
- Конфликты: не было.

## Выполнено

- Targeted suites: `137/137`; полный suite на интегрированном коде: `342/342`.
- `pnpm dlx pnpm@10.33.2 install --frozen-lockfile`, daemon/web typecheck, production build, `docs:check`, `check:boundary`, `lint:craft`, `git diff --check`: PASS.
- WorkSpace, 10 слайдов: 30/30 A/B/C, детерминированный и contextual audit, selected/A/B/C PPTX reopen, PDF 10 страниц, HTML 10 слайдов, native editable text, source hash unchanged. Fake-only полный runtime: 127.501 s; три варианта готовы за 84.364 s.
- Held-out `kompaniya-napravleniya-i-klienty.pptx`, 10 слайдов: 30/30 A/B/C, оба аудита, A/B/C PPTX reopen/editability, PDF/HTML, source hash unchanged. Fake-only полный runtime: 60.850 s; варианты готовы за 15.872 s.
- VK Education, 3 слайда: 9/9 A/B/C, оба аудита, A/B/C PPTX reopen/editability, PDF 3 страницы, HTML 3 слайда, source hash unchanged. Fake-only полный runtime: 93.285 s; варианты готовы за 17.202 s. Примечание: typography resolution оставила четыре placeholder неизвестными; conservative fit gates сохранились.
- Проверены реальные preview PNG для WorkSpace и held-out: слайды 1/5/10, A/B/C. Контактные листы: `.lct/final-integration-20260929/workspace-visual-review.png`, `.lct/final-integration-20260929/heldout-visual-review.png`. Приемлемые фон, логотип и chrome сохранены; clipping/overlap не выявлены на проверенных страницах. На части WorkSpace A/B близки по композиции; это остаётся визуальным риском.
- Ручной UI проход: проект восстановлен, редактор показывает сохранённые слайды и реальные preview URLs, A→B→A переключает центральный предпросмотр, contextual findings и детерминированный аудит показываются в отдельных блоках. Скриншоты UI были просмотрены через browser automation; их локальное сохранение в артефактный каталог недоступно в использованном UI API.
- Во время ручного dev-прохода тестовый запуск с CLI semantic cache identity отличался от injected adapter identity E2E runner; это вызвало ожидаемую переподготовку профиля, а первый Windows `rename` вернул `EPERM`. После успешной повторной подготовки состояние профиля и плана восстановилось. Этот диагностический эпизод не менял tracked продуктовый код.

## Интеграционное изменение

Boundary gate запрещает отдавать Figma assets из `apps/web/public`. Интеграция перенесла те же inline SVG path data в `FigmaIcon` в `apps/web/src/App.tsx` и не добавляла второй путь раздачи статических файлов. Удалены только добавленные Figma branch icon files из `apps/web/public/figma-icons/`.

## Документы и следующий шаг

- Demo-инструкция: [`docs/runbooks/FINAL_DEMO_RUNBOOK.md`](../../runbooks/FINAL_DEMO_RUNBOOK.md).
- Предыдущие live evidence ограничены 3-slide A/B/C readiness и не подтверждают полный contextual audit либо 300-секундный бюджет. Live quality, strict structured output, 10–15-slide latency и VK endpoint integration остаются неизвестными.
- Следующий шаг вне этого integration pass: отдельная bounded live qualification с RunPod; этот запуск не выполнялся.

## Финализация

- Финальный интеграционный коммит и push разрешены только в `origin/final-integration`.
- `main` не обновлять.
