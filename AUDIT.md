# Аудит качества и безопасности презентации

Детерминированный safety audit отделён от контекстной оценки и остаётся authoritative: ответ модели не может разрешить geometry/provenance errors или менять факты. Для фиксированных `CompiledPresentation`, `ContentIR` и `TemplateIR` audit — чистая функция: `auditCompiledPresentation(presentation, contentIR, templateIR)`. Она не вызывает сеть, модель, часы или случайные генераторы и не меняет входы. Два запуска на одинаковых входах возвращают одинаковый report; тест также проверяет независимые копии объектов и ожидаемое изменение hash после геометрической ошибки.

`canonicalDeterministicAuditSha256` хеширует каноническое представление версии правил, findings и checks; run-specific `presentationId` в него не входит. Canonical runner записывает aggregate fingerprint всех A/B/C audit reports в manifest. Это локальная идентичность детерминированных свидетельств, а не оценка смыслового качества.

После генерации приложение отправляет один bounded текстовый запрос на всю выбранную deck revision через `SemanticInferenceAdapter`; raw PPTX и preview images не отправляются. Контекстные findings — проверяемые подсказки, не автоматическое исправление. Полная матрица требований и ограничений — в [CASE_REQUIREMENTS.md](./docs/compliance/CASE_REQUIREMENTS.md).

## Реально выполняемые проверки

| Проверка | Тип | Этап | Уровень | Автоисправление | Источник проверки | Риск ложного срабатывания | Тест / статус |
|---|---|---|---|---|---|---|---|
| PPTX читается и экспорт повторно открывается | Детерминированная | Экспорт | Ошибка | Нет | Проверка пакета Office Kit | Может не совпасть с поведением PowerPoint | Export/reopen tests: PASS локально; Office отдельно не проверен |
| Ссылки на макеты и ContentIR/media существуют | Детерминированная | План и компиляция | Ошибка | Нет | ID и отношения в IR | Низкий; проверка структурная | Generation/audit tests |
| Геометрия вышла за холст; выбранные пары объектов пересекаются | Детерминированная | Компиляция и аудит | Ошибка/предупреждение | Ограниченная | Измеренная геометрия объектов | Не охватывает все пары OOXML и реальный PowerPoint render | Geometry tests; покрытие частичное |
| Пустой слайд, непреднамеренный title-only, placeholder/test text | Детерминированная | Аудит | Ошибка/предупреждение | Нет | Текст и структура слайда | Словарь placeholder конечен; cover может быть title-only | Deterministic audit tests |
| Факты и числовые значения связаны с ContentIR | Детерминированная | Аудит | Ошибка/предупреждение | Нет | Явные content refs и значения | Проверка лексическая, не доказывает entailment или корректность преобразований | Audit/provenance tests; prose фактчек частичный |
| Таблицы, chart и KPI содержат provenance refs | Детерминированная | План, компиляция, аудит | Ошибка | Нет | ContentIR unit refs | Наличие ссылки не доказывает полезность визуализации | Provenance tests |
| Нативные объекты, сохранение template parts, отсутствие speaker notes | Детерминированная | Экспорт | Ошибка/информация | Нет | Reopen/package inspection и счётчики объектов | Не является визуальным проходом в Office | Export tests; структурная редактируемость проверена |
| A/B/C отличаются, нет повторов заголовка/текста и чужого текста донора | Детерминированная | Генерация и quality report | Предупреждение/ошибка | Withhold при небезопасной композиции | Нормализованный текст и исходный текст donor slide | Точное совпадение не обнаруживает смысловые дубли | Slide/deck quality tests; шаблонная матрица BLOCKED |
| Иерархия, плотность, контраст, safe area, text fit и единообразие шаблона | Детерминированная эвристика | Quality report | Информация/предупреждение/ошибка | Ограниченная; безопасный layout repair | Template-derived bands, OOXML и approximate preview evidence | Приближённые метрики; неизвестное помечается unknown | Quality tests; визуальное подтверждение не заменяют |

## Контекстные критерии

