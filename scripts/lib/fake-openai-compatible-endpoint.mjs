import { createServer } from 'node:http';
import { buildOfflineQualificationPlan } from './offline-qualification-plan.mjs';

function completion(model, value, finishReason = 'stop') {
  return {
    id: 'offline-fake-request',
    model,
    choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content: typeof value === 'string' ? value : JSON.stringify(value) } }],
    usage: { prompt_tokens: 32, completion_tokens: 16 },
  };
}

function conciseHeading(value, limit = 40) {
  const heading = String(value ?? '').replace(/^\s{0,3}#{1,6}\s+/u, '').replace(/\s+/gu, ' ').trim();
  if (heading.length <= limit) return heading;
  const bounded = heading.slice(0, limit + 1);
  const boundary = bounded.lastIndexOf(' ');
  return (boundary > 0 ? bounded.slice(0, boundary) : bounded.slice(0, limit)).trim();
}

function sourceBodyPoints(section, fallback) {
  const sentences = (section?.contentUnits ?? []).flatMap((unit) => String(unit.text ?? '')
    .replace(/^\s{0,3}[-*+]\s+/gmu, '')
    .split(/(?<=[.!?])\s+/u))
    .map((text) => text.replace(/\s+/gu, ' ').trim())
    .filter((text) => text.length > 0);
  const selected = [...new Set(sentences)].slice(0, 4);
  return (selected.length ? selected : fallback).map((text) => ({ text, origin: 'generated-from-brief', evidenceRefs: [] }));
}

function familyForPlannedSlide(evidence, order, slide) {
  const budgets = evidence.contentBudgets;
  if (!budgets || budgets.version !== 'fit-aware-copy-budget.v1') return null;
  const row = budgets.slides?.find((item) => item.order === order);
  const available = new Set(row?.candidateFamilyKeys ?? []);
  const families = (budgets.candidateFamilies ?? []).filter((item) => available.has(item.familyKey));
  const roleArchetypes = slide.narrativeRole === 'opening' ? ['cover', 'visual-led', 'content']
    : slide.narrativeRole === 'closing' ? ['closing', 'section-divider', 'content', 'visual-led']
      : slide.narrativeRole === 'section-divider' ? ['section-divider', 'content']
        : slide.narrativeRole === 'agenda' ? ['content', 'content-split', 'content-dense', 'section-divider']
          : ['content', 'content-split', 'content-dense', 'metric-evidence', 'table-data', 'visual-led'];
  const applicable = families.filter((item) => roleArchetypes.includes(item.archetype));
  const contentModes = slide.semanticVisualType === 'table' || slide.semanticVisualType === 'comparison' ? ['table', 'mixed']
    : slide.semanticVisualType === 'chart' || slide.semanticVisualType === 'kpi' ? ['chart', 'metrics', 'mixed']
      : slide.semanticVisualType === 'diagram' || slide.semanticVisualType === 'process' || slide.semanticVisualType === 'timeline' ? ['diagram', 'mixed']
        : slide.semanticVisualType === 'image' ? ['image', 'mixed'] : ['text', 'mixed'];
  const roleMatched = applicable.length ? applicable : families;
  const modeMatched = roleMatched.filter((item) => contentModes.some((mode) => item.supportedContentModes?.includes(mode)));
  const candidates = modeMatched.length ? modeMatched : roleMatched;
  const copyFit = (family) => {
    const titleFits = Array.from(slide.takeaway).length <= (family.titleRegion?.maxCharacters ?? 0);
    const bodyLimit = family.body?.maxCharacters ?? 0;
    const pointLimit = Math.min(180, family.body?.maxCharactersPerPoint ?? 0);
    const pointLimitCount = family.body?.maxPoints ?? 0;
    let total = 0;
    let fittingPoints = 0;
    for (const point of slide.bodyPoints ?? []) {
      const sentence = String(point.text).split(/(?<=[.!?])\s+/u).map((value) => value.trim()).find((value) => Array.from(value).length <= pointLimit);
      if (!sentence || fittingPoints >= pointLimitCount || total + Array.from(sentence).length > bodyLimit) continue;
      total += Array.from(sentence).length;
      fittingPoints += 1;
    }
    const roleRank = roleArchetypes.indexOf(family.archetype);
    return { titleFits, fittingPoints, roleRank: roleRank < 0 ? roleArchetypes.length : roleRank,
      capacity: (family.body?.maxCharacters ?? 0) + (family.titleRegion?.maxCharacters ?? 0) };
  };
  return [...candidates].sort((left, right) => {
    const a = copyFit(left);
    const b = copyFit(right);
    return Number(b.titleFits) - Number(a.titleFits)
      || b.fittingPoints - a.fittingPoints
      || a.roleRank - b.roleRank
      || b.capacity - a.capacity;
  })[0] ?? null;
}

function fitGeneratedCopy(slide, family) {
  if (!family) return slide;
  // Source-backed claims are never shortened or removed by the deterministic
  // fake planner. If they do not fit, the same runtime budget validator must
  // reject the draft so a semantic planner can make a source-preserving edit.
  if (slide.contentRefs.length > 0) return slide;
  const titleLimit = Math.max(1, family.titleRegion?.maxCharacters ?? 40);
  const bodyLimit = Math.max(0, family.body?.maxCharacters ?? 0);
  const pointLimit = Math.max(1, Math.min(180, family.body?.maxCharactersPerPoint ?? 180));
  const pointCount = Math.max(1, Math.min(4, family.body?.maxPoints ?? 4));
  const fitted = [];
  let used = 0;
  for (const point of slide.bodyPoints ?? []) {
    const candidates = String(point.text).split(/(?<=[.!?])\s+/u).map((value) => value.trim()).filter(Boolean);
    const fullText = Array.from(point.text).length <= pointLimit ? point.text : candidates.find((value) => Array.from(value).length <= pointLimit);
    if (!fullText) continue;
    const length = Array.from(fullText).length;
    if (used + length > bodyLimit || fitted.length >= pointCount) continue;
    fitted.push({ ...point, text: fullText });
    used += length;
  }
  // Removing complete lower-priority generated sentences is safe. If none
  // can fit, preserve the original wording and let runtime validation fail
  // closed instead of inventing filler or dropping the slide's takeaway.
  if (fitted.length > 0 && Array.from(slide.takeaway).length <= titleLimit) slide.bodyPoints = fitted;
  return slide;
}

function sourceVisualType(section) {
  const units = section?.contentUnits ?? [];
  if (units.some((unit) => ['table', 'table-row', 'table-cell'].includes(String(unit.kind ?? '').toLowerCase()))) return 'table';
  const text = units.map((unit) => String(unit.text ?? '')).join('\n');
  const orderedItems = text.split(/\r?\n/u).filter((line) => /^\s*(?:\d+[.)]|[-*+])\s+\S/u.test(line));
  if (orderedItems.length >= 2) return 'process';
  if (/(?:сравнен|сопоставлен|вариант\s+[а-яa-z]|преимуществ\s+и\s+ограничен)/iu.test(text)) return 'comparison';
  return 'none';
}

