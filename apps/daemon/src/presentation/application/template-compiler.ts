import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  derivePresentationDesignSystem,
  createTemplateIR,
  validatePresentationDesignSystem,
  validateTemplateIR,
  type PresentationDesignSystem,
  type TemplateIR,
  type TemplateSource,
} from './template-mapper.js';
import { inspectPptx } from '../adapters/python-inspector.js';
import { addTemplateMediaVisualFingerprints } from '../adapters/office-kit-template-media-fingerprint.js';
import { resolvePresentationFilePath } from '../../presentation-files.js';
import { recordElapsed, type PerformanceDiagnosticsPort } from '../performance-diagnostics.js';

export type TemplateTypographyResolver = (templateIR: TemplateIR, sourceBytes: Uint8Array) => Promise<void>;

const COMPILER_VERSION = 'lct-template-compiler/2';
const MAX_TEMPLATE_BYTES = 64 * 1024 * 1024;
const STATE_RELATIVE_PATH = '.template-compiler/state.json';

interface SuccessfulCompilation {
  source: TemplateSource;
  templateIR: TemplateIR;
  presentationDesignSystem: PresentationDesignSystem;
}

interface StoredTemplateState {
  schemaVersion: 1;
  latestAttempt: {
    status: 'ready';
    filePath: string;
    sourceSha256: string;
    compiledAt: string;
  } | {
    status: 'failed';
    source: { filePath: string; originalName: string; sha256?: string };
    attemptedAt: string;
    failure: { code: string; message: string };
  };
  lastSuccessful: SuccessfulCompilation | null;
}

export type TemplateCompilationStatus = 'uncompiled' | 'ready' | 'stale' | 'failed';

export interface TemplateCompilationResponse {
  status: TemplateCompilationStatus;
  source?: { filePath: string; originalName: string; sha256?: string };
  currentSourceSha256?: string;
  compiledAt?: string;
  failure?: { code: string; message: string };
  templateIR?: TemplateIR;
  presentationDesignSystem?: PresentationDesignSystem;
}

export class TemplateCompilerError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TemplateCompilerError';
    this.code = code;
    this.status = status;
  }
}

function sourceNameFor(filePath: string): string {
  return path.posix.basename(filePath.replaceAll('\\', '/'));
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function sourceHash(absolutePath: string): Promise<string> {
  return hashBytes(await readFile(absolutePath));
}

function statePath(projectsRoot: string, projectId: string): Promise<string> {
  return resolvePresentationFilePath(projectsRoot, projectId, STATE_RELATIVE_PATH, { createParent: true })
    .then((resolved) => resolved.absolute);
}

async function writeState(projectsRoot: string, projectId: string, state: StoredTemplateState): Promise<void> {
  const target = await statePath(projectsRoot, projectId);
  const temp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateStoredState(value: unknown): StoredTemplateState {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.latestAttempt)) {
    throw new TypeError('Stored template state has an unsupported shape');
  }
  const lastSuccessfulValue = value.lastSuccessful;
  let lastSuccessful: SuccessfulCompilation | null = null;
  if (lastSuccessfulValue !== null) {
    if (!isRecord(lastSuccessfulValue)) throw new TypeError('Stored compilation is invalid');
    const templateIR = validateTemplateIR(lastSuccessfulValue.templateIR);
    const storedSource = lastSuccessfulValue.source;
    if (!isRecord(storedSource) || Object.keys(storedSource).length !== 5) {
      throw new TypeError('Stored source metadata does not match TemplateIR');
    }
    if (['filePath', 'originalName', 'sha256', 'compiledAt', 'compilerVersion']
      .some((key) => storedSource[key] !== templateIR.source[key as keyof TemplateSource])) {
      throw new TypeError('Stored source metadata does not match TemplateIR');
    }
    lastSuccessful = {
      source: templateIR.source,
      templateIR,
      presentationDesignSystem: validatePresentationDesignSystem(lastSuccessfulValue.presentationDesignSystem, templateIR),
    };
  }
  if (value.latestAttempt.status === 'ready') {
    const attempt = value.latestAttempt;
    if (typeof attempt.filePath !== 'string' || typeof attempt.sourceSha256 !== 'string' || typeof attempt.compiledAt !== 'string'
        || !lastSuccessful || lastSuccessful.source.filePath !== attempt.filePath
        || lastSuccessful.source.sha256 !== attempt.sourceSha256 || lastSuccessful.source.compiledAt !== attempt.compiledAt) {
      throw new TypeError('Stored successful attempt does not match its canonical snapshot');
    }
    return {
      schemaVersion: 1,
      latestAttempt: { status: 'ready', filePath: attempt.filePath, sourceSha256: attempt.sourceSha256, compiledAt: attempt.compiledAt },
      lastSuccessful,
    };
  }
  if (value.latestAttempt.status === 'failed') {
    const attempt = value.latestAttempt;
    if (!isRecord(attempt.source) || !isRecord(attempt.failure)
        || typeof attempt.source.filePath !== 'string'
        || typeof attempt.source.originalName !== 'string'
        || typeof attempt.attemptedAt !== 'string'
        || typeof attempt.failure.code !== 'string'
        || typeof attempt.failure.message !== 'string') {
      throw new TypeError('Stored failed attempt is invalid');
    }
    return {
      schemaVersion: 1,
      latestAttempt: {
        status: 'failed',
        source: {
          filePath: attempt.source.filePath,
          originalName: attempt.source.originalName,
          ...(typeof attempt.source.sha256 === 'string' ? { sha256: attempt.source.sha256 } : {}),
        },
        attemptedAt: attempt.attemptedAt,
        failure: { code: attempt.failure.code, message: attempt.failure.message },
      },
      lastSuccessful,
    };
  }
  throw new TypeError('Stored template attempt has an unsupported status');
}

