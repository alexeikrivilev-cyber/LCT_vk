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
        purpose: index === 0 ? 'Introduce the supplied topic using the linked source evidence.'
          : index === count - 1 ? 'Close with the final linked source section.'
            : 'Explain the linked source section.',
        takeaway,
        contentRefs: selectedSection.contentUnits.slice(0, 5).map((unit) => unit.id),
        mediaRefs: [],
        semanticVisualType: 'none',
        targetDensity: 'balanced',
      };
    });
    return completion(request.model, {
      workingTitle: 'Presentation from supplied source material',
      narrativeSummary: `Organize the supplied evidence for ${evidence.brief.purpose}.`,
      slides,
    });
  }
  if (schemaName === 'supervisor_plan_review_v1') {
    return completion(request.model, { checkpointVersion: evidence.checkpointVersion, outcome: 'pass', findings: [], operations: [] });
  }
  if (schemaName === 'template_semantic_profile_v1') {
    const slides = evidence.slides.map((slide, index) => {
      const textElements = slide.elements.filter((element) => typeof element.text === 'string' && element.text.trim());
      const visualElements = slide.elements.filter((element) => !textElements.includes(element) && element.kind !== 'shape');
      return {
        sourceSlideIndex: slide.sourceSlideIndex,
        archetype: index === 0 ? 'cover' : index === evidence.slides.length - 1 ? 'closing' : 'content',
        supportedContentModes: ['text'],
        titleElementId: textElements[0]?.id ?? null,
        bodyElementIds: textElements.slice(1, 4).map((element) => element.id),
        visualElementIds: visualElements.slice(0, 8).map((element) => element.id),
        confidence: 0.25,
        reasonCodes: ['offline_fake'],
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
