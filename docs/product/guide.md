# Руководство пользователя и границы продукта

## Обычный путь

Создайте проект, загрузите PPTX-шаблон и исходные материалы, задайте brief, получите план, проверьте его и запустите генерацию A/B/C. Для каждого слайда доступны только варианты, прошедшие применимые safety checks; выбранный вариант можно закрепить, провести аудит/допустимый локальный repair и экспортировать. Состояние проекта хранится daemon-ом и восстанавливается через API после обновления страницы.

Интерфейс локализован на русский. `PPTX`, `PDF`, `HTML`, `Qwen`, `TemplateIR`, `ContentIR` и `DeckPlan` остаются техническими идентификаторами.

## Входные материалы

| Формат | Реальная обработка |
|---|---|
| `.md`, `.txt` | Текстовые источники для ContentIR |
| `.csv`, `.tsv` | Табличные источники, значения и provenance units |
| `.json` | Ограниченный разбор JSON данных |
| `.pptx` | Template inspection; не следует считать произвольный OOXML полностью поддержанным |
| Изображения | Asset/reference inventory; не гарантируется OCR или понимание изображения |
| Иные бинарные форматы | Не считать разобранным текстом; unsupported/asset-only статус должен сохраняться честно |

PDF/DOCX text extraction и OCR не заявлены как поддержанные pipeline. Лимиты ContentIR и upload приведены в [конфигурации](../getting-started/configuration.md).

## A/B/C, аудит и экспорт

A/B/C используют общий план и одни source facts, но целятся в разные композиционные стратегии. Стратегии не гарантируют, что каждый шаблон сможет безопасно отдать все три варианта: такой вариант withheld. Значения, chart/table и quote должны ссылаться на ContentIR; компилятор не должен придумывать числа.

Детерминированная проверка, её пределы и repair policy описаны в [AUDIT.md](../../AUDIT.md). Результат:

- **PPTX** — основной формат, со структурно редактируемыми native objects по текущим Office Kit checks; полный визуальный render в PowerPoint не подтверждён.
- **PDF** — изображения слайдов из approximate preview renderer, одна страница на слайд; это не точный PowerPoint render.
- **HTML** — артефакт просмотра, не editable PPTX и не pixel-identical Office rendering.

## Ограничения

Case acceptance сейчас BLOCKED; organizer 3×3 matrix дала 6 из 9 outputs, full content pack отсутствует. Real Qwen classification/schema quality, VK endpoint integration, browser matrix, 10–15-slide live timing и PowerPoint/LibreOffice visual QA не подтверждены. Подробный статус — [READY_FOR_QWEN.md](../READY_FOR_QWEN.md).
