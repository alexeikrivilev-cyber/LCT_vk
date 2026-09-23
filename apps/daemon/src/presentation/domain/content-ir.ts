import { createHash } from 'node:crypto';
import path from 'node:path';

export const MAX_CONTENT_SOURCES = 12;
export const MAX_CONTENT_SOURCE_BYTES = 16 * 1024 * 1024;
export const MAX_CONTENT_TOTAL_BYTES = 32 * 1024 * 1024;
export const MAX_CONTENT_TEXT_BYTES = 256 * 1024;
export const MAX_CONTENT_UNITS = 4096;

export type ContentSourceKind = 'text' | 'image' | 'unsupported';
export type ContentUnitKind = 'text' | 'heading' | 'json-value' | 'table-cell' | 'media-reference';
export type ContentJsonValueKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export interface ContentWarning {
  code: string;
  message: string;
}

export interface ContentIRWarning extends ContentWarning {
  sourceId: string | null;
}

/** Source material supplied by the user. Exact UTF-8 text is retained once here. */
export interface ContentSource {
  id: string;
  sourcePath: string;
  originalName: string;
  mediaType: string;
  sha256: string;
  order: number;
  byteLength: number;
  kind: ContentSourceKind;
  text: string | null;
  warnings: ContentWarning[];
}

export interface ContentUnit {
  id: string;
  sourceId: string;
  order: number;
  kind: ContentUnitKind;
  locator: {
    startByte: number;
    endByte: number;
    jsonPointer?: string;
    rowIndex?: number;
    columnIndex?: number;
  };
  /** Exact paragraph for text units; decoded JSON string values for JSON units. */
  text?: string;
  valueKind?: ContentJsonValueKind;
  /** Preserved source spelling, never converted through a JavaScript number. */
  numericLexeme?: string;
  /** Decoded cell value; the source range retains the exact CSV/TSV spelling. */
  cellValue?: string;
}

export interface ContentIR {
  id: string;
  schemaVersion: 1;
  sources: ContentSource[];
  units: ContentUnit[];
  warnings: ContentIRWarning[];
  hash: string;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const NUMERIC_CELL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const SUPPORTED_TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json', '.csv', '.tsv']);
const UNIT_ID_PREFIX = 'unit_';
const SOURCE_ID_PREFIX = 'source_';

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  // The generated IR is composed only of ordered arrays and own data fields.
  // Keeping insertion order here makes the hash independent of runtime state.
  return JSON.stringify(value);
}

export function contentSourceId(sourcePath: string, order: number, sha256: string): string {
  return `${SOURCE_ID_PREFIX}${digest(stableJson([sourcePath, order, sha256])).slice(0, 24)}`;
}

export function contentUnitId(sourceId: string, unit: Omit<ContentUnit, 'id'>): string {
  return `${UNIT_ID_PREFIX}${digest(stableJson([
    sourceId,
    unit.order,
    unit.kind,
    unit.locator,
    unit.text ?? null,
    unit.valueKind ?? null,
    unit.numericLexeme ?? null,
    unit.cellValue ?? null,
  ])).slice(0, 24)}`;
}

export function contentIRHashPayload(ir: Pick<ContentIR, 'schemaVersion' | 'sources' | 'units' | 'warnings'>): string {
  return stableJson({ schemaVersion: ir.schemaVersion, sources: ir.sources, units: ir.units, warnings: ir.warnings });
}

export function contentIRHash(ir: Pick<ContentIR, 'schemaVersion' | 'sources' | 'units' | 'warnings'>): string {
  return digest(contentIRHashPayload(ir));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => typeof key === 'string'
    && Object.getOwnPropertyDescriptor(value, key)?.get === undefined
    && Object.getOwnPropertyDescriptor(value, key)?.set === undefined);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false;
  }
  return true;
}

function isUtf8SizeWithin(value: string, maxBytes: number): boolean {
  return Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function sourceExtension(sourcePath: string): string {
  return path.posix.extname(sourcePath).toLowerCase();
}

function byteOffsets(text: string): Uint32Array {
  const offsets = new Uint32Array(text.length + 1);
  let byteOffset = 0;
  let index = 0;
  while (index < text.length) {
    const first = text.charCodeAt(index);
    offsets[index] = byteOffset;
    if (first >= 0xd800 && first <= 0xdbff && index + 1 < text.length) {
      const second = text.charCodeAt(index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        offsets[index + 1] = byteOffset;
        byteOffset += 4;
        offsets[index + 2] = byteOffset;
        index += 2;
        continue;
      }
    }
    byteOffset += first <= 0x7f ? 1 : first <= 0x7ff ? 2 : 3;
    offsets[index + 1] = byteOffset;
    index += 1;
  }
  return offsets;
}

function textAtByteRange(source: string, startByte: number, endByte: number): string | null {
  const bytes = Buffer.from(source, 'utf8');
  if (endByte > bytes.length) return null;
  const range = bytes.subarray(startByte, endByte);
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(range);
  return decoded;
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes('\0') || value.startsWith('/') || value.includes('\\')) return false;
  return !value.split('/').some((segment) => !segment || segment === '.' || segment === '..');
}

