# План: финальная приёмка релиза

## Цель

Проверить фактическое состояние LCT перед ограниченной live-квалификацией Qwen/VK; исправить только P0/P1, упаковать результаты и обновить документацию. Не запускать RunPod/GPU/внешний inference, не выполнять commit или push.

## Критерии приемки

- Требования кейса имеют точное происхождение и актуальные статусы.
- README, ARCHITECTURE, MODELS, AUDIT, release notes, demo runbook, pitch outline и readiness report актуальны; пример конфигурации не содержит секретов.
- Пользовательский интерфейс не показывает внутренние английские audit-сообщения.
- Проверки 3×3, held-out и на 10–15 слайдов основаны на текущих артефактах; неполный результат явно обозначен как BLOCKED.
- Frozen install, tests, typecheck, build, boundary, lint, docs links и diff check завершены и отражены в отчёте.

## Итог текущей проверки

- Официальный PDF кейса из 7 страниц проверен; SHA-256 записан в `docs/compliance/CASE_REQUIREMENTS.md`; PDF отсутствует в Git, URL не придумывался.
- Матрица шаблонов: 6/9 на синтетическом содержимом; варианты WorkSpace withheld; проверка AIOS как held-out шаблона останавливается до audit/export.
- 12-слайдовый fake-only smoke функционально прошёл, но генерация/рендер/предпросмотр заняли 304.077 s, весь поток — 322.635 s; цель 300 s не достигнута.
- Устранён показ английских deterministic audit-сообщений в UI через типизированный русский каталог; добавлен regression-тест для всех текущих audit rules.
- Текущий статус релиза: BLOCKED. Live inference, RunPod, GPU, commit и push не выполнялись.

## Проверки и точный следующий шаг

Финальные offline gates после UI regression fix завершились успешно: frozen install pnpm 10.33.2; 181/181 test; typecheck; build; boundary; craft lint; docs links (55 обязательных файлов); `git diff --check`. Все результаты записаны в `RELEASE_READINESS.md`; acceptance остаётся BLOCKED из-за 6/9 matrix, провала held-out до audit/export и превышения 300 s. Точный следующий шаг: получить organizer content pack/brief и закрыть эти offline blockers, затем провести ограниченную live qualification до 3 запросов.
