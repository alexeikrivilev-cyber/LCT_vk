import { createHash } from 'node:crypto';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const MAX_FAILURE_ARTIFACT_BYTES = 96 * 1024;
const MAX_FIXTURE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_CAPTURE_BYTES = 8 * 1024 * 1024;

function operationSlug(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9._-]{0,63}$/.test(value) ? value : 'unknown-operation';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactString(value, forbiddenValues) {
  let result = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|hf|r8|AIza)[-_][A-Za-z0-9_-]{12,}\b/gu, '[REDACTED_SECRET]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|authorization)\s*[:=]\s*[^\s,;"']+/giu, '[REDACTED_CREDENTIAL]');
  for (const secret of forbiddenValues) {
    if (secret) result = result.replace(new RegExp(escapeRegExp(secret), 'giu'), '[REDACTED_PRIVATE_VALUE]');
  }
  return result;
}

function redactValue(value, forbiddenValues, depth = 0) {
  if (depth > 24) return '[OMITTED_DEPTH_LIMIT]';
  if (typeof value === 'string') return redactString(value, forbiddenValues);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, forbiddenValues, depth + 1));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /(?:api.?key|authorization|access.?token|secret|credential|password)/iu.test(key)
      ? '[REDACTED_CREDENTIAL]' : redactValue(item, forbiddenValues, depth + 1)]));
}

function safeFailureRecord(diagnostic, forbiddenValues) {
  if (!diagnostic || typeof diagnostic !== 'object'
      || typeof diagnostic.operation !== 'string'
      || typeof diagnostic.schemaName !== 'string'
      || typeof diagnostic.requestId !== 'string'
      || typeof diagnostic.responseJsonValid !== 'boolean'
      || typeof diagnostic.validationDiagnostic !== 'string') return null;
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(diagnostic.operation)
      || !/^[A-Za-z0-9._-]{1,128}$/.test(diagnostic.schemaName)
      || !/^[0-9a-f-]{16,64}$/i.test(diagnostic.requestId)
      || diagnostic.validationDiagnostic.length > 512 || /[\r\n]/.test(diagnostic.validationDiagnostic)) return null;
  if (diagnostic.schemaVersion !== null && typeof diagnostic.schemaVersion !== 'string' && typeof diagnostic.schemaVersion !== 'number') return null;
  if (diagnostic.validationFailureCode !== null && (typeof diagnostic.validationFailureCode !== 'string'
      || !/^[A-Z][A-Z0-9_]{0,63}$/.test(diagnostic.validationFailureCode))) return null;
  return {
    operation: diagnostic.operation,
    schemaName: diagnostic.schemaName,
    schemaVersion: diagnostic.schemaVersion,
    requestId: diagnostic.requestId,
    responseJsonValid: diagnostic.responseJsonValid,
    ...(diagnostic.responseJsonValid ? { parsedResponse: redactValue(diagnostic.parsedResponse, forbiddenValues) } : {}),
    validationFailureCode: diagnostic.validationFailureCode,
    validationDiagnostic: diagnostic.validationDiagnostic,
  };
}

function diagnosticFileName(record) {
  const requestId = record.requestId.replaceAll('-', '').slice(0, 32);
  return `${record.operation}-${requestId}.json`;
}

function sanitizeRequest(request) {
  return {
    role: request.role,
    operation: request.operation,
    schemaName: request.output.name,
    schemaVersion: request.output.schemaVersion ?? null,
    maxOutputTokens: request.maxOutputTokens,
    temperature: request.temperature ?? null,
    messages: request.messages.map((message) => ({
      role: message.role,
      utf8Bytes: Buffer.byteLength(message.content, 'utf8'),
      sha256: createHash('sha256').update(message.content, 'utf8').digest('hex'),
    })),
  };
}