function validWarning(value: unknown): value is ContentWarning {
  return isRecord(value) && exactKeys(value, ['code', 'message'])
    && typeof value.code === 'string' && value.code.length > 0 && value.code.length <= 96
    && typeof value.message === 'string' && value.message.length > 0 && value.message.length <= 512;
}

function validTextUnit(unit: Record<string, unknown>, source: ContentSource, expectedKind: 'text' | 'heading'): boolean {
  if (!exactKeys(unit, ['id', 'sourceId', 'order', 'kind', 'locator', 'text'])) return false;
  if (typeof unit.text !== 'string' || !unit.text.trim()) return false;
  if (unit.kind !== expectedKind) return false;
  const locator = unit.locator;
  if (!isRecord(locator) || !exactKeys(locator, ['startByte', 'endByte'])) return false;
  if (!Number.isSafeInteger(locator.startByte) || !Number.isSafeInteger(locator.endByte)
      || (locator.startByte as number) < 0 || (locator.endByte as number) <= (locator.startByte as number)) return false;
  try {
    if (textAtByteRange(source.text!, locator.startByte as number, locator.endByte as number) !== unit.text) return false;
    return expectedKind !== 'heading' || /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(unit.text);
  } catch {
    return false;
  }
}

function validJsonUnit(unit: Record<string, unknown>, source: ContentSource): boolean {
  const allowed = ['id', 'sourceId', 'order', 'kind', 'locator', 'valueKind', 'text', 'numericLexeme'];
  if (Object.keys(unit).some((key) => !allowed.includes(key))) return false;
  if (!Object.hasOwn(unit, 'valueKind')) return false;
  const locator = unit.locator;
  if (!isRecord(locator) || !exactKeys(locator, ['startByte', 'endByte', 'jsonPointer'])) return false;
  if (!Number.isSafeInteger(locator.startByte) || !Number.isSafeInteger(locator.endByte)
      || (locator.startByte as number) < 0 || (locator.endByte as number) <= (locator.startByte as number)
      || (locator.endByte as number) > source.byteLength || typeof locator.jsonPointer !== 'string'
      || (locator.jsonPointer !== '' && !locator.jsonPointer.startsWith('/'))
      || /~(?![01])/.test(locator.jsonPointer)) return false;
  let raw: string;
  try {
    raw = textAtByteRange(source.text!, locator.startByte as number, locator.endByte as number) ?? '';
  } catch {
    return false;
  }
  switch (unit.valueKind) {
    case 'object': {
      if (raw !== unit.text || !raw.startsWith('{') || !raw.endsWith('}') || Object.hasOwn(unit, 'numericLexeme')) return false;
      try { const parsed = JSON.parse(raw); return isRecord(parsed) && Object.keys(parsed).length === 0; } catch { return false; }
    }
    case 'array': {
      if (raw !== unit.text || !raw.startsWith('[') || !raw.endsWith(']') || Object.hasOwn(unit, 'numericLexeme')) return false;
      try { const parsed = JSON.parse(raw); return Array.isArray(parsed) && parsed.length === 0; } catch { return false; }
    }
    case 'string': {
      if (typeof unit.text !== 'string' || Object.hasOwn(unit, 'numericLexeme')) return false;
      try { return JSON.parse(raw) === unit.text; } catch { return false; }
    }
    case 'number': return typeof unit.numericLexeme === 'string' && raw === unit.numericLexeme
      && !Object.hasOwn(unit, 'text') && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw);
    case 'boolean': return (raw === 'true' || raw === 'false') && raw === unit.text && !Object.hasOwn(unit, 'numericLexeme');
    case 'null': return raw === 'null' && raw === unit.text && !Object.hasOwn(unit, 'numericLexeme');
    default: return false;
  }
}

