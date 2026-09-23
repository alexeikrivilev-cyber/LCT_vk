// Presentation-only daemon surface. Generic OpenDesign collaboration,
// marketplace, campaign, AMR, connector, automation and multi-media planes
// intentionally do not register here.

import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
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
  ensurePresentationProjectDir,
  listPresentationFiles,
  mimeForPresentationFile,
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
import { presentationImageModels } from './media/models.js';
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
  const message = error instanceof Error ? error.message : String(error);
  res.status(status).json({ error: { code: status === 404 ? 'NOT_FOUND' : 'PRESENTATION_CORE_ERROR', message } });
}

function projectNotFound(res: express.Response): void {
  res.status(404).json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Presentation project not found.' } });
}

function encodedRawUrl(projectId: string, name: string): string {
  const encoded = name.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `/api/projects/${encodeURIComponent(projectId)}/raw/${encoded}`;
}

export async function startServer(options: StartServerOptions = {}): Promise<string | StartedPresentationServer> {
  const projectRoot = path.resolve(options.projectRoot ?? repoRootFromModule());
  const dataDir = resolveDataDir(projectRoot, options.dataDir);
  const projectsRoot = path.join(dataDir, 'projects');
  await mkdir(projectsRoot, { recursive: true });

  const db = openPresentationStore(dataDir);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32mb' }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 64 * 1024 * 1024, files: 64 },
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, product: 'lct-presentation-core', runtime: 'presentation-only' });
  });

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
    res.json({ project, resolvedDir: path.join(projectsRoot, project.id) });
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
    try {
      if (!getPresentationProject(db, req.params.id)) return projectNotFound(res);
      deletePresentationProject(db, req.params.id);
      await removePresentationProjectDir(projectsRoot, req.params.id);
      res.json({ ok: true });
    } catch (error) {
      apiError(res, 400, error);
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

  app.post('/api/projects/:id/upload', upload.array('files', 64), async (req, res) => {
    try {
      const projectId = req.params.id as string;
      if (!getPresentationProject(db, projectId)) return projectNotFound(res);
      const requestedDir = typeof req.body?.dir === 'string' ? req.body.dir.trim().replace(/^\/+/, '') : '';
      const files = Array.isArray(req.files) ? req.files as Express.Multer.File[] : [];
      const written = [];
      for (const file of files) {
        const name = requestedDir ? `${requestedDir}/${file.originalname}` : file.originalname;
        const saved = await writePresentationFile(projectsRoot, projectId, name, file.buffer);
        written.push({ ...saved, originalName: file.originalname });
      }
      res.json({ files: written });
    } catch (error) {
      apiError(res, 400, error);
    }
  });

  app.get('/api/projects/:id/template', async (req, res) => {
    try {
      if (!getPresentationProject(db, req.params.id)) return projectNotFound(res);
      res.json(await getTemplateCompilation(projectsRoot, req.params.id));
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
    try {
      res.json(await compileTemplate(projectsRoot, req.params.id, filePath));
    } catch (error) {
      if (error instanceof TemplateCompilerError) {
        return res.status(error.status).json({ status: 'failed', failure: { code: error.code, message: error.message } });
      }
      return res.status(500).json({
        status: 'failed',
        failure: { code: 'TEMPLATE_COMPILE_FAILED', message: 'Template compilation failed.' },
      });
    }
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
      res.setHeader('Cache-Control', 'no-store');
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
    res.json({ image: presentationImageModels() });
  });

  app.post('/api/media/generate', async (req, res) => {
    try {
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

  const host = options.host?.trim() || process.env.LCT_BIND_HOST?.trim() || '127.0.0.1';
  const port = Number.isInteger(options.port) ? Number(options.port) : (Number(process.env.LCT_PORT) || 7456);
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(port, host, () => resolve(listening));
    listening.once('error', reject);
  });
  const address = server.address();
  const boundPort = address && typeof address === 'object' ? address.port : port;
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${urlHost}:${boundPort}`;

  const shutdown = async () => {
    try { db.close(); } catch { /* already closed */ }
  };

  if (options.returnServer) return { server, url, shutdown };
  return url;
}