function sanitizeTelemetry(telemetry) {
  if (!telemetry) return null;
  return {
    requestId: telemetry.requestId,
    model: telemetry.model,
    role: telemetry.role,
    operation: telemetry.operation,
    wallTimeMs: telemetry.wallTimeMs,
    promptTokens: telemetry.promptTokens ?? null,
    completionTokens: telemetry.completionTokens ?? null,
    httpStatus: telemetry.httpStatus ?? null,
    finishReason: telemetry.finishReason ?? null,
    runtimeSchemaValidation: telemetry.runtimeSchemaValidation ?? null,
    validationFailureCode: telemetry.validationFailureCode ?? null,
    status: telemetry.status,
    errorCode: telemetry.errorCode ?? null,
  };
}

export function createQualificationSemanticCapture(outputDir, options = {}) {
  const root = path.resolve(outputDir);
  const forbiddenValues = Array.isArray(options.forbiddenValues)
    ? options.forbiddenValues.filter((value) => typeof value === 'string' && value.length > 0) : [];
  const failuresDir = path.join(root, 'semantic-diagnostics');
  const fixturesDir = path.join(root, 'semantic-fixtures');
  let capturedBytes = 0;
  let captureError = null;
  let fixtureCount = 0;
  const fixtureOperations = new Set();

  function fixtureFileName(operation, requestId) {
    fixtureCount += 1;
    const safeId = typeof requestId === 'string' && /^[A-Za-z0-9-]{8,80}$/.test(requestId)
      ? requestId.replaceAll('-', '').slice(0, 32)
      : String(fixtureCount).padStart(3, '0');
    return `${String(fixtureCount).padStart(3, '0')}-${operationSlug(operation)}-${safeId}.json`;
  }

  async function writeBounded(directory, name, value, maxFileBytes) {
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > maxFileBytes || capturedBytes + bytes > MAX_TOTAL_CAPTURE_BYTES) {
      captureError = 'QUALIFICATION_CAPTURE_SIZE_LIMIT';
      return false;
    }
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, name), serialized, { encoding: 'utf8', flag: 'wx' });
    capturedBytes += bytes;
    return true;
  }

  const wrap = (adapter) => ({
    async infer(request) {
      try {
        const response = await adapter.infer(request);
        const fixture = {
          artifactVersion: 1,
          operation: request.operation,
          schemaName: request.output.name,
          schemaVersion: request.output.schemaVersion ?? null,
          request: sanitizeRequest(request),
          response: redactValue(response.value, forbiddenValues),
          telemetry: sanitizeTelemetry(response.telemetry),
        };
        try {
          const written = await writeBounded(fixturesDir, fixtureFileName(request.operation, response.telemetry?.requestId), fixture, MAX_FIXTURE_BYTES);
          if (written) fixtureOperations.add(request.operation);
        } catch {
          captureError = 'QUALIFICATION_CAPTURE_WRITE_FAILED';
        }
        return response;
      } catch (error) {
        const diagnostic = safeFailureRecord(error?.structuredOutputDiagnostic, forbiddenValues);
        if (diagnostic) {
          let record = { artifactVersion: 1, ...diagnostic };
          let serializedBytes = Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
          if (serializedBytes > MAX_FAILURE_ARTIFACT_BYTES || capturedBytes + serializedBytes > MAX_TOTAL_CAPTURE_BYTES) {
            record = { artifactVersion: 1, ...diagnostic, parsedResponse: undefined, parsedResponseOmitted: 'SIZE_LIMIT' };
          }
          try {
            const written = await writeBounded(failuresDir, diagnosticFileName(diagnostic), record, MAX_FAILURE_ARTIFACT_BYTES);
            if (written) fixtureOperations.add(`failure:${diagnostic.operation}`);
          } catch {
            captureError = 'QUALIFICATION_CAPTURE_WRITE_FAILED';
          }
        }
        throw error;
      }
    },
  });

  return {
    wrap,
    summary: async () => ({
      fixtureOperations: [...fixtureOperations].sort(),
      capturedBytes,
      captureError,
      fixtureFiles: await readdir(fixturesDir).catch(() => []),
      diagnosticFiles: await readdir(failuresDir).catch(() => []),
    }),
  };
}
