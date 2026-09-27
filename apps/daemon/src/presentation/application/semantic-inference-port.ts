/**
 * PROVISIONAL, REPLACEABLE internal semantic-inference port for the
 * presentation application. This is not an agreed product/API contract and
 * may change with the final ContentIR/DeckPlan requirements. The daemon owns
 * messages and validated outputs; serving-engine details stay in adapters.
 */

export type SemanticRole = 'worker' | 'supervisor';
export type SemanticMessageRole = 'system' | 'developer' | 'user' | 'assistant';
export type SemanticImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

export type SemanticContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: SemanticImageMediaType; data: Uint8Array };

export interface SemanticMessage {
  role: SemanticMessageRole;
  content: string | readonly SemanticContentPart[];
}

export type SemanticJsonSchema = Readonly<Record<string, unknown>>;

export interface SemanticOutputContract<T> {
  name: string;
  schema: SemanticJsonSchema;
  validate(value: unknown): value is T;
  /** Optional safe enum-like diagnosis for logs; implementations must not include model output. */
  diagnoseValidationFailure?(value: unknown): string | undefined;
}

export interface SemanticRequestMetadata {
  projectId?: string;
  generationId?: string;
  checkpointId?: string;
  templateProfilerBatch?: {
    batchNumber: number;
    totalBatches: number;
    sourceSlideIndexes: number[];
  };
}

export interface SemanticInferenceRequest<T> {
  role: SemanticRole;
  operation: string;
  messages: readonly SemanticMessage[];
  output: SemanticOutputContract<T>;
  maxOutputTokens: number;
  temperature?: number;
  timeoutMs?: number;
  deadlineAtEpochMs?: number;
  signal?: AbortSignal;
  metadata?: SemanticRequestMetadata;
}

export type SemanticInferenceErrorCode =
  | 'CONFIGURATION_ERROR'
  | 'INVALID_REQUEST'
  | 'REQUEST_TOO_LARGE'
  | 'RESPONSE_TOO_LARGE'
  | 'SERVICE_UNAVAILABLE'
  | 'AUTH_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'INVALID_JSON'
  | 'INVALID_STRUCTURED_OUTPUT'
  | 'EMPTY_RESPONSE'
  | 'DEADLINE_EXCEEDED';

export interface SemanticInferenceTelemetry {
  role: SemanticRole;
  operation: string;
  model: string;
  requestId: string;
  providerRequestId?: string;
  startedAt: string;
  finishedAt: string;
  wallTimeMs: number;
  promptTokens?: number;
  completionTokens?: number;
  httpStatus?: number;
  finishReason?: string;
  runtimeSchemaValidation?: 'passed' | 'failed' | 'not-run';
  validationFailureCode?: string;
  ttftMs?: number;
  cacheSignal?: string;
  status: 'success' | 'error' | 'cancelled';
  errorCode?: SemanticInferenceErrorCode;
  metadata?: SemanticRequestMetadata;
}

export interface SemanticInferenceResponse<T> {
  value: T;
  telemetry: SemanticInferenceTelemetry;
}

export class SemanticInferenceError extends Error {
  readonly code: SemanticInferenceErrorCode;
  readonly httpStatus?: number;
  readonly telemetry?: SemanticInferenceTelemetry;

  constructor(
    code: SemanticInferenceErrorCode,
    message: string,
    options: { httpStatus?: number; telemetry?: SemanticInferenceTelemetry; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SemanticInferenceError';
    this.code = code;
    this.httpStatus = options.httpStatus;
    this.telemetry = options.telemetry;
  }
}

export interface SemanticInferenceAdapter {
  infer<T>(request: SemanticInferenceRequest<T>): Promise<SemanticInferenceResponse<T>>;
}
