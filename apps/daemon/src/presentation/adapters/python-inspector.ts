/**
 * Internal, replaceable Node-to-Python boundary for the PPTX inspection spike.
 * This protocol is private evidence transport and is not a product contract.
 */
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTOCOL_VERSION = 1;
const SCHEMA_STATUS = 'REPLACEABLE/PROVISIONAL';
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const INSPECTION_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 3_000;
const PYTHON_PROBE = 'import sys;sys.stdout.write(f"{sys.version_info.major}.{sys.version_info.minor}")';
const MAX_PYTHON_CANDIDATES = 8;
const pythonProbeResults = new Map<string, Promise<boolean>>();

export type InspectionAdapterErrorCode =
  | 'INVALID_INPUT'
  | 'INPUT_UNAVAILABLE'
  | 'PYTHON_NOT_AVAILABLE'
  | 'PROCESS_START_FAILED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'OUTPUT_TOO_LARGE'
  | 'NON_ZERO_EXIT'
  | 'INVALID_PPTX'
  | 'INVALID_JSON'
  | 'INVALID_ENVELOPE';

/** @internal */
export class InspectionAdapterError extends Error {
  readonly code: InspectionAdapterErrorCode;
  readonly details?: { exitCode?: number | null; stderr?: string };

  constructor(
    code: InspectionAdapterErrorCode,
    message: string,
    details?: { exitCode?: number | null; stderr?: string },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'InspectionAdapterError';
    this.code = code;
    this.details = details;
  }
}

/** Internal replaceable DTO derived from the current donor inspector's output. */
export interface InspectionGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  unit: 'EMU';
}

/** @internal */
export interface InspectionPlaceholderIdentity {
  slideIndex: number | null;
  idx: string | null;
  type: string;
}

/** @internal */
export interface InspectionRelationship {
  id: string;
  type: string;
  target: string;
  targetPart: string | null;
  mode: 'internal' | 'external';
}

/** @internal */
export interface InspectionStyle {
  fonts?: string[];
  font_sizes_pt?: number[];
  bold?: boolean;
  italic?: boolean;
  fill_color?: string;
  line_color?: string;
}

/** @internal */
export interface InspectionElement {
  type: string;
  name: string;
  elementId: string | null;
  text: string;
  placeholderRole: string | null;
  placeholderIdentity: InspectionPlaceholderIdentity | null;
  rawGeometry: InspectionGeometry | null;
  resolvedGeometry: InspectionGeometry | null;
  geometryProvenance: 'direct' | 'group_transformed' | 'layout_explicit' | 'master_inherited' | 'unknown';
  geometryResolutionUnknown: boolean;
  style: InspectionStyle;
  relationship: InspectionRelationship | null;
  sourcePart: string;
  parentId: string | null;
  warnings: string[];
  sourceOrder: number;
}

/** @internal */
export interface InspectionEnvelope {
  protocolVersion: 1;
  schemaStatus: typeof SCHEMA_STATUS;
  inspectionMs: number;
  inspection: {
    schemaStatus: typeof SCHEMA_STATUS;
    slideSize: { width: number; height: number; unit: 'EMU' };
    slides: Array<{
      index: number;
      part: string;
      layoutPart: string | null;
      masterPart: string | null;
      elements: InspectionElement[];
      designElements: InspectionElement[];
      relationships: InspectionRelationship[];
      background: Record<string, unknown> | null;
      warnings: string[];
    }>;
    masters: Array<{
      part: string;
      declaredName: string;
      layoutParts: string[];
      elements: InspectionElement[];
      designElements: InspectionElement[];
      relationships: InspectionRelationship[];
      background: Record<string, unknown> | null;
      colorMapping: Record<string, unknown> | null;
    }>;
    layouts: Array<{
      part: string;
      masterPart: string | null;
      declaredName: string;
      declaredType: string | null;
      matchingName: string | null;
      preserve: boolean;
      placeholders: InspectionElement[];
      elements: InspectionElement[];
      designElements: InspectionElement[];
      relationships: InspectionRelationship[];
      background: Record<string, unknown> | null;
      colorMapping: Record<string, unknown> | null;
    }>;
    theme: { part: string; colors: Record<string, string>; fonts: Record<string, string> } | null;
    notesParts: string[];
    mediaParts: string[];
    unsupportedDetails: Array<Record<string, unknown>>;
    parserWarnings: string[];
  };
}

