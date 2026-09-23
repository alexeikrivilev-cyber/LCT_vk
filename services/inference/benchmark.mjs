#!/usr/bin/env node
import { performance } from 'node:perf_hooks';

const MODEL = process.env.LCT_SEMANTIC_MODEL || 'Qwen/Qwen3.8-27B';
const PROFILE = process.env.LCT_INFERENCE_PROFILE || 'unspecified';
const CHECKPOINT = process.env.MODEL_ID || 'unspecified';
const MODEL_REVISION = process.env.MODEL_REVISION || 'unspecified';
const MODEL_DTYPE = process.env.MODEL_DTYPE || 'unspecified';
const GPU_LABEL = process.env.LCT_BENCHMARK_GPU || 'unspecified';
const API_KEY = process.env.LCT_SEMANTIC_API_KEY;
const BASE_URL = process.env.LCT_SEMANTIC_BASE_URL?.trim().replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = Number(process.env.LCT_BENCHMARK_TIMEOUT_MS || 300_000);
const MAX_RESPONSE_BYTES = 1024 * 1024;

const WORKER_SENTINEL = 'WORKER_SENTINEL_benchmark_fixture';
const SUPERVISOR_SENTINEL = 'SUPERVISOR_SENTINEL_benchmark_fixture';

const contracts = {
  worker: {
    operation: 'benchmark.worker',
    messages: [
      { role: 'system', content: 'Worker benchmark context. Return the required compact JSON using only this request evidence.' },
      { role: 'user', content: 'Evidence: ' + WORKER_SENTINEL + '. Summarize and suggest a next action.' },
    ],
    output: {
      name: 'lct_benchmark_worker_v1',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['ok'] },
          summary: { type: 'string', maxLength: 120 },
          nextAction: { type: 'string', maxLength: 80 },
        },
        required: ['status', 'summary', 'nextAction'],
      },
      validate: (value) => isRecord(value) && value.status === 'ok'
        && typeof value.summary === 'string' && value.summary.length <= 120
        && typeof value.nextAction === 'string' && value.nextAction.length <= 80
        && Object.keys(value).length === 3,
    },
  },
  supervisor: {
    operation: 'benchmark.supervisor',
    messages: [
      { role: 'system', content: 'Supervisor benchmark context. Review only the checkpoint evidence in this request.' },
      { role: 'user', content: 'Checkpoint evidence: ' + SUPERVISOR_SENTINEL + '. Return a compact review.' },
    ],
    output: {
      name: 'lct_benchmark_supervisor_v1',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          decision: { type: 'string', enum: ['pass', 'warn', 'repair'] },
          reason: { type: 'string', maxLength: 120 },
        },
        required: ['decision', 'reason'],
      },
      validate: (value) => isRecord(value) && ['pass', 'warn', 'repair'].includes(value.decision)
        && typeof value.reason === 'string' && value.reason.length <= 120
        && Object.keys(value).length === 2,
    },
  },
};

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArguments(argv) {
  const mode = argv[0];
  if (!['warm', 'cold'].includes(mode)) {
    throw new Error('Usage: node services/inference/benchmark.mjs warm|cold [--repetitions N]');
  }
  let repetitions = 3;
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] !== '--repetitions' || !/^[1-9][0-9]*$/.test(argv[index + 1] || '')) {
      throw new Error('Only --repetitions with a positive integer is supported');
    }
    repetitions = Number(argv[index + 1]);
    index += 1;
  }
  if (repetitions > 20) throw new Error('--repetitions must be at most 20');
  if (mode === 'cold' && argv.includes('--repetitions')) {
    throw new Error('Cold mode measures exactly one first request and does not accept repetitions');
  }
  return { mode, repetitions };
}

function validateConfig() {
  if (!BASE_URL) throw new Error('LCT_SEMANTIC_BASE_URL is required');
  let url;
  try {
    url = new URL(BASE_URL);
  } catch {
    throw new Error('LCT_SEMANTIC_BASE_URL must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('LCT_SEMANTIC_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment');
  }
  if (API_KEY && url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())) {
    throw new Error('LCT_SEMANTIC_API_KEY requires HTTPS except for loopback development endpoints');
  }
  if (!Number.isSafeInteger(REQUEST_TIMEOUT_MS) || REQUEST_TIMEOUT_MS < 1 || REQUEST_TIMEOUT_MS > 600_000) {
    throw new Error('LCT_BENCHMARK_TIMEOUT_MS must be between 1 and 600000');
  }
}

