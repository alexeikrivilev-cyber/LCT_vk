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
export interface InspectionElement {
  type: string;
  name: string;
  elementId: string | null;
  text: string;
  placeholderRole: string | null;
  geometry: InspectionGeometry | null;
  sourcePart: string;
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
    }>;
    masters: Array<{ part: string; layoutParts: string[]; elements: InspectionElement[] }>;
    layouts: Array<{ part: string; masterPart: string | null; elements: InspectionElement[] }>;
    unsupportedParts: string[];
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

function validElement(value: unknown): value is InspectionElement {
  if (!isRecord(value) || !hasKeys(value, ['type', 'name', 'elementId', 'text', 'placeholderRole', 'geometry', 'sourcePart'])) return false;
  return isString(value.type)
    && isString(value.name)
    && isNullableString(value.elementId)
    && isString(value.text)
    && isNullableString(value.placeholderRole)
    && validGeometry(value.geometry)
    && validPart(value.sourcePart);
}

function validElements(value: unknown): value is InspectionElement[] {
  return Array.isArray(value) && value.length <= 100_000 && value.every(validElement);
}

function validPartArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 4096 && value.every(validPart);
}

function validateEnvelope(value: unknown): InspectionEnvelope {
  if (!isRecord(value) || !hasKeys(value, ['protocolVersion', 'schemaStatus', 'inspectionMs', 'inspection'])) {
    throw failure('INVALID_ENVELOPE', 'Python inspector returned an unexpected envelope object');
  }
  if (value.protocolVersion !== PROTOCOL_VERSION || value.schemaStatus !== SCHEMA_STATUS
      || typeof value.inspectionMs !== 'number' || !Number.isFinite(value.inspectionMs) || value.inspectionMs < 0) {
    throw failure('INVALID_ENVELOPE', 'Python inspector returned unsupported protocol metadata');
  }
  const inspection = value.inspection;
  if (!isRecord(inspection) || !hasKeys(inspection, ['schemaStatus', 'slideSize', 'slides', 'masters', 'layouts', 'unsupportedParts'])
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
    if (!isRecord(slide) || !hasKeys(slide, ['index', 'part', 'layoutPart', 'masterPart', 'elements'])) return false;
    return Number.isSafeInteger(slide.index) && (slide.index as number) > 0
      && validPart(slide.part) && (slide.layoutPart === null || validPart(slide.layoutPart))
      && (slide.masterPart === null || validPart(slide.masterPart)) && validElements(slide.elements);
  })) {
    throw failure('INVALID_ENVELOPE', 'Python inspector returned invalid slide observations');
  }
  if (!Array.isArray(inspection.masters) || inspection.masters.length > 4096 || !inspection.masters.every((master) =>
    isRecord(master) && hasKeys(master, ['part', 'layoutParts', 'elements']) && validPart(master.part)
      && validPartArray(master.layoutParts) && validElements(master.elements))) {
    throw failure('INVALID_ENVELOPE', 'Python inspector returned invalid master observations');
  }
  if (!Array.isArray(inspection.layouts) || inspection.layouts.length > 4096 || !inspection.layouts.every((layout) =>
    isRecord(layout) && hasKeys(layout, ['part', 'masterPart', 'elements']) && validPart(layout.part)
      && (layout.masterPart === null || validPart(layout.masterPart)) && validElements(layout.elements))) {
    throw failure('INVALID_ENVELOPE', 'Python inspector returned invalid layout observations');
  }
  if (!validPartArray(inspection.unsupportedParts)) {
    throw failure('INVALID_ENVELOPE', 'Python inspector returned invalid unsupported-part observations');
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
        resolve(validateEnvelope(parsed));
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