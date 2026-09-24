import { randomUUID } from 'node:crypto';

import {
  SemanticInferenceError,
  type SemanticInferenceAdapter,
  type SemanticInferenceErrorCode,
  type SemanticInferenceRequest,
  type SemanticInferenceResponse,
  type SemanticInferenceTelemetry,
  type SemanticMessage,
  type SemanticMessageRole,
  type SemanticRequestMetadata,
} from '../application/semantic-inference-port.js';

const DEFAULT_MODEL = 'Qwen/Qwen3.8-27B';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_MESSAGES = 128;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_NODES = 8192;
const MAX_SCHEMA_DEPTH = 64;
const MAX_OUTPUT_TOKENS = 8192;
const MAX_TEXT_CHARS = 4 * 1024 * 1024;
const OPERATION_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MESSAGE_ROLES = new Set<SemanticMessageRole>(['system', 'developer', 'user', 'assistant']);
const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface SemanticInferenceConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  requestTimeoutMs?: number;
  enableThinking?: boolean;
}

export type SemanticFetch = typeof fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function configError(message: string): SemanticInferenceError {
  return new SemanticInferenceError('CONFIGURATION_ERROR', message);
}

function normalizeBaseUrl(value: string, apiKey?: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new SemanticInferenceError('CONFIGURATION_ERROR', 'LCT_SEMANTIC_BASE_URL must be an absolute HTTP(S) URL', { cause: error });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password
      || parsed.search || parsed.hash) {
    throw configError('LCT_SEMANTIC_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment');
  }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname.toLowerCase());
  if (apiKey && parsed.protocol !== 'https:' && !loopback) {
    throw configError('LCT_SEMANTIC_API_KEY requires HTTPS except for a loopback development endpoint');
  }
  return parsed.toString().replace(/\/+$/, '');
}

export function semanticInferenceConfigFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): SemanticInferenceConfig {
  const baseUrl = environment.LCT_SEMANTIC_BASE_URL?.trim();
  if (!baseUrl) throw configError('LCT_SEMANTIC_BASE_URL is required');
  const model = environment.LCT_SEMANTIC_MODEL?.trim() || DEFAULT_MODEL;
  if (model.length > 256 || /[\r\n]/.test(model)) {
    throw configError('LCT_SEMANTIC_MODEL is invalid');
  }
  const apiKey = environment.LCT_SEMANTIC_API_KEY?.trim() || undefined;
  if (apiKey && apiKey.length > 4096) throw configError('LCT_SEMANTIC_API_KEY is too long');
  const enableThinkingValue = environment.LCT_SEMANTIC_ENABLE_THINKING?.trim().toLowerCase();
  if (enableThinkingValue && enableThinkingValue !== 'true' && enableThinkingValue !== 'false') {
    throw configError('LCT_SEMANTIC_ENABLE_THINKING must be true or false');
  }
  return {
    baseUrl: normalizeBaseUrl(baseUrl, apiKey),
    model,
    ...(apiKey ? { apiKey } : {}),
    ...(enableThinkingValue ? { enableThinking: enableThinkingValue === 'true' } : {}),
    requestTimeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

function validateMetadata(metadata: SemanticRequestMetadata | undefined): void {
  if (metadata === undefined) return;
  for (const [name, value] of Object.entries(metadata)) {
    if (!['projectId', 'generationId', 'checkpointId'].includes(name)
        || (value !== undefined && (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)))) {
      throw new SemanticInferenceError('INVALID_REQUEST', 'Semantic request metadata is invalid');
    }
  }
}

function validateSchema(schema: Readonly<Record<string, unknown>>): boolean {
  return isRecord(schema) && schema.type === 'object';
}

function jsonStringByteLength(value: string): number {
  let byteLength = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) byteLength += 2;
    else if (code < 0x20) byteLength += 6;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        byteLength += 4;
        index += 1;
      } else byteLength += 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) byteLength += 6;
    else if (code < 0x80) byteLength += 1;
    else if (code < 0x800) byteLength += 2;
    else byteLength += 3;

    if (byteLength > MAX_SCHEMA_BYTES) {
      throw new SemanticInferenceError('REQUEST_TOO_LARGE', 'Semantic output schema exceeds its byte limit');
    }
  }
  return byteLength;
}

