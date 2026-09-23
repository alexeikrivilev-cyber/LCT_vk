'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Project = {
  id: string;
  name: string;
  designSystemId?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

type ProjectFile = {
  name: string;
  path?: string;
  size?: number;
  isDirectory?: boolean;
  originalName?: string;
};

type DesignSystem = {
  id: string;
  name?: string;
  displayName?: string;
  description?: string;
};

type Route = { kind: 'home' } | { kind: 'project'; projectId: string };

type ApiError = { error?: string | { message?: string }; message?: string };

type TemplateCompileStatus = 'uncompiled' | 'ready' | 'stale' | 'failed';
type TemplateCompileResponse = {
  status: TemplateCompileStatus;
  source?: unknown;
  compiledAt?: string;
  failure?: unknown;
  templateIR?: unknown;
  presentationDesignSystem?: unknown;
};

type DataRecord = Record<string, unknown>;

const TEXT_EXTENSIONS = new Set([
  'html', 'htm', 'css', 'js', 'jsx', 'ts', 'tsx', 'json', 'md', 'txt', 'svg', 'xml', 'yaml', 'yml',
]);

function parseRoute(pathname = window.location.pathname): Route {
  const match = pathname.match(/^\/project\/([^/]+)\/?$/);
  return match ? { kind: 'project', projectId: decodeURIComponent(match[1]) } : { kind: 'home' };
}

