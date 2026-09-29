// Presentation-only daemon surface. Generic OpenDesign collaboration,
// marketplace, campaign, AMR, connector, automation and multi-media planes
// intentionally do not register here.

import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { assertLoopbackDaemonBindHost, DEFAULT_DAEMON_PORT, parseDaemonPort } from './daemon-bind-host.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';

import {
  createPresentationProject,
  deletePresentationProject,
  getPresentationProject,
  listPresentationProjects,
  openPresentationStore,
  patchPresentationProject,
} from './presentation-store.js';
import {
  deletePresentationFile,
  assertSafeProjectId,
  ensurePresentationProjectDir,
  listPresentationFiles,
  mimeForPresentationFile,
  normalizeMultipartFilename,
  removePresentationProjectDir,
  resolvePresentationFilePath,
  writePresentationFile,
} from './presentation-files.js';
import {
  listPresentationDesignSystems,
  listPresentationSkills,
  resolveDesignSystemFile,
  resolveDesignSystemPreview,
} from './presentation-catalog.js';
import { generatePresentationImage } from './media/index.js';
import { presentationImageConfig, presentationImageModels } from './media/models.js';
import {
  OpenAICompatibleSemanticInferenceAdapter,
  probeSemanticEndpoint,
  semanticInferenceConfigFromEnvironment,
} from './presentation/adapters/openai-compatible-semantic-inference.js';
import { derivePlanningContentBudgets } from './presentation/adapters/office-kit-planning-content-budgets.js';
import { SemanticInferenceError, type SemanticInferenceAdapter } from './presentation/application/semantic-inference-port.js';
import { PlanningService, PlanningServiceError } from './presentation/application/planning-service.js';
import { ProductWorkflowError, ProductWorkflowService } from './presentation/application/product-workflow-service.js';
import {
  createDeterministicTemplateSemanticProfile,
  projectTemplateSemanticProfileCache,
  projectTemplateSemanticProfilePreparationStore,
  TemplateSemanticProfiler,
  type TemplateSemanticProfile,
  type TemplateSemanticProfilePreparationRecord,
} from './presentation/application/template-semantic-profiler.js';
import {
  PresentationGenerationError,
  PresentationGenerationService,
} from './presentation/application/generation-service.js';
import type { PptxRendererPort } from './presentation/application/pptx-backend-port.js';
import type { PptxPreviewPort } from './presentation/application/pptx-preview-port.js';
import { createPptxRenderer, resolvePptxBackend } from './presentation/adapters/pptx-renderer-factory.js';
import { addEffectivePlaceholderTypography } from './presentation/adapters/office-kit-effective-typography.js';
import type { PerformanceDiagnosticsPort } from './presentation/performance-diagnostics.js';
import {
  compileTemplate,
  getTemplateCompilation,
  TemplateCompilerError,
} from './presentation/application/template-compiler.js';

export interface StartServerOptions {
  host?: string;
  port?: number;
  dataDir?: string;
  projectRoot?: string;
  serveWeb?: boolean;
  returnServer?: boolean;
  semanticInferenceAdapter?: SemanticInferenceAdapter;
  semanticInferenceAdapterFactory?: () => SemanticInferenceAdapter;
  /** Internal structural-only seam. The normal daemon enables prepared semantic profiles. */
  enableSemanticProfiling?: boolean;
  /** Replaceable bounded concurrency for template preparation; defaults to LCT_TEMPLATE_PROFILE_CONCURRENCY or 1. */
  templateProfileConcurrency?: number;
  /** Replaceable renderer seam used by offline application tests. */
  presentationRenderer?: PptxRendererPort;
  /** Replaceable preview seam used by offline application tests. */
  presentationPreview?: PptxPreviewPort;
  /** Scoped local measurement seam for deterministic qualification runs. */
  performanceDiagnostics?: PerformanceDiagnosticsPort;
  /** Offline golden replay seam; omitted by normal daemon startup. */
  planningNow?: () => Date;
  /** Offline golden replay seam; omitted by normal daemon startup. */
  planningCreateId?: () => string;
  /** Offline golden replay seam; omitted by normal daemon startup. */
  generationCreateId?: () => string;
}

export interface StartedPresentationServer {
  server: Server;
  url: string;
  shutdown: () => Promise<void>;
}

function repoRootFromModule(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const daemonDir = ['src', 'dist'].includes(path.basename(moduleDir)) ? path.dirname(moduleDir) : moduleDir;
  return path.resolve(daemonDir, '../..');
}

function resolveDataDir(projectRoot: string, configured?: string): string {
  const raw = configured?.trim() || process.env.LCT_DATA_DIR?.trim();
  if (!raw) return path.join(projectRoot, '.lct');
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(projectRoot, raw);
}

