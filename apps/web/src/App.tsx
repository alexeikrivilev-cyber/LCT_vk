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
};

type DesignSystem = {
  id: string;
  name?: string;
  displayName?: string;
  description?: string;
};

type Route = { kind: 'home' } | { kind: 'project'; projectId: string };

type ApiError = { error?: string | { message?: string }; message?: string };

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

  const reload = useCallback(async () => {
    setError(null);
    try {
      await Promise.all([loadProject(), loadFiles(), loadDesignSystems()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [loadDesignSystems, loadFiles, loadProject]);

  useEffect(() => { void reload(); }, [reload]);

  const previewFile = useMemo(() => pickPreviewFile(files, selectedFile), [files, selectedFile]);

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
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      for (const file of Array.from(incoming)) form.append('files', file);
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/upload`, { method: 'POST', body: form });
      if (!response.ok) throw new Error(await errorMessage(response));
      await loadFiles();
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
                  <button key={path} className={`file-row ${selectedFile === path ? 'active' : ''}`} onClick={() => setSelectedFile(path)}>
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