function validTableUnit(unit: Record<string, unknown>, source: ContentSource): boolean {
  const allowed = ['id', 'sourceId', 'order', 'kind', 'locator', 'cellValue', 'numericLexeme'];
  if (Object.keys(unit).some((key) => !allowed.includes(key)) || typeof unit.cellValue !== 'string') return false;
  const locator = unit.locator;
  if (!isRecord(locator) || !exactKeys(locator, ['startByte', 'endByte', 'rowIndex', 'columnIndex'])) return false;
  if (![locator.startByte, locator.endByte, locator.rowIndex, locator.columnIndex].every(Number.isSafeInteger)
      || (locator.startByte as number) < 0 || (locator.endByte as number) < (locator.startByte as number)
      || (locator.endByte as number) > source.byteLength || (locator.rowIndex as number) < 0 || (locator.columnIndex as number) < 0) return false;
  let raw: string | null;
  try { raw = textAtByteRange(source.text!, locator.startByte as number, locator.endByte as number); } catch { return false; }
  if (raw === null) return false;
  let decoded: string;
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"') || raw.length < 2) return false;
    const interior = raw.slice(1, -1);
    decoded = '';
    for (let index = 0; index < interior.length; index += 1) {
      if (interior[index] === '"') {
        if (interior[index + 1] !== '"') return false;
        decoded += '"';
        index += 1;
      } else decoded += interior[index];
    }
  } else {
    if (raw.includes('"')) return false;
    decoded = raw;
  }
  if (decoded !== unit.cellValue) return false;
  const numeric = NUMERIC_CELL_PATTERN.test(unit.cellValue as string);
  return numeric === Object.hasOwn(unit, 'numericLexeme')
    && (!numeric || unit.numericLexeme === unit.cellValue);
}

function validMediaReferenceUnit(unit: Record<string, unknown>, source: ContentSource): boolean {
  if (source.kind !== 'image' || !exactKeys(unit, ['id', 'sourceId', 'order', 'kind', 'locator'])) return false;
  const locator = unit.locator;
  return isRecord(locator) && exactKeys(locator, ['startByte', 'endByte'])
    && locator.startByte === 0 && locator.endByte === source.byteLength;
}

