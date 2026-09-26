# Карта компонентов по этапам

Полный context/component/dataflow diagram и правила границ находятся в корневом [ARCHITECTURE.md](../../ARCHITECTURE.md). Здесь приведено соответствие пользовательского flow к текущим компонентам.

| Этап | Компонент | Вход/выход | Граница проверки |
|---|---|---|---|
| Понять шаблон | Template compiler и PPTX inspector | PPTX → TemplateIR/PDS | Ограниченная структурная инспекция OOXML |
| Разобрать источники | Content compiler | supported source files → ContentIR | Размеры, формат, provenance IDs |
| Составить brief/plan | PlanningService и SemanticInferenceAdapter | brief + evidence → validated DeckPlan | strict output schema, refs и лимиты |
| Семантическая разметка шаблона | Опциональный TemplateSemanticProfiler | TemplateIR → cached role profile | replaceable evidence; deterministic selector владеет окончательным выбором |
| Сгенерировать варианты | GenerationService / slide compiler | один DeckPlan + template → A/B/C | native object compile и bounded composition selection |
| Проверить качество | deterministic audit и quality report | variant → findings | safety gate отдельно от approximate/semantic quality |
| Выдать файл | PPTX/PDF/HTML adapters | проверенная композиция → artifacts | reopen/package gates различаются по формату |

Это functional modules одного daemon-а, не отдельные services/process boundaries. Внешняя модель не управляет geometry или напрямую изменяет сохранённый проект.
