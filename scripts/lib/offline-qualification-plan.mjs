const STORY = [
  { takeaway: 'Цель задаёт ход', points: ['Цель задаёт тему.', 'Путь ведёт к решению.'] },
  { takeaway: 'Порядок запросов', points: ['Единый маршрут связывает запрос с нужным контекстом.', 'Сопоставимые условия упрощают обсуждение вариантов.'] },
  { takeaway: 'Фокус аудитории', points: ['Задачи участников определяют, какие сообщения важны.', 'Приоритет темы связан с решением аудитории.'] },
  { takeaway: 'Факты и версии', points: ['Подтверждённые сведения отделены от рабочих предположений.', 'Неопределённость обозначена до выбора действия.'] },
  { takeaway: 'Владельцы этапов', points: ['Владелец этапа связывает работу его участников.', 'Зависимости показывают, что требуется для перехода дальше.'] },
  { takeaway: 'Связи задают ход', visual: 'process', points: [
    'Владельцы связывают этапы.', 'Условия показывают готовность.', 'Каждый переход имеет контроль.',
  ] },
  { takeaway: 'Критерии выбора', visual: 'comparison', points: [
    'Одинаковые критерии помогают сопоставить варианты.', 'Риск и ограничение остаются видимыми в сравнении.', 'Выбор завершается понятным следующим шагом.',
  ] },
  { takeaway: 'Риски в решениях', points: ['Риск важен в контексте решения, на которое он влияет.', 'Владелец проверки помогает учитывать ограничение.'] },
  { takeaway: 'Вопрос и действие', points: ['Недостающий ответ превращается в конкретный вопрос.', 'Назначенное действие помогает закрыть неопределённость.'] },
  { takeaway: 'Обратная связь', points: ['Обратная связь помогает уточнить приоритеты команды.', 'Изменения плана опираются на замечания участников.'] },
  { takeaway: 'Проверка этапов', points: ['Проверка условий показывает готовность к переходу.', 'Общий процесс заранее обозначает путь для блокера.'] },
  { takeaway: 'Следующий шаг', points: ['Шаг переводит план в работу.', 'Участникам понятен итог.'] },
];

function selectedStoryIndexes(requestedSlideCount) {
  const count = Math.max(1, Math.min(12, Math.trunc(requestedSlideCount) || 1));
  if (count === 1) return [0];
  if (count === 3) return [0, 5, 11];
  return Array.from({ length: count }, (_unused, index) => Math.round(index * (STORY.length - 1) / (count - 1)));
}

/** A synthetic, qualitative offline fixture; it contains no sourced or invented measurements. */
export function buildOfflineQualificationPlan(requestedSlideCount) {
  const indexes = selectedStoryIndexes(requestedSlideCount);
  return {
    workingTitle: 'План согласованной подготовки запуска',
    narrativeSummary: 'Провести команду от цели и проверки материалов к владельцам, готовности и следующему действию.',
    slides: indexes.map((storyIndex, index) => {
      const story = STORY[storyIndex];
      const process = story.visual === 'process';
      return {
        narrativeRole: index === 0 ? 'opening' : index === indexes.length - 1 ? 'closing' : 'content',
        purpose: index === 0 ? 'Задать цель и контекст.' : index === indexes.length - 1 ? 'Согласовать действие.' : 'Продвинуть историю к решению.',
        takeaway: story.takeaway,
        contentRefs: [],
        bodyPoints: story.points.map((text) => ({ text, origin: 'generated-from-brief', evidenceRefs: [] })),
        mediaRefs: [],
        semanticVisualType: story.visual ?? 'none',
        targetDensity: story.visual === 'comparison' ? 'detailed' : 'balanced',
      };
    }),
  };
}

export function offlineQualificationResponse(request) {
  const schemaName = request.response_format?.json_schema?.name;
  if (schemaName !== 'deck_plan_draft_v4') return null;
  const evidence = JSON.parse(request.messages.at(-1).content);
  const value = buildOfflineQualificationPlan(evidence.requestedSlideCount);
  return {
    id: 'offline-qualification-plan',
    model: request.model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }],
    usage: { prompt_tokens: 32, completion_tokens: 16 },
  };
}