async function readBoundedError(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) return;
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      bytes += result.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return;
      }
    }
  } catch (error) {
    if (signal.aborted) {
      throw new Error('TIMEOUT: inference request exceeded its client deadline');
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function runRequest(role) {
  const contract = contracts[role];
  const controller = new AbortController();
  const started = performance.now();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let firstTokenMs;
  let contentTtftMs;
  let outputText = '';
  let usage;
  let responseId;
  let responseModel;
  let responseBytes = 0;
  let pending = '';

  function consumeEvent(event) {
    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new Error('Endpoint returned malformed streaming JSON');
    }
    if (!isRecord(payload)) return;
    if (typeof payload.id === 'string') responseId = payload.id;
    if (typeof payload.model === 'string') responseModel = payload.model;
    if (isRecord(payload.usage)) usage = payload.usage;
    if (!Array.isArray(payload.choices)) return;
    for (const choice of payload.choices) {
      if (!isRecord(choice) || !isRecord(choice.delta)) continue;
      const reasoning = (typeof choice.delta.reasoning === 'string' && choice.delta.reasoning.length > 0)
        || (typeof choice.delta.reasoning_content === 'string' && choice.delta.reasoning_content.length > 0);
      if ((reasoning || (typeof choice.delta.content === 'string' && choice.delta.content.length > 0))
          && firstTokenMs === undefined) {
        firstTokenMs = performance.now() - started;
      }
      if (typeof choice.delta.content === 'string' && choice.delta.content.length > 0) {
        if (contentTtftMs === undefined) contentTtftMs = performance.now() - started;
        outputText += choice.delta.content;
      }
    }
  }

  try {
    let response;
    try {
      response = await fetch(BASE_URL + '/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-request-id': crypto.randomUUID(),
          'x-lct-semantic-role': role,
          'x-lct-semantic-operation': contract.operation,
          ...(API_KEY ? { authorization: 'Bearer ' + API_KEY } : {}),
        },
        body: JSON.stringify({
          model: MODEL,
          messages: contract.messages,
          max_tokens: 96,
          temperature: 0,
          stream: true,
          stream_options: { include_usage: true },
          response_format: {
            type: 'json_schema',
            json_schema: { name: contract.output.name, strict: true, schema: contract.output.schema },
          },
        }),
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) throw new Error('TIMEOUT: inference request exceeded its client deadline');
      throw new Error('SERVICE_UNAVAILABLE: could not reach inference endpoint');
    }

    if (!response.ok) {
      await readBoundedError(response, controller.signal);
      if (response.status === 401 || response.status === 403) throw new Error('AUTH_ERROR: endpoint rejected authentication');
      if (response.status === 429) throw new Error('RATE_LIMITED: endpoint is at capacity or rate limited');
      if ([500, 502, 503, 504].includes(response.status)) throw new Error('SERVICE_UNAVAILABLE: endpoint returned HTTP ' + response.status);
      throw new Error('PROVIDER_ERROR: endpoint returned HTTP ' + response.status);
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      throw new Error('PROVIDER_ERROR: endpoint did not return a streaming response');
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('EMPTY_RESPONSE: endpoint returned no response stream');
    const decoder = new TextDecoder();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        responseBytes += result.value.byteLength;
        if (responseBytes > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new Error('RESPONSE_TOO_LARGE: streaming response exceeded its byte limit');
        }
        pending += decoder.decode(result.value, { stream: true });
        let boundary = pending.search(/\r?\n\r?\n/);
        while (boundary >= 0) {
          const event = pending.slice(0, boundary);
          const delimiter = pending.slice(boundary).match(/^\r?\n\r?\n/)[0];
          pending = pending.slice(boundary + delimiter.length);
          consumeEvent(event);
          boundary = pending.search(/\r?\n\r?\n/);
        }
      }
      pending += decoder.decode();
      if (pending.trim()) consumeEvent(pending);
    } finally {
      reader.releaseLock();
    }

    if (responseModel && responseModel !== MODEL) {
      throw new Error('CONFIGURATION_ERROR: endpoint served a different model identifier');
    }
    if (!outputText) throw new Error('EMPTY_RESPONSE: stream contained no structured assistant content');
    let value;
    try {
      value = JSON.parse(outputText);
    } catch {
      throw new Error('INVALID_JSON: model returned malformed JSON content');
    }
    if (!contract.output.validate(value)) {
      throw new Error('INVALID_STRUCTURED_OUTPUT: model output failed the benchmark contract');
    }
    const finished = performance.now();
    const wallTimeMs = finished - started;
    const promptTokens = isRecord(usage) && Number.isSafeInteger(usage.prompt_tokens) ? usage.prompt_tokens : undefined;
    const completionTokens = isRecord(usage) && Number.isSafeInteger(usage.completion_tokens) ? usage.completion_tokens : undefined;
    const generationMs = firstTokenMs === undefined ? wallTimeMs : wallTimeMs - firstTokenMs;
    return {
      role,
      status: 'success',
      requestId: responseId,
      wallTimeMs: round(wallTimeMs),
      ttftMs: firstTokenMs === undefined ? undefined : round(firstTokenMs),
      contentTtftMs: contentTtftMs === undefined ? undefined : round(contentTtftMs),
      promptTokens,
      completionTokens,
      tokensPerSecond: completionTokens !== undefined && generationMs > 0
        ? round(completionTokens / (generationMs / 1000)) : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
    throw new Error(`${role}: ${message}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

function round(value) {
  return Math.round(value * 10) / 10;
}

async function runCase(name, roles) {
  const started = performance.now();
  const requests = roles.length === 1
    ? [await runRequest(roles[0])]
    : await Promise.all(roles.map((role) => runRequest(role)));
  return {
    name,
    wallTimeMs: round(performance.now() - started),
    requests,
    totalCompletionTokens: requests.every((request) => request.completionTokens !== undefined)
      ? requests.reduce((sum, request) => sum + request.completionTokens, 0) : undefined,
  };
}

function percentile(values, fraction) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return round(sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]);
}

function summarize(rows) {
  const cases = [...new Set(rows.map((row) => row.name))];
  return cases.map((name) => {
    const selected = rows.filter((row) => row.name === name);
    const requestRows = selected.flatMap((row) => row.requests);
    const latencies = requestRows.map((request) => request.wallTimeMs);
    const ttfts = requestRows.map((request) => request.ttftMs).filter(Number.isFinite);
    const contentTtfts = requestRows.map((request) => request.contentTtftMs).filter(Number.isFinite);
    const promptTokens = requestRows.map((request) => request.promptTokens).filter(Number.isFinite);
    const completionTokens = requestRows.map((request) => request.completionTokens).filter(Number.isFinite);
    return {
      name,
      repetitions: selected.length,
      wallTimeP50Ms: percentile(selected.map((row) => row.wallTimeMs), 0.5),
      requestLatencyP50Ms: percentile(latencies, 0.5),
      ttftP50Ms: percentile(ttfts, 0.5),
      contentTtftP50Ms: percentile(contentTtfts, 0.5),
      promptTokens: promptTokens.length === requestRows.length ? promptTokens : undefined,
      completionTokens: completionTokens.length === requestRows.length ? completionTokens : undefined,
    };
  });
}

async function main() {
  const { mode, repetitions } = parseArguments(process.argv.slice(2));
  validateConfig();
  const output = {
    mode,
    model: MODEL,
    profile: PROFILE,
    checkpoint: CHECKPOINT,
    revision: MODEL_REVISION,
    dtype: MODEL_DTYPE,
    gpu: GPU_LABEL,
    endpointHost: new URL(BASE_URL).host,
    startedAt: new Date().toISOString(),
    coldMeasurement: mode === 'cold'
      ? 'single first Worker request; includes platform startup, model download/load, queueing, and generation'
      : undefined,
    warmup: mode === 'warm' ? 'one unmeasured Worker request followed by one unmeasured Supervisor request' : 'none',
    executionOrder: [],
    results: [],
  };

  if (mode === 'cold') {
    output.results.push(await runCase('cold-first-worker', ['worker']));
  } else {
    await runRequest('worker');
    await runRequest('supervisor');
    const caseOrder = ['worker-only', 'supervisor-only', 'serial-pair', 'overlapping-pair'];
    for (let iteration = 1; iteration <= repetitions; iteration += 1) {
      const rotation = (iteration - 1) % caseOrder.length;
      const order = caseOrder.slice(rotation).concat(caseOrder.slice(0, rotation));
      output.executionOrder.push({ iteration, cases: order });
      for (const name of order) {
        let result;
        if (name === 'worker-only') {
          result = await runCase(name, ['worker']);
        } else if (name === 'supervisor-only') {
          result = await runCase(name, ['supervisor']);
        } else if (name === 'serial-pair') {
          const serialStarted = performance.now();
          const serialWorker = await runRequest('worker');
          const serialSupervisor = await runRequest('supervisor');
          result = {
            name,
            wallTimeMs: round(performance.now() - serialStarted),
            requests: [serialWorker, serialSupervisor],
            totalCompletionTokens: serialWorker.completionTokens !== undefined && serialSupervisor.completionTokens !== undefined
              ? serialWorker.completionTokens + serialSupervisor.completionTokens : undefined,
          };
        } else {
          result = await runCase(name, ['worker', 'supervisor']);
        }
        result.iteration = iteration;
        output.results.push(result);
      }
    }
  }
  output.summary = summarize(output.results);
  const serial = output.summary.find((item) => item.name === 'serial-pair');
  const overlap = output.summary.find((item) => item.name === 'overlapping-pair');
  if (serial?.wallTimeP50Ms && overlap?.wallTimeP50Ms) {
    output.serialVsOverlapP50WallTimeReductionPercent = round(
      (1 - overlap.wallTimeP50Ms / serial.wallTimeP50Ms) * 100,
    );
  }
  output.finishedAt = new Date().toISOString();
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message.slice(0, 300) : 'UNKNOWN_ERROR';
  const role = /^(worker|supervisor):/.exec(message)?.[1];
  process.stderr.write(JSON.stringify({
    status: 'failed', profile: PROFILE, model: MODEL, checkpoint: CHECKPOINT,
    revision: MODEL_REVISION, dtype: MODEL_DTYPE, gpu: GPU_LABEL,
    ...(role ? { role } : {}), error: message,
  }) + '\n');
  process.exitCode = 1;
});
