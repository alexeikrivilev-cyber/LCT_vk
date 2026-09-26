# Готовность к квалификации Qwen

**STATUS: BLOCKED**  
Последняя проверка: 2026-09-26. Текущий источник истины — [RELEASE_READINESS.md](../RELEASE_READINESS.md); требования и provenance — [CASE_REQUIREMENTS.md](./compliance/CASE_REQUIREMENTS.md).

## Локальный продукт

- Чистая временная копия прошла frozen install, build, offline start, локальный fake endpoint и smoke с реальным локальным PPTX. Повторный 12-слайдовый fake-only flow прошёл создание, выбор/закрепление, аудит, экспорт selected/A/B/C и повторное открытие PPTX. Это структурный smoke на синтетическом содержимом, не приемка organizer content.
- В 12-слайдовом smoke проверены 36 слайдовых вариантов, 0 audit findings/errors, 24 native text shapes, 0 notes, source hash не изменился. Deck-level track facts/provenance не проверены, safe repair недоступен, native Office rendering неизвестен.
- `generationRenderAndPreview`: 304.077 s; полный flow: 322.635 s. Оба результата превышают 300 s. Целевой live inference не измерялся.
- Поддерживаемая конфигурация находится в `.env.example`; там только loopback/fake-настройки, секретов нет. Clean-room запуск из этой конфигурации проверен. Это не заменяет VK endpoint qualification.

## Organizer matrix и held-out

- Последняя fake-only матрица: `.lct/core-generation-fix-20260926/case-3x3/CASE_QUALIFICATION_MANIFEST.json`; **PASS, 9/9** на одном task/context-only planning state. VK Tech, WorkSpace, Education — по A/B/C. Все PPTX reopened, прошли factual-equivalence/template-preservation, имеют 0 deterministic audit findings, notes и raster slides. Три profiler обращения были только к локальному fake endpoint.
- Preview gate содержит 10 низкоуверенных текстовых предупреждений приближённого Office Kit renderer; PowerPoint/LibreOffice визуально не проверялись.
- Точный held-out AIOS manifest: `.lct/unknown-template-qualification/unknown-template-2026-09-26T164941-924Z-ceef591a/UNKNOWN_TEMPLATE_MANIFEST.json`; **PASS**. `AIOS_Онбординг (4) (1) (1).pptx`, SHA `18198cc08df9fc3ea5aee5f509d89e70a4ade68bb539fed61a957581ee365ad`, 16 slides / 2 masters / 2 layouts. Task+context only, 0 source files; analysis/profile, plan, A/B/C, audit, selected and track exports/reopen passed. Проверены пять предметных строк на отсутствие во всех четырёх выходах; residue check — PASS.
- Organizer clarification: отдельного content package не будет; обязательны шаблон и задача, контекст и source files optional. 3×3 использует одну qualification task/context, а не отсутствующий пакет.

## Визуальное качество и экспорт

- PPTX reopen/native-object checks для smoke и шести matrix artifacts — PASS структурно; открытие в PowerPoint/LibreOffice и ручной визуальный осмотр не выполнены.
- PDF/HTML адаптеры и structural/reopen tests существуют. PDF/HTML release artifacts на все 9 deck не созданы; browser rendering acceptance не выполнялась. Для релизной приемки PDF/HTML — **не подтверждены**.
- Предпросмотры приблизительные. WorkSpace и AIOS блокируют автоматическое подтверждение композиции.

## UI и документация

- Русский каталог централизован. UI показывает русские сводки вместо внутренних английских audit messages, произвольного Supervisor reason и parser/template warning prose. Regression tests проверяют все текущие deterministic audit rules и запрещают прямой показ этих полей.
- Полный browser walkthrough на 1280–1920 px не выполнен; UI visual acceptance остаётся частичной.
- README, ARCHITECTURE, MODELS и AUDIT существуют. Безопасная пример-конфигурация — `.env.example`. Документы релизного набора, demo runbook, pitch outline и acceptance report подготовлены в этом рабочем дереве.

## Offline checks и live-only риски

2026-09-26 после P0 Core Generation Fix повторно пройдены frozen install на pnpm 10.33.2, **187/187 тестов**, typecheck, build, boundary, craft lint, docs links (55 required files) и `git diff --check`. Команды и ограничения evidence: в [`RELEASE_READINESS.md`](../RELEASE_READINESS.md).

Не запускались RunPod, GPU, Qwen, VK endpoint или внешнее inference. Остаются live-only риски: Qwen semantic quality, strict schema compliance, latency, VK endpoint/configuration.

## Блокеры

1. Проверить 9-deck и held-out exports в PowerPoint/LibreOffice; принять или исправить preview approximation warnings.
2. Подтвердить 10–15 slide performance: текущий 12-slide synthetic run превысил 300 s.
3. Проверить PDF/HTML в браузере и выполнить customer-facing browser walkthrough.
4. Зафиксировать clean final Git revision и config-based startup для целевого VK endpoint.

**NEXT ACTION:** закрыть offline blockers 1–4; затем выполнить один ограниченный live Qwen/VK qualification с бюджетом не более 3 inference-запросов (profiler 1, Worker 1, Supervisor 1, generation 0).
