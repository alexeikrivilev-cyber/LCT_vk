(() => {
  'use strict';

  const slides = [
    { label: 'Проблема', title: 'Переход от шаблона к готовым слайдам занимает время', points: ['Композицию приходится собирать вручную', 'Единый стиль сложно удержать во всей колоде'], steps: ['Шаблон', 'Материалы', 'Слайды'] },
    { label: 'Решение', title: 'LCT связывает содержание и дизайн шаблона', points: ['Анализирует структуру и визуальные правила', 'Собирает редактируемые варианты'], steps: ['Понять', 'Спланировать', 'Создать'] },
    { label: 'Анализ шаблона', title: 'Сначала система изучает устройство PPTX', points: ['Композиции и геометрию', 'Типографику и роли элементов'], steps: ['Структура', 'Макеты', 'Правила'] },
    { label: 'Варианты', title: 'Один смысл — три композиционных решения', points: ['Сценарная подача', 'Свободная подача', 'Структура из карточек'], steps: ['A', 'B', 'C'] },
    { label: 'Результат', title: 'Готовая презентация остаётся редактируемой', points: ['Нативные объекты PowerPoint', 'Проверка перед экспортом'], steps: ['Проверить', 'Выбрать', 'Экспортировать'] },
  ];
  const stages = ['Анализируем материалы', 'Строим структуру', 'Подбираем композиции', 'Создаём варианты', 'Проверяем результат', 'Готово'];
  const state = { templateReady: false, sourceReady: false, activeSlide: 0, variant: 'A', timer: 0 };
  const $ = (selector) => document.querySelector(selector);
  const templateCard = $('#template-card');
  const sourceCard = $('#source-card');
  const generateButton = $('#generate-button');
  const toast = $('#toast');

  function updateGenerateAvailability() {
    generateButton.disabled = !(state.templateReady && state.sourceReady && $('#brief').value.trim());
  }

  $('#template-button').addEventListener('click', () => {
    state.templateReady = true;
    templateCard.classList.add('ready');
    $('#template-state').lastElementChild.textContent = 'Шаблон разобран в демонстрационном режиме';
    $('#template-summary').hidden = false;
    updateGenerateAvailability();
  });

  $('#source-button').addEventListener('click', () => {
    state.sourceReady = true;
    sourceCard.classList.add('ready');
    $('#source-state').lastElementChild.textContent = 'Источник добавлен локально';
    $('#source-summary').hidden = false;
    updateGenerateAvailability();
  });

  $('#brief').addEventListener('input', updateGenerateAvailability);

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function renderThumbnails() {
    const rail = $('#slide-rail');
    rail.replaceChildren();
    slides.forEach((slide, index) => {
      const button = createElement('button', `thumb-button${index === state.activeSlide ? ' active' : ''}`);
      button.type = 'button';
      button.setAttribute('aria-current', index === state.activeSlide ? 'true' : 'false');
      button.setAttribute('aria-label', `Слайд ${index + 1}: ${slide.label}`);
      button.dataset.variant = state.variant;
      button.append(createElement('span', 'thumb-number', String(index + 1).padStart(2, '0')), createElement('span', 'thumb-mini'));
      button.append(createElement('span', 'thumb-title', slide.label));
      button.addEventListener('click', () => { state.activeSlide = index; renderResult(); });
      rail.append(button);
    });
  }

  function renderSlide() {
    const frame = $('#slide-frame');
    const slide = slides[state.activeSlide];
    const canvas = createElement('article', `slide-canvas variant-${state.variant}`);
    canvas.setAttribute('aria-label', `${slide.label}, вариант ${state.variant}`);
    canvas.append(createElement('span', 'slide-topline', `LCT  /  ${slide.label}`));
    canvas.append(createElement('h3', 'slide-title', slide.title));
    if (state.variant === 'A') {
      const list = createElement('ol', 'timeline');
      slide.steps.forEach((item, index) => {
        const entry = createElement('li', '', item);
        entry.append(createElement('span', '', `Этап 0${index + 1}`));
        list.append(entry);
      });
      const visual = createElement('div', 'slide-visual');
      visual.append(list);
      canvas.append(visual);
      canvas.append(createElement('p', 'slide-body', slide.points.join(' · ')));
    } else if (state.variant === 'B') {
      canvas.append(createElement('p', 'slide-body', slide.points.join(' · ')));
      const visual = createElement('div', 'split-visual');
      visual.append(createElement('strong', '', 'LCT'), createElement('span', '', 'от замысла к слайдам'));
      canvas.append(visual);
    } else {
      const grid = createElement('div', 'card-visual');
      slide.points.slice(0, 3).forEach((point, index) => {
        const card = createElement('div', 'mini-card');
        card.append(createElement('b', '', `0${index + 1}`), createElement('span', '', point));
        grid.append(card);
      });
      if (slide.points.length < 3) {
        const card = createElement('div', 'mini-card');
        card.append(createElement('b', '', '03'), createElement('span', '', 'Проверка и экспорт'));
        grid.append(card);
      }
      canvas.append(grid);
    }
    canvas.append(createElement('span', 'slide-footer', 'КОНСТРУКТОР ПРЕЗЕНТАЦИЙ'));
    canvas.append(createElement('span', 'slide-code', `${String(state.activeSlide + 1).padStart(2, '0')} / 05`));
    frame.replaceChildren(canvas);
    $('#slide-counter').textContent = `Слайд ${String(state.activeSlide + 1).padStart(2, '0')} из 05`;
  }

  function renderResult() {
    renderThumbnails();
    renderSlide();
    document.querySelectorAll('.variant-button').forEach((button) => {
      const active = button.dataset.variant === state.variant;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  document.querySelectorAll('.variant-button').forEach((button) => {
    button.addEventListener('click', () => {
      state.variant = button.dataset.variant;
      renderResult();
    });
  });

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('visible');
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(() => toast.classList.remove('visible'), 2300);
  }

  document.querySelectorAll('.export-button').forEach((button) => {
    button.addEventListener('click', () => {
      $('#export-hint').textContent = `Экспорт ${button.dataset.format} подготовлен в демонстрационном режиме.`;
      showToast(`Экспорт ${button.dataset.format} подготовлен`);
    });
  });

  function runDemoGeneration() {
    if (generateButton.disabled) return;
    const panel = $('#generation-state');
    const list = $('#generation-steps');
    const fill = $('#generation-progress-fill');
    const title = $('#generation-title');
    generateButton.disabled = true;
    panel.hidden = false;
    $('#result-section').hidden = true;
    list.replaceChildren(...stages.map((stage) => createElement('li', '', stage)));
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const items = [...list.children];
    let index = 0;
    const tick = () => {
      items.forEach((item, itemIndex) => item.className = itemIndex < index ? 'done' : itemIndex === index ? 'active' : '');
      fill.style.width = `${Math.round(index / (stages.length - 1) * 100)}%`;
      title.textContent = index === stages.length - 1 ? 'Демонстрационный результат готов' : stages[index] + '…';
      if (index < stages.length - 1) {
        index += 1;
        window.setTimeout(tick, 620);
      } else {
        panel.dataset.done = 'true';
        $('#result-section').hidden = false;
        renderResult();
        generateButton.disabled = false;
        $('#result-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };
    tick();
  }

  generateButton.addEventListener('click', runDemoGeneration);
  updateGenerateAvailability();
})();
