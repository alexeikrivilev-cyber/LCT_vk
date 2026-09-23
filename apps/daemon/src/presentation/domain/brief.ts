import { createHash } from 'node:crypto';

/**
 * Brief v1 is the bounded user intent consumed by planning. These limits are
 * local input guards; they do not define an external wire protocol.
 */
export interface Brief {
  audience: string;
  purpose: string;
  expectedOutcome: string;
  preferences: string[];
  requestedSlideCount?: number;
}

const BRIEF_LIMITS = {
  audience: 500,
  purpose: 1_000,
  expectedOutcome: 1_000,
  preferencesCount: 12,
  preference: 200,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactDataRecord(value: unknown, allowedKeys: readonly string[], requiredKeys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) return false;
  const keys = ownKeys as string[];
  if (keys.some((key) => !allowedKeys.includes(key)) || requiredKeys.some((key) => !keys.includes(key))) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor;
  });
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)))) return false;
  if (keys.length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return false;
  }
  return true;
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength * 2
    && value.trim().length > 0 && Array.from(value).length <= maxLength;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
    return JSON.stringify(value);
  }
  if (value === null) return 'null';
  throw new TypeError('Cannot hash a value outside canonical JSON');
}

/** Validate and normalize untrusted Brief v1 input. Unknown keys are rejected. */
export function validateBrief(value: unknown): Brief {
  if (!exactDataRecord(value, ['audience', 'purpose', 'expectedOutcome', 'preferences', 'requestedSlideCount'],
    ['audience', 'purpose', 'expectedOutcome', 'preferences'])) {
    throw new TypeError('Invalid Brief v1 fields');
  }

  if (!boundedText(value.audience, BRIEF_LIMITS.audience)
    || !boundedText(value.purpose, BRIEF_LIMITS.purpose)
    || !boundedText(value.expectedOutcome, BRIEF_LIMITS.expectedOutcome)) {
    throw new TypeError('Brief audience, purpose, and expectedOutcome must be non-empty and within their limits');
  }
  if (!isDenseArray(value.preferences) || value.preferences.length > BRIEF_LIMITS.preferencesCount
    || !value.preferences.every((item) => boundedText(item, BRIEF_LIMITS.preference))) {
    throw new TypeError('Brief preferences must contain at most 12 bounded, non-empty strings');
  }
  if ('requestedSlideCount' in value
    && (!Number.isSafeInteger(value.requestedSlideCount) || (value.requestedSlideCount as number) < 1
      || (value.requestedSlideCount as number) > 30)) {
    throw new TypeError('Brief requestedSlideCount must be an integer from 1 through 30');
  }

  return {
    audience: value.audience.trim(),
    purpose: value.purpose.trim(),
    expectedOutcome: value.expectedOutcome.trim(),
    preferences: value.preferences.map((item) => item.trim()),
    ...('requestedSlideCount' in value ? { requestedSlideCount: value.requestedSlideCount as number } : {}),
  };
}

/** SHA-256 over the normalized, key-order-independent Brief v1 value. */
export function briefHash(brief: Brief): string {
  const normalized = validateBrief(brief);
  return createHash('sha256').update(canonicalJson(normalized)).digest('hex');
}