function navigate(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function id(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `presentation-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function extension(name: string): string {
  const part = name.split('.').pop();
  return part && part !== name ? part.toLowerCase() : '';
}

function isTextFile(name: string): boolean {
  return TEXT_EXTENSIONS.has(extension(name));
}

function formatBytes(value?: number): string {
  if (!Number.isFinite(value) || !value) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function filePath(file: ProjectFile): string {
  return file.path || file.name;
}

function rawFileUrl(projectId: string, path: string): string {
  const encoded = path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `/api/projects/${encodeURIComponent(projectId)}/raw/${encoded}`;
}

async function errorMessage(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as ApiError | null;
  if (typeof body?.error === 'string') return body.error;
  if (body?.error && typeof body.error === 'object' && body.error.message) return body.error.message;
  if (body?.message) return body.message;
  return `Request failed (${response.status})`;
}

function pickPreviewFile(files: ProjectFile[], selected?: string | null): string | null {
  if (selected && /\.html?$/i.test(selected)) return selected;
  const paths = files.filter((file) => !file.isDirectory).map(filePath);
  return paths.find((path) => /(^|\/)index\.html?$/i.test(path))
    ?? paths.find((path) => /\.html?$/i.test(path))
    ?? null;
}

function record(value: unknown): DataRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as DataRecord
    : null;
}

function pathValue(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => record(current)?.[key], value);
}

function firstValue(value: unknown, paths: string[]): unknown {
  for (const path of paths) {
    const found = pathValue(value, path);
    if (found !== undefined && found !== null) return found;
  }
  return undefined;
}

function arrayValue(value: unknown, paths: string[]): unknown[] {
  const found = firstValue(value, paths);
  return Array.isArray(found) ? found : [];
}

function countLabel(value: unknown, arrayPaths: string[], countPaths: string[]): string {
  const found = firstValue(value, arrayPaths);
  if (Array.isArray(found)) return String(found.length);
  return stringValue(firstValue(value, countPaths), 'Not reported');
}

function stringValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function sourcePathOf(value: TemplateCompileResponse | null): string | null {
  if (!value) return null;
  const source = value.source;
  if (typeof source === 'string') return source;
  const found = firstValue(source, ['filePath', 'path', 'name']);
  return typeof found === 'string' ? found : null;
}

function parseTemplateCompileResponse(value: unknown): TemplateCompileResponse {
  const body = record(value);
  const status = body?.status;
  if (status !== 'ready' && status !== 'stale' && status !== 'failed' && status !== 'uncompiled') {
    throw new Error('Template analysis returned an unexpected response.');
  }
  return body as unknown as TemplateCompileResponse;
}

function readableValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  const item = record(value);
  if (!item) return '';
  const primary = stringValue(firstValue(item, ['name', 'displayName', 'label', 'family', 'fontFamily', 'value', 'message', 'reason', 'description', 'detail']));
  if (primary) return primary;
  return [
    stringValue(firstValue(item, ['kind', 'type', 'code'])),
    stringValue(firstValue(item, ['part', 'sourcePart', 'path'])),
  ].filter(Boolean).join(' · ');
}

function formatAspectRatio(width: unknown, height: unknown, declared?: unknown): string {
  if (typeof declared === 'string' && declared.trim()) return declared;
  if (typeof declared === 'number' && Number.isFinite(declared)) return `${declared.toFixed(2)}:1`;
  if (typeof width !== 'number' || typeof height !== 'number' || !width || !height) return 'Not reported';
  const ratio = width / height;
  const near = (a: number, b: number) => Math.abs(a - b) < 0.035;
  if (near(ratio, 16 / 9)) return '16:9';
  if (near(ratio, 4 / 3)) return '4:3';
  if (near(ratio, 16 / 10)) return '16:10';
  return `${ratio.toFixed(2)}:1`;
}

function formatCanvasDimensions(width: unknown, height: unknown, unit: unknown): string {
  if (typeof width !== 'number' || typeof height !== 'number') return 'Dimensions not reported';
  if (unit === 'EMU') return `${(width / 914400).toFixed(2)} × ${(height / 914400).toFixed(2)} in`;
  return `${width} × ${height}${typeof unit === 'string' && unit ? ` ${unit}` : ''}`;
}

function templateFailureText(value: unknown): string {
  if (typeof value === 'string') return value;
  return readableValue(value) || 'The structural scan could not be completed.';
}

function uniqueStrings(values: unknown[]): string[] {
  const collected = values.map(readableValue).map((value) => value.trim()).filter(Boolean);
  return [...new Set(collected)];
}

function colorEntry(value: unknown): { label: string; value: string } | null {
  if (typeof value === 'string') return { label: value, value };
  const item = record(value);
  if (!item) return null;
  const color = firstValue(item, ['hex', 'value', 'color', 'rgb', 'argb']);
  if (typeof color !== 'string') return null;
  return { label: stringValue(firstValue(item, ['name', 'token', 'role', 'label']), color), value: color };
}

function safeColor(value: string): string | null {
  const normalized = /^[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value) ? `#${value}` : value;
  return /^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.% ,/+-]+\))$/i.test(normalized) ? normalized : null;
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute());

  useEffect(() => {
    const onPop = () => setRoute(parseRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return route.kind === 'home'
    ? <PresentationHome onOpen={(projectId) => navigate(`/project/${encodeURIComponent(projectId)}`)} />
    : <PresentationWorkspace projectId={route.projectId} onBack={() => navigate('/')} />;
}

function PresentationHome({ onOpen }: { onOpen: (projectId: string) => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/projects', { cache: 'no-store' });
      if (!response.ok) throw new Error(await errorMessage(response));
      const body = await response.json() as { projects?: Project[] };
      setProjects(body.projects ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    const title = name.trim() || 'Untitled presentation';
    setCreating(true);
    setError(null);
    try {
      const projectId = id();
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: projectId,
          name: title,
          skillId: null,
          designSystemId: null,
        }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const body = await response.json() as { project?: Project };
      if (!body.project?.id) throw new Error('Project response did not include a project id.');
      setName('');
      onOpen(body.project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <main className="home-shell">
      <header className="home-header">
        <div>
          <div className="eyebrow">LCT · presentation core</div>
          <h1>Presentations, without the generic product shell.</h1>
          <p className="lede">One workspace for source material, design-system constraints, editable files and a live deck preview.</p>
        </div>
      </header>

      <section className="create-panel" aria-label="Create presentation">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !creating) void create(); }}
          placeholder="Presentation name"
          aria-label="Presentation name"
        />
        <button className="primary" disabled={creating} onClick={() => void create()}>
          {creating ? 'Creating…' : 'New presentation'}
        </button>
      </section>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="projects-section">
        <div className="section-heading">
          <h2>Projects</h2>
          <button className="quiet" onClick={() => void load()} disabled={loading}>Refresh</button>
        </div>
        {loading ? <div className="empty-state">Loading projects…</div> : null}
        {!loading && projects.length === 0 ? (
          <div className="empty-state">No projects yet. Create the first presentation above.</div>
        ) : null}
        <div className="project-grid">
          {projects.map((project) => (
            <button key={project.id} className="project-card" onClick={() => onOpen(project.id)}>
              <span className="project-card-kind">PRESENTATION</span>
              <strong>{project.name || 'Untitled presentation'}</strong>
              <span className="project-card-meta">{project.updatedAt ? `Updated ${new Date(project.updatedAt).toLocaleString()}` : project.id}</span>
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}

function PresentationWorkspace({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const uploadRef = useRef<HTMLInputElement>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [designSystems, setDesignSystems] = useState<DesignSystem[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [templateFile, setTemplateFile] = useState<string | null>(null);
  const [templateScan, setTemplateScan] = useState<TemplateCompileResponse | null>(null);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [editorText, setEditorText] = useState('');
  const [editorDirty, setEditorDirty] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newFileName, setNewFileName] = useState('');

  const loadProject = useCallback(async () => {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(await errorMessage(response));
    const body = await response.json() as { project?: Project };
    if (!body.project) throw new Error('Project not found.');
    setProject(body.project);
  }, [projectId]);

  const loadFiles = useCallback(async () => {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, { cache: 'no-store' });
    if (!response.ok) throw new Error(await errorMessage(response));
    const body = await response.json() as { files?: ProjectFile[] };
    setFiles((body.files ?? []).filter((file) => !file.isDirectory));
  }, [projectId]);

  const loadDesignSystems = useCallback(async () => {
    const response = await fetch('/api/design-systems', { cache: 'no-store' });
    if (!response.ok) return;
    const body = await response.json() as { designSystems?: DesignSystem[] };
    setDesignSystems(body.designSystems ?? []);
  }, []);

  const loadTemplateScan = useCallback(async () => {
    setTemplateLoading(true);
    setTemplateError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/template`, { cache: 'no-store' });
      if (!response.ok) throw new Error(await errorMessage(response));
      setTemplateScan(parseTemplateCompileResponse(await response.json()));
    } catch (err) {
      setTemplateError(err instanceof Error ? err.message : String(err));
    } finally {
      setTemplateLoading(false);
    }
  }, [projectId]);

  const reload = useCallback(async () => {
    setError(null);
    try {
      await Promise.all([loadProject(), loadFiles(), loadDesignSystems(), loadTemplateScan()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [loadDesignSystems, loadFiles, loadProject, loadTemplateScan]);

  useEffect(() => { void reload(); }, [reload]);

  const previewFile = useMemo(() => pickPreviewFile(files, selectedFile), [files, selectedFile]);
  const templateFiles = useMemo(() => files.filter((file) => /\.pptx$/i.test(filePath(file))), [files]);
  const scanSourcePath = sourcePathOf(templateScan);
  const scanSelectionMismatch = Boolean(scanSourcePath && templateFile !== scanSourcePath);
  const visibleTemplateStatus: TemplateCompileStatus | null = scanSelectionMismatch
    ? 'stale'
    : templateScan?.status ?? null;
  const templateBadgeStatus = visibleTemplateStatus ?? (templateLoading ? 'loading' : templateError ? 'unavailable' : 'uncompiled');
  const templateBadgeLabel = templateLoading ? 'Analyzing…'
    : templateBadgeStatus === 'ready' ? 'Understood'
      : templateBadgeStatus === 'stale' ? 'Needs re-scan'
        : templateBadgeStatus === 'uncompiled' ? 'Not analyzed'
          : templateBadgeStatus === 'failed' ? 'Failed'
            : templateBadgeStatus === 'unavailable' ? 'Unavailable'
              : templateBadgeStatus;
  const templateIR = record(templateScan?.templateIR);
  const presentationDesignSystem = record(templateScan?.presentationDesignSystem);
  const canvas = record(firstValue(presentationDesignSystem, ['canvas']))
    ?? record(firstValue(templateIR, ['slideSize', 'canvas']))
    ?? null;
  const slideSize = record(firstValue(templateIR, ['slideSize'])) ?? canvas;
  const width = firstValue(slideSize, ['width', 'cx']);
  const height = firstValue(slideSize, ['height', 'cy']);
  const layoutCards = arrayValue(presentationDesignSystem, ['layouts']);
  const irLayouts = arrayValue(templateIR, ['layouts']);
  const layouts = layoutCards.length ? layoutCards : irLayouts;
  const typographyDirect = arrayValue(presentationDesignSystem, ['typography.direct']);
  const fonts = uniqueStrings(typographyDirect.flatMap((observation) => arrayValue(observation, ['fonts'])));
  const fontSizes = [...new Set(arrayValue(presentationDesignSystem, ['typography.observedSizesPt'])
    .filter((size): size is number => typeof size === 'number' && Number.isFinite(size)))].sort((left, right) => left - right);
  const themeTypography = record(firstValue(presentationDesignSystem, ['typography.theme']));
  const themeFontEntries = [
    { role: 'Major', font: firstValue(themeTypography, ['major']) },
    { role: 'Minor', font: firstValue(themeTypography, ['minor']) },
  ].filter((entry): entry is { role: string; font: string } => typeof entry.font === 'string' && Boolean(entry.font));
  const directColors = arrayValue(presentationDesignSystem, ['colors.direct']).flatMap((observation) => {
    const item = record(observation);
    if (!item) return [];
    const value = firstValue(item, ['value']);
    if (typeof value !== 'string' || !value.trim()) return [];
    const role = stringValue(firstValue(item, ['role']), 'color');
    const uses = firstValue(item, ['uses']);
    const elementCount = arrayValue(item, ['elementIds']).length;
    const count = typeof uses === 'number' ? uses : elementCount;
    return [{ label: `${role} · ${count} ${count === 1 ? 'use' : 'uses'}`, value }];
  });
  const themeColors = arrayValue(presentationDesignSystem, ['colors.theme'])
    .map(colorEntry).filter((entry): entry is { label: string; value: string } => Boolean(entry));
  const theme = record(firstValue(templateIR, ['theme'])) ?? record(firstValue(presentationDesignSystem, ['theme']));
  const themeName = stringValue(firstValue(theme, ['name', 'displayName', 'themeName', 'id']));
  const reusableAssets = arrayValue(presentationDesignSystem, ['assets']);
  const templateAssets = arrayValue(templateIR, ['assets']);
  const unsupported = [
    ...arrayValue(templateIR, ['unsupported', 'unsupportedParts']),
    ...arrayValue(presentationDesignSystem, ['unsupported']),
  ].map((entry) => {
    const item = record(entry);
    if (!item) return readableValue(entry);
    return [
      stringValue(firstValue(item, ['kind']), 'unsupported'),
      stringValue(firstValue(item, ['part']), 'part unknown'),
      stringValue(firstValue(item, ['reason'])),
    ].filter(Boolean).join(' · ');
  });
  const warnings = [
    ...arrayValue(templateIR, ['warnings']),
    ...arrayValue(presentationDesignSystem, ['warnings']),
  ];
  const matchingScan = Boolean(templateIR && !scanSelectionMismatch);

  const analyzeTemplate = async () => {
    if (!templateFile) return;
    setTemplateLoading(true);
    setTemplateError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/template/compile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: templateFile }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const failed = record(body);
        if (failed?.status === 'failed') setTemplateScan(parseTemplateCompileResponse(body));
        throw new Error(failed?.failure ? templateFailureText(failed.failure) : `Request failed (${response.status})`);
      }
      setTemplateScan(parseTemplateCompileResponse(body));
    } catch (err) {
      setTemplateError(err instanceof Error ? err.message : String(err));
    } finally {
      setTemplateLoading(false);
    }
  };

  useEffect(() => {
    const paths = templateFiles.map(filePath);
    if (templateFile && paths.includes(templateFile)) return;
    const compiledSource = sourcePathOf(templateScan);
    setTemplateFile(compiledSource && paths.includes(compiledSource) ? compiledSource : paths[0] ?? null);
  }, [templateFile, templateFiles, templateScan]);

  const refreshPreview = useCallback(async () => {
    if (!previewFile) {
      setPreviewUrl(null);
      return;
    }
    try {
      const params = new URLSearchParams({ file: previewFile });
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/preview-url?${params.toString()}`, { cache: 'no-store' });
      if (response.ok) {
        const body = await response.json() as { url?: string };
        if (body.url) {
          setPreviewUrl(`${body.url}${body.url.includes('?') ? '&' : '?'}v=${Date.now()}`);
          return;
        }
      }
      setPreviewUrl(`${rawFileUrl(projectId, previewFile)}?v=${Date.now()}`);
    } catch {
      setPreviewUrl(`${rawFileUrl(projectId, previewFile)}?v=${Date.now()}`);
    }
  }, [previewFile, projectId]);

  useEffect(() => { void refreshPreview(); }, [refreshPreview]);

  useEffect(() => {
    if (!selectedFile || !isTextFile(selectedFile)) {
      setEditorText('');
      setEditorDirty(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(rawFileUrl(projectId, selectedFile), { cache: 'no-store' });
        if (!response.ok) throw new Error(await errorMessage(response));
        const text = await response.text();
        if (!cancelled) {
          setEditorText(text);
          setEditorDirty(false);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, selectedFile]);

  const saveText = async () => {
    if (!selectedFile || !isTextFile(selectedFile)) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: selectedFile, content: editorText }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      setEditorDirty(false);
      await loadFiles();
      await refreshPreview();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const createTextFile = async () => {
    const name = newFileName.trim().replace(/^\/+/, '');
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content: name.endsWith('.html') ? '<!doctype html>\n<html>\n<head><meta charset="utf-8"><title>Presentation</title></head>\n<body></body>\n</html>\n' : '' }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      setNewFileName('');
      await loadFiles();
      setSelectedFile(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const upload = async (incoming: FileList | null) => {
    if (!incoming?.length) return;
    const incomingFiles = Array.from(incoming);
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      for (const file of incomingFiles) form.append('files', file);
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/upload`, { method: 'POST', body: form });
      if (!response.ok) throw new Error(await errorMessage(response));
      const body = await response.json().catch(() => null) as { files?: ProjectFile[] } | null;
      await loadFiles();
      const uploadedTemplate = body?.files?.find((file) => /\.pptx$/i.test(filePath(file) || file.originalName || ''));
      const incomingTemplate = incomingFiles.find((file) => /\.pptx$/i.test(file.name));
      const uploadedPath = uploadedTemplate
        ? filePath(uploadedTemplate)
        : incomingTemplate?.name ?? null;
      if (uploadedPath) setTemplateFile(uploadedPath);
      await loadTemplateScan();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (uploadRef.current) uploadRef.current.value = '';
      setBusy(false);
    }
  };

  const applyDesignSystem = async (designSystemId: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ designSystemId: designSystemId || null }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const body = await response.json() as { project?: Project };
      if (body.project) setProject(body.project);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!project && !error) return <div className="boot-state">Loading presentation workspace…</div>;

  return (
    <main className="workspace-shell">
      <header className="workspace-topbar">
        <button className="quiet" onClick={onBack}>← Projects</button>
        <div className="project-title-block">
          <span className="eyebrow">PRESENTATION WORKSPACE</span>
          <strong>{project?.name ?? projectId}</strong>
        </div>
        <div className="topbar-actions">
          <button className="quiet" onClick={() => void reload()}>Reload</button>
          <button className="primary" onClick={() => uploadRef.current?.click()} disabled={busy}>Add sources</button>
          <input ref={uploadRef} className="visually-hidden" type="file" multiple onChange={(event) => void upload(event.target.files)} />
        </div>
      </header>

      {error ? <div className="error-banner workspace-error">{error}</div> : null}

      <section className="template-panel" aria-labelledby="template-panel-title">
        <div className="template-panel-head">
          <div>
            <span className="eyebrow">TEMPLATE UNDERSTANDING</span>
            <h2 id="template-panel-title">Structural template scan</h2>
            <p>Reads the uploaded PowerPoint structure and records observed layout, theme and asset details.</p>
          </div>
          <span className={`template-status status-${templateBadgeStatus}`} role="status">
            {templateBadgeLabel}
          </span>
        </div>

        <div className="template-toolbar">
          <label htmlFor="template-source">PowerPoint source</label>
          <select
            id="template-source"
            value={templateFile ?? ''}
            onChange={(event) => setTemplateFile(event.target.value || null)}
            disabled={templateFiles.length === 0 || templateLoading}
          >
            {templateFiles.length === 0 ? <option value="">Upload a .pptx file first</option> : null}
            {templateFiles.map((file) => {
              const path = filePath(file);
              return <option key={path} value={path}>{path}</option>;
            })}
          </select>
          <button className="primary" onClick={() => void analyzeTemplate()} disabled={!templateFile || busy || templateLoading}>
            {templateLoading ? 'Analyzing…' : 'Analyze as template'}
          </button>
          {templateScan?.compiledAt ? <span className="template-compiled-at">Last scan {new Date(templateScan.compiledAt).toLocaleString()}</span> : null}
        </div>

        <p className="template-scope-note">This is a structural scan. It describes observed file data and does not promise universal compatibility with arbitrary or native PowerPoint templates.</p>
        {templateError ? <div className="error-banner template-error">{templateError}</div> : null}

        {visibleTemplateStatus === 'uncompiled' ? (
          <div className="template-message">Choose an uploaded .pptx, then run the scan to inspect its structure.</div>
        ) : null}
        {visibleTemplateStatus === 'stale' ? (
          <div className="template-message template-message-warning">
            {scanSelectionMismatch
              ? `The displayed scan belongs to ${scanSourcePath}. Analyze ${templateFile ?? 'the selected file'} to refresh it.`
              : 'The source file changed after this scan. Analyze it again to refresh the structural summary.'}
          </div>
        ) : null}
        {visibleTemplateStatus === 'failed' ? (
          <div className="template-message template-message-warning">{templateFailureText(templateScan?.failure)}</div>
        ) : null}
        {!templateLoading && !templateScan && templateError ? (
          <div className="template-message template-message-warning">Template scan status could not be loaded.</div>
        ) : null}

        {matchingScan && templateIR ? (
          <div className="template-report">
            <div className="template-source-line">
              <span>Scanned file</span>
              <strong>{stringValue(firstValue(templateScan?.source, ['originalName', 'filePath']), scanSourcePath ?? 'Source not reported')}</strong>
            </div>

            <div className="template-metrics">
              <div className="template-metric"><span>Canvas / aspect</span><strong>{formatCanvasDimensions(width, height, firstValue(slideSize, ['unit']))} · {formatAspectRatio(width, height, firstValue(canvas, ['aspectRatio']))}</strong></div>
              <div className="template-metric"><span>Slides</span><strong>{countLabel(templateIR, ['slides'], ['slideCount', 'summary.slideCount'])}</strong></div>
              <div className="template-metric"><span>Masters</span><strong>{countLabel(templateIR, ['masters'], ['masterCount', 'summary.masterCount'])}</strong></div>
              <div className="template-metric"><span>Layouts</span><strong>{countLabel(presentationDesignSystem, ['layouts'], [])}</strong></div>
            </div>

            <div className="template-observations">
              <section className="template-observation-block">
                <div className="template-block-heading">
                  <h3>Observed theme</h3>
                  <span>{themeName || (theme ? 'Theme data present' : 'Name not reported')}</span>
                </div>
                <strong className="template-subheading">Observed fonts</strong>
                <div className="template-chip-list">
                  {fonts.length ? fonts.map((font) => <span className="template-chip" key={font}>{font}</span>) : <span className="template-muted">No observed fonts reported.</span>}
                </div>
                <strong className="template-subheading">Observed font sizes</strong>
                <div className="template-chip-list">
                  {fontSizes.length ? fontSizes.map((size) => <span className="template-chip" key={size}>{size} pt</span>) : <span className="template-muted">No observed font sizes reported.</span>}
                </div>
                <strong className="template-subheading">Theme fonts</strong>
                <div className="template-chip-list">
                  {themeFontEntries.length ? themeFontEntries.map((entry) => (
                    <span className="template-chip" key={entry.role}>{entry.role}: {entry.font}</span>
                  )) : <span className="template-muted">Theme font roles not reported.</span>}
                </div>
                <strong className="template-subheading">Direct palette</strong>
                <div className="template-chip-list template-palette-list">
                  {directColors.length ? directColors.map((color, index) => (
                    <span className="template-chip template-color-chip" key={`${color.label}-${index}`}>
                      <i aria-hidden="true" style={safeColor(color.value) ? { backgroundColor: safeColor(color.value) as string } : undefined} />
                      <span>{color.label}</span>
                      <code>{color.value}</code>
                    </span>
                  )) : <span className="template-muted">No direct palette values reported.</span>}
                </div>
                {themeColors.length ? <p className="template-theme-colors">Theme colors: {themeColors.map((color) => `${color.label}: ${color.value}`).join(' · ')}</p> : null}
              </section>

              <section className="template-observation-block">
                <div className="template-block-heading">
                  <h3>Assets</h3>
                  <span>{templateAssets.length || reusableAssets.length} observed</span>
                </div>
                {templateAssets.length || reusableAssets.length ? (
                  <div className="template-asset-list">
                    {Object.entries((templateAssets.length ? templateAssets : reusableAssets).reduce<Record<string, number>>((counts, asset) => {
                      const kind = stringValue(firstValue(asset, ['kind', 'type', 'contentType']), 'Unclassified');
                      counts[kind] = (counts[kind] ?? 0) + 1;
                      return counts;
                    }, {})).map(([kind, count]) => <span key={kind}>{kind}<strong>{count}</strong></span>)}
                  </div>
                ) : <p className="template-muted">No assets were reported by this scan.</p>}
              </section>
            </div>

            <section className="template-layout-section">
              <div className="template-block-heading">
                <div><span className="eyebrow">STRUCTURAL INVENTORY</span><h3>Layouts</h3></div>
                <span>{layouts.length} reported</span>
              </div>
              {layouts.length ? (
                <div className="template-layout-grid">
                  {layouts.map((entry, index) => {
                    const layout = record(entry);
                    if (!layout) return null;
                    const title = stringValue(firstValue(layout, ['matchingName', 'declaredName', 'name', 'title']), `Layout ${index + 1}`);
                    const roles = uniqueStrings(arrayValue(layout, ['placeholderRoles', 'structure.placeholderRoles']));
                    const elementCounts = record(firstValue(layout, ['elementCounts']));
                    const elementKinds = record(firstValue(elementCounts, ['byKind'])) ?? {};
                    const totalElements = firstValue(elementCounts, ['total']);
                    const usageCount = firstValue(layout, ['usageCount', 'slideUsageCount']);
                    const layoutType = stringValue(firstValue(layout, ['declaredType', 'type', 'kind']));
                    const layoutPart = stringValue(firstValue(layout, ['sourcePart', 'part', 'id']));
                    return (
                      <article className="template-layout-card" key={`${layoutPart || title}-${index}`}>
                        <div className="template-layout-card-head">
                          <div><strong>{title}</strong>{layoutType ? <span>{layoutType}</span> : null}</div>
                          <span className="template-usage">{typeof usageCount === 'number' ? `${usageCount} uses` : 'Usage unknown'}</span>
                        </div>
                        {layoutPart ? <code className="template-layout-part">{layoutPart}</code> : null}
                        <strong className="template-subheading">Placeholder composition</strong>
                        <div className="template-chip-list">
                          {roles.length ? roles.map((role, roleIndex) => <span className="template-chip" key={`${role}-${roleIndex}`}>{role}</span>) : <span className="template-muted">No placeholder roles reported.</span>}
                        </div>
                        {elementCounts && Object.keys(elementCounts).length ? (
                          <div className="template-element-counts">
                          {typeof totalElements === 'number' ? <span>Total<strong>{totalElements}</strong></span> : null}
                          {Object.entries(elementKinds).map(([kind, count]) => <span key={kind}>{kind}<strong>{stringValue(count, '—')}</strong></span>)}
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              ) : <div className="template-message">No layout details were reported.</div>}
            </section>

            <section className="template-notes-section">
              <h3>Unsupported features and warnings</h3>
              {unsupported.length || warnings.length ? (
                <ul>
                  {uniqueStrings(unsupported).map((item, index) => <li key={`unsupported-${index}`}><strong>Unsupported:</strong> {item}</li>)}
                  {uniqueStrings(warnings).map((item, index) => <li key={`warning-${index}`}>{item}</li>)}
                </ul>
              ) : <p className="template-muted">No unsupported features or warnings were reported. This does not imply complete PowerPoint compatibility.</p>}
            </section>
          </div>
        ) : null}
      </section>

      <div className="workspace-grid">
        <aside className="workspace-sidebar">
          <section className="sidebar-section">
            <div className="sidebar-heading"><span>Files</span><span>{files.length}</span></div>
            <div className="new-file-row">
              <input value={newFileName} onChange={(event) => setNewFileName(event.target.value)} placeholder="new-file.html" />
              <button className="quiet compact" onClick={() => void createTextFile()} disabled={busy || !newFileName.trim()}>+</button>
            </div>
            <div className="file-list">
              {files.map((file) => {
                const path = filePath(file);
                return (
                  <button key={path} className={`file-row ${selectedFile === path ? 'active' : ''}`} onClick={() => { setSelectedFile(path); if (/\.pptx$/i.test(path)) setTemplateFile(path); }}>
                    <span className="file-name">{path}</span>
                    <span className="file-size">{formatBytes(file.size)}</span>
                  </button>
                );
              })}
              {files.length === 0 ? <div className="sidebar-empty">Upload a PPTX, PDF, image or HTML deck to start.</div> : null}
            </div>
          </section>

          <section className="sidebar-section design-system-section">
            <label className="sidebar-heading" htmlFor="design-system"><span>Design system</span></label>
            <select id="design-system" value={project?.designSystemId ?? ''} onChange={(event) => void applyDesignSystem(event.target.value)} disabled={busy}>
              <option value="">Unspecified</option>
              {designSystems.map((system) => <option key={system.id} value={system.id}>{system.displayName || system.name || system.id}</option>)}
            </select>
            <p className="sidebar-note">Uploaded template understanding should resolve into this project constraint, not into a generic style gallery.</p>
          </section>
        </aside>

        <section className="preview-panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">LIVE PREVIEW</span>
              <strong>{previewFile ?? 'No HTML output yet'}</strong>
            </div>
            <button className="quiet" onClick={() => void refreshPreview()} disabled={!previewFile}>Refresh</button>
          </div>
          <div className="preview-stage">
            {previewUrl ? (
              <iframe key={previewUrl} title="Presentation preview" src={previewUrl} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
            ) : (
              <div className="preview-empty">
                <strong>No renderable deck yet.</strong>
                <span>Generate or upload an HTML presentation. The preview will bind to index.html automatically.</span>
              </div>
            )}
          </div>
        </section>

        <section className="editor-panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">SOURCE / EDIT</span>
              <strong>{selectedFile ?? 'Select a file'}</strong>
            </div>
            {selectedFile && isTextFile(selectedFile) ? (
              <button className="primary" onClick={() => void saveText()} disabled={busy || !editorDirty}>{busy ? 'Saving…' : 'Save'}</button>
            ) : null}
          </div>
          {selectedFile && isTextFile(selectedFile) ? (
            <textarea
              className="source-editor"
              spellCheck={false}
              value={editorText}
              onChange={(event) => { setEditorText(event.target.value); setEditorDirty(true); }}
            />
          ) : (
            <div className="editor-empty">
              {selectedFile ? 'Binary source selected. Keep it as reference/media; edit generated text/HTML files here.' : 'Select an HTML, CSS, JS, JSON, Markdown or text file to edit.'}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
