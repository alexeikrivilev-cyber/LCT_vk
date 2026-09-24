import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  OpenAICompatibleSemanticInferenceAdapter,
  semanticInferenceConfigFromEnvironment,
} from '../src/presentation/adapters/openai-compatible-semantic-inference.ts';
import { SemanticInferenceError } from '../src/presentation/application/semantic-inference-port.ts';
import {
  SUPERVISOR_SENTINEL,
  WORKER_SENTINEL,
  supervisorSmokeRequest,
  workerSmokeRequest,
} from './semantic-smoke-contracts.mjs';

const model = 'Qwen/Qwen3.8-27B';

function openAIResponse(content, options = {}) {
  return {
    id: 'chatcmpl-local-fixture',
    model: options.model ?? model,
    choices: [{ index: 0, message: { role: 'assistant', ...options.message, content }, finish_reason: options.finishReason ?? 'stop' }],
    usage: { prompt_tokens: 42, completion_tokens: 13 },
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function startServer(t, handler) {
  const server = createServer((request, reply) => { void handler(request, reply); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return { server, baseUrl: 'http://127.0.0.1:' + address.port + '/v1' };
}

function adapter(baseUrl, options = {}) {
  return new OpenAICompatibleSemanticInferenceAdapter({
    baseUrl,
    model,
    requestTimeoutMs: options.requestTimeoutMs ?? 500,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
  });
}

function errorCode(code) {
  return (error) => error instanceof SemanticInferenceError && error.code === code;
}

test('environment config requires an endpoint, pins a fixed model by default, and protects bearer credentials', () => {
  assert.throws(() => semanticInferenceConfigFromEnvironment({}), errorCode('CONFIGURATION_ERROR'));
  const config = semanticInferenceConfigFromEnvironment({
    LCT_SEMANTIC_BASE_URL: 'https://inference.example.test/v1/',
    LCT_SEMANTIC_API_KEY: 'local-test-key',
  });
  assert.equal(config.baseUrl, 'https://inference.example.test/v1');
  assert.equal(config.model, model);
  assert.equal(semanticInferenceConfigFromEnvironment({
    LCT_SEMANTIC_BASE_URL: 'https://inference.example.test/v1',
    LCT_SEMANTIC_ENABLE_THINKING: 'false',
  }).enableThinking, false);
  assert.throws(() => semanticInferenceConfigFromEnvironment({
    LCT_SEMANTIC_BASE_URL: 'https://inference.example.test/v1',
    LCT_SEMANTIC_ENABLE_THINKING: 'off',
  }), errorCode('CONFIGURATION_ERROR'));
  assert.throws(() => semanticInferenceConfigFromEnvironment({
    LCT_SEMANTIC_BASE_URL: 'http://remote.example.test/v1',
    LCT_SEMANTIC_API_KEY: 'local-test-key',
  }), errorCode('CONFIGURATION_ERROR'));
  assert.throws(() => semanticInferenceConfigFromEnvironment({
    LCT_SEMANTIC_BASE_URL: 'https://user:pass@inference.example.test/v1',
  }), errorCode('CONFIGURATION_ERROR'));
});

test('validates structured output and keeps Worker and Supervisor evidence in separate requests', async (t) => {
  const received = [];
  const { baseUrl } = await startServer(t, async (request, reply) => {
    const body = await readJson(request);
    const role = request.headers['x-lct-semantic-role'];
    const prompt = JSON.stringify(body.messages);
    received.push({ role, prompt, body });

    if (role === 'worker') {
      assert.match(prompt, new RegExp(WORKER_SENTINEL));
      assert.doesNotMatch(prompt, new RegExp(SUPERVISOR_SENTINEL));
      reply.writeHead(200, { 'content-type': 'application/json' });
      reply.end(JSON.stringify(openAIResponse(JSON.stringify({
        status: 'ok', summary: WORKER_SENTINEL, nextAction: 'continue',
      }))));
      return;
    }
    assert.equal(role, 'supervisor');
    assert.match(prompt, new RegExp(SUPERVISOR_SENTINEL));
    assert.doesNotMatch(prompt, new RegExp(WORKER_SENTINEL));
    reply.writeHead(200, { 'content-type': 'application/json' });
    reply.end(JSON.stringify(openAIResponse(JSON.stringify({
      decision: 'pass', reason: SUPERVISOR_SENTINEL,
    }))));
  });
  const client = adapter(baseUrl);

  const worker = await client.infer(workerSmokeRequest());
  const supervisor = await client.infer(supervisorSmokeRequest());

  assert.equal(worker.value.summary, WORKER_SENTINEL);
  assert.doesNotMatch(JSON.stringify(worker.value), new RegExp(SUPERVISOR_SENTINEL));
  assert.equal(supervisor.value.reason, SUPERVISOR_SENTINEL);
  assert.doesNotMatch(JSON.stringify(supervisor.value), new RegExp(WORKER_SENTINEL));
  assert.deepEqual(received.map((item) => item.role), ['worker', 'supervisor']);
  assert.equal(received[0].body.response_format.type, 'json_schema');
  assert.equal(received[0].body.response_format.json_schema.strict, true);
  assert.equal(Object.hasOwn(received[0].body, 'chat_template_kwargs'), false);
  assert.equal(worker.telemetry.role, 'worker');
  assert.equal(supervisor.telemetry.role, 'supervisor');
  assert.equal(worker.telemetry.promptTokens, 42);
  assert.equal(worker.telemetry.completionTokens, 13);
  assert.equal(worker.telemetry.providerRequestId, 'chatcmpl-local-fixture');
  assert.equal(worker.telemetry.finishReason, 'stop');
  assert.equal(worker.telemetry.status, 'success');
  assert.doesNotMatch(JSON.stringify(worker.telemetry), /WORKER_SENTINEL|SUPERVISOR_SENTINEL/);
  assert.doesNotMatch(JSON.stringify(supervisor.telemetry), /WORKER_SENTINEL|SUPERVISOR_SENTINEL/);
});

test('maps the optional adapter thinking setting to request-level chat template kwargs', async (t) => {
  let receivedBody;
  const { baseUrl } = await startServer(t, async (request, reply) => {
    receivedBody = await readJson(request);
    reply.writeHead(200, { 'content-type': 'application/json' });
    reply.end(JSON.stringify(openAIResponse(JSON.stringify({
      status: 'ok', summary: 'small schema accepted', nextAction: 'continue',
    }))));
  });
  const config = semanticInferenceConfigFromEnvironment({
    LCT_SEMANTIC_BASE_URL: baseUrl,
    LCT_SEMANTIC_MODEL: model,
    LCT_SEMANTIC_ENABLE_THINKING: 'false',
  });
  await new OpenAICompatibleSemanticInferenceAdapter({ ...config, requestTimeoutMs: 500 }).infer(workerSmokeRequest());
  assert.deepEqual(receivedBody.chat_template_kwargs, { enable_thinking: false });
  assert.equal(receivedBody.response_format.type, 'json_schema');
  assert.equal(receivedBody.response_format.json_schema.strict, true);
});

test('two semantic roles can be in flight at once through the stateless adapter', async (t) => {
  let active = 0;
  let maximumActive = 0;
  let seen = 0;
  let releaseBoth;
  const bothArrived = new Promise((resolve) => { releaseBoth = resolve; });
  const { baseUrl } = await startServer(t, async (request, reply) => {
    const body = await readJson(request);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    seen += 1;
    if (seen === 2) releaseBoth();
    await bothArrived;
    const role = request.headers['x-lct-semantic-role'];
    const result = role === 'worker'
      ? { status: 'ok', summary: 'worker', nextAction: 'continue' }
      : { decision: 'pass', reason: 'checkpoint reviewed' };
    reply.writeHead(200, { 'content-type': 'application/json' });
    reply.end(JSON.stringify(openAIResponse(JSON.stringify(result))));
    active -= 1;
  });
  const client = adapter(baseUrl);
  const results = await Promise.all([
    client.infer(workerSmokeRequest()),
    client.infer(supervisorSmokeRequest()),
  ]);

  assert.equal(maximumActive, 2);
  assert.deepEqual(results.map((item) => item.telemetry.role).sort(), ['supervisor', 'worker']);
});

test('maps authentication, model, capacity, and service errors without returning provider bodies', async (t) => {
  for (const [status, code] of [[401, 'AUTH_ERROR'], [404, 'PROVIDER_ERROR'], [429, 'RATE_LIMITED'], [503, 'SERVICE_UNAVAILABLE'], [524, 'SERVICE_UNAVAILABLE']]) {
    const { baseUrl } = await startServer(t, async (_request, reply) => {
      reply.writeHead(status, { 'content-type': 'text/plain' });
      reply.end('BODY_SECRET_MUST_NOT_APPEAR_IN_ERRORS');
    });
    await assert.rejects(adapter(baseUrl).infer(workerSmokeRequest()), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.httpStatus, status);
      assert.doesNotMatch(error.message, /BODY_SECRET/);
      assert.equal(error.telemetry.status, 'error');
      return true;
    });
  }
});

test('fails closed for malformed JSON, wrong schemas, empty answers, and wrong model ids', async (t) => {
  const cases = [
    ['not-json', {}, 'INVALID_JSON'],
    [null, { message: { reasoning: 'reasoning without final content' } }, 'EMPTY_RESPONSE'],
    [JSON.stringify({ status: 'ok', summary: 'missing nextAction' }), {}, 'INVALID_STRUCTURED_OUTPUT'],
    ['', {}, 'EMPTY_RESPONSE'],
    [JSON.stringify({ status: 'ok', summary: 'ok', nextAction: 'continue' }), { model: 'some/other-model' }, 'CONFIGURATION_ERROR'],
  ];
  for (const [content, options, code] of cases) {
    const { baseUrl } = await startServer(t, async (_request, reply) => {
      reply.writeHead(200, { 'content-type': 'application/json' });
      reply.end(JSON.stringify(openAIResponse(content, options)));
    });
    await assert.rejects(adapter(baseUrl).infer(workerSmokeRequest()), errorCode(code));
  }
});

test('rejects max-token truncation even when the partial structured content is valid JSON', async (t) => {
  const { baseUrl } = await startServer(t, async (_request, reply) => {
    reply.writeHead(200, { 'content-type': 'application/json' });
    reply.end(JSON.stringify(openAIResponse(JSON.stringify({
      status: 'ok', summary: 'complete-looking result', nextAction: 'continue',
    }), { finishReason: 'length' })));
  });
  await assert.rejects(adapter(baseUrl).infer(workerSmokeRequest()), (error) => {
    assert.equal(error.code, 'INVALID_STRUCTURED_OUTPUT');
    assert.equal(error.telemetry.finishReason, 'length');
    return true;
  });
});

test('keeps a separate reasoning field out of strict JSON content and rejects reasoning mixed into content', async (t) => {
  const structured = JSON.stringify({ status: 'ok', summary: 'final answer', nextAction: 'continue' });
  const { baseUrl } = await startServer(t, async (_request, reply) => {
    reply.writeHead(200, { 'content-type': 'application/json' });
    reply.end(JSON.stringify(openAIResponse(structured, {
      message: { reasoning: 'private reasoning that is not JSON' },
    })));
  });
  const result = await adapter(baseUrl).infer(workerSmokeRequest());
  assert.deepEqual(result.value, { status: 'ok', summary: 'final answer', nextAction: 'continue' });

  const contaminated = await startServer(t, async (_request, reply) => {
    reply.writeHead(200, { 'content-type': 'application/json' });
    reply.end(JSON.stringify(openAIResponse('<think>private reasoning</think>' + structured)));
  });
  await assert.rejects(adapter(contaminated.baseUrl).infer(workerSmokeRequest()), errorCode('INVALID_JSON'));
});

test('applies caller cancellation and bounded request deadlines', async (t) => {
  const { baseUrl } = await startServer(t, async (_request, reply) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!reply.destroyed) {
      reply.writeHead(200, { 'content-type': 'application/json' });
      reply.end(JSON.stringify(openAIResponse(JSON.stringify({
        status: 'ok', summary: 'late', nextAction: 'continue',
      }))));
    }
  });
  const client = adapter(baseUrl, { requestTimeoutMs: 500 });
  const controller = new AbortController();
  const cancelled = client.infer({ ...workerSmokeRequest(), signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(cancelled, (error) => errorCode('CANCELLED')(error)
    && error.telemetry.status === 'cancelled');

  await assert.rejects(client.infer({ ...workerSmokeRequest(), timeoutMs: 20 }), (error) => {
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(error.telemetry.errorCode, 'TIMEOUT');
    return true;
  });
  await assert.rejects(client.infer({
    ...workerSmokeRequest(),
    deadlineAtEpochMs: Date.now() - 1,
  }), errorCode('DEADLINE_EXCEEDED'));
});

test('maps image evidence to a data URL and rejects oversized responses', async (t) => {
  let receivedImage = false;
  const { baseUrl } = await startServer(t, async (request, reply) => {
    const body = await readJson(request);
    const imagePart = body.messages[0].content.find((part) => part.type === 'image_url');
    receivedImage = imagePart?.image_url.url === 'data:image/png;base64,AQID';
    reply.writeHead(200, { 'content-type': 'application/json' });
    reply.end(JSON.stringify(openAIResponse(JSON.stringify({
      status: 'ok', summary: 'image received', nextAction: 'continue',
    }))));
  });
  const imageRequest = workerSmokeRequest();
  imageRequest.messages = [{
    role: 'user',
    content: [{ type: 'image', mediaType: 'image/png', data: Uint8Array.from([1, 2, 3]) }],
  }];
  await adapter(baseUrl).infer(imageRequest);
  assert.equal(receivedImage, true);

  const oversized = new OpenAICompatibleSemanticInferenceAdapter({
    baseUrl: 'http://127.0.0.1:1/v1',
    model,
  }, async () => new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }));
  await assert.rejects(oversized.infer(workerSmokeRequest()), errorCode('RESPONSE_TOO_LARGE'));
});

test('bounds schema size before serializing or dispatching the request', async () => {
  let dispatched = false;
  const client = new OpenAICompatibleSemanticInferenceAdapter({
    baseUrl: 'http://127.0.0.1:1/v1',
    model,
  }, async () => {
    dispatched = true;
    return new Response();
  });
  const request = workerSmokeRequest();
  request.output = {
    ...request.output,
    schema: { type: 'object', description: 'x'.repeat(64 * 1024) },
  };
  await assert.rejects(client.infer(request), errorCode('REQUEST_TOO_LARGE'));
  assert.equal(dispatched, false);

  const circularSchema = { type: 'object' };
  circularSchema.self = circularSchema;
  await assert.rejects(client.infer({
    ...workerSmokeRequest(),
    output: { ...workerSmokeRequest().output, schema: circularSchema },
  }), errorCode('INVALID_REQUEST'));
  assert.equal(dispatched, false);
});
