import { createServer } from 'node:http';

function completion(model, value, finishReason = 'stop') {
  return {
    id: 'offline-fake-request',
    model,
    choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content: typeof value === 'string' ? value : JSON.stringify(value) } }],
    usage: { prompt_tokens: 32, completion_tokens: 16 },
  };
}

function deterministicPlanningResponse(request) {
  const schemaName = request.response_format?.json_schema?.name;
  if (schemaName === 'lct_worker_smoke_v1') {
    return completion(request.model, { status: 'ok', summary: 'Strict JSON response passed.', nextAction: 'Continue with planning.' });
  }
  const evidence = JSON.parse(request.messages.at(-1).content);
  if (schemaName === 'deck_plan_draft_v1') {
    const sections = [];
    let section = null;
    for (const unit of evidence.contentIR.units) {
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
    if (!sections.length) throw new Error('fake semantic endpoint requires at least one text evidence section');
    const count = Math.max(1, Math.min(30, evidence.requestedSlideCount ?? 1));
    const slides = Array.from({ length: count }, (_, index) => {
      const sectionIndex = count === 1 ? 0 : Math.round(index * (sections.length - 1) / (count - 1));
      const selectedSection = sections[sectionIndex % sections.length];
      const heading = selectedSection.heading?.text.replace(/^#+\s*/, '').trim();
      const firstContentText = selectedSection.contentUnits[0]?.text.trim();
      const takeaway = (heading || firstContentText?.split(/(?<=[.!?])\s/u, 1)[0] || 'Source-backed content').slice(0, 180);
      return {
        narrativeRole: count > 1 && index === 0 ? 'opening' : count > 1 && index === count - 1 ? 'closing' : 'content',
        purpose: index === 0 ? 'Представить тему по исходным материалам.'
          : index === count - 1 ? 'Подвести итог по последнему разделу источников.'
            : 'Раскрыть раздел, на который ссылается источник.',
        takeaway,
        contentRefs: [...(selectedSection.heading ? [selectedSection.heading] : []), ...selectedSection.contentUnits]
          .slice(0, 5).map((unit) => unit.id),
        mediaRefs: [],
        semanticVisualType: 'none',
        targetDensity: 'balanced',
      };
    });
    return completion(request.model, {
      workingTitle: 'Презентация по исходным материалам',
      narrativeSummary: `Систематизировать материалы для задачи: ${evidence.brief.purpose}.`,
      slides,
    });
  }
  if (schemaName === 'supervisor_plan_review_v1') {
    return completion(request.model, { checkpointVersion: evidence.checkpointVersion, outcome: 'pass', findings: [], operations: [] });
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
  const state = { inference: [], authHeaders: [], healthCalls: 0, modelCalls: 0 };
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
      state.inference.push({ role, operation, request: body });
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
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
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
