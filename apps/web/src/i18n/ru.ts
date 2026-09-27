export const ru = {
  metadata: {
    title: 'LCT — конструктор презентаций',
    description: 'Подготовка презентации по исходным материалам и шаблону PowerPoint.',
  },
  home: {
    eyebrow: 'LCT · создание презентаций',
    title: 'Создавайте презентации в вашем PowerPoint-шаблоне.',
    lede: 'Опишите задачу — структура, варианты слайдов и проверка создадутся автоматически. Контекст и материалы можно добавить при необходимости.',
    createLabel: 'Название презентации',
    createPlaceholder: 'Например, итоги квартала',
    create: 'Новая презентация',
    creating: 'Создаём…',
    projects: 'Проекты',
    projectKind: 'ПРЕЗЕНТАЦИЯ',
    refresh: 'Обновить',
    loading: 'Загружаем проекты…',
    empty: 'Пока нет проектов. Создайте первую презентацию.',
    genericProject: 'Без названия',
    updated: (date: string) => `Обновлён ${date}`,
  },
  workspace: {
    boot: 'Открываем рабочее пространство…',
    back: '← Проекты',
    eyebrow: 'РАБОЧЕЕ ПРОСТРАНСТВО ПРЕЗЕНТАЦИИ',
    reload: 'Обновить состояние',
    addSources: 'Добавить шаблон или материалы',
    advancedMode: 'Расширенный режим',
    technicalTools: 'Технические инструменты',
    uploading: 'Загружаем исходные материалы…',
    stagesLabel: 'Этапы создания презентации',
    templateStage: 'Шаблон',
    contentStage: 'Материалы и бриф',
    planStage: 'План',
    generateStage: 'Создание',
    reviewStage: 'Проверка и экспорт',
    files: 'Файлы',
    newFile: 'новый-файл.html',
    createFile: 'Создать текстовый файл',
    newHtmlTitle: 'Презентация',
    selectedFileFallback: 'выбранный файл',
    emptyFiles: 'Загрузите шаблон PowerPoint. Исходные материалы можно добавить при необходимости.',
    unspecified: 'Не выбрано',
    designSystem: 'Система оформления',
    designSystemLabel: (name: string) => name === 'Corporate' ? 'Корпоративный стиль' : name === 'Neutral Modern' ? 'Современный нейтральный стиль' : name,
    designSystemNote: 'Параметры загруженного шаблона применяются к этой презентации.',
    livePreview: 'ПРЕДПРОСМОТР',
    noHtml: 'Пока нет HTML-результата',
    previewTitle: 'Предпросмотр презентации',
    noDeck: 'Пока нечего показывать.',
    previewHint: 'Создайте или загрузите HTML-презентацию. Файл index.html откроется автоматически.',
    sourceEdit: 'ИСХОДНЫЙ ФАЙЛ',
    selectFile: 'Выберите файл',
    save: 'Сохранить',
    saving: 'Сохраняем…',
    binary: 'Бинарный файл доступен как материал или вложение. Здесь можно редактировать текстовые и HTML-файлы.',
    editorHint: 'Выберите файл HTML, CSS, JS, JSON, Markdown или TXT для редактирования.',
  },
  template: {
    eyebrow: 'ШАБЛОН',
    title: 'Шаблон PowerPoint',
    description: 'Загрузите PowerPoint-шаблон. Мы используем его макеты, тему и оформление.',
    fetching: 'Загружаем сохранённый результат…',
    analyzing: 'Анализируем шаблон…',
    ready: 'Шаблон изучен',
    selected: 'Шаблон выбран',
    selectTemplate: 'Загрузите шаблон',
    stale: 'Нужно проверить снова',
    uncompiled: 'Не анализировался',
    failed: 'Не удалось проанализировать',
    unavailable: 'Состояние недоступно',
    sourceLabel: 'Файл PowerPoint',
    upload: 'Загрузить PPTX',
    replace: 'Заменить шаблон',
    uploadFirst: 'Сначала загрузите файл .pptx',
    analyze: 'Анализировать шаблон',
    reportSummary: 'Структурные сведения о шаблоне',
    lastScan: (date: string) => `Последний анализ: ${date}`,
    scope: 'Это структурный анализ файла. Он не гарантирует полную совместимость с любым шаблоном или PowerPoint.',
    chooseAndAnalyze: 'Выберите загруженный файл .pptx. Основная кнопка запустит анализ автоматически.',
    scanUnavailable: 'Не удалось загрузить сохранённое состояние анализа шаблона.',
    technicalFailure: 'Не удалось завершить анализ шаблона.',
    diagnosticLabel: 'Подробности анализа',
    scannedFile: 'Проанализированный файл',
    notReported: 'Нет данных',
    canvas: 'Формат слайда',
    slides: 'Слайды',
    masters: 'Образцы',
    layouts: 'Макеты',
    theme: 'Тема',
    themeData: 'Данные темы доступны',
    fonts: 'Шрифты в файле',
    noFonts: 'Данные о шрифтах не получены.',
    fontSizes: 'Размеры шрифта',
    noFontSizes: 'Данные о размерах шрифта не получены.',
    themeFonts: 'Шрифты темы',
    noThemeFonts: 'Роли шрифтов темы не определены.',
    palette: 'Цвета в файле',
    noPalette: 'Цвета текста и фигур не обнаружены.',
    themeColors: 'Цвета темы',
    noThemeName: 'Имя не указано',
    majorFont: 'Основной',
    minorFont: 'Дополнительный',
    useCount: (count: number) => `использований: ${count}`,
    layoutUnknown: (index: number) => `Макет ${index}`,
    total: 'Всего',
    placeholderRoles: 'Области макета',
    noLayoutDetails: 'Сведения о макетах отсутствуют.',
    sourceNotReported: 'Исходный файл не указан',
    dimensionsUnknown: 'Размер не указан',
    dataUnavailable: 'Данные не получены',
    observedTitle: 'Зафиксированная тема',
    observedFonts: 'Шрифты в файле',
    observedSizes: 'Размеры шрифта',
    directPalette: 'Цвета в файле',
    assetCount: (count: number) => `обнаружено: ${count}`,
    layoutCount: (count: number) => `найдено: ${count}`,
    assets: 'Встроенные материалы',
    observed: 'обнаружено',
    unclassified: 'Без типа',
    noAssets: 'Встроенные материалы не обнаружены.',
    inventory: 'СТРУКТУРА ФАЙЛА',
    reported: 'найдено',
    placeholderComposition: 'Области макета',
    noPlaceholders: 'Области содержимого не определены.',
    usageUnknown: 'Использование неизвестно',
    unsupported: 'Неподдерживаемые элементы и предупреждения',
    unsupportedLabel: 'Не поддерживается:',
    unsupportedSummary: (count: number) => count === 1
      ? 'Одна часть структуры шаблона не поддерживается полностью.'
      : `Частично не поддерживаются элементы структуры шаблона: ${count}.`,
    warningSummary: (count: number) => count === 1
      ? 'Есть одно предупреждение о структуре шаблона.'
      : `Есть предупреждения о структуре шаблона: ${count}.`,
    noUnsupported: 'Предупреждений не получено. Это не означает полной совместимости с PowerPoint.',
    staleOtherFile: (scanned: string, selected: string) => `Сохранённый анализ относится к файлу «${scanned}». Запустите анализ для файла «${selected}».`,
    staleChangedFile: 'После анализа исходный файл изменился. Запустите анализ ещё раз.',
    unknownCount: 'Неизвестно',
    usage: (count: number) => `${count} использ.`,
  },
  planning: {
    eyebrow: 'ЗАДАЧА ПРЕЗЕНТАЦИИ',
    title: 'Опишите задачу',
    description: 'Расскажите, для кого и зачем нужна презентация. Структура, варианты слайдов и проверка подготовятся автоматически.',
    loading: 'Загружаем сохранённый план…',
    understanding: 'Готовим план…',
    unavailable: 'Состояние плана недоступно',
    reload: 'Обновить план',
    analyzeTemplateFirst: 'Сначала проанализируйте выбранный шаблон PowerPoint.',
    oneClickWillAnalyze: 'Шаблон будет проанализирован автоматически при создании презентации.',
    uploadTemplateFirst: 'Сначала выберите PPTX-шаблон.',
    optionalLabel: 'необязательно',
    stale: 'Сохранённый план построен по прежней задаче, контексту, материалам или шаблону. Создайте новый план.',
    draftChanged: 'Задача, контекст или материалы изменились после сохранения плана. Создайте новый план перед запуском слайдов.',
    sourceFiles: 'Исходные материалы',
    readyForPlanning: 'Можно составить план',
    selected: (count: number) => `Выбрано: ${count} из 12`,
    uploadSources: 'Исходные материалы не обязательны. Загрузите файлы, если они дополняют задачу или контекст.',
    audience: 'Для кого презентация · необязательно',
    audiencePlaceholder: 'Например, руководство компании',
    purpose: 'Задача презентации',
    purposePlaceholder: 'Что нужно создать и какой вопрос раскрыть?',
    context: 'Контекст',
    contextPlaceholder: 'Факты, ограничения и дополнительная информация. Необязательно.',
    outcome: 'Ожидаемый результат · необязательно',
    outcomePlaceholder: 'Что аудитория должна понять или сделать?',
    preferences: 'Пожелания',
    perLine: 'по одному в строке',
    preferencesPlaceholder: 'Необязательные пожелания к стилю и акцентам',
    slideCount: 'Количество слайдов',
    optionalRange: 'необязательно · от 1 до 30',
    automatic: 'Автоматически',
    requires: 'Нужны проанализированный шаблон и задача. Материалы можно не добавлять.',
    optionalSourcesNote: 'Загруженные материалы включаются автоматически. Список можно изменить в расширенном режиме.',
    optionalSettings: 'Дополнительные настройки',
    addSources: 'Добавить материалы',
    requiredTaskNote: 'Укажите шаблон и задачу. Остальное можно настроить по желанию.',
    planDetails: 'План и технические подробности',
    generate: 'Создать план',
    generating: 'Составляем план…',
    sourceWarnings: 'Предупреждения по материалам',
    generated: 'СОСТАВЛЕННЫЙ ПЛАН',
    defaultTitle: 'План презентации',
    purposeUnknown: 'Задача не указана',
    takeawayUnknown: 'Основной вывод не указан',
    visualUnknown: 'Тип визуализации не указан',
    densityUnknown: 'Плотность не указана',
    sources: 'Источники',
    noSource: 'Источник не указан',
    review: 'Проверка плана',
    outcomeUnknown: 'Результат не указан',
    findingUnknown: 'Описание проблемы отсутствует.',
    findingSummary: (targetType: string) => targetType === 'deck'
      ? 'Проверьте соответствие плана брифу и исходным материалам.'
      : 'Проверьте вывод слайда и указанные исходные материалы.',
    noFindings: 'Проблем нет.',
    reviewOutcome: (value: string) => value === 'pass' ? 'План прошёл проверку' : value === 'revise' ? 'Нужны изменения' : 'Результат проверки не указан',
    findingSeverity: (value: string) => value === 'error' ? 'Ошибка' : value === 'warning' ? 'Предупреждение' : value === 'info' ? 'Информация' : 'Замечание',
    narrativeRole: (value: string) => ({ cover: 'Обложка', setup: 'Контекст', problem: 'Проблема', evidence: 'Данные', solution: 'Решение', architecture: 'Устройство решения', value: 'Результат', closing: 'Заключение', slide: 'Слайд', unknown: 'Роль не указана' } as Record<string, string>)[value] ?? 'Роль не указана',
    visualType: (value: string) => ({ comparison: 'сравнение', table: 'таблица', chart: 'диаграмма', diagram: 'схема', process: 'процесс', image: 'изображение', icon: 'значок', text: 'текст', unknown: 'Тип визуализации не указан' } as Record<string, string>)[value] ?? 'Тип визуализации не указан',
    density: (value: string) => ({ sparse: 'свободная', balanced: 'сбалансированная', dense: 'плотная', unknown: 'Плотность не указана' } as Record<string, string>)[value] ?? 'Плотность не указана',
    targetType: (value: string) => ({ deck: 'презентация', slide: 'слайд', 'visual-slot': 'визуальный блок', block: 'элемент' } as Record<string, string>)[value] ?? 'элемент',
    reviewLabel: 'Проверка плана',
    noPlanFindings: 'Проблем с планом нет.',
    sourceWarningCount: (count: number) => `Предупреждений по материалам: ${count}`,
    sourceWarningSummary: 'Некоторые исходные материалы распознаны частично или требуют внимания. Проверьте их состояние в списке файлов.',
    sourceNotSelected: 'Источник не указан',
    planUpdated: (date: string) => `Сохранён ${date}`,
    generatedTitle: 'План презентации',
    slideIndex: (index: string) => `СЛАЙД ${index}`,
    planChanged: 'План изменён · можно создать заново',
    readyToGenerate: 'Можно создавать слайды',
    waiting: 'Ожидает готового плана',
  },
  generation: {
    eyebrow: 'СОЗДАНИЕ СЛАЙДОВ',
    title: 'Варианты и проверка слайдов',
    description: 'Для каждого слайда готовятся варианты A/B/C. Выбор варианта не запускает планирование повторно.',
    cancel: 'Остановить создание',
    resume: 'Продолжить создание',
    generated: 'Создано',
    generate: 'Создать варианты слайдов',
    loading: 'Загружаем сохранённое состояние…',
    incompletePlan: 'Сначала завершите и сохраните план презентации.',
    slideProgress: (ready: number, total: number) => `Готово слайдов: ${ready} из ${total}`,
    workingOnSlide: (index: number | undefined) => `Создаём слайд ${index ?? ''} и готовим предпросмотр…`,
    defaultTrack: 'Вариант для всей презентации',
    track: (variant: string, recommended: boolean) => `${variant}${recommended ? ' · рекомендуем' : ''}`,
    slide: (index: string) => `СЛАЙД ${index}`,
    variant: (variant: string) => `Вариант ${variant}`,
    recommended: 'Рекомендуем',
    selected: (variant: string) => `Выбран ${variant}`,
    choose: (variant: string) => `Выбрать ${variant}`,
    locked: (variant: string) => `Закреплён ${variant}`,
    lock: (variant: string) => `Закрепить ${variant}`,
    unlock: (variant: string) => `Снять закрепление ${variant}`,
    previewAlt: (index: number, variant: string) => `Предпросмотр слайда ${index}, вариант ${variant}`,
    slideVariantLabel: (index: number, variant: string) => `Слайд ${index}, ${ru.generation.variant(variant)}`,
    preparingPreview: 'Готовим предпросмотр…',
    noPreview: 'Предпросмотр пока недоступен',
    textSlide: 'Текстовый слайд',
    visual: (status: string) => `Визуальный блок: ${status}`,
    blockingLayoutNotes: (count: number) => `Блокирующих проблем макета: ${count}`,
    layoutWarnings: (count: number) => `Замечаний макета: ${count}`,
    approximateLayoutNotes: (count: number) => `Предупреждения предпросмотра: ${count}`,
    unclassifiedLayoutNotes: (count: number) => `Непроверенных замечаний предпросмотра: ${count}`,
    approximateLayoutDetail: 'Метрики текста в предпросмотре приблизительны и сами по себе не подтверждают переполнение PPTX.',
    templateBleedDetail: 'Элемент унаследован из исходного шаблона и слегка выходит за границы холста; это замечание сохранено отдельно от ошибок генерации.',
    blockingLayoutDetail: 'Проверка предпросмотра отметила возможную проблему геометрии. Проверьте этот слайд перед экспортом.',
    genericLayoutWarningDetail: 'Предпросмотр обнаружил замечание к макету. Проверьте слайд визуально.',
    auditCounts: (count: number) => `Проблем аудита: ${count}`,
    auditSummary: (errors: number, warnings: number) => errors === 0 && warnings === 0
      ? 'Проверка пройдена'
      : `Найдено проблем: ${errors + warnings} · ошибок: ${errors} · предупреждений: ${warnings}`,
    audit: 'Аудит качества',
    deterministicAudit: 'Детерминированная проверка',
    applyFix: 'Применить безопасное исправление',
    replan: 'Нужен новый план',
    noAuditFindings: 'Аудит не обнаружил проблем.',
    findingUnknown: 'Описание проблемы недоступно.',
    auditRuleMessages: {
      'integrity.title-only-slide': 'На слайде есть заголовок, но нет поясняющего текста или визуальных данных.',
      'geometry.bounds': 'Область слайда выходит за границы макета.',
      'geometry.out-of-bounds': 'Элемент выходит за границы слайда.',
      'geometry.overlap': 'Элементы слайда перекрываются.',
      'geometry.text-slots-overlap': 'Области заголовка и основного текста перекрываются.',
      'geometry.visual-slot-overlap': 'Визуальный блок перекрывает текст.',
      'integrity.blank-slide': 'На слайде нет видимого текста.',
      'integrity.placeholder-text': 'На слайде остался текст-заполнитель шаблона.',
      'integrity.broken-provenance': 'Ссылка на исходные материалы не найдена.',
      'fidelity.numeric': 'Число или дата на слайде не подтверждены исходными материалами.',
      'fidelity.unsupported-number': 'На слайде есть число без подтверждения в исходных материалах.',
      'density.excessive-bullets': 'На слайде слишком много пунктов списка.',
      'density.long-bullet-copy': 'Пункт списка может не поместиться в отведённой области.',
      'density.table': 'Таблица может быть слишком плотной для чтения.',
      'density.table-limits': 'Размер таблицы превышает текущий порог проверки.',
      'visualization.unresolved': 'Запрошенный визуальный блок не удалось подготовить из исходных данных.',
      'integrity.chart-labels-legend': 'Для диаграммы не хватает заголовка, подписей или легенды.',
      'integrity.chart-unit-unknown': 'Для значений диаграммы не указана единица измерения.',
      'fidelity.chart-source-reference': 'Источник данных диаграммы не подтверждён.',
      'fidelity.chart-label-provenance': 'Подписи диаграммы не совпадают с исходными данными.',
      'fidelity.chart-numeric-provenance': 'Числа диаграммы не подтверждены исходными данными.',
      'fidelity.kpi-numeric-provenance': 'Значение показателя не подтверждено исходными данными.',
      'integrity.process-source-reference': 'Шаги схемы или процесса не связаны с исходными материалами.',
      'integrity.visual-asset-reference': 'Изображение не совпадает с указанным исходным материалом.',
      'integrity.duplicate-slide-content': 'Содержимое слайда повторяет другой слайд.',
      'template.invalid-layout': 'Для слайда выбранный макет недоступен в шаблоне.',
      'template.font-color-contrast': 'Контраст текста и фона может быть недостаточным.',
      'rendered-overflow': 'Текст или объект может обрезаться при отображении.',
      'fidelity.semantic': 'Содержимое слайда требует проверки на соответствие заголовку.',
      'fidelity.table-source-reference': 'Значения таблицы не связаны с исходными материалами.',
      'density.chart-series': 'В диаграмме слишком много рядов для удобного сравнения.',
    } as Record<string, string>,
    withheld: 'Варианты не созданы',
    withheldReason: 'В шаблоне не найдена безопасная подходящая композиция. Выберите другой шаблон или измените план.',
    failed: 'Не удалось создать',
    pending: 'В очереди',
    rendering: 'Создаём варианты и предпросмотр…',
    ready: 'Готово',
    error: 'Не удалось создать слайд',
    stale: 'План устарел',
    failedStatus: 'Создание остановлено из-за ошибки',
    cancelled: 'Создание остановлено',
    preparing: 'Подготавливаем слайды…',
    completed: 'Все слайды готовы',
    exportTitle: 'Проверка и экспорт',
    exportHeading: 'Скачать презентацию',
    exportDescription: 'PowerPoint-файл можно редактировать. PDF и HTML подходят для просмотра; оформление может отличаться.',
    editablePowerPoint: 'Редактируемый PowerPoint',
    downloadPptx: 'Скачать PPTX',
    downloadPdf: 'PDF · для просмотра',
    downloadHtml: 'HTML · для просмотра',
    otherVariants: 'Скачать отдельный вариант',
    previousDownloads: 'Подготовленные файлы',
    resultReady: 'Презентация готова',
    resultSummary: (slides: number) => {
      const lastTwo = slides % 100;
      const form = slides % 10 === 1 && lastTwo !== 11 ? 'слайд'
        : slides % 10 >= 2 && slides % 10 <= 4 && (lastTwo < 12 || lastTwo > 14) ? 'слайда' : 'слайдов';
      return `${slides} ${form} · три варианта для проверки`;
    },
    assembling: 'Собираем файл…',
    exportSelected: 'Скачать выбранную презентацию',
    exportTrack: (mode: string) => `Скачать вариант ${mode}`, 
    exportAction: (mode: string, format: 'pptx' | 'pdf' | 'html') => `${mode === 'selected' ? 'Выбранная' : `Вариант ${mode}`} · ${format.toUpperCase()}`,
    downloadSelected: 'Скачать выбранную презентацию',
    downloadTrack: (mode: string) => `Скачать вариант ${mode}`,
    validated: 'Структура файла проверена · отображение в PowerPoint не проверялось',
    noGeneration: 'Варианты и предпросмотр появятся здесь по мере готовности слайдов.',
    fileDownloaded: 'Файл готов к скачиванию',
  },
  errors: {
    generic: 'Не удалось выполнить действие. Попробуйте ещё раз.',
    retry: 'Повторить',
    uploadTooLarge: 'Файл превышает допустимый размер. Выберите файл поменьше.',
    requestTooLarge: 'Слишком много данных для обработки. Выберите меньше материалов или сократите текст.',
    unsupportedFile: 'Этот формат нельзя разобрать как текст. Его можно оставить как вложение или выбрать поддерживаемый файл.',
    template: 'Не удалось проанализировать структуру шаблона. Проверьте файл и повторите попытку.',
    semantic: 'Сервис анализа временно недоступен. Проверьте подключение и повторите попытку.',
    plan: 'Не удалось составить план. Проверьте бриф и выбранные материалы.',
    variant: 'Этот вариант не создан: в шаблоне не найдено безопасной подходящей композиции.',
    render: 'Не удалось подготовить слайд или его предпросмотр. Готовые слайды сохранены.',
    export: 'Не удалось собрать презентацию. Проверьте состояние слайдов и повторите попытку.',
    notFound: 'Элемент не найден. Обновите состояние проекта и повторите попытку.',
    conflict: 'Состояние изменилось. Обновите проект и повторите действие.',
    invalidRequest: 'Не удалось обработать запрос. Проверьте введённые данные.',
    fileRead: 'Не удалось открыть файл в предпросмотре. Выберите другой материал или загрузите файл снова.',
    diagnostics: 'Технические сведения',
    code: (value: string) => `Код: ${value}`,
    status: (value: number) => `HTTP ${value}`,
  },
  status: {
    uncompiled: 'Не анализировался',
    ready: 'Готово',
    stale: 'Устарело',
    failed: 'Ошибка',
    unavailable: 'Недоступно',
    loading: 'Загружаем…',
    unconfigured: 'Не настроено',
    planning: 'Составляем план…',
    generating: 'Создаём слайды…',
    preparing: 'Подготавливаем…',
    completed: 'Завершено',
    cancelled: 'Остановлено',
    pending: 'В очереди',
    rendering: 'Создаём предпросмотр…',
    withheld: 'Не создано',
    locked: 'Закреплено',
    selected: 'Выбрано',
    pass: 'План прошёл проверку',
    needsRevision: 'Нужны изменения',
    warning: 'Предупреждение',
    error: 'Ошибка',
    info: 'Информация',
    unknown: 'Нет данных',
  },
  validation: {
    maxFiles: 'Можно выбрать не более 12 исходных файлов.',
    filesRange: 'Можно выбрать не более 12 исходных файлов.',
    briefRequired: 'Опишите задачу презентации.',
    slideCount: 'Укажите целое число слайдов от 1 до 30.',
    preferences: 'Укажите не более 12 пожеланий длиной до 200 символов каждое.',
  },
  contentSource: {
    parsed: 'Распознано',
    assetOnly: 'Только вложение',
    unsupported: 'Не поддерживается',
    notParsed: 'Ещё не проверено',
  },
  workflow: {
    action: 'Сгенерировать презентацию',
    working: 'Создаём презентацию…',
    openResult: 'Результат готов',
    requireTemplateAndTask: 'Выберите шаблон PowerPoint и опишите задачу. Исходные материалы можно не добавлять.',
    stages: {
      analyzing_template: 'Анализируем шаблон',
      understanding_template: 'Изучаем структуру шаблона',
      planning: 'Создаём и проверяем план',
      generating: (ready: number, total: number | null) => total === null ? 'Создаём варианты' : `Создаём слайды: ${ready} из ${total}`,
      contextual_audit: 'Проверяем смысл и связность',
      ready: 'Презентация готова к просмотру',
      failed: 'Не удалось завершить создание презентации',
    },
    error: 'Не удалось создать презентацию. Проверьте шаблон и задачу, затем повторите попытку.',
    audit: 'Контекстуальная проверка',
    contextualAudit: 'Контекстуальная проверка',
    auditClean: 'Замечаний нет',
    auditFindings: (count: number) => `Замечаний: ${count}`,
    auditStale: 'Выбранные варианты изменились после смысловой проверки.',
    auditRerun: 'Проверить выбранные варианты',
    suggestionsOnly: 'Это подсказки для проверки. Они не меняют факты и не исправляют слайды автоматически.',
    actionMessages: {
      REVIEW_TITLE: 'Проверьте заголовок и основной вывод.',
      CHECK_SOURCE: 'Сверьте утверждение с исходными материалами.',
      SIMPLIFY_SLIDE: 'Уточните главную мысль слайда.',
      REVIEW_VISUAL: 'Проверьте, подходит ли тип визуализации.',
      REMOVE_INSTRUCTIONS: 'Проверьте и удалите служебный текст.',
      CHECK_SPELLING: 'Проверьте написание слов на слайдах.',
      CHECK_LANGUAGE: 'Проверьте единообразие языка и стиля.',
      REVIEW_TABLE: 'Проверьте пользу строк, категорий и легенды.',
      REVIEW_NARRATIVE: 'Проверьте связь с соседними слайдами.',
      REVIEW_DUPLICATE: 'Проверьте, добавляет ли повторяющийся слайд новый вывод.',
    },
    slideLabel: (index: number) => `Слайд ${index}`,
    deckLabel: 'Вся презентация',
    messages: {
      TITLE_TAKEAWAY_CLEAR: 'Заголовки выражают основные выводы.',
      TITLE_TAKEAWAY_REVIEW: 'Проверьте, выражает ли заголовок главный вывод слайда.',
      TITLE_CONTENT_ALIGNED: 'Содержание соответствует заголовкам.',
      TITLE_CONTENT_MISMATCH: 'Проверьте соответствие заголовка и содержания.',
      FACTS_GROUNDED: 'Факты связаны с исходными материалами.',
      FACTS_UNGROUNDED: 'Проверьте факты по исходным материалам.',
      VISUAL_SEMANTIC_FIT: 'Тип визуализации соответствует содержанию.',
      VISUAL_SEMANTIC_MISMATCH: 'Проверьте, подходит ли выбранный тип визуализации.',
      LANGUAGE_CONSISTENT: 'Язык и стиль выдержаны последовательно.',
      LANGUAGE_MIXED: 'Проверьте единообразие языка и стиля.',
      NARRATIVE_CONTINUOUS: 'Переходы между слайдами связны.',
      NARRATIVE_BREAK: 'Проверьте переход между соседними слайдами.',
      NO_REDUNDANCY: 'Повторяющихся выводов не найдено.',
      CONTENT_REPEATED: 'Проверьте, не повторяет ли слайд уже раскрытую мысль.',
      NO_PROMPT_GARBAGE: 'Инструкций и служебных фрагментов не найдено.',
      PROMPT_GARBAGE: 'Удалите случайно попавшие в презентацию инструкции или служебный текст.',
      SUMMARY_CLEAR: 'Смысл каждого слайда можно кратко сформулировать.',
      SUMMARY_UNCLEAR: 'Уточните основную мысль слайда.',
      SPELLING_CLEAR: 'Явных орфографических замечаний не найдено.',
      SPELLING_REVIEW: 'Проверьте написание слов в видимом тексте.',
      TABLE_LEGEND_USEFUL: 'Строки таблиц и элементы легенды поддерживают мысль слайда.',
      TABLE_LEGEND_REVIEW: 'Проверьте, помогают ли строки таблиц и легенда понять вывод.',
    },
  },
} as const;