function deterministicPlanningResponse(request) {
  const schemaName = request.response_format?.json_schema?.name;
  if (schemaName === 'lct_worker_smoke_v1') {
    return completion(request.model, { status: 'ok', summary: 'Strict JSON response passed.', nextAction: 'Continue with planning.' });
  }
  const evidence = JSON.parse(request.messages.at(-1).content);
  if (schemaName === 'deck_plan_draft_v2' || schemaName === 'deck_plan_draft_v3' || schemaName === 'deck_plan_draft_v4') {
    const sourceKinds = new Map((evidence.contentIR.sources ?? []).map((source) => [source.id, source.kind]));
    const hasSourceInventory = sourceKinds.size > 0;
    const imageUnits = (evidence.contentIR.mediaAssets ?? []).filter((asset) => typeof asset.id === 'string');
    const allTextUnits = evidence.contentIR.units.filter((unit) => unit.kind !== 'media-reference'
      && (!hasSourceInventory || sourceKinds.get(unit.sourceId) === 'text')
      && typeof unit.text === 'string' && unit.text.trim());
    const textUnits = allTextUnits;
    const hasHeadings = textUnits.some((unit) => unit.kind === 'heading');
    const sections = !hasHeadings ? textUnits.flatMap((unit) => {
      if (!unit.text.includes('\n')) {
        return [{ heading: null, contentUnits: [unit] }];
      }
      const paragraphs = unit.text.split(/\r?\n+/u).map((text) => text.trim()).filter(Boolean);
      return (paragraphs.length ? paragraphs : [unit.text]).map((text) => ({ heading: null, contentUnits: [{ ...unit, text }] }));
    }) : [];
    let section = null;
    for (const unit of hasHeadings ? textUnits : []) {
      if (unit.kind === 'media-reference' || typeof unit.text !== 'string' || !unit.text.trim()) continue;
      if (unit.kind === 'heading') {
        if (section?.contentUnits.length) sections.push(section);
        section = { heading: unit, contentUnits: [] };
        continue;
      }
      section ??= { heading: null, contentUnits: [] };
      section.contentUnits.push(unit);
    }
    if (section?.contentUnits.length) sections.push(section);
    if (!sections.length) sections.push({ heading: null, contentUnits: [] });
    const imageTargetSectionIndex = imageUnits.length > 0
      ? sections.findIndex((candidate) => /(?:фото|фотограф|изображен|иллюстрац)/iu.test(
        [candidate.heading?.text, ...candidate.contentUnits.map((unit) => unit.text)]
          .filter((text) => typeof text === 'string').join(' ')))
      : -1;
    const count = Math.max(1, Math.min(30, evidence.requestedSlideCount ?? 1));
    const syntheticStory = buildOfflineQualificationPlan(count).slides;
    const slides = Array.from({ length: count }, (_, index) => {
      const sectionIndex = count === 1 ? 0 : Math.round(index * (sections.length - 1) / (count - 1));
      const selectedSection = sections[sectionIndex % sections.length];
      const story = syntheticStory[index];
      if (!story) throw new RangeError('Fake story does not cover the requested slide count');
      const mediaRefs = imageUnits.length > 0 && sectionIndex === imageTargetSectionIndex
        ? [imageUnits[0].id]
        : [];
      const plannedSlide = {
        narrativeRole: story.narrativeRole,
        purpose: story.purpose,
        takeaway: selectedSection.heading ? conciseHeading(selectedSection.heading.text) : story.takeaway,
        contentRefs: [...(selectedSection.heading ? [selectedSection.heading] : []), ...selectedSection.contentUnits]
          .slice(0, 5).map((unit) => unit.id),
        bodyPoints: sourceBodyPoints(selectedSection, story.bodyPoints.map((point) => point.text)),
        mediaRefs,
        semanticVisualType: mediaRefs.length ? 'image' : hasHeadings ? sourceVisualType(selectedSection) : story.semanticVisualType,
        targetDensity: story.targetDensity,
      };
      return fitGeneratedCopy(plannedSlide, familyForPlannedSlide(evidence, index + 1, plannedSlide));
    });
    return completion(request.model, {
      workingTitle: 'План и рекомендуемое решение',
      narrativeSummary: 'Провести аудиторию от контекста через аргументы к практическому следующему шагу.',
      slides,
    });
  }
  if (schemaName === 'supervisor_plan_review_v1') {
    return completion(request.model, { checkpointVersion: evidence.checkpointVersion, outcome: 'pass', findings: [], operations: [] });
  }
  if (schemaName === 'contextual_deck_audit_v2') {
      const rules = [
        ['titleTakeaway', 'TITLE_TAKEAWAY_CLEAR'],
        ['titleContentAlignment', 'TITLE_CONTENT_ALIGNED'],
        ['oneSentenceSummary', 'SUMMARY_CLEAR'],
        ['factGrounding', 'FACTS_GROUNDED'],
        ['visualSemanticFit', 'VISUAL_SEMANTIC_FIT'],
        ['garbage', 'NO_PROMPT_GARBAGE'],
        ['spelling', 'SPELLING_CLEAR'],
        ['languageConsistency', 'LANGUAGE_CONSISTENT'],
        ['tableLegendUsefulness', 'TABLE_LEGEND_USEFUL'],
        ['narrativeContinuity', 'NARRATIVE_CONTINUOUS'],
        ['redundancy', 'NO_REDUNDANCY'],
      ];
    const firstSlide = evidence.slides?.[0];
    const firstRef = firstSlide?.evidenceRefs?.[0];
    return completion(request.model, {
        schemaVersion: 2,
      findings: rules.map(([ruleId, messageCode]) => ({
        ruleId,
        slideId: firstRef ? firstSlide.slideId : null,
        severity: 'info',
        messageCode,
        evidenceRefs: firstRef ? [firstRef] : [],
        repairable: false,
        suggestedActionCode: null,
      })),
    });
  }
  if (schemaName === 'template_semantic_profile_v1') {
    const repeatedTextCounts = new Map();
    for (const sourceSlide of evidence.slides) for (const element of sourceSlide.elements) {
      if (typeof element.text !== 'string' || !element.text.trim()) continue;
      const key = element.text.trim().replace(/\s+/gu, ' ').toLowerCase();
      repeatedTextCounts.set(key, (repeatedTextCounts.get(key) ?? 0) + 1);
    }
    const slides = evidence.slides.map((slide) => {
      const textElements = slide.elements.filter((element) => typeof element.text === 'string' && element.text.trim());
      const numericFont = (element) => Math.max(0, ...(element.styles?.fontSizesPt ?? []));
      const canvas = evidence.canvas ?? { width: 1, height: 1 };
      const box = (element) => element.geometry ?? { x: 0, y: 0, width: 0, height: 0 };
      const title = [...textElements].sort((left, right) => {
        const role = (element) => /title|subtitle|ctrtitle/i.test(`${element.placeholderRole ?? ''}`) ? 100 : 0;
        const leftBox = box(left);
        const rightBox = box(right);
        const leftScore = role(left) + numericFont(left) * 2 + Math.max(0, 1 - leftBox.y / Math.max(1, canvas.height)) * 8 + leftBox.width / Math.max(1, canvas.width);
        const rightScore = role(right) + numericFont(right) * 2 + Math.max(0, 1 - rightBox.y / Math.max(1, canvas.height)) * 8 + rightBox.width / Math.max(1, canvas.width);
        return rightScore - leftScore || (left.order ?? 0) - (right.order ?? 0);
      })[0] ?? null;
      const bodyCandidates = textElements.filter((element) => {
        if (element === title || !element.geometry || element.kind !== 'shape') return false;
        const geometry = box(element);
        const edgeFurniture = geometry.y <= canvas.height * 0.12 || geometry.y + geometry.height >= canvas.height * 0.92;
        const recurring = (repeatedTextCounts.get(element.text.trim().replace(/\s+/gu, ' ').toLowerCase()) ?? 0)
          >= Math.max(2, Math.ceil(evidence.slides.length * 0.6));
        const areaShare = geometry.width * geometry.height / Math.max(1, canvas.width * canvas.height);
        return !(recurring && edgeFurniture && numericFont(element) <= 12 && geometry.height <= canvas.height * 0.06)
          && (areaShare >= 0.015 || (numericFont(element) >= 16 && areaShare >= 0.006));
      }).sort((left, right) => box(right).width * box(right).height - box(left).width * box(left).height
        || (left.order ?? 0) - (right.order ?? 0));
      const bodyElements = [];
      for (const candidate of bodyCandidates) {
        const candidateBox = box(candidate);
        const overlapsSelected = bodyElements.some((selected) => {
          const selectedBox = box(selected);
          return candidateBox.x < selectedBox.x + selectedBox.width && candidateBox.x + candidateBox.width > selectedBox.x
            && candidateBox.y < selectedBox.y + selectedBox.height && candidateBox.y + candidateBox.height > selectedBox.y;
        });
        if (overlapsSelected) continue;
        bodyElements.push(candidate);
        if (bodyElements.length >= 4) break;
      }
      const visualElements = slide.elements.filter((element) => !textElements.includes(element)
        && /picture|image|table|chart|graphicframe|group|connector|shape/i.test(element.kind));
      const titleBox = title ? box(title) : null;
      const bodyBoxes = bodyElements.map(box);
      const bodyCenters = bodyBoxes.map((geometry) => (geometry.x + geometry.width / 2) / Math.max(1, canvas.width));
      const hasDataVisual = slide.elements.some((element) => /table|chart|graphicframe/i.test(element.kind));
      const visualShare = visualElements.reduce((total, element) => {
        const geometry = box(element);
        return total + geometry.width * geometry.height / Math.max(1, canvas.width * canvas.height);
      }, 0);
      const separatedBodyColumns = bodyCenters.length > 1 && Math.max(...bodyCenters) - Math.min(...bodyCenters) > 0.28;
      const titleFont = title ? numericFont(title) : 0;
      const bodyFont = bodyElements.length ? Math.max(8, ...bodyElements.map(numericFont)) : 8;
      const titleBodyRatio = titleFont / bodyFont;
      let archetype = 'content';
      if (hasDataVisual) archetype = 'table-data';
      else if (visualShare >= 0.34) archetype = 'visual-led';
      else if (separatedBodyColumns) archetype = 'content-split';
      else if (bodyElements.length >= 5) archetype = 'content-dense';
      else if (title && bodyElements.length <= 1 && titleBodyRatio >= 3) archetype = 'cover';
      const mappedTextIds = new Set([...(title ? [title.id] : []), ...bodyElements.map((element) => element.id)]);
      const preservedElements = textElements.filter((element) => {
        if (mappedTextIds.has(element.id)) return false;
        const geometry = box(element);
        const edgeFurniture = geometry.y <= canvas.height * 0.12 || geometry.y + geometry.height >= canvas.height * 0.92;
        const recurring = (repeatedTextCounts.get(element.text.trim().replace(/\s+/gu, ' ').toLowerCase()) ?? 0)
          >= Math.max(2, Math.ceil(evidence.slides.length * 0.6));
        return recurring && edgeFurniture && numericFont(element) <= 12 && geometry.height <= canvas.height * 0.06;
      });
      const preservedIds = new Set(preservedElements.map((element) => element.id));
      const replaceableTextElements = textElements.filter((element) => !mappedTextIds.has(element.id)
        && !preservedIds.has(element.id) && element.kind === 'shape' && element.geometry
        && element.text.trim().length > 3);
      return {
        sourceSlideIndex: slide.sourceSlideIndex,
        archetype,
        supportedContentModes: [...new Set(['text', ...(hasDataVisual ? ['table', 'chart'] : []), ...(visualElements.length ? ['image', 'diagram', 'mixed'] : [])])],
        titleElementId: title?.id ?? null,
        bodyElementIds: bodyElements.slice(0, 32).map((element) => element.id),
        visualElementIds: visualElements.slice(0, 8).map((element) => element.id),
        preservedElementIds: preservedElements.map((element) => element.id),
        replaceableTextElementIds: replaceableTextElements.map((element) => element.id),
        confidence: title && bodyElements.length ? 0.82 : 0.32,
        reasonCodes: ['offline_fake', title && bodyElements.length ? 'geometry_text_roles' : 'incomplete_role_evidence'],
      };
    });
    return completion(request.model, { templateIRHash: evidence.templateIRHash, slides });
  }
  return completion(request.model, { unknown: true });
}