async function readState(projectsRoot: string, projectId: string): Promise<StoredTemplateState | null> {
  const file = await statePath(projectsRoot, projectId);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return validateStoredState(JSON.parse(raw));
  } catch (error) {
    throw new TemplateCompilerError('PERSISTED_STATE_INVALID', 'Saved template understanding is invalid; compile the source again.', 500, { cause: error });
  }
}

function publicSnapshot(snapshot: SuccessfulCompilation, status: 'ready' | 'stale', currentSourceSha256?: string): TemplateCompilationResponse {
  return {
    status,
    source: {
      filePath: snapshot.source.filePath,
      originalName: snapshot.source.originalName,
      sha256: snapshot.source.sha256,
    },
    ...(currentSourceSha256 ? { currentSourceSha256 } : {}),
    compiledAt: snapshot.source.compiledAt,
    templateIR: snapshot.templateIR,
    presentationDesignSystem: snapshot.presentationDesignSystem,
  };
}

/** Compile one project-owned PPTX deterministically and persist canonical state. */
export async function compileTemplate(
  projectsRoot: string,
  projectId: string,
  requestedFilePath: string,
  resolveEffectiveTypography?: TemplateTypographyResolver,
  diagnostics?: PerformanceDiagnosticsPort,
): Promise<TemplateCompilationResponse> {
  const filePath = typeof requestedFilePath === 'string' ? requestedFilePath.trim() : '';
  if (!filePath || path.posix.extname(filePath.replaceAll('\\', '/')).toLowerCase() !== '.pptx') {
    throw new TemplateCompilerError('INVALID_TEMPLATE_PATH', 'Choose a .pptx file from this project.', 400);
  }

  const requestedName = sourceNameFor(filePath);
  let source: { filePath: string; originalName: string; sha256?: string } = {
    // A rejected caller path is not a project-relative source path. Persist only
    // its basename so failed attempts cannot disclose absolute/traversal paths.
    filePath: requestedName,
    originalName: requestedName,
  };
  const attemptedAt = new Date().toISOString();
  try {
    const resolved = await resolvePresentationFilePath(projectsRoot, projectId, filePath, { requireExisting: true });
    const info = await stat(resolved.absolute);
    if (!info.isFile()) throw new TemplateCompilerError('TEMPLATE_NOT_FOUND', 'The selected template file was not found.', 404);
    if (info.size > MAX_TEMPLATE_BYTES) throw new TemplateCompilerError('TEMPLATE_TOO_LARGE', 'The PPTX exceeds the 64 MiB template limit.', 413);

    const sourceBytes = await readFile(resolved.absolute);
    const beforeHash = hashBytes(sourceBytes);
    source = { ...source, filePath: resolved.name, sha256: beforeHash };
    const compiledAt = new Date().toISOString();
    const templateSource: TemplateSource = {
      filePath: resolved.name,
      originalName: source.originalName,
      sha256: beforeHash,
      compiledAt,
      compilerVersion: COMPILER_VERSION,
    };
    const parseStartedAt = performance.now();
    const inspection = await inspectPptx(resolved.absolute);
    recordElapsed(diagnostics, 'template.structuralParse', parseStartedAt);
    diagnostics?.increment('templateStructuralParseCount');
    const afterHash = await sourceHash(resolved.absolute);
    if (beforeHash !== afterHash) {
      throw new TemplateCompilerError('SOURCE_CHANGED_DURING_COMPILE', 'The PPTX changed during inspection. Compile it again.', 409);
    }

    const mappingStartedAt = performance.now();
    const mappedTemplateIR = createTemplateIR(inspection, templateSource);
    diagnostics?.increment('templateIRMappingCount');
    recordElapsed(diagnostics, 'template.structuralMapping', mappingStartedAt);
    const fingerprintStartedAt = performance.now();
    await addTemplateMediaVisualFingerprints(mappedTemplateIR, sourceBytes);
    recordElapsed(diagnostics, 'template.mediaFingerprint', fingerprintStartedAt);
    diagnostics?.increment('templateMediaFingerprintCount', mappedTemplateIR.assets.filter((asset) => asset.visualFingerprint).length);
    if (resolveEffectiveTypography) {
      try {
        const typographyStartedAt = performance.now();
        await resolveEffectiveTypography(mappedTemplateIR, sourceBytes);
        recordElapsed(diagnostics, 'template.effectiveTypography', typographyStartedAt);
      } catch (error) {
        const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'TEMPLATE_TYPOGRAPHY_RESOLUTION_FAILED';
        console.warn(`Template typography resolution unavailable (${code}); conservative fit gates remain active.`);
      }
    }
    const templateIR = validateTemplateIR(mappedTemplateIR);
    const designSystemStartedAt = performance.now();
    const presentationDesignSystem = validatePresentationDesignSystem(derivePresentationDesignSystem(templateIR), templateIR);
    recordElapsed(diagnostics, 'template.designSystemExtraction', designSystemStartedAt);
    diagnostics?.increment('templateDesignSystemExtractionCount');
    const snapshot: SuccessfulCompilation = { source: templateSource, templateIR, presentationDesignSystem };
    await writeState(projectsRoot, projectId, {
      schemaVersion: 1,
      latestAttempt: { status: 'ready', filePath: templateSource.filePath, sourceSha256: beforeHash, compiledAt },
      lastSuccessful: snapshot,
    });
    return publicSnapshot(snapshot, 'ready');
  } catch (error) {
    const failure = normalizeCompileError(error);
    const priorState = await readState(projectsRoot, projectId).catch(() => null);
    try {
      await writeState(projectsRoot, projectId, {
        schemaVersion: 1,
        latestAttempt: { status: 'failed', source, attemptedAt, failure: { code: failure.code, message: failure.message } },
        lastSuccessful: priorState?.lastSuccessful ?? null,
      });
    } catch {
      // Preserve the original compile failure if persistence is also unavailable.
    }
    throw failure;
  }
}