interface PythonLaunch {
  executable: string;
  argsPrefix: string[];
}

interface ProcessLimits {
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

const DEFAULT_LIMITS: ProcessLimits = {
  timeoutMs: INSPECTION_TIMEOUT_MS,
  maxStdoutBytes: MAX_STDOUT_BYTES,
  maxStderrBytes: MAX_STDERR_BYTES,
};

let defaultPythonLaunch: Promise<PythonLaunch> | undefined;
const inspectorScript = fileURLToPath(new URL('../../../python-inspector/inspect_cli.py', import.meta.url));

function failure(code: InspectionAdapterErrorCode, message: string): InspectionAdapterError {
  return new InspectionAdapterError(code, message);
}

function captureChild(
  executable: string,
  args: string[],
  timeoutMs: number,
  byteLimit: number,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, { shell: false, windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' }, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      reject(error);
      return;
    }
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(failure('PYTHON_NOT_AVAILABLE', 'Python 3.12 probe timed out'));
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (length + chunk.length > byteLimit) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          child.kill();
          reject(failure('PYTHON_NOT_AVAILABLE', 'Python 3.12 probe output exceeded its limit'));
        }
        return;
      }
      chunks.push(chunk);
      length += chunk.length;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

async function isPython312(executable: string, argsPrefix: string[]): Promise<boolean> {
  const key = JSON.stringify([executable, argsPrefix]);
  let result = pythonProbeResults.get(key);
  if (!result) {
    result = captureChild(executable, [...argsPrefix, '-c', PYTHON_PROBE], PROBE_TIMEOUT_MS, 64)
      .then((probe) => probe.code === 0 && probe.stdout === '3.12')
      .catch(() => false);
    pythonProbeResults.set(key, result);
  }
  return result;
}

async function discoverDefaultPython(): Promise<PythonLaunch> {
  if (process.platform === 'win32') {
    try {
      const listing = await captureChild('py', ['-0p'], PROBE_TIMEOUT_MS, 16 * 1024);
      if (listing.code === 0) {
        const selectors = listing.stdout
          .split(/\r?\n/)
          .map((line) => /^\s*(-V:\S+)(?:\s+\*)?\s+\S/.exec(line)?.[1])
          .filter((value): value is string => Boolean(value))
          .slice(0, MAX_PYTHON_CANDIDATES);
        for (const selector of selectors) {
          if (await isPython312('py', [selector])) return { executable: 'py', argsPrefix: [selector] };
        }
      }
    } catch {
      // Try the regular PATH executable below.
    }
  }

  for (const executable of process.platform === 'win32' ? ['python3', 'python'] : ['python3']) {
    if (await isPython312(executable, [])) return { executable, argsPrefix: [] };
  }
  throw failure('PYTHON_NOT_AVAILABLE', 'Python 3.12 is unavailable; configure LCT_PYTHON with an executable path');
}