async function readJson(request, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('request exceeds the fake endpoint limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Local-only OpenAI-compatible fake used by offline tests and development. */
export async function startFakeSemanticEndpoint({
  model = 'Qwen/Qwen3.8-27B',
  port = 0,
  wrongModel = false,
  failure,
  respond = deterministicPlanningResponse,
} = {}) {
  const state = { inference: [], authHeaders: [], healthCalls: 0, modelCalls: 0, errors: [] };
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        state.healthCalls += 1;
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        return;
      }
      if (request.method === 'GET' && request.url === '/v1/models') {
        state.modelCalls += 1;
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: wrongModel ? 'different/model' : model }] }));
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      const body = await readJson(request);
      const role = request.headers['x-lct-semantic-role'];
      const operation = request.headers['x-lct-semantic-operation'];
      const requestRecord = { role, operation, request: body, startedAt: performance.now(), durationMs: null };
      state.inference.push(requestRecord);
      state.authHeaders.push(request.headers.authorization ?? null);
      const failureKind = failure?.(role, operation, state.inference.length);
      if (failureKind === 'http-524') {
        response.writeHead(524, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      if (failureKind === 'content-null') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          id: 'fake-null', model,
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: null } }],
        }));
        return;
      }
      if (failureKind === 'length' || failureKind === 'malformed-json') {
        const value = failureKind === 'length' ? '{}' : '{';
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(completion(model, value, failureKind === 'length' ? 'length' : 'stop')));
        return;
      }
      if (failureKind === 'invalid-schema') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(completion(model, { status: 'invalid', summary: 'bad', nextAction: 'bad' })));
        return;
      }
      const result = await respond(body, { role, operation, index: state.inference.length });
      requestRecord.durationMs = performance.now() - requestRecord.startedAt;
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      state.errors.push(error instanceof Error ? error.message : 'fake endpoint error');
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: error instanceof Error ? error.message : 'fake endpoint error' } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake endpoint did not bind to a TCP port');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  return {
    state,
    baseUrl,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export { deterministicPlanningResponse };