/** Validate the internal, replaceable ContentIR shape and all integrity links. */
export function validateContentIR(value: unknown): ContentIR {
  if (!isRecord(value) || !exactKeys(value, ['id', 'schemaVersion', 'sources', 'units', 'warnings', 'hash']) || value.schemaVersion !== 1
      || !isDenseArray(value.sources) || !isDenseArray(value.units) || !isDenseArray(value.warnings) || typeof value.hash !== 'string'
      || !SHA256_PATTERN.test(value.hash)) {
    throw new TypeError('ContentIR has an unsupported shape');
  }
  if (value.sources.length > MAX_CONTENT_SOURCES || value.units.length > MAX_CONTENT_UNITS) {
    throw new TypeError('ContentIR exceeds its source or unit limit');
  }

  const sources: ContentSource[] = [];
  const sourceById = new Map<string, ContentSource>();
  let totalSourceBytes = 0;
  let totalTextBytes = 0;
  for (let index = 0; index < value.sources.length; index += 1) {
    const item = value.sources[index];
    if (!isRecord(item) || !exactKeys(item, ['id', 'sourcePath', 'originalName', 'mediaType', 'sha256', 'order', 'byteLength', 'kind', 'text', 'warnings'])
        || typeof item.sourcePath !== 'string' || !isSafeRelativePath(item.sourcePath)
        || typeof item.originalName !== 'string' || !item.originalName || item.originalName.includes('/') || item.originalName.includes('\\')
        || item.originalName !== path.posix.basename(item.sourcePath)
        || !isUtf8SizeWithin(item.sourcePath, 1024) || !isUtf8SizeWithin(item.originalName, 255)
        || typeof item.mediaType !== 'string' || !item.mediaType || item.mediaType.length > 128
        || typeof item.sha256 !== 'string' || !SHA256_PATTERN.test(item.sha256)
        || item.order !== index || !Number.isSafeInteger(item.byteLength) || (item.byteLength as number) < 0
        || (item.byteLength as number) > MAX_CONTENT_SOURCE_BYTES
        || !['text', 'image', 'unsupported'].includes(String(item.kind)) || !isDenseArray(item.warnings)
        || !item.warnings.every(validWarning)) {
      throw new TypeError(`ContentIR source ${index} is invalid`);
    }
    const source = item as unknown as ContentSource;
    if (source.id !== contentSourceId(source.sourcePath, source.order, source.sha256)) {
      throw new TypeError(`ContentIR source ${index} has a non-deterministic id`);
    }
    totalSourceBytes += source.byteLength;
    if (totalSourceBytes > MAX_CONTENT_TOTAL_BYTES) throw new TypeError('ContentIR exceeds the selected source byte limit');
    if (source.kind === 'text') {
      const extension = sourceExtension(source.sourcePath);
      if (!SUPPORTED_TEXT_EXTENSIONS.has(extension) || typeof source.text !== 'string') {
        throw new TypeError(`ContentIR text source ${index} is invalid`);
      }
      const textBytes = Buffer.byteLength(source.text, 'utf8');
      if (textBytes !== source.byteLength || digest(Buffer.from(source.text, 'utf8')) !== source.sha256) {
        throw new TypeError(`ContentIR source ${index} text does not match its source hash`);
      }
      totalTextBytes += textBytes;
      if (totalTextBytes > MAX_CONTENT_TEXT_BYTES) throw new TypeError('ContentIR exceeds the extracted text limit');
    } else {
      if (source.text !== null) throw new TypeError(`ContentIR non-text source ${index} must not contain extracted text`);
      if (source.kind === 'image' && !source.mediaType.toLowerCase().startsWith('image/')) {
        throw new TypeError(`ContentIR image source ${index} has a non-image media type`);
      }
    }
    if (sourceById.has(source.id)) throw new TypeError('ContentIR source ids must be unique');
    sourceById.set(source.id, source);
    sources.push({
      ...source,
      warnings: source.warnings.map((warning) => ({ code: warning.code, message: warning.message })),
    });
  }

  const units: ContentUnit[] = [];
  const unitIds = new Set<string>();
  for (let index = 0; index < value.units.length; index += 1) {
    const item = value.units[index];
    if (!isRecord(item) || item.order !== index || typeof item.id !== 'string' || typeof item.sourceId !== 'string'
        || !['text', 'heading', 'json-value', 'table-cell', 'media-reference'].includes(String(item.kind))) {
      throw new TypeError(`ContentIR unit ${index} is invalid`);
    }
    const source = sourceById.get(item.sourceId);
    if (!source) throw new TypeError(`ContentIR unit ${index} refers to an unknown source`);
    const extension = sourceExtension(source.sourcePath);
    const valid = item.kind === 'media-reference'
      ? validMediaReferenceUnit(item, source)
      : source.kind !== 'text'
        ? false
        : item.kind === 'text'
          ? ['.txt', '.md'].includes(extension) && validTextUnit(item, source, 'text')
          : item.kind === 'heading'
            ? extension === '.md' && validTextUnit(item, source, 'heading')
            : item.kind === 'json-value'
              ? extension === '.json' && validJsonUnit(item, source)
              : item.kind === 'table-cell' && ['.csv', '.tsv'].includes(extension) && validTableUnit(item, source);
    if (!valid) throw new TypeError(`ContentIR unit ${index} does not match its source`);
    const unit = item as unknown as ContentUnit;
    const { id: _id, ...unitPayload } = unit;
    if (unit.id !== contentUnitId(unit.sourceId, unitPayload) || unitIds.has(unit.id)) {
      throw new TypeError(`ContentIR unit ${index} has a non-deterministic id`);
    }
    unitIds.add(unit.id);
    units.push({ ...unit, locator: { ...unit.locator } });
  }

  const warnings: ContentIRWarning[] = [];
  for (const item of value.warnings) {
    if (!isRecord(item) || !exactKeys(item, ['sourceId', 'code', 'message'])
        || !(item.sourceId === null || (typeof item.sourceId === 'string' && sourceById.has(item.sourceId)))
        || typeof item.code !== 'string' || !item.code || item.code.length > 96
        || typeof item.message !== 'string' || !item.message || item.message.length > 512) {
      throw new TypeError('ContentIR warning is invalid');
    }
    warnings.push({ sourceId: item.sourceId as string | null, code: item.code, message: item.message });
  }

  const expectedWarnings = sources.flatMap((source) => source.warnings.map((item) => ({
    sourceId: source.id,
    code: item.code,
    message: item.message,
  })));
  if (stableJson(warnings) !== stableJson(expectedWarnings)) {
    throw new TypeError('ContentIR warnings do not match source warnings');
  }

  const resultWithoutHash = { schemaVersion: 1 as const, sources, units, warnings };
  if (contentIRHash(resultWithoutHash) !== value.hash) throw new TypeError('ContentIR hash does not match its contents');
  const expectedId = `cir_${value.hash.slice(0, 24)}`;
  if (value.id !== expectedId) throw new TypeError('ContentIR id does not match its contents');
  return { id: expectedId, ...resultWithoutHash, hash: value.hash };
}

/** Build a final hash after the compiler has constructed deterministic sources and units. */
export function finalizeContentIR(sources: ContentSource[], units: ContentUnit[]): ContentIR {
  const warnings: ContentIRWarning[] = sources.flatMap((source) => source.warnings.map((item) => ({
    sourceId: source.id,
    code: item.code,
    message: item.message,
  })));
  const payload = { schemaVersion: 1 as const, sources, units, warnings };
  const hash = contentIRHash(payload);
  return validateContentIR({ id: `cir_${hash.slice(0, 24)}`, ...payload, hash });
}

export function contentSourceSupportsText(sourcePath: string): boolean {
  return SUPPORTED_TEXT_EXTENSIONS.has(sourceExtension(sourcePath));
}

export function contentByteOffsets(text: string): Uint32Array {
  return byteOffsets(text);
}