async function resolvePythonLaunch(): Promise<PythonLaunch> {
  const override = process.env.LCT_PYTHON;
  if (override !== undefined) {
    if (!override || !path.isAbsolute(override)) {
      throw failure('PYTHON_NOT_AVAILABLE', 'LCT_PYTHON must be an absolute executable path without arguments');
    }
    if (!(await isPython312(override, []))) {
      throw failure('PYTHON_NOT_AVAILABLE', 'LCT_PYTHON must point to a working Python 3.12 executable');
    }
    return { executable: override, argsPrefix: [] };
  }
  defaultPythonLaunch ??= discoverDefaultPython();
  try {
    return await defaultPythonLaunch;
  } catch (error) {
    defaultPythonLaunch = undefined;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.length === Object.keys(value).length && keys.every((key) => Object.hasOwn(value, key));
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function validPart(value: unknown): value is string {
  return isString(value)
    && value.length > 0
    && !value.startsWith('/')
    && !value.includes('\\')
    && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function validGeometry(value: unknown): value is InspectionGeometry | null {
  if (value === null) return true;
  if (!isRecord(value) || !hasKeys(value, ['x', 'y', 'width', 'height', 'rotation', 'unit'])) return false;
  return Number.isSafeInteger(value.x)
    && Number.isSafeInteger(value.y)
    && Number.isSafeInteger(value.width)
    && Number.isSafeInteger(value.height)
    && typeof value.rotation === 'number'
    && Number.isFinite(value.rotation)
    && value.unit === 'EMU';
}

function validStringArray(value: unknown, maxLength = 100_000): value is string[] {
  return Array.isArray(value) && value.length <= maxLength && value.every(isString);
}

function validPartArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 4096 && value.every(validPart);
}

function validStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(isString);
}

function validPlaceholder(value: unknown, expectedSlideIndex: number | null): value is InspectionPlaceholderIdentity | null {
  if (value === null) return true;
  return isRecord(value) && hasKeys(value, ['slideIndex', 'idx', 'type'])
    && (value.slideIndex === null || (Number.isSafeInteger(value.slideIndex) && (value.slideIndex as number) > 0))
    && value.slideIndex === expectedSlideIndex
    && isNullableString(value.idx)
    && isString(value.type);
}

function validStyle(value: unknown): value is InspectionStyle {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !['fonts', 'font_sizes_pt', 'bold', 'italic', 'fill_color', 'line_color'].includes(key))) return false;
  if (Object.hasOwn(value, 'fonts') && !validStringArray(value.fonts, 4096)) return false;
  if (Object.hasOwn(value, 'font_sizes_pt')
      && (!Array.isArray(value.font_sizes_pt) || value.font_sizes_pt.length > 4096
        || !value.font_sizes_pt.every((size) => typeof size === 'number' && Number.isFinite(size)))) return false;
  if (Object.hasOwn(value, 'bold') && typeof value.bold !== 'boolean') return false;
  if (Object.hasOwn(value, 'italic') && typeof value.italic !== 'boolean') return false;
  if (Object.hasOwn(value, 'fill_color') && !isString(value.fill_color)) return false;
  if (Object.hasOwn(value, 'line_color') && !isString(value.line_color)) return false;
  return true;
}

function validRelationship(value: unknown): value is InspectionRelationship {
  if (!isRecord(value) || !hasKeys(value, ['id', 'type', 'target', 'targetPart', 'mode'])) return false;
  return isString(value.id) && value.id.length > 0
    && isString(value.type) && value.type.length > 0
    && isString(value.target)
    && (value.targetPart === null || validPart(value.targetPart))
    && (value.mode === 'internal' || value.mode === 'external')
    && ((value.mode === 'external' && value.targetPart === null)
      || (value.mode === 'internal' && value.targetPart !== null));
}

function validRelationships(value: unknown): value is InspectionRelationship[] {
  return Array.isArray(value) && value.length <= 4096 && value.every(validRelationship);
}

const ELEMENT_KEYS = [
  'type', 'name', 'elementId', 'text', 'placeholderRole', 'placeholderIdentity', 'rawGeometry',
  'resolvedGeometry', 'geometryProvenance', 'geometryResolutionUnknown', 'style', 'relationship', 'sourcePart', 'parentId', 'warnings', 'sourceOrder',
];

function validElement(value: unknown, expectedSlideIndex: number | null): value is InspectionElement {
  if (!isRecord(value) || !hasKeys(value, ELEMENT_KEYS)) return false;
  return isString(value.type)
    && isString(value.name)
    && isNullableString(value.elementId)
    && isString(value.text)
    && isNullableString(value.placeholderRole)
    && validPlaceholder(value.placeholderIdentity, expectedSlideIndex)
    && validGeometry(value.rawGeometry)
    && validGeometry(value.resolvedGeometry)
    && ['direct', 'group_transformed', 'layout_explicit', 'master_inherited', 'unknown'].includes(String(value.geometryProvenance))
    && typeof value.geometryResolutionUnknown === 'boolean'
    && (!value.geometryResolutionUnknown || (value.resolvedGeometry === null && value.geometryProvenance === 'unknown'))
    && validStyle(value.style)
    && (value.relationship === null || validRelationship(value.relationship))
    && validPart(value.sourcePart)
    && isNullableString(value.parentId)
    && validStringArray(value.warnings, 4096)
    && Number.isSafeInteger(value.sourceOrder) && (value.sourceOrder as number) >= 0;
}