export function formatUiDateTime(date: Date): string {
  return date.toLocaleString('ru-RU');
}

export type UiOperation = 'generic' | 'upload' | 'template' | 'planning' | 'generation' | 'export' | 'file';

export function friendlyErrorMessage(code: string | undefined, status: number, operation: UiOperation = 'generic'): string {
  const normalized = (code ?? '').toUpperCase();
  if (/LIMIT_FILE_SIZE|UPLOAD_TOO_LARGE/.test(normalized) || status === 413 && operation === 'upload') return ru.errors.uploadTooLarge;
  if (status === 413) return operation === 'planning' ? ru.errors.plan : ru.errors.requestTooLarge;
  if (/TOO_LARGE/.test(normalized)) return operation === 'planning' ? ru.errors.plan : ru.errors.requestTooLarge;
  if (/UNSUPPORTED_FORMAT|UNSUPPORTED_FILE|INVALID_UTF8|NOT_PARSED/.test(normalized)) return ru.errors.unsupportedFile;
  if (/VARIANTS_NOT_DISTINCT|VARIANT_NOT_READY/.test(normalized)) return ru.errors.variant;
  if (/EXPORT|POWERPOINT_ASSEMBLY/.test(normalized) || operation === 'export') return ru.errors.export;
  if (/SEMANTIC|INFERENCE|PROVIDER|TIMEOUT|DEADLINE|CONFIGURATION|STRUCTURED_OUTPUT|INVALID_JSON|EMPTY_RESPONSE|SERVICE_UNAVAILABLE|AUTH_ERROR|RATE_LIMIT/.test(normalized)
      || status === 502 || status === 503 || status === 504) return ru.errors.semantic;
  if (/TEMPLATE|PPTX|OOXML/.test(normalized) || operation === 'template') return ru.errors.template;
  if (/PLAN|BRIEF|CONTENT|SUPERVISOR|SCHEMA/.test(normalized) || operation === 'planning') return ru.errors.plan;
  if (/RENDER|PREVIEW|AUDIT/.test(normalized) || operation === 'generation') return ru.errors.render;
  if (status === 404 || /NOT_FOUND/.test(normalized)) return ru.errors.notFound;
  if (status === 409 || /STALE|LOCKED|CONFLICT/.test(normalized)) return ru.errors.conflict;
  if (status >= 400 && status < 500) return ru.errors.invalidRequest;
  return ru.errors.generic;
}

