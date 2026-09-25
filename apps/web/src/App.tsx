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

type PlanningResponse = {
  status?: string;
  templateStatus?: string;
  inputFingerprint?: string | null;
  contentFiles?: string[];
  brief?: unknown;
  contentIR?: unknown;
  deckPlan?: unknown;
  checkpoint?: unknown;
  review?: unknown;
  telemetry?: unknown;
  promptVersions?: unknown;
  failure?: unknown;
  warnings?: unknown;
  updatedAt?: string | null;
};

type GenerationVariantId = 'A' | 'B' | 'C';
type GenerationVariant = {
  status: string;
  version: number;
  previewUrl: string | null;
  layoutIssueCount: number;
  visualSlotStatus: string;
  audit: { findings?: unknown[] } | null;
};
type GenerationPack = {
  slideId: string;
  index: number;
  title: string;
  recommendedVariant: GenerationVariantId;
  selectedVariant: GenerationVariantId;
  status: string;
  version: number;
  lockedVariant: GenerationVariantId | null;
  auditSummary: { errors: number; warnings: number; infos: number };
  failure: { code: string; message: string } | null;
  variants: Record<GenerationVariantId, GenerationVariant>;
};
type GenerationState = {
  generationId: string;
  idempotencyKey: string;
  inputFingerprint: string;
  planHash: string;
  contentIRHash: string;
  templateIRHash: string;
  revision: number;
  status: string;
  readySlides: number;
  totalSlides: number;
  currentSlideId: string | null;
  defaultTrack: GenerationVariantId;
  selectionVersion: number;
  slides: GenerationPack[];
  failure: { code: string; message: string } | null;
  exports: Array<{ id: string; mode: 'selected' | GenerationVariantId; downloadUrl: string; validationStatus: string; nativeOfficeStatus: string }>;
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
  const [planning, setPlanning] = useState<PlanningResponse | null>(null);
  const [planningLoading, setPlanningLoading] = useState(false);
  const [planningGenerating, setPlanningGenerating] = useState(false);
  const [planningError, setPlanningError] = useState<string | null>(null);
  const [selectedContentFiles, setSelectedContentFiles] = useState<string[]>([]);
  const [briefAudience, setBriefAudience] = useState('');
  const [briefPurpose, setBriefPurpose] = useState('');
  const [briefExpectedOutcome, setBriefExpectedOutcome] = useState('');
  const [briefPreferences, setBriefPreferences] = useState('');
  const [requestedSlideCount, setRequestedSlideCount] = useState('');
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

  const loadPlanning = useCallback(async () => {
    setPlanningLoading(true);
    setPlanningError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/planning`, { cache: 'no-store' });
      if (!response.ok) throw new Error(await errorMessage(response));
      const body = await response.json() as PlanningResponse;
      setPlanning(body);
      setSelectedContentFiles(Array.isArray(body.contentFiles) ? body.contentFiles.slice(0, 12) : []);
      const brief = record(body.brief);
      setBriefAudience(stringValue(brief?.audience));
      setBriefPurpose(stringValue(brief?.purpose));
      setBriefExpectedOutcome(stringValue(brief?.expectedOutcome));
      setBriefPreferences(Array.isArray(brief?.preferences)
        ? brief.preferences.filter((item): item is string => typeof item === 'string').join('\n')
        : '');
      setRequestedSlideCount(typeof brief?.requestedSlideCount === 'number' ? String(brief.requestedSlideCount) : '');
    } catch (err) {
      setPlanningError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanningLoading(false);
    }
  }, [projectId]);

  const reload = useCallback(async () => {
    setError(null);
    try {
      await Promise.all([loadProject(), loadFiles(), loadDesignSystems(), loadTemplateScan(), loadPlanning()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [loadDesignSystems, loadFiles, loadPlanning, loadProject, loadTemplateScan]);

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
  const excludedPlanningPath = templateFile ?? scanSourcePath;
  const planningSourceFiles = files.filter((file) => filePath(file) !== excludedPlanningPath);
  const availablePlanningPaths = new Set(planningSourceFiles.map(filePath));
  const planningSelectedPaths = selectedContentFiles.filter((path) => availablePlanningPaths.has(path)).slice(0, 12);
  const planningDeckPlan = record(planning?.deckPlan);
  const planningSlides = arrayValue(planningDeckPlan, ['slides']);
  const contentIR = record(planning?.contentIR);
  const sourcePathById = new Map(arrayValue(contentIR, ['sources']).flatMap((source) => {
    const item = record(source);
    const sourceId = stringValue(firstValue(item, ['id']));
    const path = stringValue(firstValue(item, ['sourcePath']));
    return sourceId && path ? [[sourceId, path] as const] : [];
  }));
  const unitSourceById = new Map(arrayValue(contentIR, ['units']).flatMap((unit) => {
    const item = record(unit);
    const unitId = stringValue(firstValue(item, ['id']));
    const sourceId = stringValue(firstValue(item, ['sourceId']));
    return unitId && sourceId ? [[unitId, sourceId] as const] : [];
  }));
  const planningReview = record(planning?.review);
  const planningFindings = arrayValue(planningReview, ['findings']);
  const planningWarnings = arrayValue(planning, ['warnings']);
  const planningFailure = record(planning?.failure);

  const togglePlanningFile = (path: string, checked: boolean) => {
    setPlanningError(null);
    const validCurrent = selectedContentFiles.filter((item) => availablePlanningPaths.has(item));
    if (!checked) {
      setSelectedContentFiles(validCurrent.filter((item) => item !== path));
      return;
    }
    if (validCurrent.includes(path)) return;
    if (validCurrent.length >= 12) {
      setPlanningError('Select no more than 12 source files.');
      return;
    }
    setSelectedContentFiles([...validCurrent, path]);
  };

  const generatePlan = async () => {
    setPlanningError(null);
    if (planningSelectedPaths.length < 1 || planningSelectedPaths.length > 12) {
      setPlanningError('Select between 1 and 12 project source files.');
      return;
    }
    if (!briefAudience.trim() || !briefPurpose.trim() || !briefExpectedOutcome.trim()) {
      setPlanningError('Audience, purpose, and expected outcome are required.');
      return;
    }
    const count = requestedSlideCount.trim() ? Number(requestedSlideCount) : undefined;
    if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 30)) {
      setPlanningError('Requested slide count must be an integer from 1 to 30.');
      return;
    }
    const preferences = briefPreferences.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    if (preferences.length > 12 || preferences.some((item) => item.length > 200)) {
      setPlanningError('Enter at most 12 preferences, with no more than 200 characters per line.');
      return;
    }
    const brief = {
      audience: briefAudience.trim(),
      purpose: briefPurpose.trim(),
      expectedOutcome: briefExpectedOutcome.trim(),
      preferences,
      ...(count === undefined ? {} : { requestedSlideCount: count }),
    };
    setPlanningGenerating(true);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/planning/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentFiles: planningSelectedPaths, brief }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const body = await response.json() as PlanningResponse;
      setPlanning(body);
      setSelectedContentFiles(Array.isArray(body.contentFiles) ? body.contentFiles.slice(0, 12) : planningSelectedPaths);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await loadPlanning();
      setPlanningError(message);
    } finally {
      setPlanningGenerating(false);
    }
  };

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
      await loadPlanning();
    } catch (err) {
      setTemplateError(err instanceof Error ? err.message : String(err));
      await loadPlanning();
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
      await loadPlanning();
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
    const uploadedFiles: ProjectFile[] = [];
    setBusy(true);
    setError(null);
    try {
      for (let offset = 0; offset < incomingFiles.length; offset += 2) {
        const form = new FormData();
        for (const file of incomingFiles.slice(offset, offset + 2)) form.append('files', file);
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/upload`, { method: 'POST', body: form });
        if (!response.ok) throw new Error(await errorMessage(response));
        const body = await response.json().catch(() => null) as { files?: ProjectFile[] } | null;
        uploadedFiles.push(...(body?.files ?? []));
      }
      await loadFiles();
      const uploadedTemplate = uploadedFiles.find((file) => /\.pptx$/i.test(filePath(file) || file.originalName || ''));
      const incomingTemplate = incomingFiles.find((file) => /\.pptx$/i.test(file.name));
      const uploadedPath = uploadedTemplate
        ? filePath(uploadedTemplate)
        : incomingTemplate?.name ?? null;
      if (uploadedPath) setTemplateFile(uploadedPath);
      await loadTemplateScan();
      await loadPlanning();
    } catch (err) {
      if (uploadedFiles.length) await loadFiles();
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

      <nav className="workspace-stages" aria-label="Presentation stages">
        <a href="#template-panel" data-complete={templateScan?.status === 'ready'}>Template</a>
        <a href="#planning-panel" data-complete={planningSourceFiles.length > 0}>Content / brief</a>
        <a href="#planning-panel" data-complete={planning?.status === 'ready'}>Plan</a>
        <a href="#generation-panel" data-complete={planning?.status === 'ready'}>Generate</a>
        <a href="#generation-review" data-complete={false}>Review / export</a>
      </nav>

      <section className="template-panel" id="template-panel" aria-labelledby="template-panel-title">
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

      <section className="planning-panel" id="planning-panel" aria-labelledby="planning-panel-title">
        <div className="planning-panel-head">
          <div>
            <span className="eyebrow">CONTENT PLANNING</span>
            <h2 id="planning-panel-title">Build a presentation outline</h2>
            <p>Select source files and describe the intended presentation. The plan is reviewed before it is saved.</p>
          </div>
          <div className="planning-head-actions">
            <span className={`planning-status planning-status-${planningGenerating ? 'generating' : planning?.status ?? 'loading'}`} role="status">
              {planningLoading ? 'Loading' : planningGenerating ? 'Generating' : planning?.status?.replaceAll('_', ' ') ?? 'Unavailable'}
            </span>
            <button className="quiet" onClick={() => void loadPlanning()} disabled={planningLoading || planningGenerating}>Reload plan</button>
          </div>
        </div>

        {planning?.templateStatus !== 'ready' || !matchingScan ? (
          <div className="planning-notice" role="status">
            Analyze the selected PowerPoint template before generating a plan.
          </div>
        ) : null}
        {planningLoading && !planning ? <div className="planning-notice">Loading saved planning inputs…</div> : null}
        {planningError ? <div className="error-banner planning-error" role="alert">{planningError}</div> : null}
        {planning?.status === 'stale' ? <div className="planning-notice planning-notice-warning" role="status">
          This saved outline uses earlier template, source, brief, or prompt inputs. Generate a new plan to refresh it.
        </div> : null}
        {planningFailure?.message ? <div className="planning-notice planning-notice-warning" role="status">
          {stringValue(planningFailure.message)}{planningFailure.code ? ` (${stringValue(planningFailure.code)})` : ''}
        </div> : null}

        <div className="planning-form-grid">
          <fieldset className="planning-file-picker">
            <legend>Source files <span>{planningSelectedPaths.length}/12 selected</span></legend>
            {planningSourceFiles.length ? (
              <div className="planning-file-list">
                {planningSourceFiles.map((file) => {
                  const path = filePath(file);
                  return (
                    <label className="planning-file-option" key={path} title={path}>
                      <input
                        type="checkbox"
                        checked={planningSelectedPaths.includes(path)}
                        onChange={(event) => togglePlanningFile(path, event.target.checked)}
                        disabled={planningGenerating || (!planningSelectedPaths.includes(path) && planningSelectedPaths.length >= 12)}
                      />
                      <span>{path}</span>
                      <small>{formatBytes(file.size)}</small>
                    </label>
                  );
                })}
              </div>
            ) : <p className="planning-muted">Upload source material to choose files for the outline.</p>}
          </fieldset>

          <div className="planning-brief">
            <label>Audience
              <input maxLength={500} value={briefAudience} onChange={(event) => setBriefAudience(event.target.value)} disabled={planningGenerating} placeholder="Who will use this presentation?" />
            </label>
            <label>Purpose
              <textarea maxLength={1000} value={briefPurpose} onChange={(event) => setBriefPurpose(event.target.value)} disabled={planningGenerating} rows={2} placeholder="What should the presentation explain or support?" />
            </label>
            <label>Expected outcome
              <textarea maxLength={1000} value={briefExpectedOutcome} onChange={(event) => setBriefExpectedOutcome(event.target.value)} disabled={planningGenerating} rows={2} placeholder="What should the audience understand or do?" />
            </label>
            <label>Preferences <span className="planning-label-note">one per line</span>
              <textarea value={briefPreferences} onChange={(event) => setBriefPreferences(event.target.value)} disabled={planningGenerating} rows={2} placeholder="Optional style, emphasis, or constraints" />
            </label>
            <label className="planning-slide-count">Requested slide count <span className="planning-label-note">optional · 1–30</span>
              <input type="number" min="1" max="30" step="1" value={requestedSlideCount} onChange={(event) => setRequestedSlideCount(event.target.value)} disabled={planningGenerating} placeholder="Auto" />
            </label>
            <div className="planning-submit-row">
              <span className="planning-muted">Requires a ready template and at least one source file.</span>
              <button className="primary" onClick={() => void generatePlan()} disabled={planningGenerating || planningLoading || templateLoading || planning?.templateStatus !== 'ready' || !matchingScan}>
                {planningGenerating ? 'Generating…' : 'Generate plan'}
              </button>
            </div>
          </div>
        </div>

        {planningWarnings.length ? (
          <div className="planning-warnings"><strong>Source warnings</strong><ul>{planningWarnings.map((warning, index) => <li key={`planning-warning-${index}`}>{readableValue(warning)}</li>)}</ul></div>
        ) : null}

        {planningDeckPlan ? (
          <section className="planning-result" aria-labelledby="planning-result-title">
            <div className="planning-result-head">
              <div>
                <span className="eyebrow">{planningDeckPlan.id ? `PLAN ${stringValue(planningDeckPlan.id)}` : 'GENERATED OUTLINE'}</span>
                <h3 id="planning-result-title">{stringValue(planningDeckPlan.workingTitle, 'Presentation outline')}</h3>
                <p>{stringValue(planningDeckPlan.narrativeSummary)}</p>
              </div>
              {planning?.updatedAt ? <span className="planning-updated">Updated {new Date(planning.updatedAt).toLocaleString()}</span> : null}
            </div>
            <div className="planning-slide-grid">
              {planningSlides.map((slide, index) => {
                const item = record(slide);
                const refs = arrayValue(item, ['contentRefs']).filter((ref): ref is string => typeof ref === 'string');
                const paths = [...new Set(refs.map((ref) => unitSourceById.get(ref)).filter((sourceId): sourceId is string => Boolean(sourceId))
                  .map((sourceId) => sourcePathById.get(sourceId)).filter((path): path is string => Boolean(path)))];
                return (
                  <article className="planning-slide-card" key={stringValue(firstValue(item, ['id']), `slide-${index + 1}`)}>
                    <div className="planning-slide-card-head">
                      <strong>{stringValue(firstValue(item, ['order']), String(index + 1)).padStart(2, '0')}</strong>
                      <span>{stringValue(firstValue(item, ['narrativeRole']), 'slide').replaceAll('-', ' ')}</span>
                    </div>
                    <h4>{stringValue(firstValue(item, ['purpose']), 'Purpose not reported')}</h4>
                    <p className="planning-takeaway">{stringValue(firstValue(item, ['takeaway']), 'Takeaway not reported')}</p>
                    <div className="planning-slide-meta">
                      <span>{stringValue(firstValue(item, ['semanticVisualType']), 'Visual not reported')}</span>
                      <span>{stringValue(firstValue(item, ['targetDensity']), 'Density not reported')}</span>
                    </div>
                    <div className="planning-source-paths">
                      <strong>Sources</strong>
                      {paths.length ? paths.map((path) => <span key={path} title={path}>{path}</span>) : <span>No source path cited</span>}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}

        {planningReview ? (
          <section className="planning-review" aria-label="Supervisor review">
            <div className="planning-review-head">
              <h3>Supervisor review</h3>
              <span className={`planning-review-outcome outcome-${stringValue(planningReview.outcome, 'unknown')}`}>
                {stringValue(planningReview.outcome, 'Outcome not reported').replaceAll('-', ' ')}
              </span>
            </div>
            {planningFindings.length ? (
              <ul>{planningFindings.map((finding, index) => {
                const item = record(finding);
                return <li key={`finding-${index}`}>
                  <span className={`finding-severity severity-${stringValue(firstValue(item, ['severity']), 'unknown')}`}>{stringValue(firstValue(item, ['severity']), 'finding')}</span>
                  <span>{stringValue(firstValue(item, ['reason']), 'Finding details not reported.')}</span>
                  <small>{stringValue(firstValue(item, ['targetType']), 'deck')}{firstValue(item, ['slideId']) ? ` · ${stringValue(firstValue(item, ['slideId']))}` : ''}</small>
                </li>;
              })}</ul>
            ) : <p className="planning-muted">No findings were reported.</p>}
          </section>
        ) : null}
      </section>

      <PresentationGenerationPanel
        projectId={projectId}
        planningReady={planning?.status === 'ready'}
        inputFingerprint={planning?.inputFingerprint ?? null}
        planHash={stringValue(firstValue(planningDeckPlan, ['hash']))}
        contentIRHash={stringValue(firstValue(contentIR, ['hash']))}
        templateIRHash={stringValue(firstValue(templateIR, ['hash']))}
      />

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

function PresentationGenerationPanel({ projectId, planningReady, inputFingerprint, planHash, contentIRHash, templateIRHash }: {
  projectId: string;
  planningReady: boolean;
  inputFingerprint: string | null;
  planHash: string;
  contentIRHash: string;
  templateIRHash: string;
}) {
  const [generation, setGeneration] = useState<GenerationState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef<GenerationState | null>(null);
  const idempotencyRef = useRef<string | null>(null);
  const activeRef = useRef(false);
  const matchesCurrentInputs = (state: GenerationState | null) => Boolean(state && inputFingerprint && planHash && contentIRHash && templateIRHash
    && state.inputFingerprint && state.planHash === planHash && state.contentIRHash === contentIRHash
    && state.templateIRHash === templateIRHash);

  useEffect(() => {
    if (generation && !matchesCurrentInputs(generation)) idempotencyRef.current = null;
  }, [generation?.generationId, generation?.status, inputFingerprint, planHash, contentIRHash, templateIRHash]);

  const apply = useCallback((next: GenerationState | null) => {
    const current = generationRef.current;
    if (next && current && next.generationId === current.generationId && next.revision < current.revision) return;
    generationRef.current = next;
    activeRef.current = Boolean(next && (next.status === 'preparing' || next.status === 'generating'));
    if (next?.idempotencyKey) idempotencyRef.current = next.idempotencyKey;
    setGeneration(next);
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/generation`, { cache: 'no-store' });
      if (!response.ok) throw new Error(await errorMessage(response));
      const body = await response.json() as { generation?: GenerationState | null };
      apply(body.generation ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [apply, projectId]);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      await load();
      if (!disposed && activeRef.current) timer = window.setTimeout(() => void poll(), 850);
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [load, projectId]);

  const request = async (url: string, init: RequestInit = {}) => {
    const response = await fetch(url, init);
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      const message = await errorMessage(new Response(JSON.stringify(body), { status: response.status }));
      throw new Error(message);
    }
    return body ?? {};
  };

  const withBusy = async (key: string, operation: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try { await operation(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  };

  const start = () => withBusy('start', async () => {
    const key = matchesCurrentInputs(generationRef.current) ? idempotencyRef.current ?? id() : id();
    idempotencyRef.current = key;
    const body = await request(`/api/projects/${encodeURIComponent(projectId)}/generation`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: '{}',
    }) as { generation?: GenerationState };
    if (body.generation) apply(body.generation);
    await load();
  });

  const cancel = () => withBusy('cancel', async () => {
    const body = await request(`/api/projects/${encodeURIComponent(projectId)}/generation/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }) as { generation?: GenerationState };
    if (body.generation) apply(body.generation);
  });

  const chooseTrack = (variant: GenerationVariantId) => {
    if (!generation) return;
    void withBusy(`track-${variant}`, async () => {
      const body = await request(`/api/projects/${encodeURIComponent(projectId)}/generation/selection`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'deck', variant, expectedVersion: generation.selectionVersion }),
      }) as { generation?: GenerationState };
      if (body.generation) apply(body.generation);
    });
  };

  const chooseSlide = (pack: GenerationPack, variant: GenerationVariantId) => {
    void withBusy(`slide-${pack.slideId}-${variant}`, async () => {
      const body = await request(`/api/projects/${encodeURIComponent(projectId)}/generation/selection`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'slide', slideId: pack.slideId, variant, expectedVersion: pack.version }),
      }) as { generation?: GenerationState };
      if (body.generation) apply(body.generation);
    });
  };

  const toggleLock = (pack: GenerationPack) => {
    void withBusy(`lock-${pack.slideId}`, async () => {
      const body = await request(`/api/projects/${encodeURIComponent(projectId)}/generation/slides/${encodeURIComponent(pack.slideId)}/lock`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locked: !pack.lockedVariant, variant: pack.selectedVariant, expectedVersion: pack.version }),
      }) as { generation?: GenerationState };
      if (body.generation) apply(body.generation);
    });
  };

  const repair = (pack: GenerationPack, variant: GenerationVariantId, findingId: string) => {
    void withBusy(`repair-${pack.slideId}-${findingId}`, async () => {
      const body = await request(`/api/projects/${encodeURIComponent(projectId)}/generation/repair`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slideId: pack.slideId, variant, findingId, expectedVersion: pack.version }),
      }) as { generation?: GenerationState };
      if (body.generation) apply(body.generation);
    });
  };

  const exportDeck = (mode: 'selected' | GenerationVariantId) => {
    void withBusy(`export-${mode}`, async () => {
      const body = await request(`/api/projects/${encodeURIComponent(projectId)}/generation/export`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }),
      }) as { state?: GenerationState };
      if (body.state) apply(body.state);
    });
  };

  const isActive = generation?.status === 'preparing' || generation?.status === 'generating';
  const currentGeneration = matchesCurrentInputs(generation);
  const canExport = currentGeneration && generation?.status === 'completed' && generation.readySlides === generation.totalSlides;

  return (
    <section className="generation-panel" id="generation-panel" aria-labelledby="generation-panel-title">
      <div className="generation-panel-head">
        <div>
          <span className="eyebrow">PROGRESSIVE SLIDE GENERATION</span>
          <h2 id="generation-panel-title">Generate and review slide packs</h2>
          <p>The saved outline is compiled into A/B/C alternatives once. Changing a selection does not run planning again.</p>
        </div>
        <div className="generation-actions">
          {isActive ? <button className="quiet" onClick={() => void cancel()} disabled={Boolean(busy)}>Cancel generation</button>
            : <button className="primary" onClick={() => void start()} disabled={!planningReady || loading || Boolean(busy) || currentGeneration && (generation?.status === 'completed' || generation?.status === 'cancelled')}>
              {currentGeneration && generation?.status === 'failed' ? 'Resume generation' : currentGeneration && generation?.status === 'completed' ? 'Generated' : 'Generate slide packs'}
            </button>}
          <span className={`generation-status generation-status-${generation?.status ?? 'idle'}`} role="status">
            {loading ? 'Loading saved generation' : generation?.status === 'completed' && !currentGeneration ? 'Plan changed · ready to regenerate' : generation ? generation.status.replaceAll('_', ' ') : planningReady ? 'Ready to generate' : 'Waiting for a ready plan'}
          </span>
        </div>
      </div>

      {!planningReady ? <p className="generation-notice">Finish and save a valid plan before starting slide generation.</p> : null}
      {error ? <p className="generation-error" role="alert">{error}</p> : null}
      {generation?.failure ? <p className="generation-notice" role="status">{generation.failure.message}</p> : null}

      {generation ? <>
        <div className="generation-progress-row" role="status" aria-live="polite">
          <strong>{generation.readySlides} / {generation.totalSlides} slides ready</strong>
          <span>{generation.currentSlideId ? `Working on slide ${generation.slides.find((pack) => pack.slideId === generation.currentSlideId)?.index ?? ''}` : generation.status}</span>
        </div>
        <div className="generation-track-picker" role="group" aria-label="Default deck track">
          <span>Default track</span>
          {(['A', 'B', 'C'] as const).map((variant) => <button key={variant} className={generation.defaultTrack === variant ? 'active' : ''}
            aria-pressed={generation.defaultTrack === variant} disabled={Boolean(busy)} onClick={() => chooseTrack(variant)}>
            All {variant}{variant === 'A' ? ' · recommended' : ''}
          </button>)}
        </div>
        <div className="generation-slide-list">
          {generation.slides.map((pack) => <article className="generation-slide-card" key={pack.slideId} aria-labelledby={`generation-slide-${pack.index}`}>
            <div className="generation-slide-heading">
              <div><span>SLIDE {String(pack.index).padStart(2, '0')}</span><h3 id={`generation-slide-${pack.index}`}>{pack.title}</h3></div>
              <div className={`generation-pack-status pack-status-${pack.status}`} role="status">{pack.status}</div>
            </div>
            <div className="generation-variants">
              {(['A', 'B', 'C'] as const).map((variant) => {
                const item = pack.variants[variant];
                const audit = item.audit?.findings ?? [];
                return <section className={`generation-variant ${pack.selectedVariant === variant ? 'selected' : ''}`} key={variant} aria-label={`Slide ${pack.index}, variant ${variant}`}>
                  <div className="generation-variant-heading">
                    <strong>Variant {variant}</strong>
                    {pack.recommendedVariant === variant ? <span className="recommended-mark">Recommended</span> : null}
                  </div>
                  {item.previewUrl ? <img className="generation-preview" src={`${item.previewUrl}?v=${item.version}`} alt={`Slide ${pack.index}, variant ${variant} preview`} />
                    : <div className="generation-preview-empty" role="status">{pack.status === 'rendering' ? 'Preparing preview…' : item.status}</div>}
                  <div className="generation-variant-meta">
                    <span>{item.visualSlotStatus === 'not-applicable' ? 'Text slide' : `Visual ${item.visualSlotStatus}`}</span>
                    {item.layoutIssueCount ? <span>{item.layoutIssueCount} preview layout note(s)</span> : null}
                    <span>{audit.length} audit finding(s)</span>
                  </div>
                  <button className={pack.selectedVariant === variant ? 'primary generation-select' : 'quiet generation-select'}
                    aria-pressed={pack.selectedVariant === variant} disabled={pack.status !== 'ready' || Boolean(busy)}
                    onClick={() => chooseSlide(pack, variant)}>
                    {pack.selectedVariant === variant ? `Selected ${variant}` : `Choose ${variant}`}
                  </button>
                </section>;
              })}
            </div>
            <div className="generation-slide-footer">
              <span className="generation-audit-badge" data-errors={pack.auditSummary.errors > 0}>
                A/B/C: {pack.auditSummary.errors} errors · {pack.auditSummary.warnings} warnings
              </span>
              <button className="quiet" disabled={pack.status !== 'ready' || Boolean(busy)} onClick={() => toggleLock(pack)}>
                {pack.lockedVariant ? `Unlock ${pack.lockedVariant}` : `Lock ${pack.selectedVariant}`}
              </button>
              <details className="generation-audit" id={pack.index === 1 ? 'generation-review' : undefined}>
                <summary>Audit findings</summary>
                {pack.variants[pack.selectedVariant].audit?.findings?.length ? <ul>
                  {pack.variants[pack.selectedVariant].audit?.findings?.map((findingValue, index) => {
                    const finding = record(findingValue);
                    const findingId = stringValue(firstValue(finding, ['id']));
                    const rule = stringValue(firstValue(finding, ['ruleId']), 'audit');
                    const message = stringValue(firstValue(finding, ['message']), 'Finding details are unavailable.');
                    const safeFix = firstValue(finding, ['autofixAvailable']) === true;
                    return <li key={`${findingId}-${index}`}>
                      <span><strong>{rule}</strong> · {message}</span>
                      {safeFix ? <button className="quiet compact" disabled={Boolean(busy)} onClick={() => repair(pack, pack.selectedVariant, findingId)}>Apply safe fix</button> : <small>Replan required</small>}
                    </li>;
                  })}
                </ul> : <p>No deterministic findings for the selected variant.</p>}
              </details>
            </div>
            {pack.failure ? <p className="generation-notice" role="alert">{pack.failure.message}</p> : null}
          </article>)}
        </div>

        <section className="generation-export" aria-labelledby="generation-export-title">
          <div><span className="eyebrow">REVIEW / EXPORT</span><h3 id="generation-export-title">Download editable PowerPoint</h3>
            <p>Exports become available after package reopen validation. PowerPoint desktop rendering has not been reviewed.</p></div>
          <div className="generation-export-actions">
            {(['selected', 'A', 'B', 'C'] as const).map((mode) => <button key={mode} className={mode === 'selected' ? 'primary' : 'quiet'}
              disabled={!canExport || Boolean(busy)} onClick={() => exportDeck(mode)}>
              {busy === `export-${mode}` ? 'Assembling…' : mode === 'selected' ? 'Download selected PPTX' : `Download ${mode}`}
            </button>)}
          </div>
          {generation.exports.length ? <ul className="generation-export-list">{generation.exports.map((artifact) => <li key={artifact.id}>
            <a href={artifact.downloadUrl}>Download {artifact.mode === 'selected' ? 'selected deck' : `track ${artifact.mode}`}</a>
            <span>package validation passed · native Office review unknown</span>
          </li>)}</ul> : null}
        </section>
      </> : <p className="generation-notice">A/B/C slide alternatives and previews will appear here as each pack is ready.</p>}
    </section>
  );
}