function normalizeCompileError(error: unknown): TemplateCompilerError {
  if (error instanceof TemplateCompilerError) return error;
  if (isRecord(error) && typeof error.code === 'string') {
    const code = error.code;
    if (code === 'ENOENT') {
      return new TemplateCompilerError('TEMPLATE_NOT_FOUND', 'The selected PPTX file was not found in this project.', 404, { cause: error });
    }
    const message = typeof error.message === 'string' ? error.message : 'Template inspection failed.';
    if (code === 'INVALID_PPTX') return new TemplateCompilerError(code, 'The file is not a valid supported PPTX package.', 422, { cause: error });
    if (code === 'INVALID_INPUT' || code === 'INPUT_UNAVAILABLE') {
      return new TemplateCompilerError('TEMPLATE_NOT_FOUND', 'The selected PPTX file could not be read.', 404, { cause: error });
    }
    if (code === 'PYTHON_NOT_AVAILABLE' || code === 'PROCESS_START_FAILED') {
      return new TemplateCompilerError('INSPECTOR_UNAVAILABLE', 'The PPTX inspection runtime is unavailable.', 503, { cause: error });
    }
    if (code === 'TIMEOUT') return new TemplateCompilerError('INSPECTION_TIMEOUT', 'PPTX inspection exceeded its time limit.', 504, { cause: error });
    return new TemplateCompilerError(code, message, 500, { cause: error });
  }
  if (error instanceof Error && /invalid project file path|project file escapes project root|project file symlink escapes project root/.test(error.message)) {
    return new TemplateCompilerError('INVALID_TEMPLATE_PATH', 'The selected file path is outside this project.', 400, { cause: error });
  }
  return new TemplateCompilerError('TEMPLATE_COMPILE_FAILED', 'Template compilation failed.', 500, {
    cause: error instanceof Error ? error : new Error(String(error)),
  });
}

/** Read the saved snapshot and compare its source hash with the current project file. */
export async function getTemplateCompilation(
  projectsRoot: string,
  projectId: string,
): Promise<TemplateCompilationResponse> {
  const state = await readState(projectsRoot, projectId);
  if (!state) return { status: 'uncompiled' };
  if (state.latestAttempt.status === 'failed') {
    return {
      status: 'failed',
      source: state.latestAttempt.source,
      failure: state.latestAttempt.failure,
    };
  }

  const snapshot = state.lastSuccessful;
  if (!snapshot) {
    throw new TemplateCompilerError('PERSISTED_STATE_INVALID', 'Saved template understanding is missing; compile the source again.', 500);
  }
  try {
    const resolved = await resolvePresentationFilePath(projectsRoot, projectId, snapshot.source.filePath, { requireExisting: true });
    const currentHash = await sourceHash(resolved.absolute);
    return currentHash === snapshot.source.sha256
      ? publicSnapshot(snapshot, 'ready')
      : publicSnapshot(snapshot, 'stale', currentHash);
  } catch {
    return publicSnapshot(snapshot, 'stale');
  }
}