function apiError(res: express.Response, status: number, error: unknown): void {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const errorCode = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : null;
  const containsFilesystemPath = /(?:\b[A-Za-z]:[\\/]|\\\\|(?:^|[\s("'])\/(?:[^\s/]+\/)+|node_modules[\\/])/i.test(rawMessage);
  const message = status >= 500 || typeof errorCode === 'string' || containsFilesystemPath
    ? 'The request could not be completed.'
    : rawMessage.slice(0, 240);
  const code = status === 404 ? 'NOT_FOUND' : 'PRESENTATION_CORE_ERROR';
  res.locals.errorCode = code;
  res.status(status).json({ error: { code, message } });
}

function safeProjectId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ? value : null;
}

function operationLabel(req: express.Request): string {
  if (typeof req.route?.path !== 'string') return `${req.method} request-body-or-unmatched`;
  let route = `${req.baseUrl}${req.route.path}`;
  const projectId = safeProjectId(req.params?.id);
  if (projectId) route = route.replace(`/${projectId}/`, '/:id/').replace(`/${projectId}`, '/:id');
  return `${req.method} ${route}`.slice(0, 160);
}

function requestLoggingMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const requestId = randomUUID();
  const startedAt = performance.now();
  res.locals.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  res.once('finish', () => {
    console.log(JSON.stringify({
      event: 'http.request', requestId, projectId: safeProjectId(req.params?.id),
      operation: operationLabel(req), durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      status: res.statusCode, errorCode: typeof res.locals.errorCode === 'string' ? res.locals.errorCode : null,
    }));
  });
  next();
}

function logRequestFailure(res: express.Response, error: unknown, status: number): void {
  const code = error instanceof multer.MulterError ? 'UPLOAD_LIMIT_EXCEEDED'
    : status === 400 ? 'INVALID_REQUEST' : 'REQUEST_FAILED';
  res.locals.errorCode = code;
  console.error(JSON.stringify({
    event: 'http.error', requestId: typeof res.locals.requestId === 'string' ? res.locals.requestId : null,
    status, errorCode: code, errorType: error instanceof Error ? error.name.slice(0, 80) : 'UnknownError',
  }));
}

function projectNotFound(res: express.Response): void {
  res.locals.errorCode = 'PROJECT_NOT_FOUND';
  res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Presentation project not found.' } });
}

function generationError(res: express.Response, error: unknown): void {
  if (error instanceof PresentationGenerationError) {
    res.locals.errorCode = error.code;
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof Error && error.message === 'invalid project id') {
    res.locals.errorCode = 'INVALID_PROJECT_ID';
    res.status(400).json({ error: { code: 'INVALID_PROJECT_ID', message: 'Project id is invalid.' } });
    return;
  }
  res.locals.errorCode = 'GENERATION_FAILED';
  res.status(500).json({ error: { code: 'GENERATION_FAILED', message: 'The slide generation request failed.' } });
}

function smallGenerationBody(req: express.Request): boolean {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return false;
  return Buffer.byteLength(JSON.stringify(req.body), 'utf8') <= 16 * 1024;
}

function encodedRawUrl(projectId: string, name: string): string {
  const encoded = name.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `/api/projects/${encodeURIComponent(projectId)}/raw/${encoded}`;
}

export async function startServer(options: StartServerOptions = {}): Promise<string | StartedPresentationServer> {
  const host = assertLoopbackDaemonBindHost(options.host?.trim() || process.env.LCT_BIND_HOST || '127.0.0.1');
  const envPort = parseDaemonPort(process.env.LCT_PORT, DEFAULT_DAEMON_PORT);
  const port = options.port === undefined ? envPort : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('LCT_PORT must be an integer between 1 and 65535.');
  const configuredProfileConcurrency = process.env.LCT_TEMPLATE_PROFILE_CONCURRENCY;
  const profileConcurrency = options.templateProfileConcurrency
    ?? (configuredProfileConcurrency === undefined || configuredProfileConcurrency.trim() === '' ? 1 : Number(configuredProfileConcurrency));
  if (!Number.isSafeInteger(profileConcurrency) || profileConcurrency < 1 || profileConcurrency > 2) {
    throw new TypeError('LCT_TEMPLATE_PROFILE_CONCURRENCY must be an integer between 1 and 2.');
  }
  const projectRoot = path.resolve(options.projectRoot ?? repoRootFromModule());
  const hasInjectedSemanticAdapter = Boolean(options.semanticInferenceAdapter || options.semanticInferenceAdapterFactory);
  const semanticProfilingEnabled = options.enableSemanticProfiling === true;
  const configuredSemanticBaseUrl = process.env.LCT_SEMANTIC_BASE_URL?.trim();
  const semanticConfig = !hasInjectedSemanticAdapter && configuredSemanticBaseUrl
    ? semanticInferenceConfigFromEnvironment()
    : null;
  const backend = resolvePptxBackend();
  const renderer = options.presentationRenderer ?? createPptxRenderer(backend, options.performanceDiagnostics);
  const dataDir = resolveDataDir(projectRoot, options.dataDir);
  const projectsRoot = path.join(dataDir, 'projects');
  await mkdir(projectsRoot, { recursive: true });

  const db = openPresentationStore(dataDir);
  let semanticAdapter: SemanticInferenceAdapter | undefined = options.semanticInferenceAdapter;
  if (!hasInjectedSemanticAdapter && semanticConfig) semanticAdapter = new OpenAICompatibleSemanticInferenceAdapter(semanticConfig);
  const getSemanticAdapter = () => semanticAdapter ??= options.semanticInferenceAdapterFactory?.()
    ?? new OpenAICompatibleSemanticInferenceAdapter(semanticConfig ?? semanticInferenceConfigFromEnvironment());
  const templateProfilers = new Map<string, TemplateSemanticProfiler>();
  const templatePreparationStores = new Map<string, ReturnType<typeof projectTemplateSemanticProfilePreparationStore>>();
  const activeTemplatePreparations = new Map<string, Promise<unknown>>();
  const lazyTemplateProfileAdapter: SemanticInferenceAdapter = { infer: (request) => getSemanticAdapter().infer(request) };
  const profilerForProject = (projectId: string) => {
    let profiler = templateProfilers.get(projectId);
    if (!profiler) {
      profiler = new TemplateSemanticProfiler(lazyTemplateProfileAdapter, projectTemplateSemanticProfileCache(projectsRoot, projectId), {
        concurrency: profileConcurrency,
      });
      templateProfilers.set(projectId, profiler);
    }
    return profiler;
  };
  const preparationStoreForProject = (projectId: string) => {
    let store = templatePreparationStores.get(projectId);
    if (!store) {
      store = projectTemplateSemanticProfilePreparationStore(projectsRoot, projectId);
      templatePreparationStores.set(projectId, store);
    }
    return store;
  };
  const profileHasDeterministicFallback = (profile: TemplateSemanticProfile) => profile.slides.some((slide) =>
    slide.reasonCodes.includes('deterministic_fallback'));
  const readPreparedTemplateProfile = async (projectId: string, snapshot: Awaited<ReturnType<typeof getTemplateCompilation>>) => {
    if (snapshot.status !== 'ready' || !snapshot.templateIR || !snapshot.presentationDesignSystem) {
      return null;
    }
    try {
      return await profilerForProject(projectId).getPreparedTemplateProfile(snapshot.templateIR, snapshot.presentationDesignSystem);
    } catch {
      return null;
    }
  };
  const preparationStatus = async (
    projectId: string,
    snapshot: Awaited<ReturnType<typeof getTemplateCompilation>>,
  ): Promise<Record<string, unknown>> => {
    if (snapshot.status !== 'ready' || !snapshot.templateIR || !snapshot.presentationDesignSystem) {
      return { status: 'missing', cached: false };
    }
    try {
      const profiler = profilerForProject(projectId);
      const profileCacheKey = await profiler.profileCacheKey(snapshot.templateIR);
      const key = `${projectId}:${profileCacheKey}`;
      const record = await preparationStoreForProject(projectId).read(profileCacheKey);
      if (record?.templateIRHash === snapshot.templateIR.hash && record.status === 'processing') {
        return { status: 'processing', cached: false,
          ...(record.templateStructuralMs === undefined ? {} : { templateStructuralMs: record.templateStructuralMs }) };
      }
      const profile = await profiler.getPreparedTemplateProfile(snapshot.templateIR, snapshot.presentationDesignSystem);
      if (profile) {
        const degraded = profileHasDeterministicFallback(profile) || record?.profileOrigin === 'deterministic-fallback'
          || record?.status === 'degraded-ready';
        return { status: degraded ? 'degraded-ready' : 'ready', cached: true,
          ...(degraded ? { degradationCode: record?.degradationCode ?? 'SEMANTIC_PROFILE_DEGRADED' } : {}), ...(record?.templateIRHash === snapshot.templateIR.hash ? {
        templatePreparationMs: record.templatePreparationMs ?? null,
        templateStructuralMs: record.templateStructuralMs ?? null,
        templateSemanticProfileMs: record.templateSemanticProfileMs ?? null,
      } : {}) };
      }
      if (activeTemplatePreparations.has(key)) return { status: 'processing', cached: false,
        ...(record?.templateIRHash === snapshot.templateIR.hash && record.templateStructuralMs !== undefined
          ? { templateStructuralMs: record.templateStructuralMs } : {}) };
      if (record?.templateIRHash === snapshot.templateIR.hash) {
        if (record.status === 'failed') return { status: 'failed', cached: false, failureCode: record.failureCode ?? 'TEMPLATE_PROFILE_FAILED' };
        if (record.status === 'processing') return { status: 'processing', cached: false,
          ...(record.templateStructuralMs !== undefined ? { templateStructuralMs: record.templateStructuralMs } : {}) };
        if (record.status === 'degraded-ready') return { status: 'failed', cached: false, failureCode: 'TEMPLATE_PROFILE_CACHE_MISSING' };
      }
      return { status: 'missing', cached: false };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'TEMPLATE_PROFILE_STATUS_UNAVAILABLE';
      return { status: 'failed', cached: false, failureCode: code };
    }
  };
  const prepareTemplateProfile = async (
    projectId: string,
    snapshot: Awaited<ReturnType<typeof getTemplateCompilation>>,
    timing: { templateStructuralMs: number },
    recovery: { recoveryCount?: number; fallbackOnly?: boolean } = {},
  ): Promise<{ status: 'processing' | 'ready' | 'degraded-ready'; cached: boolean; templateSemanticProfileMs?: number }> => {
    if (snapshot.status !== 'ready' || !snapshot.templateIR || !snapshot.presentationDesignSystem) {
      throw new TypeError('A structurally ready TemplateIR and presentation design system are required for semantic profiling.');
    }
    const profiler = profilerForProject(projectId);
    const profileCacheKey = await profiler.profileCacheKey(snapshot.templateIR);
    const key = `${projectId}:${profileCacheKey}`;
    const store = preparationStoreForProject(projectId);
    const alreadyPrepared = await profiler.getPreparedTemplateProfile(snapshot.templateIR, snapshot.presentationDesignSystem);
    if (alreadyPrepared) {
      const degraded = profileHasDeterministicFallback(alreadyPrepared);
      await store.write({ schemaVersion: 1, templateIRHash: snapshot.templateIR.hash, profileCacheKey,
        status: degraded ? 'degraded-ready' : 'ready', profileOrigin: degraded ? 'deterministic-fallback' : 'semantic',
        ...(degraded ? { degradationCode: 'SEMANTIC_PROFILE_DEGRADED' } : {}), updatedAt: new Date().toISOString(),
        ...timing, templateSemanticProfileMs: 0 });
      return { status: degraded ? 'degraded-ready' : 'ready', cached: true, templateSemanticProfileMs: 0 };
    }
    const existing = activeTemplatePreparations.get(key);
    if (existing) return { status: 'processing', cached: false };
    // Reserve the key before the first asynchronous write so concurrent compile requests dedupe.
    activeTemplatePreparations.set(key, Promise.resolve());
    try {
      await store.write({ schemaVersion: 1, templateIRHash: snapshot.templateIR.hash, profileCacheKey,
        status: 'processing', updatedAt: new Date().toISOString(), templateStructuralMs: timing.templateStructuralMs,
        recoveryCount: recovery.recoveryCount ?? 0 });
    } catch (error) {
      activeTemplatePreparations.delete(key);
      throw error;
    }
    const preparationQueuedAt = performance.now();
    let task!: Promise<void>;
    task = Promise.resolve().then(async () => {
      const startedAt = performance.now();
      try {
        let profile: TemplateSemanticProfile;
        let profileOrigin: 'semantic' | 'deterministic-fallback' = 'semantic';
        let degradationCode: string | undefined;
        try {
          if (recovery.fallbackOnly) throw new SemanticInferenceError('SERVICE_UNAVAILABLE', 'Interrupted profile preparation was bounded to one automatic resume.');
          profile = await profilerForProject(projectId).prepareTemplateProfile(snapshot.templateIR!, snapshot.presentationDesignSystem!);
        } catch (error) {
          const failureCode = error instanceof SemanticInferenceError ? error.code : 'TEMPLATE_PROFILE_FAILED';
          const reason = error instanceof SemanticInferenceError ? `semantic_${error.code.toLowerCase()}` : 'semantic_profile_failed';
          profile = createDeterministicTemplateSemanticProfile(snapshot.templateIR!, snapshot.presentationDesignSystem!, reason);
          await projectTemplateSemanticProfileCache(projectsRoot, projectId).write(profile, profileCacheKey);
          profileOrigin = 'deterministic-fallback';
          degradationCode = /^[A-Z0-9_]{1,64}$/.test(failureCode) ? failureCode : 'TEMPLATE_PROFILE_FAILED';
        }
        const templateSemanticProfileMs = Math.max(0, Math.round(performance.now() - startedAt));
        const degraded = profileOrigin === 'deterministic-fallback' || profileHasDeterministicFallback(profile);
        const terminalStatus = degraded ? 'degraded-ready' : 'ready';
        await store.write({ schemaVersion: 1, templateIRHash: snapshot.templateIR!.hash, profileCacheKey,
          status: terminalStatus, profileOrigin: degraded ? 'deterministic-fallback' : 'semantic',
          ...(degraded ? { degradationCode: degradationCode ?? 'SEMANTIC_PROFILE_DEGRADED' } : {}),
          updatedAt: new Date().toISOString(), ...timing,
          templatePreparationMs: Math.max(0, Math.round(performance.now() - preparationQueuedAt)), templateSemanticProfileMs,
          recoveryCount: recovery.recoveryCount ?? 0 });
      } catch (error) {
        const failureCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'TEMPLATE_PROFILE_FAILED';
        await store.write({ schemaVersion: 1, templateIRHash: snapshot.templateIR!.hash, profileCacheKey,
          status: 'failed', failureCode, updatedAt: new Date().toISOString(), ...timing,
          templateSemanticProfileMs: Math.max(0, Math.round(performance.now() - startedAt)), recoveryCount: recovery.recoveryCount ?? 0 });
        console.error(JSON.stringify({ event: 'template.profile-preparation', projectId, status: 'failed', errorCode: failureCode }));
      } finally {
        if (activeTemplatePreparations.get(key) === task) activeTemplatePreparations.delete(key);
      }
    });
    activeTemplatePreparations.set(key, task);
    void task.catch((error) => {
      const failureCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'TEMPLATE_PROFILE_STATE_PERSIST_FAILED';
      console.error(JSON.stringify({ event: 'template.profile-preparation-task', projectId, status: 'failed', errorCode: failureCode }));
    });
    return { status: 'processing', cached: false };
  };
  const resumeInterruptedTemplatePreparations = async () => {
    if (!semanticProfilingEnabled) return;
    for (const project of listPresentationProjects(db)) {
      try {
        const snapshot = await getTemplateCompilation(projectsRoot, project.id);
        if (snapshot.status !== 'ready' || !snapshot.templateIR || !snapshot.presentationDesignSystem) continue;
        const profiler = profilerForProject(project.id);
        const profileCacheKey = await profiler.profileCacheKey(snapshot.templateIR);
        const store = preparationStoreForProject(project.id);
        const record = await store.read(profileCacheKey);
        if (!record || record.templateIRHash !== snapshot.templateIR.hash || record.status !== 'processing') continue;
        const cached = await profiler.getPreparedTemplateProfile(snapshot.templateIR, snapshot.presentationDesignSystem);
        if (cached) {
          const degraded = profileHasDeterministicFallback(cached);
          await store.write({ ...record, status: degraded ? 'degraded-ready' : 'ready',
            profileOrigin: degraded ? 'deterministic-fallback' : 'semantic',
            ...(degraded ? { degradationCode: record.degradationCode ?? 'SEMANTIC_PROFILE_DEGRADED' } : {}),
            updatedAt: new Date().toISOString() });
          continue;
        }
        await prepareTemplateProfile(project.id, snapshot,
          { templateStructuralMs: record.templateStructuralMs ?? 0 },
          { recoveryCount: Math.min(1, (record.recoveryCount ?? 0) + 1), fallbackOnly: (record.recoveryCount ?? 0) >= 1 });
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'TEMPLATE_PROFILE_RECOVERY_FAILED';
        console.error(JSON.stringify({ event: 'template.profile-recovery', projectId: project.id, status: 'failed', errorCode: code }));
      }
    }
  };
  const planningService = new PlanningService({
    projectRoot,
    projectsRoot,
    getInferenceAdapter: getSemanticAdapter,
    ...(semanticProfilingEnabled ? {
      getPreparedTemplateProfile: readPreparedTemplateProfile,
      getPlanningContentBudgets: (input) => derivePlanningContentBudgets({ projectsRoot, ...input }),
    } : {}),
    ...(options.planningNow ? { now: options.planningNow } : {}),
    ...(options.planningCreateId ? { createId: options.planningCreateId } : {}),
  });
  const generationService = new PresentationGenerationService({
    db,
    projectsRoot,
    planningService,
    backend,
    renderer,
    ...(semanticProfilingEnabled ? { getPreparedTemplateProfile: readPreparedTemplateProfile } : {}),
    ...(options.performanceDiagnostics ? { performanceDiagnostics: options.performanceDiagnostics } : {}),
    ...(options.presentationRenderer ? { renderer: options.presentationRenderer } : {}),
    ...(options.presentationPreview ? { preview: options.presentationPreview } : {}),
    ...(options.generationCreateId ? { createGenerationId: options.generationCreateId } : {}),
  });
  const productWorkflowService = new ProductWorkflowService({
    projectRoot,
    projectsRoot,
    planningService,
    generationService,
    getInferenceAdapter: getSemanticAdapter,
    ...(semanticProfilingEnabled ? { getPreparedTemplateProfile: readPreparedTemplateProfile } : {}),
  });
  const app = express();
  const deletingProjects = new Set<string>();
  app.disable('x-powered-by');
  app.use(requestLoggingMiddleware);
  app.use(express.json({ limit: '32mb' }));
  app.use('/api/projects/:id', (req, res, next) => {
    const projectId = safeProjectId(req.params.id);
    if (projectId && deletingProjects.has(projectId)) {
      res.locals.errorCode = 'PROJECT_DELETING';
      return res.status(409).json({ error: { code: 'PROJECT_DELETING', message: 'This project is being deleted. Retry after the operation completes.' } });
    }
    next();
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 64 * 1024 * 1024, files: 2, fields: 2, parts: 4 },
  });
  let activeUploadRequests = 0;
  const reserveUploadSlot: express.RequestHandler = (_req, res, next) => {
    if (activeUploadRequests >= 2) {
      res.status(429).json({ error: { code: 'UPLOAD_BUSY', message: 'Too many uploads are already in progress.' } });
      return;
    }
    activeUploadRequests += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeUploadRequests -= 1;
    };
    res.once('close', release);
    res.once('finish', release);
    next();
  };

  const healthHandler: express.RequestHandler = (_req, res) => {
    res.json({ ok: true, product: 'lct-presentation-core', runtime: 'presentation-only' });
  };
  const readinessHandler: express.RequestHandler = async (_req, res) => {
    let storeAvailable = false;
    let requiredDirsWritable = false;
    try {
      db.prepare('SELECT 1 AS ready').get();
      storeAvailable = true;
    } catch { /* readiness reports status without exposing store diagnostics */ }
    const probes: string[] = [];
    try {
      for (const directory of [dataDir, projectsRoot]) {
        const probe = path.join(directory, `.lct-readiness-${randomUUID()}`);
        await writeFile(probe, '', { flag: 'wx' });
        probes.push(probe);
      }
      requiredDirsWritable = true;
    } catch {
      requiredDirsWritable = false;
    } finally {
      await Promise.all(probes.map((probe) => rm(probe, { force: true }).catch(() => undefined)));
    }
    const semanticRequired = semanticProfilingEnabled || Boolean(semanticConfig);
    const semanticReachable = semanticConfig ? await probeSemanticEndpoint(semanticConfig) : null;
    const semanticReady = !semanticRequired || (semanticConfig ? semanticReachable === true : hasInjectedSemanticAdapter);
    const ready = storeAvailable && requiredDirsWritable && Boolean(renderer)
      && semanticReady;
    const semanticStatus = semanticConfig ? semanticReachable ? 'reachable' : 'unreachable'
      : hasInjectedSemanticAdapter ? 'injected-unprobed' : semanticRequired ? 'unconfigured' : 'not-required';
    res.status(ready ? 200 : 503).json({
      ok: ready,
      checks: {
        store: storeAvailable ? 'available' : 'unavailable',
        writableDirectories: requiredDirsWritable ? 'writable' : 'unavailable',
        renderer: renderer ? 'initialized' : 'unavailable',
        pptxBackend: backend,
        semantic: { required: semanticRequired, status: semanticStatus },
      },
    });
  };
  app.get('/health', healthHandler);
  app.get('/api/health', healthHandler);
  app.get('/readiness', readinessHandler);
  app.get('/api/readiness', readinessHandler);

  app.get('/api/projects', (_req, res) => {
    res.json({ projects: listPresentationProjects(db) });
  });

  app.post('/api/projects', async (req, res) => {
    try {
      const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      if (!id || !name) return apiError(res, 400, new Error('id and name are required'));
      if (getPresentationProject(db, id)) return apiError(res, 409, new Error('project already exists'));
      const project = createPresentationProject(db, {
        id,
        name,
        skillId: typeof req.body?.skillId === 'string' ? req.body.skillId : null,
        designSystemId: typeof req.body?.designSystemId === 'string' ? req.body.designSystemId : null,
        pendingPrompt: typeof req.body?.pendingPrompt === 'string' ? req.body.pendingPrompt : null,
        metadata: req.body?.metadata && typeof req.body.metadata === 'object' && !Array.isArray(req.body.metadata)
          ? req.body.metadata
          : { projectKind: 'presentation' },
      });
      await ensurePresentationProjectDir(projectsRoot, project.id);
      res.status(201).json({ project });
    } catch (error) {
      apiError(res, 400, error);
    }
  });

  app.get('/api/projects/:id', (req, res) => {
    const project = getPresentationProject(db, req.params.id);
    if (!project) return projectNotFound(res);
    res.json({ project });
  });

  app.patch('/api/projects/:id', (req, res) => {
    try {
      const project = patchPresentationProject(db, req.params.id, {
        ...(typeof req.body?.name === 'string' ? { name: req.body.name } : {}),
        ...(Object.prototype.hasOwnProperty.call(req.body ?? {}, 'skillId')
          ? { skillId: typeof req.body.skillId === 'string' ? req.body.skillId : null }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(req.body ?? {}, 'designSystemId')
          ? { designSystemId: typeof req.body.designSystemId === 'string' ? req.body.designSystemId : null }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(req.body ?? {}, 'pendingPrompt')
          ? { pendingPrompt: typeof req.body.pendingPrompt === 'string' ? req.body.pendingPrompt : null }
          : {}),
        ...(req.body?.metadata && typeof req.body.metadata === 'object' && !Array.isArray(req.body.metadata)
          ? { metadata: req.body.metadata }
          : {}),
      });
      if (!project) return projectNotFound(res);
      res.json({ project });
    } catch (error) {
      apiError(res, 400, error);
    }
  });

  app.delete('/api/projects/:id', async (req, res) => {
    let projectId: string | null = null;
    try {
      projectId = assertSafeProjectId(req.params.id);
      if (!getPresentationProject(db, projectId)) return projectNotFound(res);
      if (deletingProjects.has(projectId)) {
        res.locals.errorCode = 'PROJECT_DELETING';
        return res.status(409).json({ error: { code: 'PROJECT_DELETING', message: 'This project is already being deleted.' } });
      }
      deletingProjects.add(projectId);
      if (!await planningService.cancel(projectId)) {
        res.locals.errorCode = 'PLANNING_CANCELLATION_TIMEOUT';
        return res.status(503).json({ error: { code: 'PLANNING_CANCELLATION_TIMEOUT', message: 'Planning is still stopping. Retry project deletion shortly.' } });
      }
      const generation = await generationService.getSnapshot(projectId);
      if (generation && ['preparing', 'generating'].includes(generation.status)) await generationService.cancel(projectId);
      if (!await generationService.drainProject(projectId)) {
        res.locals.errorCode = 'GENERATION_DRAIN_TIMEOUT';
        return res.status(503).json({ error: { code: 'GENERATION_DRAIN_TIMEOUT', message: 'Project operations are still stopping. Retry project deletion shortly.' } });
      }
      deletePresentationProject(db, projectId);
      await removePresentationProjectDir(projectsRoot, projectId);
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof PresentationGenerationError) return generationError(res, error);
      const reportedStatus = error && typeof error === 'object' && 'status' in error
        && typeof (error as { status?: unknown }).status === 'number'
        ? Number((error as { status: number }).status)
        : error instanceof Error && error.message === 'invalid project id' ? 400 : 500;
      apiError(res, reportedStatus, error);
    } finally {
      if (projectId) deletingProjects.delete(projectId);
    }
  });

  app.get('/api/projects/:id/files', async (req, res) => {
    try {
      if (!getPresentationProject(db, req.params.id)) return projectNotFound(res);
      res.json({ files: await listPresentationFiles(projectsRoot, req.params.id) });
    } catch (error) {
      apiError(res, 400, error);
    }
  });

  app.post('/api/projects/:id/files', async (req, res) => {
    try {
      const projectId = req.params.id as string;
      if (!getPresentationProject(db, projectId)) return projectNotFound(res);
      const name = typeof req.body?.name === 'string' ? req.body.name : '';
      if (!name) return apiError(res, 400, new Error('file name is required'));
      const encoding = req.body?.encoding === 'base64' ? 'base64' : 'utf8';
      const raw = typeof req.body?.content === 'string' ? req.body.content : '';
      const content = encoding === 'base64' ? Buffer.from(raw, 'base64') : raw;
      res.json({ file: await writePresentationFile(projectsRoot, projectId, name, content) });
    } catch (error) {
      apiError(res, 400, error);
    }
  });

  app.post('/api/projects/:id/upload', reserveUploadSlot, upload.array('files', 2), async (req, res) => {
    try {
      const projectId = req.params.id as string;
      if (!getPresentationProject(db, projectId)) return projectNotFound(res);
      const requestedDir = typeof req.body?.dir === 'string' ? req.body.dir.trim().replace(/^\/+/, '') : '';
      const files = Array.isArray(req.files) ? req.files as Express.Multer.File[] : [];
      const written = [];
      for (const file of files) {
        const originalName = normalizeMultipartFilename(file.originalname);
        const name = requestedDir ? `${requestedDir}/${originalName}` : originalName;
        const saved = await writePresentationFile(projectsRoot, projectId, name, file.buffer);
        written.push({ ...saved, originalName });
      }
      res.json({ files: written });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const invalidInput = new Set(['invalid project id', 'invalid project file path', 'project file escapes project root']);
      const status = invalidInput.has(message) ? 400 : 500;
      if (status >= 500) logRequestFailure(res, error, status);
      apiError(res, status, error);
    }
  });

  app.get('/api/projects/:id/template', async (req, res) => {
    try {
      if (!getPresentationProject(db, req.params.id)) return projectNotFound(res);
      const snapshot = await getTemplateCompilation(projectsRoot, req.params.id);
      res.json({ ...snapshot, semanticProfile: semanticProfilingEnabled
        ? await preparationStatus(req.params.id, snapshot)
        : { status: 'disabled', cached: false } });
    } catch (error) {
      if (error instanceof TemplateCompilerError) {
        return res.status(error.status).json({ status: 'failed', failure: { code: error.code, message: error.message } });
      }
      return res.status(500).json({
        status: 'failed',
        failure: { code: 'TEMPLATE_STATE_UNAVAILABLE', message: 'Saved template understanding could not be loaded.' },
      });
    }
  });

  app.post('/api/projects/:id/template/compile', async (req, res) => {
    if (!getPresentationProject(db, req.params.id)) return projectNotFound(res);
    const filePath = typeof req.body?.filePath === 'string' ? req.body.filePath : '';
    const preparationStartedAt = performance.now();
    try {
      const structuralStartedAt = performance.now();
      const compiled = await compileTemplate(projectsRoot, req.params.id, filePath, addEffectivePlaceholderTypography);
      const templateStructuralMs = Math.max(0, Math.round(performance.now() - structuralStartedAt));
      if (!semanticProfilingEnabled) {
        res.json({ ...compiled, semanticProfile: { status: 'disabled', cached: false } });
        return;
      }
      const profile = await prepareTemplateProfile(req.params.id, compiled, { templateStructuralMs });
      const templatePreparationMs = Math.max(0, Math.round(performance.now() - preparationStartedAt));
      res.status(profile.status === 'processing' ? 202 : 200).json({ ...compiled, semanticProfile: {
        status: profile.status,
        cached: profile.cached,
        ...(profile.status === 'processing' ? {} : { templatePreparationMs }),
        templateStructuralMs,
        ...(profile.templateSemanticProfileMs === undefined ? {} : { templateSemanticProfileMs: profile.templateSemanticProfileMs }),
      } });
    } catch (error) {
      if (error instanceof TemplateCompilerError) {
        return res.status(error.status).json({ status: 'failed', failure: { code: error.code, message: error.message } });
      }
      return res.status(500).json({
        status: 'failed',
        semanticProfile: { status: 'failed', cached: false, failureCode: 'TEMPLATE_PROFILE_FAILED' },
        failure: { code: 'TEMPLATE_COMPILE_FAILED', message: 'Template compilation failed.' },
      });
    }
  });

  app.get('/api/projects/:id/workflow', async (req, res) => {
    if (!getPresentationProject(db, req.params.id)) return projectNotFound(res);
    try {
      res.json({ operation: await productWorkflowService.get(req.params.id) });
    } catch (error) {
      if (error instanceof ProductWorkflowError) {
        res.locals.errorCode = error.code;
        return res.status(error.status).json({ error: { code: error.code, message: 'Не удалось загрузить состояние презентации.' } });
      }
      return apiError(res, 500, error);
    }
  });

  app.post('/api/projects/:id/workflow/generate', async (req, res) => {
    if (!getPresentationProject(db, req.params.id)) return projectNotFound(res);
    if (!smallGenerationBody(req)) return apiError(res, 413, new Error('product workflow request must be a small JSON object'));
    try {
      const operation = await productWorkflowService.start(req.params.id, req.body);
      res.status(operation.status === 'running' ? 202 : 200).json({ operation });
    } catch (error) {
      if (error instanceof ProductWorkflowError) {
        res.locals.errorCode = error.code;
        return res.status(error.status).json({ error: { code: error.code, message: 'Не удалось запустить создание презентации.' } });
      }
      return apiError(res, 500, error);
    }
  });

  app.post('/api/projects/:id/workflow/contextual-audit', async (req, res) => {
    if (!getPresentationProject(db, req.params.id)) return projectNotFound(res);
    if (!smallGenerationBody(req) || Object.keys(req.body as Record<string, unknown>).length > 0) {
      return apiError(res, 400, new Error('contextual audit request must be an empty JSON object'));
    }
    try {
      res.json({ operation: await productWorkflowService.auditCurrentSelection(req.params.id) });
    } catch (error) {
      if (error instanceof ProductWorkflowError) {
        res.locals.errorCode = error.code;
        return res.status(error.status).json({ error: { code: error.code, message: 'Не удалось проверить смысл презентации.' } });
      }
      return apiError(res, 500, error);
    }
  });

  app.get('/api/projects/:id/planning', async (req, res) => {
    if (!getPresentationProject(db, req.params.id)) return projectNotFound(res);
    try {
      res.json(await planningService.get(req.params.id));
    } catch (error) {
      if (error instanceof PlanningServiceError) {
        return res.status(error.status).json({ error: { code: error.code, message: error.message } });
      }
      return res.status(500).json({
        error: { code: 'PLANNING_STATE_UNAVAILABLE', message: 'Saved planning state could not be loaded.' },
      });
    }
  });

  app.post('/api/projects/:id/planning/generate', async (req, res) => {
    if (!getPresentationProject(db, req.params.id)) return projectNotFound(res);
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      res.json(await planningService.generate(req.params.id, req.body, controller.signal));
    } catch (error) {
      if (error instanceof PlanningServiceError) {
        res.locals.errorCode = error.code;
        return res.status(error.status).json({ error: { code: error.code, message: error.message } });
      }
      res.locals.errorCode = 'PLANNING_FAILED';
      return res.status(500).json({
        error: { code: 'PLANNING_FAILED', message: 'Planning failed. Check the project sources and retry.' },
      });
    }
  });

  app.get('/api/projects/:id/generation', async (req, res) => {
    try {
      const projectId = assertSafeProjectId(req.params.id);
      if (!getPresentationProject(db, projectId)) return projectNotFound(res);
      res.json({ generation: await generationService.getSnapshot(projectId) });
    } catch (error) { generationError(res, error); }
  });

  app.get('/api/projects/:id/generation/packs', async (req, res) => {
    try {
      const projectId = assertSafeProjectId(req.params.id);
      if (!getPresentationProject(db, projectId)) return projectNotFound(res);
      const generation = await generationService.getSnapshot(projectId);
      res.json({ packs: generation?.slides ?? [], progress: generation ? {
        ready: generation.readySlides, total: generation.totalSlides, revision: generation.revision,
      } : null });
    } catch (error) { generationError(res, error); }
  });

  app.post('/api/projects/:id/generation', async (req, res) => {
    try {
      const projectId = assertSafeProjectId(req.params.id);
      if (!getPresentationProject(db, projectId)) return projectNotFound(res);
      if (!smallGenerationBody(req)) return apiError(res, 413, new Error('generation request must be a small JSON object'));
      const bodyKeys = Object.keys(req.body as Record<string, unknown>);
      if (bodyKeys.some((key) => key !== 'idempotencyKey')) return apiError(res, 400, new Error('unexpected generation request field'));
      const headerKey = req.get('Idempotency-Key');
      const bodyKey = typeof req.body.idempotencyKey === 'string' ? req.body.idempotencyKey : undefined;
      if (headerKey && bodyKey && headerKey !== bodyKey) return apiError(res, 400, new Error('Idempotency-Key header and body value differ'));
      const result = await generationService.start(projectId, headerKey ?? bodyKey);
      res.status(result.created ? 202 : 200).json({ generation: result.state, created: result.created });
    } catch (error) { generationError(res, error); }
  });

  app.post('/api/projects/:id/generation/cancel', async (req, res) => {
    try {
      const projectId = assertSafeProjectId(req.params.id);
      if (!getPresentationProject(db, projectId)) return projectNotFound(res);
      if (!smallGenerationBody(req) || Object.keys(req.body as Record<string, unknown>).length) {
        return apiError(res, 400, new Error('cancel request must have an empty JSON object'));
      }
      res.json({ generation: await generationService.cancel(projectId) });
    } catch (error) { generationError(res, error); }
  });

  app.put('/api/projects/:id/generation/selection', async (req, res) => {
    try {
      const projectId = assertSafeProjectId(req.params.id);
      if (!getPresentationProject(db, projectId)) return projectNotFound(res);
      if (!smallGenerationBody(req)) return apiError(res, 413, new Error('selection request is too large'));
      const body = req.body as Record<string, unknown>;
      if (body.scope === 'deck' && Object.keys(body).sort().join(',') === 'expectedVersion,scope,variant') {
        return res.json({ generation: await generationService.setDefaultTrack(projectId, body.variant, body.expectedVersion) });
      }
      if (body.scope === 'slide' && Object.keys(body).sort().join(',') === 'expectedVersion,scope,slideId,variant') {
        return res.json({ generation: await generationService.selectVariant(projectId, body.slideId, body.variant, body.expectedVersion) });
      }
      return apiError(res, 400, new Error('selection request fields are invalid'));
    } catch (error) { generationError(res, error); }
  });

  app.put('/api/projects/:id/generation/slides/:slideId/lock', async (req, res) => {
    try {
      const projectId = assertSafeProjectId(req.params.id);
      if (!getPresentationProject(db, projectId)) return projectNotFound(res);
      if (!smallGenerationBody(req)) return apiError(res, 413, new Error('lock request is too large'));
      const body = req.body as Record<string, unknown>;
      if (Object.keys(body).some((key) => !['locked', 'variant', 'expectedVersion'].includes(key))
          || !Object.hasOwn(body, 'locked') || !Object.hasOwn(body, 'expectedVersion')) {
        return apiError(res, 400, new Error('lock request fields are invalid'));
      }
      res.json({ generation: await generationService.lockSlide(projectId, req.params.slideId, body.locked, body.variant, body.expectedVersion) });
    } catch (error) { generationError(res, error); }
  });

  app.get('/api/projects/:id/generation/slides/:slideId/audit', (req, res) => {
    try {
      const projectId = assertSafeProjectId(req.params.id);
      if (!getPresentationProject(db, projectId)) return projectNotFound(res);
      res.json({ audit: generationService.audit(projectId, req.params.slideId, req.query.variant) });
    } catch (error) { generationError(res, error); }
  });

  app.post('/api/projects/:id/generation/repair', async (req, res) => {
    try {
      const projectId = assertSafeProjectId(req.params.id);
      if (!getPresentationProject(db, projectId)) return projectNotFound(res);
      if (!smallGenerationBody(req)) return apiError(res, 413, new Error('repair request is too large'));
      const body = req.body as Record<string, unknown>;
      if (Object.keys(body).sort().join(',') !== 'expectedVersion,findingId,slideId,variant') {
        return apiError(res, 400, new Error('repair request fields are invalid'));
      }
      res.json({ generation: await generationService.repair(projectId, body as { slideId: unknown; variant: unknown; findingId: unknown; expectedVersion: unknown }) });
    } catch (error) { generationError(res, error); }
  });

  app.get('/api/projects/:id/generation/previews/:slideId/:variant', async (req, res) => {
    try {
      const projectId = assertSafeProjectId(req.params.id);
      if (!getPresentationProject(db, projectId)) return projectNotFound(res);
      const preview = await generationService.readPreview(projectId, req.params.slideId, req.params.variant);
      res.type('png').setHeader('Cache-Control', 'private, max-age=60').send(preview);
    } catch (error) { generationError(res, error); }
  });

  app.post('/api/projects/:id/generation/export', async (req, res) => {
    try {
      const projectId = assertSafeProjectId(req.params.id);
      if (!getPresentationProject(db, projectId)) return projectNotFound(res);
      if (!smallGenerationBody(req) || !Object.hasOwn(req.body as object, 'mode')
          || !['mode', 'format'].includes(Object.keys(req.body as Record<string, unknown>).sort()[0] ?? '')
          || Object.keys(req.body as Record<string, unknown>).some((key) => !['mode', 'format'].includes(key))) {
        return apiError(res, 400, new Error('export request must contain mode and optional format'));
      }
      res.status(201).json(await generationService.export(projectId, req.body.mode, req.body.format ?? 'pptx'));
    } catch (error) { generationError(res, error); }
  });

  app.get('/api/projects/:id/generation/exports/:exportId', async (req, res) => {
    try {
      const projectId = assertSafeProjectId(req.params.id);
      if (!getPresentationProject(db, projectId)) return projectNotFound(res);
      const { bytes, artifact } = await generationService.readExport(projectId, req.params.exportId);
      const extension = artifact.format === 'pdf' ? 'pdf' : artifact.format === 'html' ? 'html' : 'pptx';
      const name = `LCT-${artifact.mode}-${artifact.id.slice(0, 8)}.${extension}`;
      res.status(200)
        .setHeader('Content-Type', mimeForPresentationFile(name))
        .setHeader('Content-Disposition', `attachment; filename="${name}"`)
        .setHeader('Cache-Control', 'no-store')
        .send(bytes);
    } catch (error) { generationError(res, error); }
  });

  app.get('/api/projects/:id/preview-url', async (req, res) => {
    try {
      if (!getPresentationProject(db, req.params.id)) return projectNotFound(res);
      const name = typeof req.query.file === 'string' ? req.query.file : '';
      if (!name) return apiError(res, 400, new Error('file query parameter is required'));
      await resolvePresentationFilePath(projectsRoot, req.params.id, name, { requireExisting: true });
      res.json({ url: encodedRawUrl(req.params.id, name) });
    } catch (error) {
      apiError(res, 404, error);
    }
  });

  app.use('/api/projects/:id/raw', async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE') return next();
    try {
      if (!getPresentationProject(db, req.params.id)) return projectNotFound(res);
      const name = decodeURIComponent(req.path.replace(/^\/+/, ''));
      if (!name) return apiError(res, 400, new Error('file path is required'));
      if (req.method === 'DELETE') {
        await deletePresentationFile(projectsRoot, req.params.id, name);
        return res.json({ ok: true });
      }
      const target = await resolvePresentationFilePath(projectsRoot, req.params.id, name, { requireExisting: true });
      res.type(mimeForPresentationFile(name));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      if (['.html', '.htm', '.svg', '.js', '.mjs'].includes(path.extname(name).toLowerCase())) {
        res.setHeader('Content-Disposition', 'attachment');
      }
      return res.sendFile(target.absolute);
    } catch (error) {
      return apiError(res, 404, error);
    }
  });

  app.get('/api/design-systems', async (_req, res) => {
    res.json({ designSystems: await listPresentationDesignSystems(projectRoot) });
  });

  app.get('/api/design-systems/:id/preview', async (req, res) => {
    const file = await resolveDesignSystemPreview(projectRoot, req.params.id);
    if (!file) return apiError(res, 404, new Error('design-system preview not found'));
    res.type('html').sendFile(file);
  });

  app.get('/api/design-systems/:id/showcase', async (req, res) => {
    const file = await resolveDesignSystemPreview(projectRoot, req.params.id);
    if (!file) return apiError(res, 404, new Error('design-system showcase not found'));
    res.type('html').sendFile(file);
  });

  app.get('/api/design-systems/:id/static', async (req, res) => {
    const requested = typeof req.query.path === 'string' ? req.query.path : '';
    const file = requested ? await resolveDesignSystemFile(projectRoot, req.params.id, requested) : null;
    if (!file) return apiError(res, 404, new Error('design-system asset not found'));
    res.sendFile(file);
  });

  app.get('/api/skills', async (_req, res) => {
    res.json({ skills: await listPresentationSkills(projectRoot) });
  });

  app.get('/api/media/models', (_req, res) => {
    const config = presentationImageConfig();
    res.json({
      image: presentationImageModels(),
      configured: config.configured,
      message: config.configured ? null : 'Генерация изображений не настроена.',
    });
  });

  app.post('/api/media/generate', async (req, res) => {
    try {
      const config = presentationImageConfig();
      if (!config.configured) {
        res.locals.errorCode = 'IMAGE_GENERATION_NOT_CONFIGURED';
        return res.status(503).json({ error: { code: 'IMAGE_GENERATION_NOT_CONFIGURED', message: 'Генерация изображений не настроена.' } });
      }
      const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : '';
      if (!projectId || !getPresentationProject(db, projectId)) return projectNotFound(res);
      if (req.body?.surface && req.body.surface !== 'image') {
        return apiError(res, 400, new Error('presentation media generation supports images only'));
      }
      const result = await generatePresentationImage({
        projectsRoot,
        projectId,
        prompt: typeof req.body?.prompt === 'string' ? req.body.prompt : '',
        model: typeof req.body?.model === 'string' ? req.body.model : undefined,
        output: typeof req.body?.output === 'string' ? req.body.output : undefined,
        aspect: typeof req.body?.aspect === 'string' ? req.body.aspect : undefined,
        quality: typeof req.body?.quality === 'string' ? req.body.quality : undefined,
      });
      res.json(result);
    } catch (error) {
      const status = typeof (error as { status?: unknown })?.status === 'number'
        ? Number((error as { status: number }).status)
        : 500;
      apiError(res, status, error);
    }
  });

  if (options.serveWeb !== false) {
    const webOut = path.join(projectRoot, 'apps', 'web', 'out');
    const indexFile = path.join(webOut, 'index.html');
    if (fs.existsSync(webOut)) {
      app.use(express.static(webOut, { index: false, fallthrough: true }));
      app.get(/^(?!\/api\/).*/, (_req, res, next) => {
        if (!fs.existsSync(indexFile)) return next();
        res.sendFile(indexFile);
      });
    }
  }

  app.use('/api', (_req, res) => {
    res.status(404).json({
      error: {
        code: 'REMOVED_GENERIC_SURFACE',
        message: 'This endpoint is not part of the presentation-only runtime.',
      },
    });
  });

  app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return;
    const status = typeof (error as { status?: unknown })?.status === 'number'
      ? Number((error as { status: number }).status)
      : error instanceof multer.MulterError ? 413 : 500;
    logRequestFailure(res, error, status);
    const code = error instanceof multer.MulterError ? 'UPLOAD_LIMIT_EXCEEDED'
      : status === 400 ? 'INVALID_REQUEST' : 'REQUEST_FAILED';
    res.status(status).json({
      error: {
        code,
        message: error instanceof multer.MulterError
          ? 'Upload limits were exceeded. Upload at most two files per request, each no larger than 64 MiB.'
          : status === 400 ? 'The request body could not be parsed.' : 'The request could not be completed.',
      },
    });
  });

  await generationService.recover();
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(port, host, () => resolve(listening));
    listening.once('error', reject);
  });
  const address = server.address();
  const boundPort = address && typeof address === 'object' ? address.port : port;
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${urlHost}:${boundPort}`;
  void resumeInterruptedTemplatePreparations().catch(() => {
    console.error(JSON.stringify({ event: 'template.profile-recovery', status: 'failed', errorCode: 'TEMPLATE_PROFILE_RECOVERY_FAILED' }));
  });

  const shutdown = async () => {
    productWorkflowService.requestShutdown();
    const [planningDrained, generationDrained] = await Promise.all([
      planningService.shutdown().catch(() => false),
      generationService.shutdown().catch(() => false),
    ]);
    await productWorkflowService.waitForIdle().catch(() => undefined);
    const closeStore = () => { try { db.close(); } catch { /* already closed */ } };
    if (planningDrained && generationDrained) closeStore();
    else void Promise.all([planningService.waitForIdle(), generationService.waitForIdle()]).finally(closeStore);
  };

  if (options.returnServer) return { server, url, shutdown };
  return url;
}