function measureSchemaJsonBytes(schema: Readonly<Record<string, unknown>>): number {
  const ancestors = new WeakSet<object>();
  let nodeCount = 0;

  function measure(value: unknown, depth: number): number {
    nodeCount += 1;
    if (nodeCount > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) {
      throw new SemanticInferenceError('REQUEST_TOO_LARGE', 'Semantic output schema exceeds its structural limit');
    }
    if (value === null) return 4;
    if (typeof value === 'boolean') return value ? 4 : 5;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value).length;
    if (typeof value === 'string') return jsonStringByteLength(value);
    if (typeof value !== 'object') {
      throw new SemanticInferenceError('INVALID_REQUEST', 'Semantic output schema must contain only JSON values');
    }
    if (ancestors.has(value)) {
      throw new SemanticInferenceError('INVALID_REQUEST', 'Semantic output schema cannot contain circular references');
    }

    ancestors.add(value);
    let byteLength = 2;
    if (Array.isArray(value)) {
      if (value.length > MAX_SCHEMA_NODES) {
        throw new SemanticInferenceError('REQUEST_TOO_LARGE', 'Semantic output schema exceeds its structural limit');
      }
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) byteLength += 1;
        byteLength += measure(value[index], depth + 1);
        if (byteLength > MAX_SCHEMA_BYTES) {
          throw new SemanticInferenceError('REQUEST_TOO_LARGE', 'Semantic output schema exceeds its byte limit');
        }
      }
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new SemanticInferenceError('INVALID_REQUEST', 'Semantic output schema objects must be plain JSON objects');
      }
      let propertyCount = 0;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        propertyCount += 1;
        if (propertyCount > MAX_SCHEMA_NODES) {
          throw new SemanticInferenceError('REQUEST_TOO_LARGE', 'Semantic output schema exceeds its structural limit');
        }
        if (propertyCount > 1) byteLength += 1;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) {
          throw new SemanticInferenceError('INVALID_REQUEST', 'Semantic output schema cannot contain accessors');
        }
        byteLength += jsonStringByteLength(key) + 1 + measure(descriptor.value, depth + 1);
        if (byteLength > MAX_SCHEMA_BYTES) {
          throw new SemanticInferenceError('REQUEST_TOO_LARGE', 'Semantic output schema exceeds its byte limit');
        }
      }
    }
    ancestors.delete(value);
    return byteLength;
  }

  return measure(schema, 0);
}

