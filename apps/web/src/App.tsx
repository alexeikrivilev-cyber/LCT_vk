'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { contentSourceStatus, contentSourceStatusLabel, type ContentSourceStatus } from './content-source-status';
import {
  auditFindingMessage,
  formatUiDateTime,
  friendlyErrorMessage,
  generationStatusLabel,
  planningStatusLabel,
  ru,
  slidePackStatusLabel,
  templateStatusLabel,
  variantStatusLabel,
} from './i18n/ru';
import { clearWorkspaceDraft, readWorkspaceDraft, writeWorkspaceDraft } from './workspace-draft';

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

type ApiError = { error?: string | { code?: string; message?: string }; message?: string; code?: string };
type UiFailure = { message: string; code?: string; status?: number };

class ApplicationUiError extends Error {
  constructor(readonly failure: UiFailure) {
    super(failure.message);
    this.name = 'ApplicationUiError';
  }
}

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
  exports: Array<{ id: string; mode: 'selected' | GenerationVariantId; format?: 'pptx' | 'pdf' | 'html'; downloadUrl: string; validationStatus: string; nativeOfficeStatus: string }>;
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

function messageFromApiError(body: ApiError | null, status: number, operation: Parameters<typeof friendlyErrorMessage>[2] = 'generic'): ApplicationUiError {
  const nested = record(body?.error);
  const code = stringValue(nested?.code ?? body?.code);
  return new ApplicationUiError({
    message: friendlyErrorMessage(code, status, operation),
    ...(code ? { code } : {}),
    status,
  });
}

function normalizePreferenceLines(value: string): string {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).join('\n');
}

async function errorMessage(response: Response, operation: Parameters<typeof friendlyErrorMessage>[2] = 'generic'): Promise<ApplicationUiError> {
  const body = await response.json().catch(() => null) as ApiError | null;
  return messageFromApiError(body, response.status, operation);
}

function uiFailure(error: unknown, fallback: string = ru.errors.generic): UiFailure {
  if (error instanceof ApplicationUiError) return error.failure;
  return { message: fallback };
}

function ErrorNotice({ failure, className, role = 'alert' }: { failure: UiFailure | string | null; className?: string; role?: 'alert' | 'status' }) {
  if (!failure) return null;
  const value = typeof failure === 'string' ? { message: failure } : failure;
  const showDiagnostics = process.env.NODE_ENV !== 'production' && (value.code || value.status);
  return <div className={className} role={role}>
    <span>{value.message}</span>
    {showDiagnostics ? <details className="ui-error-details">
      <summary>{ru.errors.diagnostics}</summary>
      {value.code ? <code>{ru.errors.code(value.code)}</code> : null}
      {value.status ? <code>{ru.errors.status(value.status)}</code> : null}
    </details> : null}
  </div>;
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
  return stringValue(firstValue(value, countPaths), ru.template.dataUnavailable);
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
  if (typeof width !== 'number' || typeof height !== 'number') return ru.template.dimensionsUnknown;
  if (unit === 'EMU') return `${(width / 914400).toFixed(2)} × ${(height / 914400).toFixed(2)} in`;
  return `${width} × ${height}${typeof unit === 'string' && unit ? ` ${unit}` : ''}`;
}

function templateFailureInfo(value: unknown): UiFailure {
  const failure = record(value);
  const code = stringValue(failure?.code) || undefined;
  return { message: friendlyErrorMessage(code, 422, 'template'), ...(code ? { code } : {}) };
}

function uniqueStrings(values: unknown[]): string[] {
  const collected = values.map(readableValue).map((value) => value.trim()).filter(Boolean);
  return [...new Set(collected)];
}

function readableValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  const item = record(value);
  if (!item) return '';
  const primary = stringValue(firstValue(item, ['name', 'displayName', 'label', 'family', 'fontFamily', 'value']));
  if (primary) return primary;
  return [
    stringValue(firstValue(item, ['kind', 'type', 'code'])),
    stringValue(firstValue(item, ['part', 'sourcePart', 'path'])),
  ].filter(Boolean).join(' · ');
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
  const [error, setError] = useState<UiFailure | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/projects', { cache: 'no-store' });
      if (!response.ok) throw await errorMessage(response);
      const body = await response.json() as { projects?: Project[] };
      setProjects(body.projects ?? []);
    } catch (err) {
      setError(uiFailure(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    const title = name.trim() || ru.home.genericProject;
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
      if (!response.ok) throw await errorMessage(response);
      const body = await response.json() as { project?: Project };
      if (!body.project?.id) throw new ApplicationUiError({ message: ru.errors.generic, code: 'PROJECT_ID_MISSING' });
      setName('');
      onOpen(body.project.id);
    } catch (err) {
      setError(uiFailure(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <main className="home-shell">
      <header className="home-header">
        <div>
          <div className="eyebrow">{ru.home.eyebrow}</div>
          <h1>{ru.home.title}</h1>
          <p className="lede">{ru.home.lede}</p>
        </div>
      </header>

      <section className="create-panel" aria-label={ru.home.createLabel}>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !creating) void create(); }}
          placeholder={ru.home.createPlaceholder}
          aria-label={ru.home.createLabel}
        />
        <button className="primary" disabled={creating} onClick={() => void create()}>
          {creating ? ru.home.creating : ru.home.create}
        </button>
      </section>

      <ErrorNotice failure={error} className="error-banner" />

      <section className="projects-section">
        <div className="section-heading">
          <h2>{ru.home.projects}</h2>
          <button className="quiet" onClick={() => void load()} disabled={loading}>{ru.home.refresh}</button>
        </div>
        {loading ? <div className="empty-state" role="status">{ru.home.loading}</div> : null}
        {!loading && projects.length === 0 ? (
          <div className="empty-state">{ru.home.empty}</div>
        ) : null}
        <div className="project-grid">
          {projects.map((project) => (
            <button key={project.id} className="project-card" onClick={() => onOpen(project.id)}>
              <span className="project-card-kind">{ru.home.projectKind}</span>
              <strong>{project.name || ru.home.genericProject}</strong>
              <span className="project-card-meta">{project.updatedAt ? ru.home.updated(formatUiDateTime(new Date(project.updatedAt))) : project.id}</span>
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
  const [templateFetching, setTemplateFetching] = useState(false);
  const [templateAnalyzing, setTemplateAnalyzing] = useState(false);
  const [templateError, setTemplateError] = useState<UiFailure | null>(null);
  const [planning, setPlanning] = useState<PlanningResponse | null>(null);
  const [planningLoading, setPlanningLoading] = useState(false);
  const [planningGenerating, setPlanningGenerating] = useState(false);
  const [planningError, setPlanningError] = useState<UiFailure | null>(null);
  const [selectedContentFiles, setSelectedContentFiles] = useState<string[]>([]);
  const [briefAudience, setBriefAudience] = useState('');
  const [briefPurpose, setBriefPurpose] = useState('');
  const [briefExpectedOutcome, setBriefExpectedOutcome] = useState('');
  const [briefContext, setBriefContext] = useState('');
  const [briefPreferences, setBriefPreferences] = useState('');
  const [requestedSlideCount, setRequestedSlideCount] = useState('');
  const [editorText, setEditorText] = useState('');
  const [editorDirty, setEditorDirty] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiFailure | null>(null);
  const [newFileName, setNewFileName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [draftHydrated, setDraftHydrated] = useState(false);
  const draftHydratedRef = useRef(false);
  const [generationComplete, setGenerationComplete] = useState(false);
  const [generationExported, setGenerationExported] = useState(false);
  const filesRef = useRef(files);
  const templateScanRef = useRef(templateScan);
  filesRef.current = files;
  templateScanRef.current = templateScan;

  const loadProject = useCallback(async () => {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { cache: 'no-store' });
    if (!response.ok) throw await errorMessage(response);
    const body = await response.json() as { project?: Project };
    if (!body.project) throw new ApplicationUiError({ message: ru.errors.notFound, code: 'PROJECT_NOT_FOUND', status: 404 });
    setProject(body.project);
  }, [projectId]);

  const loadFiles = useCallback(async () => {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, { cache: 'no-store' });
    if (!response.ok) throw await errorMessage(response);
    const body = await response.json() as { files?: ProjectFile[] };
    const loaded = (body.files ?? []).filter((file) => !file.isDirectory);
    setFiles(loaded);
    return loaded;
  }, [projectId]);

  const loadDesignSystems = useCallback(async () => {
    const response = await fetch('/api/design-systems', { cache: 'no-store' });
    if (!response.ok) return;
    const body = await response.json() as { designSystems?: DesignSystem[] };
    setDesignSystems(body.designSystems ?? []);
  }, []);

  const loadTemplateScan = useCallback(async () => {
    setTemplateFetching(true);
    setTemplateError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/template`, { cache: 'no-store' });
      if (!response.ok) throw await errorMessage(response, 'template');
      const scan = parseTemplateCompileResponse(await response.json());
      setTemplateScan(scan);
      return scan;
    } catch (err) {
      setTemplateError(uiFailure(err, ru.errors.template));
      return null;
    } finally {
      setTemplateFetching(false);
    }
  }, [projectId]);

  const restoreDraft = useCallback((savedPlanning: PlanningResponse | null, loadedFiles?: ProjectFile[], loadedScan?: TemplateCompileResponse | null) => {
    if (typeof window === 'undefined') return;
    let storage: Storage;
    try { storage = window.sessionStorage; }
    catch { return; }
    const currentFiles = loadedFiles ?? filesRef.current;
    const currentScan = loadedScan === undefined ? templateScanRef.current : loadedScan;
    const scanPath = sourcePathOf(currentScan);
    const firstTemplate = currentFiles.find((file) => /\.pptx$/i.test(filePath(file)));
    const selectedTemplate = scanPath ?? (firstTemplate ? filePath(firstTemplate) : null);
    const availablePaths = new Set(currentFiles.map(filePath).filter((path) => path !== selectedTemplate));
    const draft = readWorkspaceDraft(storage, projectId, savedPlanning?.updatedAt, availablePaths);
    if (!draft) return;
    setSelectedContentFiles(draft.selectedContentFiles);
    setBriefAudience(draft.briefAudience);
    setBriefPurpose(draft.briefPurpose);
    setBriefExpectedOutcome(draft.briefExpectedOutcome);
    setBriefContext(draft.briefContext ?? '');
    setBriefPreferences(draft.briefPreferences);
    setRequestedSlideCount(draft.requestedSlideCount);
  }, [projectId]);

  const loadPlanning = useCallback(async () => {
    setPlanningLoading(true);
    setPlanningError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/planning`, { cache: 'no-store' });
      if (!response.ok) throw await errorMessage(response, 'planning');
      const body = await response.json() as PlanningResponse;
      setPlanning(body);
      setSelectedContentFiles(Array.isArray(body.contentFiles) ? body.contentFiles.slice(0, 12) : []);
      const brief = record(body.brief);
      setBriefAudience(stringValue(brief?.audience));
      setBriefPurpose(stringValue(brief?.purpose));
      setBriefExpectedOutcome(stringValue(brief?.expectedOutcome));
      setBriefContext(stringValue(brief?.context));
      setBriefPreferences(Array.isArray(brief?.preferences)
        ? brief.preferences.filter((item): item is string => typeof item === 'string').join('\n')
        : '');
      setRequestedSlideCount(typeof brief?.requestedSlideCount === 'number' ? String(brief.requestedSlideCount) : '');
      if (draftHydratedRef.current) restoreDraft(body);
      return body;
    } catch (err) {
      setPlanningError(uiFailure(err, ru.errors.plan));
      return null;
    } finally {
      setPlanningLoading(false);
    }
  }, [projectId, restoreDraft]);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [, loadedFiles, , loadedScan, savedPlanning] = await Promise.all([
        loadProject(), loadFiles(), loadDesignSystems(), loadTemplateScan(), loadPlanning(),
      ]);
      restoreDraft(savedPlanning, loadedFiles, loadedScan);
      draftHydratedRef.current = true;
      setDraftHydrated(true);
    } catch (err) {
      setError(uiFailure(err));
    }
  }, [loadDesignSystems, loadFiles, loadPlanning, loadProject, loadTemplateScan, restoreDraft]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    if (!draftHydrated || typeof window === 'undefined') return;
    try {
      writeWorkspaceDraft(window.sessionStorage, projectId, {
        selectedContentFiles: selectedContentFiles.slice(0, 12),
        briefAudience,
        briefPurpose,
        briefExpectedOutcome,
        briefContext,
        briefPreferences,
        requestedSlideCount,
      });
    } catch { /* Browser storage can be disabled by policy. */ }
  }, [briefAudience, briefContext, briefExpectedOutcome, briefPreferences, briefPurpose, draftHydrated, projectId, requestedSlideCount, selectedContentFiles]);

  const previewFile = useMemo(() => pickPreviewFile(files, selectedFile), [files, selectedFile]);
  const templateFiles = useMemo(() => files.filter((file) => /\.pptx$/i.test(filePath(file))), [files]);
  const scanSourcePath = sourcePathOf(templateScan);
  const scanSelectionMismatch = Boolean(scanSourcePath && templateFile !== scanSourcePath);
  const visibleTemplateStatus: TemplateCompileStatus | null = scanSelectionMismatch
    ? 'stale'
    : templateScan?.status ?? null;
  const templateBadgeStatus = visibleTemplateStatus ?? (templateAnalyzing ? 'analyzing' : templateFetching ? 'loading' : templateError ? 'unavailable' : 'uncompiled');
  const templateBadgeLabel = templateAnalyzing ? ru.template.analyzing
    : templateFetching ? ru.template.fetching
      : templateStatusLabel(visibleTemplateStatus ?? (templateError ? 'unavailable' : 'uncompiled'));
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
  ];
  const warnings = [
    ...arrayValue(templateIR, ['warnings']),
    ...arrayValue(presentationDesignSystem, ['warnings']),
  ];
  const matchingScan = Boolean(templateIR && !scanSelectionMismatch);
  const excludedPlanningPath = templateFile ?? scanSourcePath;
  const planningSourceFiles = files.filter((file) => filePath(file) !== excludedPlanningPath);
  const availablePlanningPaths = new Set(planningSourceFiles.map(filePath));
  const planningSelectedPaths = selectedContentFiles.filter((path) => availablePlanningPaths.has(path)).slice(0, 12);
  const savedBrief = record(planning?.brief);
  const savedContentFiles = arrayValue(planning, ['contentFiles']).filter((item): item is string => typeof item === 'string');
  const savedPreferences = Array.isArray(savedBrief?.preferences)
    ? savedBrief.preferences.filter((item): item is string => typeof item === 'string').join('\n')
    : '';
  const planningDraftDirty = planning?.status === 'ready' && (
    JSON.stringify([...planningSelectedPaths].sort()) !== JSON.stringify([...savedContentFiles].sort())
    || briefAudience.trim() !== stringValue(savedBrief?.audience)
    || briefPurpose.trim() !== stringValue(savedBrief?.purpose)
    || briefExpectedOutcome.trim() !== stringValue(savedBrief?.expectedOutcome)
    || briefContext.trim() !== stringValue(savedBrief?.context)
    || normalizePreferenceLines(briefPreferences) !== normalizePreferenceLines(savedPreferences)
    || requestedSlideCount.trim() !== (typeof savedBrief?.requestedSlideCount === 'number' ? String(savedBrief.requestedSlideCount) : '')
  );
  const savedPlanReady = planning?.status === 'ready' && !planningDraftDirty;
  const planningDeckPlan = record(planning?.deckPlan);
  const planningSlides = arrayValue(planningDeckPlan, ['slides']);
  const contentIR = record(planning?.contentIR);
  const contentSourceStatusByPath = new Map(arrayValue(contentIR, ['sources']).flatMap((source) => {
    const item = record(source);
    const sourcePath = stringValue(firstValue(item, ['sourcePath']));
    if (!sourcePath) return [];
    const kind = firstValue(item, ['kind']);
    const warnings = arrayValue(item, ['warnings']).map((warning) => ({ code: stringValue(firstValue(record(warning), ['code'])) }));
    const status = planning?.status === 'ready'
      ? contentSourceStatus({
        kind: kind === 'text' || kind === 'image' || kind === 'unsupported' ? kind : 'unsupported',
        warnings,
      })
      : 'not-parsed';
    return [[sourcePath, status] as const];
  }));
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
      setPlanningError({ message: ru.validation.maxFiles });
      return;
    }
    setSelectedContentFiles([...validCurrent, path]);
  };

  const generatePlan = async () => {
    setPlanningError(null);
    if (planningSelectedPaths.length > 12) {
      setPlanningError({ message: ru.validation.filesRange });
      return;
    }
    if (!briefPurpose.trim()) {
      setPlanningError({ message: ru.validation.briefRequired });
      return;
    }
    const count = requestedSlideCount.trim() ? Number(requestedSlideCount) : undefined;
    if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 30)) {
      setPlanningError({ message: ru.validation.slideCount });
      return;
    }
    const preferences = normalizePreferenceLines(briefPreferences).split('\n').filter(Boolean);
    if (preferences.length > 12 || preferences.some((item) => item.length > 200)) {
      setPlanningError({ message: ru.validation.preferences });
      return;
    }
    const brief = {
      audience: briefAudience.trim(),
      purpose: briefPurpose.trim(),
      expectedOutcome: briefExpectedOutcome.trim(),
      context: briefContext.trim(),
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
      if (!response.ok) throw await errorMessage(response, 'planning');
      const body = await response.json() as PlanningResponse;
      setPlanning(body);
      setSelectedContentFiles(Array.isArray(body.contentFiles) ? body.contentFiles.slice(0, 12) : planningSelectedPaths);
      try { if (typeof window !== 'undefined') clearWorkspaceDraft(window.sessionStorage, projectId); }
      catch { /* Saved planning state is on the server even if browser storage is unavailable. */ }
    } catch (err) {
      await loadPlanning();
      setPlanningError(uiFailure(err, ru.errors.plan));
    } finally {
      setPlanningGenerating(false);
    }
  };

  const analyzeTemplate = async () => {
    if (!templateFile) return;
    setTemplateAnalyzing(true);
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
        const failure = record(failed?.failure);
        const code = stringValue(failure?.code) || undefined;
        throw new ApplicationUiError({ message: friendlyErrorMessage(code, response.status, 'template'), ...(code ? { code } : {}), status: response.status });
      }
      setTemplateScan(parseTemplateCompileResponse(body));
      await loadPlanning();
    } catch (err) {
      setTemplateError(uiFailure(err, ru.errors.template));
      await loadPlanning();
    } finally {
      setTemplateAnalyzing(false);
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
        if (!response.ok) throw await errorMessage(response, 'file');
        const text = await response.text();
        if (!cancelled) {
          setEditorText(text);
          setEditorDirty(false);
        }
      } catch (err) {
        if (!cancelled) setError(uiFailure(err, ru.errors.fileRead));
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
      if (!response.ok) throw await errorMessage(response);
      setEditorDirty(false);
      await loadFiles();
      await refreshPreview();
      await loadPlanning();
    } catch (err) {
      setError(uiFailure(err));
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
        body: JSON.stringify({ name, content: name.endsWith('.html') ? `<!doctype html>\n<html>\n<head><meta charset="utf-8"><title>${ru.workspace.newHtmlTitle}</title></head>\n<body></body>\n</html>\n` : '' }),
      });
      if (!response.ok) throw await errorMessage(response);
      setNewFileName('');
      await loadFiles();
      setSelectedFile(name);
    } catch (err) {
      setError(uiFailure(err));
    } finally {
      setBusy(false);
    }
  };

  const upload = async (incoming: FileList | null) => {
    if (!incoming?.length) return;
    const incomingFiles = Array.from(incoming);
    const uploadedFiles: ProjectFile[] = [];
    setBusy(true);
    setUploading(true);
    setError(null);
    try {
      for (let offset = 0; offset < incomingFiles.length; offset += 2) {
        const form = new FormData();
        for (const file of incomingFiles.slice(offset, offset + 2)) form.append('files', file);
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/upload`, { method: 'POST', body: form });
        if (!response.ok) throw await errorMessage(response, 'upload');
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
      setError(uiFailure(err));
    } finally {
      if (uploadRef.current) uploadRef.current.value = '';
      setBusy(false);
      setUploading(false);
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
      if (!response.ok) throw await errorMessage(response);
      const body = await response.json() as { project?: Project };
      if (body.project) setProject(body.project);
    } catch (err) {
      setError(uiFailure(err));
    } finally {
      setBusy(false);
    }
  };

  const reportGenerationState = useCallback((complete: boolean, exported: boolean) => {
    setGenerationComplete(complete);
    setGenerationExported(exported);
  }, []);

  if (!project && !error) return <div className="boot-state" role="status">{ru.workspace.boot}</div>;

  return (
    <main className="workspace-shell">
      <header className="workspace-topbar">
        <button className="quiet" onClick={onBack}>{ru.workspace.back}</button>
        <div className="project-title-block">
          <span className="eyebrow">{ru.workspace.eyebrow}</span>
          <strong>{project?.name ?? projectId}</strong>
        </div>
        <div className="topbar-actions">
          <button className="quiet" onClick={() => void reload()}>{ru.workspace.reload}</button>
          <button className="primary" onClick={() => uploadRef.current?.click()} disabled={busy}>{ru.workspace.addSources}</button>
          <input ref={uploadRef} className="visually-hidden" type="file" multiple aria-label={ru.workspace.addSources} onChange={(event) => void upload(event.target.files)} />
        </div>
      </header>

      <ErrorNotice failure={error} className="error-banner workspace-error" />
      {uploading ? <p className="workspace-operation-status" role="status" aria-live="polite">{ru.workspace.uploading}</p> : null}

      <nav className="workspace-stages" aria-label={ru.workspace.stagesLabel}>
        <a href="#template-panel" data-complete={visibleTemplateStatus === 'ready'}>{ru.workspace.templateStage}</a>
        <a href="#planning-panel" data-complete={planningSourceFiles.length > 0}>{ru.workspace.contentStage}</a>
        <a href="#planning-panel" data-complete={savedPlanReady}>{ru.workspace.planStage}</a>
        <a href="#generation-panel" data-complete={generationComplete}>{ru.workspace.generateStage}</a>
        <a href="#generation-review" data-complete={generationExported}>{ru.workspace.reviewStage}</a>
      </nav>

      <section className="template-panel" id="template-panel" aria-labelledby="template-panel-title">
        <div className="template-panel-head">
          <div>
          <span className="eyebrow">{ru.template.eyebrow}</span>
            <h2 id="template-panel-title">{ru.template.title}</h2>
            <p>{ru.template.description}</p>
          </div>
          <span className={`template-status status-${templateBadgeStatus}`} role="status">
            {templateBadgeLabel}
          </span>
        </div>

        <div className="template-toolbar">
          <label htmlFor="template-source">{ru.template.sourceLabel}</label>
          <select
            id="template-source"
            value={templateFile ?? ''}
            onChange={(event) => setTemplateFile(event.target.value || null)}
            disabled={templateFiles.length === 0 || templateFetching || templateAnalyzing}
          >
            {templateFiles.length === 0 ? <option value="">{ru.template.uploadFirst}</option> : null}
            {templateFiles.map((file) => {
              const path = filePath(file);
              return <option key={path} value={path}>{path}</option>;
            })}
          </select>
          <button className="primary" onClick={() => void analyzeTemplate()} disabled={!templateFile || busy || templateFetching || templateAnalyzing}>
            {templateAnalyzing ? ru.template.analyzing : ru.template.analyze}
          </button>
          {templateScan?.compiledAt ? <span className="template-compiled-at">{ru.template.lastScan(formatUiDateTime(new Date(templateScan.compiledAt)))}</span> : null}
        </div>

        <p className="template-scope-note">{ru.template.scope}</p>
        <ErrorNotice failure={templateError} className="error-banner template-error" />

        {visibleTemplateStatus === 'uncompiled' ? (
          <div className="template-message">{ru.template.chooseAndAnalyze}</div>
        ) : null}
        {visibleTemplateStatus === 'stale' ? (
          <div className="template-message template-message-warning">
            {scanSelectionMismatch
              ? ru.template.staleOtherFile(scanSourcePath ?? '', templateFile ?? ru.workspace.selectedFileFallback)
              : ru.template.staleChangedFile}
          </div>
        ) : null}
        {visibleTemplateStatus === 'failed' ? (
          <ErrorNotice failure={templateFailureInfo(templateScan?.failure)} className="template-message template-message-warning" role="status" />
        ) : null}
        {!templateFetching && !templateAnalyzing && !templateScan && templateError ? (
          <div className="template-message template-message-warning">{ru.template.scanUnavailable}</div>
        ) : null}

        {matchingScan && templateIR ? (
          <div className="template-report">
            <div className="template-source-line">
              <span>{ru.template.scannedFile}</span>
              <strong>{stringValue(firstValue(templateScan?.source, ['originalName', 'filePath']), scanSourcePath ?? ru.template.sourceNotReported)}</strong>
            </div>

            <div className="template-metrics">
              <div className="template-metric"><span>{ru.template.canvas}</span><strong>{formatCanvasDimensions(width, height, firstValue(slideSize, ['unit']))} · {formatAspectRatio(width, height, firstValue(canvas, ['aspectRatio']))}</strong></div>
              <div className="template-metric"><span>{ru.template.slides}</span><strong>{countLabel(templateIR, ['slides'], ['slideCount', 'summary.slideCount'])}</strong></div>
              <div className="template-metric"><span>{ru.template.masters}</span><strong>{countLabel(templateIR, ['masters'], ['masterCount', 'summary.masterCount'])}</strong></div>
              <div className="template-metric"><span>{ru.template.layouts}</span><strong>{countLabel(presentationDesignSystem, ['layouts'], [])}</strong></div>
            </div>

            <div className="template-observations">
              <section className="template-observation-block">
                <div className="template-block-heading">
                  <h3>{ru.template.observedTitle}</h3>
                  <span>{themeName || (theme ? ru.template.themeData : ru.template.noThemeName)}</span>
                </div>
                <strong className="template-subheading">{ru.template.observedFonts}</strong>
                <div className="template-chip-list">
                  {fonts.length ? fonts.map((font) => <span className="template-chip" key={font}>{font}</span>) : <span className="template-muted">{ru.template.noFonts}</span>}
                </div>
                <strong className="template-subheading">{ru.template.observedSizes}</strong>
                <div className="template-chip-list">
                  {fontSizes.length ? fontSizes.map((size) => <span className="template-chip" key={size}>{size} pt</span>) : <span className="template-muted">{ru.template.noFontSizes}</span>}
                </div>
                <strong className="template-subheading">{ru.template.themeFonts}</strong>
                <div className="template-chip-list">
                  {themeFontEntries.length ? themeFontEntries.map((entry) => (
                    <span className="template-chip" key={entry.role}>{entry.role === 'Major' ? ru.template.majorFont : entry.role === 'Minor' ? ru.template.minorFont : entry.role}: {entry.font}</span>
                  )) : <span className="template-muted">{ru.template.noThemeFonts}</span>}
                </div>
                <strong className="template-subheading">{ru.template.directPalette}</strong>
                <div className="template-chip-list template-palette-list">
                  {directColors.length ? directColors.map((color, index) => (
                    <span className="template-chip template-color-chip" key={`${color.label}-${index}`}>
                      <i aria-hidden="true" style={safeColor(color.value) ? { backgroundColor: safeColor(color.value) as string } : undefined} />
                      <span>{color.label}</span>
                      <code>{color.value}</code>
                    </span>
                  )) : <span className="template-muted">{ru.template.noPalette}</span>}
                </div>
                {themeColors.length ? <p className="template-theme-colors">{ru.template.themeColors}: {themeColors.map((color) => `${color.label}: ${color.value}`).join(' · ')}</p> : null}
              </section>

              <section className="template-observation-block">
                <div className="template-block-heading">
                  <h3>{ru.template.assets}</h3>
                  <span>{ru.template.assetCount(templateAssets.length || reusableAssets.length)}</span>
                </div>
                {templateAssets.length || reusableAssets.length ? (
                  <div className="template-asset-list">
                    {Object.entries((templateAssets.length ? templateAssets : reusableAssets).reduce<Record<string, number>>((counts, asset) => {
                      const kind = stringValue(firstValue(asset, ['kind', 'type', 'contentType']), ru.template.unclassified);
                      counts[kind] = (counts[kind] ?? 0) + 1;
                      return counts;
                    }, {})).map(([kind, count]) => <span key={kind}>{kind}<strong>{count}</strong></span>)}
                  </div>
                ) : <p className="template-muted">{ru.template.noAssets}</p>}
              </section>
            </div>

            <section className="template-layout-section">
              <div className="template-block-heading">
                <div><span className="eyebrow">{ru.template.inventory}</span><h3>{ru.template.layouts}</h3></div>
                <span>{ru.template.layoutCount(layouts.length)}</span>
              </div>
              {layouts.length ? (
                <div className="template-layout-grid">
                  {layouts.map((entry, index) => {
                    const layout = record(entry);
                    if (!layout) return null;
                    const title = stringValue(firstValue(layout, ['matchingName', 'declaredName', 'name', 'title']), ru.template.layoutUnknown(index + 1));
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
                          <span className="template-usage">{typeof usageCount === 'number' ? ru.template.usage(usageCount) : ru.template.usageUnknown}</span>
                        </div>
                        {layoutPart ? <code className="template-layout-part">{layoutPart}</code> : null}
                        <strong className="template-subheading">{ru.template.placeholderComposition}</strong>
                        <div className="template-chip-list">
                          {roles.length ? roles.map((role, roleIndex) => <span className="template-chip" key={`${role}-${roleIndex}`}>{role}</span>) : <span className="template-muted">{ru.template.noPlaceholders}</span>}
                        </div>
                        {elementCounts && Object.keys(elementCounts).length ? (
                          <div className="template-element-counts">
                          {typeof totalElements === 'number' ? <span>{ru.template.total}<strong>{totalElements}</strong></span> : null}
                          {Object.entries(elementKinds).map(([kind, count]) => <span key={kind}>{kind}<strong>{stringValue(count, '—')}</strong></span>)}
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              ) : <div className="template-message">{ru.template.noLayoutDetails}</div>}
            </section>

            <section className="template-notes-section">
              <h3>{ru.template.unsupported}</h3>
              {unsupported.length || warnings.length ? (
                <details>
                  <summary>{ru.template.diagnosticLabel} · {unsupported.length + warnings.length}</summary>
                  <ul>
                    {unsupported.length ? <li>{ru.template.unsupportedSummary(unsupported.length)}</li> : null}
                    {warnings.length ? <li>{ru.template.warningSummary(warnings.length)}</li> : null}
                  </ul>
                </details>
              ) : <p className="template-muted">{ru.template.noUnsupported}</p>}
            </section>
          </div>
        ) : null}
      </section>

      <section className="planning-panel" id="planning-panel" aria-labelledby="planning-panel-title">
        <div className="planning-panel-head">
          <div>
            <span className="eyebrow">{ru.planning.eyebrow}</span>
            <h2 id="planning-panel-title">{ru.planning.title}</h2>
            <p>{ru.planning.description}</p>
          </div>
          <div className="planning-head-actions">
            <span className={`planning-status planning-status-${planningGenerating ? 'generating' : planningDraftDirty ? 'stale' : planning?.status ?? 'loading'}`} role="status">
              {planningLoading ? ru.planning.loading : planningGenerating ? ru.planning.understanding : planningStatusLabel(planningDraftDirty ? 'stale' : planning?.status)}
            </span>
            <button className="quiet" onClick={() => void loadPlanning()} disabled={planningLoading || planningGenerating}>{ru.planning.reload}</button>
          </div>
        </div>

        {planning?.templateStatus !== 'ready' || !matchingScan ? (
          <div className="planning-notice" role="status">
            {ru.planning.analyzeTemplateFirst}
          </div>
        ) : null}
        {planningLoading && !planning ? <div className="planning-notice" role="status">{ru.planning.loading}</div> : null}
        <ErrorNotice failure={planningError} className="error-banner planning-error" />
        {planning?.status === 'stale' ? <div className="planning-notice planning-notice-warning" role="status">{ru.planning.stale}</div> : null}
        {planningDraftDirty ? <div className="planning-notice planning-notice-warning" role="status">{ru.planning.draftChanged}</div> : null}
        {planningFailure?.message ? <ErrorNotice role="status" className="planning-notice planning-notice-warning" failure={{
          message: friendlyErrorMessage(stringValue(planningFailure.code), 422, 'planning'),
          ...(planningFailure.code ? { code: stringValue(planningFailure.code) } : {}),
        }} /> : null}

        <div className="planning-form-grid">
          <fieldset className="planning-file-picker">
            <legend>{ru.planning.sourceFiles} <span>{ru.planning.selected(planningSelectedPaths.length)}</span></legend>
            {planningSourceFiles.length ? (
              <div className="planning-file-list">
                {planningSourceFiles.map((file) => {
                  const path = filePath(file);
                  const sourceStatus = contentSourceStatusByPath.get(path) as ContentSourceStatus | undefined ?? 'not-parsed';
                  return (
                    <label className="planning-file-option" key={path} title={path}>
                      <input
                        type="checkbox"
                        checked={planningSelectedPaths.includes(path)}
                        onChange={(event) => togglePlanningFile(path, event.target.checked)}
                        disabled={planningGenerating || (!planningSelectedPaths.includes(path) && planningSelectedPaths.length >= 12)}
                      />
                      <span>{path}</span>
                      <small className="content-source-status" data-status={sourceStatus} aria-label={`${contentSourceStatusLabel(sourceStatus)}: ${path}`}>
                        {contentSourceStatusLabel(sourceStatus)}
                      </small>
                      <small>{formatBytes(file.size)}</small>
                    </label>
                  );
                })}
              </div>
            ) : <p className="planning-muted">{ru.planning.uploadSources}</p>}
          </fieldset>

          <div className="planning-brief">
            <label>{ru.planning.audience}
              <input maxLength={500} value={briefAudience} onChange={(event) => setBriefAudience(event.target.value)} disabled={planningGenerating} placeholder={ru.planning.audiencePlaceholder} />
            </label>
            <label>{ru.planning.purpose}
              <textarea maxLength={1000} value={briefPurpose} onChange={(event) => setBriefPurpose(event.target.value)} disabled={planningGenerating} rows={2} placeholder={ru.planning.purposePlaceholder} />
            </label>
            <label>{ru.planning.outcome}
              <textarea maxLength={1000} value={briefExpectedOutcome} onChange={(event) => setBriefExpectedOutcome(event.target.value)} disabled={planningGenerating} rows={2} placeholder={ru.planning.outcomePlaceholder} />
            </label>
            <label>{ru.planning.context}
              <textarea maxLength={16_000} value={briefContext} onChange={(event) => setBriefContext(event.target.value)} disabled={planningGenerating} rows={3} placeholder={ru.planning.contextPlaceholder} />
            </label>
            <label>{ru.planning.preferences} <span className="planning-label-note">{ru.planning.perLine}</span>
              <textarea value={briefPreferences} onChange={(event) => setBriefPreferences(event.target.value)} disabled={planningGenerating} rows={2} placeholder={ru.planning.preferencesPlaceholder} />
            </label>
            <label className="planning-slide-count">{ru.planning.slideCount} <span className="planning-label-note">{ru.planning.optionalRange}</span>
              <input type="number" min="1" max="30" step="1" value={requestedSlideCount} onChange={(event) => setRequestedSlideCount(event.target.value)} disabled={planningGenerating} placeholder={ru.planning.automatic} />
            </label>
            <div className="planning-submit-row">
              <span className="planning-muted">{ru.planning.requires}</span>
              <button className="primary" onClick={() => void generatePlan()} disabled={planningGenerating || planningLoading || templateFetching || templateAnalyzing || planning?.templateStatus !== 'ready' || !matchingScan || !briefPurpose.trim()}>
                {planningGenerating ? ru.planning.generating : ru.planning.generate}
              </button>
            </div>
          </div>
        </div>

        {planningWarnings.length ? (
          <details className="planning-warnings"><summary>{ru.planning.sourceWarningCount(planningWarnings.length)}</summary><p>{ru.planning.sourceWarningSummary}</p></details>
        ) : null}

        {planningDeckPlan ? (
          <section className="planning-result" aria-labelledby="planning-result-title">
            <div className="planning-result-head">
              <div>
                <span className="eyebrow">{ru.planning.generated}</span>
                <h3 id="planning-result-title">{stringValue(planningDeckPlan.workingTitle, ru.planning.generatedTitle)}</h3>
                <p>{stringValue(planningDeckPlan.narrativeSummary)}</p>
              </div>
              {planning?.updatedAt ? <span className="planning-updated">{ru.planning.planUpdated(formatUiDateTime(new Date(planning.updatedAt)))}</span> : null}
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
                      <span>{ru.planning.narrativeRole(stringValue(firstValue(item, ['narrativeRole']), 'slide'))}</span>
                    </div>
                    <h4>{stringValue(firstValue(item, ['purpose']), ru.planning.purposeUnknown)}</h4>
                    <p className="planning-takeaway">{stringValue(firstValue(item, ['takeaway']), ru.planning.takeawayUnknown)}</p>
                    <div className="planning-slide-meta">
                      <span>{ru.planning.visualType(stringValue(firstValue(item, ['semanticVisualType']), 'unknown'))}</span>
                      <span>{ru.planning.density(stringValue(firstValue(item, ['targetDensity']), 'unknown'))}</span>
                    </div>
                    <div className="planning-source-paths">
                      <strong>{ru.planning.sources}</strong>
                      {paths.length ? paths.map((path) => <span key={path} title={path}>{path}</span>) : <span>{ru.planning.noSource}</span>}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}

        {planningReview ? (
          <section className="planning-review" aria-label={ru.planning.reviewLabel}>
            <div className="planning-review-head">
              <h3>{ru.planning.reviewLabel}</h3>
              <span className={`planning-review-outcome outcome-${stringValue(planningReview.outcome, 'unknown')}`}>
                {ru.planning.reviewOutcome(stringValue(planningReview.outcome, 'unknown'))}
              </span>
            </div>
            {planningFindings.length ? (
              <ul>{planningFindings.map((finding, index) => {
                const item = record(finding);
                return <li key={`finding-${index}`}>
                  <span className={`finding-severity severity-${stringValue(firstValue(item, ['severity']), 'unknown')}`}>{ru.planning.findingSeverity(stringValue(firstValue(item, ['severity']), 'unknown'))}</span>
                  <span>{ru.planning.findingSummary(stringValue(firstValue(item, ['targetType']), 'slide'))}</span>
                  <small>{ru.planning.targetType(stringValue(firstValue(item, ['targetType']), 'deck'))}</small>
                </li>;
              })}</ul>
            ) : <p className="planning-muted">{ru.planning.noPlanFindings}</p>}
          </section>
        ) : null}
      </section>

      <PresentationGenerationPanel
        projectId={projectId}
        planningReady={savedPlanReady}
        inputFingerprint={planning?.inputFingerprint ?? null}
        planHash={stringValue(firstValue(planningDeckPlan, ['hash']))}
        contentIRHash={stringValue(firstValue(contentIR, ['hash']))}
        templateIRHash={stringValue(firstValue(templateIR, ['hash']))}
        onStateChange={reportGenerationState}
      />

      <div className="workspace-grid">
        <aside className="workspace-sidebar">
          <section className="sidebar-section">
            <div className="sidebar-heading"><span>{ru.workspace.files}</span><span>{files.length}</span></div>
            <div className="new-file-row">
              <input aria-label={ru.workspace.newFile} value={newFileName} onChange={(event) => setNewFileName(event.target.value)} placeholder={ru.workspace.newFile} />
              <button className="quiet compact" aria-label={ru.workspace.createFile} title={ru.workspace.createFile} onClick={() => void createTextFile()} disabled={busy || !newFileName.trim()}>+</button>
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
              {files.length === 0 ? <div className="sidebar-empty">{ru.workspace.emptyFiles}</div> : null}
            </div>
          </section>

          <section className="sidebar-section design-system-section">
            <label className="sidebar-heading" htmlFor="design-system"><span>{ru.workspace.designSystem}</span></label>
            <select id="design-system" value={project?.designSystemId ?? ''} onChange={(event) => void applyDesignSystem(event.target.value)} disabled={busy}>
              <option value="">{ru.workspace.unspecified}</option>
              {designSystems.map((system) => <option key={system.id} value={system.id}>{ru.workspace.designSystemLabel(system.displayName || system.name || system.id)}</option>)}
            </select>
            <p className="sidebar-note">{ru.workspace.designSystemNote}</p>
          </section>
        </aside>

        <section className="preview-panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">{ru.workspace.livePreview}</span>
              <strong>{previewFile ?? ru.workspace.noHtml}</strong>
            </div>
            <button className="quiet" onClick={() => void refreshPreview()} disabled={!previewFile}>{ru.home.refresh}</button>
          </div>
          <div className="preview-stage">
            {previewUrl ? (
                <iframe key={previewUrl} title={ru.workspace.previewTitle} src={previewUrl} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
            ) : (
              <div className="preview-empty">
                <strong>{ru.workspace.noDeck}</strong>
                <span>{ru.workspace.previewHint}</span>
              </div>
            )}
          </div>
        </section>

        <section className="editor-panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">{ru.workspace.sourceEdit}</span>
              <strong>{selectedFile ?? ru.workspace.selectFile}</strong>
            </div>
            {selectedFile && isTextFile(selectedFile) ? (
              <button className="primary" onClick={() => void saveText()} disabled={busy || !editorDirty}>{busy ? ru.workspace.saving : ru.workspace.save}</button>
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
              {selectedFile ? ru.workspace.binary : ru.workspace.editorHint}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function PresentationGenerationPanel({ projectId, planningReady, inputFingerprint, planHash, contentIRHash, templateIRHash, onStateChange }: {
  projectId: string;
  planningReady: boolean;
  inputFingerprint: string | null;
  planHash: string;
  contentIRHash: string;
  templateIRHash: string;
  onStateChange: (complete: boolean, exported: boolean) => void;
}) {
  const [generation, setGeneration] = useState<GenerationState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<UiFailure | null>(null);
  const generationRef = useRef<GenerationState | null>(null);
  const idempotencyRef = useRef<string | null>(null);
  const activeRef = useRef(false);
  const matchesCurrentInputs = (state: GenerationState | null) => Boolean(state && inputFingerprint && planHash && contentIRHash && templateIRHash
    && state.inputFingerprint && state.planHash === planHash && state.contentIRHash === contentIRHash
    && state.templateIRHash === templateIRHash);

  useEffect(() => {
    if (generation && !matchesCurrentInputs(generation)) idempotencyRef.current = null;
  }, [generation?.generationId, generation?.status, inputFingerprint, planHash, contentIRHash, templateIRHash]);

  useEffect(() => {
    const isCurrent = matchesCurrentInputs(generation);
    onStateChange(Boolean(isCurrent && generation?.status === 'completed'), Boolean(isCurrent && generation?.exports.length));
  }, [contentIRHash, generation?.exports.length, generation?.generationId, generation?.status, inputFingerprint, onStateChange, planHash, templateIRHash]);

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
      if (!response.ok) throw await errorMessage(response);
      const body = await response.json() as { generation?: GenerationState | null };
      apply(body.generation ?? null);
      setError(null);
    } catch (err) {
      setError(uiFailure(err, ru.errors.render));
    } finally {
      setLoading(false);
    }
  }, [apply, projectId]);

  useEffect(() => { void load(); }, [load, projectId]);

  useEffect(() => {
    if (!generation || !activeRef.current) return;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      await load();
      if (!disposed && activeRef.current) timer = window.setTimeout(() => void poll(), 850);
    };
    timer = window.setTimeout(() => void poll(), 850);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [generation?.generationId, generation?.status, load, projectId]);

  const request = async (url: string, init: RequestInit = {}) => {
    const response = await fetch(url, init);
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      throw await errorMessage(new Response(JSON.stringify(body), { status: response.status }), 'generation');
    }
    return body ?? {};
  };

  const withBusy = async (key: string, operation: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try { await operation(); }
    catch (err) { setError(uiFailure(err, ru.errors.render)); }
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

  const exportDeck = (mode: 'selected' | GenerationVariantId, format: 'pptx' | 'pdf' | 'html') => {
    void withBusy(`export-${mode}-${format}`, async () => {
      const body = await request(`/api/projects/${encodeURIComponent(projectId)}/generation/export`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, format }),
      }) as { state?: GenerationState };
      if (body.state) apply(body.state);
    });
  };

  const isActive = generation?.status === 'preparing' || generation?.status === 'generating';
  const currentGeneration = matchesCurrentInputs(generation);
  const canExport = currentGeneration && generation?.status === 'completed' && generation.readySlides === generation.totalSlides;
  const canChooseTrack = Boolean(generation?.slides.length) && generation!.slides.every((pack) => pack.status === 'ready'
    && ['A', 'B', 'C'].every((variant) => pack.variants[variant as GenerationVariantId]?.status === 'ready'));

  return (
    <section className="generation-panel" id="generation-panel" aria-labelledby="generation-panel-title">
      <div className="generation-panel-head">
        <div>
          <span className="eyebrow">{ru.generation.eyebrow}</span>
          <h2 id="generation-panel-title">{ru.generation.title}</h2>
          <p>{ru.generation.description}</p>
        </div>
        <div className="generation-actions">
          {isActive ? <button className="quiet" onClick={() => void cancel()} disabled={Boolean(busy)}>{ru.generation.cancel}</button>
            : <button className="primary" onClick={() => void start()} disabled={!planningReady || loading || Boolean(busy) || currentGeneration && (generation?.status === 'completed' || generation?.status === 'cancelled')}>
              {currentGeneration && generation?.status === 'failed' ? ru.generation.resume : currentGeneration && generation?.status === 'completed' ? ru.generation.generated : ru.generation.generate}
            </button>}
          <span className={`generation-status generation-status-${generation?.status ?? 'idle'}`} role="status">
            {loading ? ru.generation.loading : generation?.status === 'completed' && !currentGeneration ? ru.planning.planChanged : generation ? generationStatusLabel(generation.status) : planningReady ? ru.planning.readyToGenerate : ru.planning.waiting}
          </span>
        </div>
      </div>

      {!planningReady ? <p className="generation-notice">{ru.generation.incompletePlan}</p> : null}
      <ErrorNotice failure={error} className="generation-error" />
      {generation?.failure ? <ErrorNotice role="status" className="generation-notice" failure={{
        message: friendlyErrorMessage(generation.failure.code, 500, 'generation'), code: generation.failure.code,
      }} /> : null}

      {generation ? <>
        <div className="generation-progress-row" role="status" aria-live="polite">
          <strong>{ru.generation.slideProgress(generation.readySlides, generation.totalSlides)}</strong>
          <span>{generation.currentSlideId ? ru.generation.workingOnSlide(generation.slides.find((pack) => pack.slideId === generation.currentSlideId)?.index) : generationStatusLabel(generation.status)}</span>
        </div>
        <div className="generation-track-picker" role="group" aria-label={ru.generation.defaultTrack}>
          <span>{ru.generation.defaultTrack}</span>
          {(['A', 'B', 'C'] as const).map((variant) => <button key={variant} className={generation.defaultTrack === variant ? 'active' : ''}
            aria-pressed={generation.defaultTrack === variant} disabled={!canChooseTrack || Boolean(busy)} onClick={() => chooseTrack(variant)}>
            {ru.generation.track(variant, variant === 'A')}
          </button>)}
        </div>
        <div className="generation-slide-list">
          {generation.slides.map((pack) => <article className="generation-slide-card" key={pack.slideId} aria-labelledby={`generation-slide-${pack.index}`}>
            <div className="generation-slide-heading">
              <div><span>{ru.generation.slide(String(pack.index).padStart(2, '0'))}</span><h3 id={`generation-slide-${pack.index}`}>{pack.title}</h3></div>
              <div className={`generation-pack-status pack-status-${pack.status}`} role="status">{slidePackStatusLabel(pack.status, pack.failure?.code)}</div>
            </div>
            {pack.failure?.code === 'VARIANTS_NOT_DISTINCT' ? <p className="generation-notice" role="status">{ru.generation.withheldReason}</p> : null}
            <div className="generation-variants">
              {(['A', 'B', 'C'] as const).map((variant) => {
                const item = pack.variants[variant];
                const audit = item.audit?.findings ?? [];
                const unavailablePack = pack.failure?.code === 'VARIANTS_NOT_DISTINCT';
                const visibleVariantStatus = unavailablePack ? 'withheld' : item.status;
                const variantReady = pack.status === 'ready' && item.status === 'ready';
                return <section className={`generation-variant ${pack.selectedVariant === variant ? 'selected' : ''}`} key={variant} aria-label={ru.generation.slideVariantLabel(pack.index, variant)}>
                  <div className="generation-variant-heading">
                    <strong>{ru.generation.variant(variant)}</strong>
                    {pack.recommendedVariant === variant ? <span className="recommended-mark">{ru.generation.recommended}</span> : null}
                    {pack.lockedVariant === variant ? <span className="locked-mark">{ru.generation.locked(variant)}</span> : null}
                    <span className="variant-status" data-status={visibleVariantStatus}>{variantStatusLabel(visibleVariantStatus)}</span>
                  </div>
                  {item.previewUrl ? <img className="generation-preview" src={`${item.previewUrl}?v=${item.version}`} alt={ru.generation.previewAlt(pack.index, variant)} />
                    : <div className="generation-preview-empty" role="status">{unavailablePack ? ru.generation.withheldReason : pack.status === 'rendering' ? ru.generation.preparingPreview : item.status === 'failed' ? ru.generation.noPreview : variantStatusLabel(item.status)}</div>}
                  <div className="generation-variant-meta">
                    <span>{item.visualSlotStatus === 'not-applicable' ? ru.generation.textSlide : ru.generation.visual(ru.status[item.visualSlotStatus as keyof typeof ru.status] ?? ru.status.unknown)}</span>
                    {item.layoutIssueCount ? <span>{ru.generation.layoutNotes(item.layoutIssueCount)}</span> : null}
                    <span>{ru.generation.auditCounts(audit.length)}</span>
                  </div>
                  <button className={pack.selectedVariant === variant ? 'primary generation-select' : 'quiet generation-select'}
                    aria-pressed={pack.selectedVariant === variant} disabled={!variantReady || Boolean(busy)}
                    onClick={() => chooseSlide(pack, variant)}>
                    {pack.selectedVariant === variant ? ru.generation.selected(variant) : ru.generation.choose(variant)}
                  </button>
                </section>;
              })}
            </div>
            <div className="generation-slide-footer">
              <span className="generation-audit-badge" data-errors={pack.auditSummary.errors > 0} aria-label={ru.generation.audit}>
                {ru.generation.auditSummary(pack.auditSummary.errors, pack.auditSummary.warnings)}
              </span>
              <button className="quiet" disabled={pack.status !== 'ready' || Boolean(busy)} onClick={() => toggleLock(pack)}>
                {pack.lockedVariant ? ru.generation.unlock(pack.lockedVariant) : ru.generation.lock(pack.selectedVariant)}
              </button>
              <details className="generation-audit" id={pack.index === 1 ? 'generation-review' : undefined}>
                <summary>{ru.generation.audit}</summary>
                {pack.variants[pack.selectedVariant].audit?.findings?.length ? <ul>
                  {pack.variants[pack.selectedVariant].audit?.findings?.map((findingValue, index) => {
                    const finding = record(findingValue);
                    const findingId = stringValue(firstValue(finding, ['id']));
                    const rule = stringValue(firstValue(finding, ['ruleId']), 'audit');
                    const safeFix = firstValue(finding, ['autofixAvailable']) === true;
                    return <li key={`${findingId}-${index}`}>
                      <span>{auditFindingMessage(rule)}</span>
                      {safeFix ? <button className="quiet compact" disabled={Boolean(busy)} onClick={() => repair(pack, pack.selectedVariant, findingId)}>{ru.generation.applyFix}</button> : <small>{ru.generation.replan}</small>}
                    </li>;
                  })}
                </ul> : <p>{ru.generation.noAuditFindings}</p>}
              </details>
            </div>
            {pack.failure && pack.failure.code !== 'VARIANTS_NOT_DISTINCT' ? <ErrorNotice role="status" className="generation-notice" failure={{
              message: friendlyErrorMessage(pack.failure.code, 422, 'generation'), code: pack.failure.code,
            }} /> : null}
          </article>)}
        </div>

        <section className="generation-export" aria-labelledby="generation-export-title">
          <div><span className="eyebrow">{ru.generation.exportTitle}</span><h3 id="generation-export-title">{ru.generation.exportHeading}</h3>
            <p>{ru.generation.exportDescription}</p></div>
          <div className="generation-export-actions">
            {(['selected', 'A', 'B', 'C'] as const).flatMap((mode) => (['pptx', 'pdf', 'html'] as const).map((format) => <button key={`${mode}-${format}`} className={mode === 'selected' && format === 'pptx' ? 'primary' : 'quiet'}
              disabled={!canExport || Boolean(busy)} onClick={() => exportDeck(mode, format)}>
              {busy === `export-${mode}-${format}` ? ru.generation.assembling : ru.generation.exportAction(mode, format)}
            </button>))}
          </div>
          {generation.exports.length ? <ul className="generation-export-list">{generation.exports.map((artifact) => <li key={artifact.id}>
            <a href={artifact.downloadUrl} download>{ru.generation.exportAction(artifact.mode, artifact.format ?? 'pptx')}</a>
            <span>{ru.generation.validated}</span>
          </li>)}</ul> : null}
        </section>
      </> : <p className="generation-notice">{ru.generation.noGeneration}</p>}
    </section>
  );
}