Текущий версионированный набор — `contextual-deck-audit.v2`, ровно 11 правил: `titleTakeaway`, `titleContentAlignment`, `oneSentenceSummary`, `factGrounding`, `visualSemanticFit`, `garbage`, `spelling`, `languageConsistency`, `tableLegendUsefulness`, `narrativeContinuity`, `redundancy`. Validator требует каждый ID ровно один раз и отклоняет неизвестные правила, message/action codes и невалидные ссылки. На всю выбранную колоду выполняется один запрос, а не отдельный запрос на слайд.

| Критерий | Тип | Этап | Уровень | Автоисправление | Источник | Риск ложного срабатывания | Реальный статус |
|---|---|---|---|---|---|---|---|
| Заголовок передаёт вывод; содержание соответствует заголовку; слайд пересказывается одним предложением | Контекстная | One-click deck audit | Info/warning/error | Нет; только подсказка пользователю | Задача, ContentIR, DeckPlan и текст готовых слайдов | Смысловая оценка субъективна; fake endpoint не оценивает качество модели | Подключён один bounded request на deck; строгая schema и refs проходят runtime validation |
| Факты связаны с источниками; визуальный тип соответствует содержанию; язык и соседние слайды согласованы | Контекстная | One-click deck audit | Info/warning/error | Нет | Provenance refs, визуальная семантика и последовательность DeckPlan | Проверка текстовая, не pixel/VLM оценка; валидная ссылка сама по себе не доказывает entailment | Контракт/схема и fake flow проверены; реальные Qwen findings не подтверждены |
| Нет повторов, prompt fragments, placeholder prose и служебных инструкций | Контекстная | One-click deck audit | Info/warning/error | Нет | Текст готовых слайдов и задача | Модель может пропустить перефразированный мусор | Один запрос на готовую deck; выводы кодированы messageCode и локализованы UI |

Contextual audit работает через provider-neutral semantic adapter и сохраняет findings вместе с fingerprint выбранных A/B/C и версией auditor/schema/prompt. UI различает «Детерминированная проверка» и «Контекстуальная проверка». Произвольная model prose не используется; недействительные slide/evidence refs отклоняются. Контекстное замечание не может понизить или удалить deterministic finding. Исправление deterministic finding по-прежнему запускается явным действием пользователя; contextual findings предлагают только ограниченное действие проверки.

Оценка только текстовая и основана на переданных evidence и метаданных. Pixel/VLM review не выполняется; `visualSemanticFit` оценивает заявленный тип визуализации/композиции, а не изображение на слайде. Fake qualification подтверждает контракт и pipeline, но не качество real Qwen/VK judgment.

Office Kit `auditTextLayout` evidence включается отдельно в `PresentationQualityReport` как renderer-derived post-render evidence. Текстовые метрики помечаются approximate/low-confidence; даже повторяемое свидетельство одного renderer не доказывает поведение Microsoft PowerPoint. Оно не подменяет deterministic safety audit. PowerPoint visual QA остаётся отдельным ручным gate. Состояние qualification: [READY_FOR_QWEN.md](./docs/READY_FOR_QWEN.md).

## Ограничения, исправления и согласие пользователя

Безопасная локальная починка может один раз выбрать другую измеренную композицию для конкретного варианта. Она не меняет смысл текста, диаграммы, lock или соседние слайды. После починки изменённый вариант проходит повторный render и audit; если blocker остался, результат отклоняется. Семантическая перепланировка и смысловые изменения не являются скрытым автоматическим repair. Вариант без безопасной композиции withheld; пользователь выбирает, закрепляет и экспортирует вариант явно.

Низкий contrast ratio, Office clipping, смысловая эквивалентность и качество spelling judgment реальной модели не заявляются проверенными. Наличие contextual `spelling` rule не означает наличие language-specific spellchecker. Approximate preview не является oracle для PowerPoint. A05 (template guides) остаётся без implementation, A13 (effective contrast ≥4.5:1) — без достоверного cascade resolver; их статусы не повышаются. Этот audit не заменяет human review или organizer acceptance.
