# Skills: справочные инструкции

Каталог содержит authoring references для разработки, а не набор skills, который автоматически загружается production runtime.

Русские продуктовые и эксплуатационные руководства собраны в `docs/`. Тексты skills и их design/craft reference assets сохранены на английском как внутренние авторские материалы; runtime prompts также остаются на исходном английском, чтобы перевод справки не менял модельные инструкции.

## Текущий состав

- `pptx-html-fidelity-audit` — сценарий сопоставления PPTX с исходным HTML deck и проверки визуального расхождения.
- `presentation-contextual-audit` — ограниченные правила текстового контекстного аудита; runtime contract фиксирует его agent/skill/prompt/schema версии, но автоматически текст skill не загружает.
- `reference-design-contract` — преобразование design reference и визуальных предпочтений в явный design contract.

Это reusable guidance, не дополнительный слой application architecture. Runtime prompts находятся в `apps/daemon/prompts/`; их версии и schema указаны в `apps/daemon/src/presentation/contracts/` и [MODELS.md](../MODELS.md).

## Правила поддержки

Новая инструкция должна иметь ограниченную цель, явные вход/выход и не дублировать длинные продуктовые правила. Точные geometry, OOXML, package mutation, locks, persistence и deterministic audit остаются задачей code, не модели. Не включайте provider credentials и transport-specific детали.

До добавления upstream кода проверьте license, provenance и maintenance. Сохраняйте NOTICE/upstream атрибуцию и не копируйте prompt/craft текст без проверки лицензии.

Runtime сейчас не подгружает тексты skills автоматически и не prewarm-ит их. Не описывайте target architecture как действующее поведение.