export function templateStatusLabel(status: string | null | undefined): string {
  if (status === 'ready') return ru.template.ready;
  if (status === 'stale') return ru.template.stale;
  if (status === 'failed') return ru.template.failed;
  if (status === 'uncompiled') return ru.template.uncompiled;
  return ru.template.unavailable;
}

export function planningStatusLabel(status: string | null | undefined): string {
  if (status === 'ready_for_planning') return ru.planning.readyForPlanning;
  if (status === 'ready') return ru.status.ready;
  if (status === 'stale') return ru.status.stale;
  if (status === 'failed') return ru.status.failed;
  if (status === 'planning' || status === 'generating') return ru.planning.understanding;
  if (status === 'unconfigured') return ru.status.unconfigured;
  return ru.planning.unavailable;
}

export function generationStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'preparing': return ru.generation.preparing;
    case 'generating': return ru.status.generating;
    case 'completed': return ru.generation.completed;
    case 'failed': return ru.generation.failedStatus;
    case 'cancelled': return ru.generation.cancelled;
    case 'stale': return ru.generation.stale;
    default: return ru.status.unknown;
  }
}

export function slidePackStatusLabel(status: string, failureCode?: string | null): string {
  if (failureCode === 'VARIANTS_NOT_DISTINCT') return ru.generation.withheld;
  switch (status) {
    case 'pending': return ru.generation.pending;
    case 'rendering': return ru.generation.rendering;
    case 'ready': return ru.generation.ready;
    case 'failed': return ru.generation.failed;
    default: return ru.status.unknown;
  }
}

export function variantStatusLabel(status: string): string {
  if (status === 'withheld') return ru.generation.withheld;
  if (status === 'ready') return ru.status.ready;
  if (status === 'failed') return ru.generation.failed;
  if (status === 'pending') return ru.generation.pending;
  return ru.status.unknown;
}

export function productWorkflowStageLabel(stage: string, readySlides: number, totalSlides: number | null): string {
  switch (stage) {
    case 'analyzing_template': return ru.workflow.stages.analyzing_template;
    case 'understanding_template': return ru.workflow.stages.understanding_template;
    case 'planning': return ru.workflow.stages.planning;
    case 'generating': return ru.workflow.stages.generating(readySlides, totalSlides);
    case 'contextual_audit': return ru.workflow.stages.contextual_audit;
    case 'ready': return ru.workflow.stages.ready;
    case 'failed': return ru.workflow.stages.failed;
    default: return ru.status.unknown;
  }
}

export function auditFindingMessage(ruleId: string): string {
  return ru.generation.auditRuleMessages[ruleId] ?? ru.generation.findingUnknown;
}