function validateMessage(message: SemanticMessage, requestBytes: { value: number }): void {
  if (!isRecord(message) || !MESSAGE_ROLES.has(message.role)) {
    throw new SemanticInferenceError('INVALID_REQUEST', 'Semantic message role is invalid');
  }
  if (typeof message.content === 'string') {
    if (message.content.length > MAX_TEXT_CHARS) {
      throw new SemanticInferenceError('REQUEST_TOO_LARGE', 'Semantic message text exceeds its character limit');
    }
    requestBytes.value += Buffer.byteLength(message.content);
    if (requestBytes.value > MAX_REQUEST_BYTES) {
      throw new SemanticInferenceError('REQUEST_TOO_LARGE', 'Semantic request exceeded its byte limit');
    }
    return;
  }
  if (!Array.isArray(message.content) || message.content.length === 0 || message.content.length > 256) {
    throw new SemanticInferenceError('INVALID_REQUEST', 'Semantic message content parts are invalid');
  }
  for (const part of message.content) {
    if (!isRecord(part)) throw new SemanticInferenceError('INVALID_REQUEST', 'Semantic content part is invalid');
    if (part.type === 'text' && typeof part.text === 'string' && part.text.length <= MAX_TEXT_CHARS) {
      requestBytes.value += Buffer.byteLength(part.text);
      if (requestBytes.value > MAX_REQUEST_BYTES) {
        throw new SemanticInferenceError('REQUEST_TOO_LARGE', 'Semantic request exceeded its byte limit');
      }
      continue;
    }
    if (part.type === 'image' && IMAGE_MEDIA_TYPES.has(String(part.mediaType))
        && part.data instanceof Uint8Array && part.data.byteLength > 0) {
      if (part.data.byteLength > MAX_IMAGE_BYTES) {
        throw new SemanticInferenceError('REQUEST_TOO_LARGE', 'Semantic image exceeds its byte limit');
      }
      requestBytes.value += Math.ceil(part.data.byteLength / 3) * 4;
      if (requestBytes.value > MAX_REQUEST_BYTES) {
        throw new SemanticInferenceError('REQUEST_TOO_LARGE', 'Semantic request exceeded its byte limit');
      }
      continue;
    }
    throw new SemanticInferenceError('INVALID_REQUEST', 'Semantic content part is invalid');
  }
}

function validateRequest<T>(request: SemanticInferenceRequest<T>): void {
  if (!isRecord(request) || !['worker', 'supervisor'].includes(request.role)
      || typeof request.operation !== 'string' || !OPERATION_PATTERN.test(request.operation)) {
    throw new SemanticInferenceError('INVALID_REQUEST', 'Semantic request role or operation is invalid');
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0 || request.messages.length > MAX_MESSAGES) {
    throw new SemanticInferenceError('INVALID_REQUEST', 'Semantic request must contain a bounded message list');
  }
  const estimatedRequestBytes = { value: 0 };
  request.messages.forEach((message) => validateMessage(message, estimatedRequestBytes));
  if (!request.output || typeof request.output.name !== 'string'
      || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(request.output.name)
      || !validateSchema(request.output.schema) || typeof request.output.validate !== 'function') {
    throw new SemanticInferenceError('INVALID_REQUEST', 'A named object JSON schema and runtime validator are required');
  }
  measureSchemaJsonBytes(request.output.schema);
  if (!isFiniteInteger(request.maxOutputTokens, 1, MAX_OUTPUT_TOKENS)) {
    throw new SemanticInferenceError('INVALID_REQUEST', 'maxOutputTokens is outside the supported range');
  }
  if (request.temperature !== undefined
      && (typeof request.temperature !== 'number' || !Number.isFinite(request.temperature)
        || request.temperature < 0 || request.temperature > 2)) {
    throw new SemanticInferenceError('INVALID_REQUEST', 'temperature must be between 0 and 2');
  }
  if (request.timeoutMs !== undefined && !isFiniteInteger(request.timeoutMs, 1, MAX_TIMEOUT_MS)) {
    throw new SemanticInferenceError('INVALID_REQUEST', 'timeoutMs is outside the supported range');
  }
  if (request.deadlineAtEpochMs !== undefined
      && (typeof request.deadlineAtEpochMs !== 'number' || !Number.isFinite(request.deadlineAtEpochMs))) {
    throw new SemanticInferenceError('INVALID_REQUEST', 'deadlineAtEpochMs must be a finite timestamp');
  }
  validateMetadata(request.metadata);
}

function toProviderMessage(message: SemanticMessage): Record<string, unknown> {
  if (typeof message.content === 'string') return { role: message.role, content: message.content };
  return {
    role: message.role,
    content: message.content.map((part) => part.type === 'text'
      ? { type: 'text', text: part.text }
      : {
          type: 'image_url',
          image_url: { url: 'data:' + part.mediaType + ';base64,' + Buffer.from(part.data).toString('base64') },
        }),
  };
}

