# ADR-007: Основной результат — native editable PPTX

- **Статус:** принято; native Office visual pass pending
- **Дата:** 2026-09-26

## Контекст

Результат презентационного компилятора должен допускать редактирование, а не быть одним raster image на слайд.

## Решение

PPTX остаётся основным результатом. Renderer строит нативные текстовые/shape/table/chart/media objects и проверяет пакет повторным открытием. PDF/HTML — отдельные viewing exports.

## Последствия

Структурная проверка объектов не доказывает fidelity Microsoft PowerPoint/LibreOffice. Для релизного утверждения нужен отдельный визуальный проход в native Office renderer.