function validElements(value: unknown, expectedSlideIndex: number | null): value is InspectionElement[] {
  return Array.isArray(value) && value.length <= 100_000 && value.every((element) => validElement(element, expectedSlideIndex));
}

function validBackgroundFill(value: unknown): boolean {
  if (!isRecord(value) || !hasKeys(value, ['kind', 'attributes', 'colors', 'relationship'])
      || !isString(value.kind) || !validStringRecord(value.attributes) || !Array.isArray(value.colors)) return false;
  if (!value.colors.every((color) => isRecord(color) && hasKeys(color, ['type', 'attributes', 'position'])
      && isString(color.type) && validStringRecord(color.attributes) && isNullableString(color.position))) return false;
  return value.relationship === null || validRelationship(value.relationship);
}

function validBackground(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (value.kind === 'bgRef') {
    return hasKeys(value, ['kind', 'idx', 'scheme_color', 'scheme_color_type', 'fill'])
      && isNullableString(value.idx) && isNullableString(value.scheme_color)
      && isNullableString(value.scheme_color_type) && value.fill === null;
  }
  return value.kind === 'explicit' && hasKeys(value, ['kind', 'element', 'fill']) && isString(value.element)
    && (value.fill === null || validBackgroundFill(value.fill));
}

function validColorMapping(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (!keys.length || keys.some((key) => !['master_mapping', 'layout_override'].includes(key))) return false;
  if (Object.hasOwn(value, 'master_mapping') && !validStringRecord(value.master_mapping)) return false;
  if (Object.hasOwn(value, 'layout_override')) {
    if (!Array.isArray(value.layout_override) || !value.layout_override.every((entry) => isRecord(entry)
      && hasKeys(entry, ['element', 'attributes']) && isString(entry.element) && validStringRecord(entry.attributes))) return false;
  }
  return true;
}

function validTheme(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value) || !hasKeys(value, ['part', 'colors', 'fonts']) || !validPart(value.part)
      || !validStringRecord(value.colors) || !isRecord(value.fonts)) return false;
  return Object.keys(value.fonts).every((key) => ['major', 'minor'].includes(key))
    && Object.values(value.fonts).every(isString);
}

function validUnsupportedDetails(value: unknown): boolean {
  const allowed = ['kind', 'part', 'reason', 'slide', 'element', 'relationship_id', 'target'];
  return Array.isArray(value) && value.length <= 100_000 && value.every((detail) => {
    if (!isRecord(detail)) return false;
    const keys = Object.keys(detail);
    if (keys.some((key) => !allowed.includes(key)) || !['kind', 'part', 'reason'].every((key) => Object.hasOwn(detail, key))) return false;
    if (!isString(detail.kind) || !validPart(detail.part) || !isString(detail.reason)) return false;
    return ['slide', 'element', 'relationship_id', 'target'].every((key) => !Object.hasOwn(detail, key) || isString(detail[key]));
  });
}