async function readBoundedText(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new SemanticInferenceError('RESPONSE_TOO_LARGE', 'Inference response exceeded its byte limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (signal.aborted) throw new SemanticInferenceError('SERVICE_UNAVAILABLE', 'Inference response ended after transport abort');
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), byteLength).toString('utf8');
}

function countUsage(usage: unknown): { promptTokens?: number; completionTokens?: number } {
  if (!isRecord(usage)) return {};
  const promptTokens = isFiniteInteger(usage.prompt_tokens, 0, Number.MAX_SAFE_INTEGER)
    ? usage.prompt_tokens : undefined;
  const completionTokens = isFiniteInteger(usage.completion_tokens, 0, Number.MAX_SAFE_INTEGER)
    ? usage.completion_tokens : undefined;
  return {
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
  };
}

function boundedFinishReason(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 64
    && /^[A-Za-z0-9_.-]+$/.test(value)
    ? value
    : undefined;
}

function makeTelemetryBase(
  request: SemanticInferenceRequest<unknown>,
  model: string,
  requestId: string,
  startedMs: number,
): Omit<SemanticInferenceTelemetry, 'finishedAt' | 'wallTimeMs' | 'status' | 'errorCode'> {
  return {
    role: request.role,
    operation: request.operation,
    model,
    requestId,
    startedAt: new Date(startedMs).toISOString(),
    ...(request.metadata ? { metadata: { ...request.metadata } } : {}),
  };
}

function finishTelemetry(
  base: Omit<SemanticInferenceTelemetry, 'finishedAt' | 'wallTimeMs' | 'status' | 'errorCode'>,
  status: SemanticInferenceTelemetry['status'],
  startedMs: number,
  additions: Partial<SemanticInferenceTelemetry> = {},
): SemanticInferenceTelemetry {
  const finishedMs = Date.now();
  return {
    ...base,
    ...additions,
    finishedAt: new Date(finishedMs).toISOString(),
    wallTimeMs: Math.max(0, finishedMs - startedMs),
    status,
  };
}

function withTelemetry(error: unknown, telemetry: SemanticInferenceTelemetry): SemanticInferenceError {
  if (error instanceof SemanticInferenceError) {
    return new SemanticInferenceError(error.code, error.message, {
      httpStatus: error.httpStatus,
      telemetry: { ...telemetry, status: error.code === 'CANCELLED' ? 'cancelled' : 'error', errorCode: error.code },
      cause: error,
    });
  }
  return new SemanticInferenceError('PROVIDER_ERROR', 'Inference response could not be processed', {
    telemetry: { ...telemetry, status: 'error', errorCode: 'PROVIDER_ERROR' },
    cause: error,
  });
}

function httpFailure(status: number): SemanticInferenceError {
  if (status === 401 || status === 403) {
    return new SemanticInferenceError('AUTH_ERROR', 'Inference endpoint rejected authentication', { httpStatus: status });
  }
  if (status === 429) {
    return new SemanticInferenceError('RATE_LIMITED', 'Inference endpoint is at capacity or rate limited', { httpStatus: status });
  }
  if (status >= 500 && status <= 599) {
    return new SemanticInferenceError('SERVICE_UNAVAILABLE', 'Inference endpoint is temporarily unavailable', { httpStatus: status });
  }
  return new SemanticInferenceError('PROVIDER_ERROR', 'Inference endpoint returned HTTP ' + status, { httpStatus: status });
}

export class OpenAICompatibleSemanticInferenceAdapter implements SemanticInferenceAdapter {
  private readonly config: SemanticInferenceConfig;
  private readonly fetcher: SemanticFetch;

  constructor(config: SemanticInferenceConfig, fetcher: SemanticFetch = globalThis.fetch) {
    if (!config || typeof config.baseUrl !== 'string' || typeof config.model !== 'string' || !config.model.trim()
        || config.model.trim().length > 256 || /[\r\n]/.test(config.model)) {
      throw configError('Semantic inference configuration requires a base URL and model');
    }
    const apiKey = config.apiKey?.trim() || undefined;
    if (apiKey && apiKey.length > 4096) throw configError('LCT_SEMANTIC_API_KEY is too long');
    if (config.enableThinking !== undefined && typeof config.enableThinking !== 'boolean') {
      throw configError('Semantic inference thinking configuration must be a boolean');
    }
    this.config = {
      ...config,
      baseUrl: normalizeBaseUrl(config.baseUrl, apiKey),
      model: config.model.trim(),
      ...(apiKey ? { apiKey } : {}),
      requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    if (!isFiniteInteger(this.config.requestTimeoutMs, 1, MAX_TIMEOUT_MS)) {
      throw configError('Semantic inference request timeout must be between 1 and 300000 ms');
    }
    if (typeof fetcher !== 'function') throw configError('Fetch implementation is unavailable');
    this.fetcher = fetcher;
  }

  async infer<T>(request: SemanticInferenceRequest<T>): Promise<SemanticInferenceResponse<T>> {
    validateRequest(request);
    const requestId = randomUUID();
    const startedMs = Date.now();
    const baseTelemetry = makeTelemetryBase(request, this.config.model, requestId, startedMs);
    let finishReason: string | undefined;
    if (request.signal?.aborted) {
      const telemetry = finishTelemetry(baseTelemetry, 'cancelled', startedMs, { errorCode: 'CANCELLED' });
      throw new SemanticInferenceError('CANCELLED', 'Semantic inference was cancelled before dispatch', { telemetry });
    }

    let timeoutMs = Math.min(request.timeoutMs ?? this.config.requestTimeoutMs!, MAX_TIMEOUT_MS);
    let timeoutCode: SemanticInferenceErrorCode = 'TIMEOUT';
    if (request.deadlineAtEpochMs !== undefined) {
      const remainingMs = request.deadlineAtEpochMs - Date.now();
      if (remainingMs <= 0) {
        const telemetry = finishTelemetry(baseTelemetry, 'error', startedMs, { errorCode: 'DEADLINE_EXCEEDED' });
        throw new SemanticInferenceError('DEADLINE_EXCEEDED', 'Semantic inference deadline has already expired', { telemetry });
      }
      if (remainingMs <= timeoutMs) {
        timeoutMs = Math.max(1, Math.floor(remainingMs));
        timeoutCode = 'DEADLINE_EXCEEDED';
      }
    }

    const payload = {
      model: this.config.model,
      messages: request.messages.map(toProviderMessage),
      max_tokens: request.maxOutputTokens,
      temperature: request.temperature ?? 0,
      ...(this.config.enableThinking === undefined ? {} : {
        chat_template_kwargs: { enable_thinking: this.config.enableThinking },
      }),
      stream: false,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: request.output.name,
          strict: true,
          schema: request.output.schema,
        },
      },
    };
    let body: string;
    try {
      body = JSON.stringify(payload);
    } catch (error) {
      throw new SemanticInferenceError('INVALID_REQUEST', 'Semantic request could not be serialized', { cause: error });
    }
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
      const telemetry = finishTelemetry(baseTelemetry, 'error', startedMs, { errorCode: 'REQUEST_TOO_LARGE' });
      throw new SemanticInferenceError('REQUEST_TOO_LARGE', 'Semantic request exceeded its byte limit', { telemetry });
    }

    const controller = new AbortController();
    let abortCode: SemanticInferenceErrorCode | undefined;
    const onAbort = () => {
      abortCode = 'CANCELLED';
      controller.abort();
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      abortCode = timeoutCode;
      controller.abort();
    }, timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.fetcher(this.config.baseUrl + '/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'x-request-id': requestId,
            'x-lct-semantic-role': request.role,
            'x-lct-semantic-operation': request.operation,
            ...(this.config.apiKey ? { authorization: 'Bearer ' + this.config.apiKey } : {}),
          },
          body,
          signal: controller.signal,
        });
      } catch (error) {
        if (abortCode) {
          throw new SemanticInferenceError(abortCode, abortCode === 'CANCELLED'
            ? 'Semantic inference was cancelled'
            : abortCode === 'DEADLINE_EXCEEDED'
              ? 'Semantic inference exceeded its deadline'
              : 'Semantic inference request timed out', { cause: error });
        }
        throw new SemanticInferenceError('SERVICE_UNAVAILABLE', 'Could not reach the semantic inference endpoint', { cause: error });
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw httpFailure(response.status);
      }
      const responseText = await readBoundedText(response, controller.signal);
      if (!responseText) throw new SemanticInferenceError('EMPTY_RESPONSE', 'Inference endpoint returned an empty response');

      let envelope: unknown;
      try {
        envelope = JSON.parse(responseText);
      } catch (error) {
        throw new SemanticInferenceError('INVALID_JSON', 'Inference endpoint returned invalid JSON', { cause: error });
      }
      if (!isRecord(envelope)) {
        throw new SemanticInferenceError('INVALID_STRUCTURED_OUTPUT', 'Inference endpoint returned an invalid response envelope');
      }
      const providerModel = typeof envelope.model === 'string' ? envelope.model : undefined;
      if (providerModel && providerModel !== this.config.model) {
        throw new SemanticInferenceError('CONFIGURATION_ERROR', 'Inference endpoint returned a different model identifier');
      }
      const choices = envelope.choices;
      if (!Array.isArray(choices) || choices.length === 0 || !isRecord(choices[0])
          || !isRecord(choices[0].message)) {
        throw new SemanticInferenceError('EMPTY_RESPONSE', 'Inference endpoint returned no assistant message');
      }
      finishReason = boundedFinishReason(choices[0].finish_reason);
      if (finishReason === 'length') {
        throw new SemanticInferenceError('INVALID_STRUCTURED_OUTPUT', 'Inference endpoint truncated structured output at max_tokens');
      }
      const content = choices[0].message.content;
      if (typeof content !== 'string' || content.length === 0) {
        throw new SemanticInferenceError('EMPTY_RESPONSE', 'Inference endpoint returned empty structured content');
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (error) {
        throw new SemanticInferenceError('INVALID_JSON', 'Model returned invalid JSON content', { cause: error });
      }
      let valid = false;
      try {
        valid = request.output.validate(parsed);
      } catch {
        valid = false;
      }
      if (!valid) {
        throw new SemanticInferenceError('INVALID_STRUCTURED_OUTPUT', 'Model output did not satisfy the requested runtime contract');
      }

      const providerRequestId = typeof envelope.id === 'string' && envelope.id.length <= 256
        ? envelope.id : undefined;
      const usage = countUsage(envelope.usage);
      return {
        value: parsed as T,
        telemetry: finishTelemetry(baseTelemetry, 'success', startedMs, {
          ...(providerRequestId ? { providerRequestId } : {}),
          ...(finishReason ? { finishReason } : {}),
          ...usage,
        }),
      };
    } catch (error) {
      const normalizedError = abortCode
        ? new SemanticInferenceError(abortCode, abortCode === 'CANCELLED'
          ? 'Semantic inference was cancelled'
          : abortCode === 'DEADLINE_EXCEEDED'
            ? 'Semantic inference exceeded its deadline'
            : 'Semantic inference request timed out', { cause: error })
        : error;
      if (normalizedError instanceof SemanticInferenceError && normalizedError.telemetry) throw normalizedError;
      const telemetry = finishTelemetry(baseTelemetry, normalizedError instanceof SemanticInferenceError && normalizedError.code === 'CANCELLED'
        ? 'cancelled' : 'error', startedMs, {
        ...(normalizedError instanceof SemanticInferenceError ? { errorCode: normalizedError.code } : { errorCode: 'PROVIDER_ERROR' }),
        ...(finishReason ? { finishReason } : {}),
      });
      throw withTelemetry(normalizedError, telemetry);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    }
  }
}