/** @internal Test seam for exact validation of the private replaceable envelope. */
export function validateInspectionEnvelope(value: unknown): InspectionEnvelope {
  if (!isRecord(value) || !hasKeys(value, ['protocolVersion', 'schemaStatus', 'inspectionMs', 'inspection'])) {
    throw failure('INVALID_ENVELOPE', 'Python inspector returned an unexpected envelope object');
  }
  if (value.protocolVersion !== PROTOCOL_VERSION || value.schemaStatus !== SCHEMA_STATUS
      || typeof value.inspectionMs !== 'number' || !Number.isFinite(value.inspectionMs) || value.inspectionMs < 0) {
    throw failure('INVALID_ENVELOPE', 'Python inspector returned unsupported protocol metadata');
  }
  const inspection = value.inspection;
  if (!isRecord(inspection) || !hasKeys(inspection, ['schemaStatus', 'slideSize', 'slides', 'masters', 'layouts', 'theme', 'notesParts', 'mediaParts', 'unsupportedDetails', 'parserWarnings'])
      || inspection.schemaStatus !== SCHEMA_STATUS) {
    throw failure('INVALID_ENVELOPE', 'Python inspector returned invalid inspection metadata');
  }
  const slideSize = inspection.slideSize;
  if (!isRecord(slideSize) || !hasKeys(slideSize, ['width', 'height', 'unit'])
      || !Number.isSafeInteger(slideSize.width) || (slideSize.width as number) <= 0
      || !Number.isSafeInteger(slideSize.height) || (slideSize.height as number) <= 0 || slideSize.unit !== 'EMU') {
    throw failure('INVALID_ENVELOPE', 'Python inspector returned invalid slide dimensions');
  }
  if (!Array.isArray(inspection.slides) || inspection.slides.length > 4096 || !inspection.slides.every((slide) => {
    if (!isRecord(slide) || !hasKeys(slide, ['index', 'part', 'layoutPart', 'masterPart', 'elements', 'designElements', 'relationships', 'background', 'warnings'])) return false;
    return Number.isSafeInteger(slide.index) && (slide.index as number) > 0
      && validPart(slide.part) && (slide.layoutPart === null || validPart(slide.layoutPart))
      && (slide.masterPart === null || validPart(slide.masterPart))
      && validElements(slide.elements, slide.index as number)
      && validElements(slide.designElements, slide.index as number)
      && validRelationships(slide.relationships) && validBackground(slide.background) && validStringArray(slide.warnings, 4096);
  })) {
    throw failure('INVALID_ENVELOPE', 'Python inspector returned invalid slide observations');
  }
  if (!Array.isArray(inspection.masters) || inspection.masters.length > 4096 || !inspection.masters.every((master) =>
    isRecord(master) && hasKeys(master, ['part', 'declaredName', 'layoutParts', 'elements', 'designElements', 'relationships', 'background', 'colorMapping'])
      && validPart(master.part) && isString(master.declaredName)
      && validPartArray(master.layoutParts) && validElements(master.elements, null) && validElements(master.designElements, null)
      && validRelationships(master.relationships) && validBackground(master.background) && validColorMapping(master.colorMapping))) {
    throw failure('INVALID_ENVELOPE', 'Python inspector returned invalid master observations');
  }
  if (!Array.isArray(inspection.layouts) || inspection.layouts.length > 4096 || !inspection.layouts.every((layout) =>
    isRecord(layout) && hasKeys(layout, ['part', 'masterPart', 'declaredName', 'declaredType', 'matchingName', 'preserve', 'placeholders', 'elements', 'designElements', 'relationships', 'background', 'colorMapping'])
      && validPart(layout.part) && (layout.masterPart === null || validPart(layout.masterPart))
      && isString(layout.declaredName) && isNullableString(layout.declaredType) && isNullableString(layout.matchingName)
      && typeof layout.preserve === 'boolean' && validElements(layout.placeholders, null)
      && validElements(layout.elements, null) && validElements(layout.designElements, null)
      && validRelationships(layout.relationships) && validBackground(layout.background) && validColorMapping(layout.colorMapping))) {
    throw failure('INVALID_ENVELOPE', 'Python inspector returned invalid layout observations');
  }
  if (!validTheme(inspection.theme) || !validPartArray(inspection.notesParts) || !validPartArray(inspection.mediaParts)
      || !validUnsupportedDetails(inspection.unsupportedDetails) || !validStringArray(inspection.parserWarnings, 100_000)) {
    throw failure('INVALID_ENVELOPE', 'Python inspector returned invalid inspection details');
  }
  return value as unknown as InspectionEnvelope;
}

function boundedStderr(chunks: Buffer[], length: number, maxBytes: number): string {
  return Buffer.concat(chunks, length).toString('utf8');
}

/** @internal Test seam for the one private JSON process boundary; not a generic runner. */
export function runInspectorProcess(
  executable: string,
  args: string[],
  options: { signal?: AbortSignal; limits?: Partial<ProcessLimits> } = {},
): Promise<InspectionEnvelope> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, { shell: false, windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new InspectionAdapterError('PROCESS_START_FAILED', 'Could not start Python inspector', undefined, { cause: error }));
      return;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let settled = false;
    let forcedError: InspectionAdapterError | undefined;
    const finishReject = (error: InspectionAdapterError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    };
    const killWith = (error: InspectionAdapterError) => {
      forcedError ??= error;
      child.kill();
    };
    const onAbort = () => killWith(failure('CANCELLED', 'PPTX inspection was cancelled'));
    const timer = setTimeout(() => killWith(failure('TIMEOUT', 'Python inspector exceeded its time limit')), limits.timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled || forcedError) return;
      if (stdoutLength + chunk.length > limits.maxStdoutBytes) {
        killWith(failure('OUTPUT_TOO_LARGE', 'Python inspector output exceeded its byte limit'));
        return;
      }
      stdoutChunks.push(chunk);
      stdoutLength += chunk.length;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (settled || stderrLength >= limits.maxStderrBytes) return;
      const retained = chunk.subarray(0, limits.maxStderrBytes - stderrLength);
      stderrChunks.push(retained);
      stderrLength += retained.length;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      const code = error.code === 'ENOENT' ? 'PYTHON_NOT_AVAILABLE' : 'PROCESS_START_FAILED';
      finishReject(new InspectionAdapterError(code, 'Could not start Python inspector', undefined, { cause: error }));
    });
    child.on('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const stderr = boundedStderr(stderrChunks, stderrLength, limits.maxStderrBytes);
      if (forcedError) {
        reject(new InspectionAdapterError(forcedError.code, forcedError.message, { stderr }));
        return;
      }
      if (exitCode !== 0) {
        if (stderr.startsWith('LCT_INPUT_ERROR:')) {
          reject(new InspectionAdapterError('INVALID_PPTX', stderr.slice('LCT_INPUT_ERROR:'.length).trim(), { exitCode, stderr }));
          return;
        }
        if (stderr.startsWith('LCT_IO_ERROR:')) {
          reject(new InspectionAdapterError('INPUT_UNAVAILABLE', stderr.slice('LCT_IO_ERROR:'.length).trim(), { exitCode, stderr }));
          return;
        }
        if (/Fatal Python error|No module named ['"]encodings['"]/.test(stderr)) {
          reject(new InspectionAdapterError('PYTHON_NOT_AVAILABLE', 'Configured Python could not initialize', { exitCode, stderr }));
          return;
        }
        reject(new InspectionAdapterError('NON_ZERO_EXIT', `Python inspector exited with code ${exitCode ?? signal ?? 'unknown'}`, { exitCode, stderr }));
        return;
      }
      const stdout = Buffer.concat(stdoutChunks, stdoutLength).toString('utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch (error) {
        reject(new InspectionAdapterError('INVALID_JSON', 'Python inspector returned invalid JSON', { stderr }, { cause: error }));
        return;
      }
      try {
        resolve(validateInspectionEnvelope(parsed));
      } catch (error) {
        reject(error instanceof InspectionAdapterError ? error : failure('INVALID_ENVELOPE', 'Python inspector returned an invalid envelope'));
      }
    });
  });
}

/** Inspect one absolute local PPTX path through the private versioned protocol. */
export async function inspectPptx(absolutePptxPath: string, options: { signal?: AbortSignal } = {}): Promise<InspectionEnvelope> {
  if (!path.isAbsolute(absolutePptxPath)) throw failure('INVALID_INPUT', 'PPTX path must be absolute');
  let info;
  try {
    info = await stat(absolutePptxPath);
  } catch (error) {
    throw new InspectionAdapterError('INVALID_INPUT', 'PPTX input file is unavailable', undefined, { cause: error });
  }
  if (!info.isFile()) throw failure('INVALID_INPUT', 'PPTX input path must refer to a file');
  if (info.size > MAX_INPUT_BYTES) throw failure('INVALID_INPUT', `PPTX exceeds ${MAX_INPUT_BYTES} byte input limit`);
  const python = await resolvePythonLaunch();
  return runInspectorProcess(python.executable, [...python.argsPrefix, inspectorScript, absolutePptxPath], { signal: options.signal });
}
