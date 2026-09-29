'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { contentSourceStatus, contentSourceStatusLabel, type ContentSourceStatus } from './content-source-status';
import {
  auditFindingMessage,
  formatUiDateTime,
  friendlyErrorMessage,
  generationStatusLabel,
  planningStatusLabel,
  productWorkflowStageLabel,
  ru,
  slidePackStatusLabel,
  templateStatusLabel,
  variantStatusLabel,
} from './i18n/ru';
import { clearWorkspaceDraft, readWorkspaceDraft, writeWorkspaceDraft } from './workspace-draft';
import { refreshPersistedWorkflowSnapshots } from './workflow-terminal-refresh';
import { includeUploadedContentFiles } from './uploaded-content-selection';
import { isPersistedTemplatePreparationState, isUsableTemplateProfileState } from './template-preparation-state';
import { persistedWorkspaceView, visibleGenerationOperationError, visiblePersistedFailure, visibleRequestFailure } from './workflow-visible-state';

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
type WorkspaceView = 'upload' | 'template' | 'brief' | 'outline' | 'progress' | 'editor' | 'audit';

type ApiError = { error?: string | { code?: string; message?: string }; message?: string; code?: string };
type UiFailure = { message: string; code?: string; status?: number };

class ApplicationUiError extends Error {
  constructor(readonly failure: UiFailure) {
    super(failure.message);
    this.name = 'ApplicationUiError';
  }
}

type TemplateCompileStatus = 'uncompiled' | 'ready' | 'stale' | 'failed';
type TemplateSemanticProfileStatus = 'disabled' | 'missing' | 'processing' | 'ready' | 'degraded-ready' | 'failed';
type TemplateCompileResponse = {
  status: TemplateCompileStatus;
  source?: unknown;
  compiledAt?: string;
  failure?: unknown;
  templateIR?: unknown;
  presentationDesignSystem?: unknown;
  semanticProfile?: {
    status: TemplateSemanticProfileStatus;
    cached: boolean;
    failureCode?: string;
    degradationCode?: string;
    templatePreparationMs?: number | null;
    templateStructuralMs?: number | null;
    templateSemanticProfileMs?: number | null;
  };
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
type LayoutIssueSummary = {
  total: number;
  blocking: number;
  warnings: number;
  approximate: number;
  details: Array<{
    category: 'blocking' | 'warning' | 'approximate';
    classification: string;
    severity: string;
    approximate: boolean;
    message: string | null;
  }>;
};
type GenerationVariant = {
  status: string;
  version: number;
  previewUrl: string | null;
  layoutIssueCount: number;
  layoutIssueSummary?: LayoutIssueSummary;
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

function LayoutEvidenceNotes({ item }: { item: GenerationVariant }) {
  const summary = item.layoutIssueSummary;
  if (!summary) return item.layoutIssueCount > 0
    ? <span>{ru.generation.unclassifiedLayoutNotes(item.layoutIssueCount)}</span>
    : null;
  if (summary.total === 0) return null;
  const notes = [
    summary.blocking > 0 ? ru.generation.blockingLayoutNotes(summary.blocking) : null,
    summary.warnings > 0 ? ru.generation.layoutWarnings(summary.warnings) : null,
    summary.approximate > 0 ? ru.generation.approximateLayoutNotes(summary.approximate) : null,
  ].filter((note): note is string => note !== null);
  return <details className="generation-layout-evidence">
    <summary>{notes.join(' · ')}</summary>
    <ul>
      {summary.details.map((issue, index) => <li key={`${issue.classification}-${index}`}>
        <span>{issue.category === 'approximate' ? ru.generation.approximateLayoutDetail
          : issue.classification === 'SOURCE_TEMPLATE_BLEED' ? ru.generation.templateBleedDetail
            : issue.category === 'blocking' ? ru.generation.blockingLayoutDetail
              : ru.generation.genericLayoutWarningDetail}</span>
        <code>{issue.classification}</code>
      </li>)}
    </ul>
  </details>;
}
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

type ProductWorkflowOperation = {
  operationId: string;
  inputFingerprint: string;
  status: 'running' | 'ready' | 'failed';
  stage: 'analyzing_template' | 'understanding_template' | 'planning' | 'generating' | 'contextual_audit' | 'ready' | 'failed';
  readySlides: number;
  totalSlides: number | null;
  generationId: string | null;
  contextualAudit: {
    status: 'ready' | 'failed';
    stale: boolean;
    findings: Array<{
      ruleId: string;
      slideId: string | null;
      severity: 'info' | 'warning' | 'error';
      messageCode: keyof typeof ru.workflow.messages;
      evidenceRefs: string[];
      repairable: boolean;
      suggestedActionCode: string | null;
    }> | null;
    telemetry: { validationFailureCode?: string } | null;
    failureCode: string | null;
  } | null;
  failure: { code: string; stage: string; retryable: boolean } | null;
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

function ErrorNotice({ failure, className, role = 'alert', onRetry }: { failure: UiFailure | string | null; className?: string; role?: 'alert' | 'status'; onRetry?: () => void }) {
  if (!failure) return null;
  const value = typeof failure === 'string' ? { message: failure } : failure;
  const showDiagnostics = Boolean(value.code || value.status);
  return <div className={className} role={role}>
    <span>{value.message}</span>
    {onRetry ? <button className="quiet compact ui-error-retry" onClick={onRetry}>{ru.errors.retry}</button> : null}
    {showDiagnostics ? <details className="ui-error-details">
      <summary>{ru.errors.diagnostics}</summary>
      {value.code ? <code>{ru.errors.code(value.code)}</code> : null}
      {value.status ? <code>{ru.errors.status(value.status)}</code> : null}
    </details> : null}
  </div>;
}

type FigmaIconName = 'menu' | 'folder' | 'clock' | 'settings' | 'arrow-right' | 'paperclip' | 'chevron-down';

const FIGMA_ICON_PATHS: Record<FigmaIconName, { viewBox: string; paths: string[] }> = {
  "menu": {
    "viewBox": "0 0 24 24",
    "paths": [
      "M4 7H20M4 12H20M4 17H20"
    ]
  },
  "folder": {
    "viewBox": "0 0 24 24",
    "paths": [
      "M3.5 6.5C3.5 6.10218 3.65804 5.72064 3.93934 5.43934C4.22064 5.15804 4.60218 5 5 5H9.1C9.58 5 10.03 5.23 10.31 5.61L11.45 7H19C19.3978 7 19.7794 7.15804 20.0607 7.43934C20.342 7.72064 20.5 8.10218 20.5 8.5V17C20.5 17.3978 20.342 17.7794 20.0607 18.0607C19.7794 18.342 19.3978 18.5 19 18.5H5C4.60218 18.5 4.22064 18.342 3.93934 18.0607C3.65804 17.7794 3.5 17.3978 3.5 17V6.5Z"
    ]
  },
  "clock": {
    "viewBox": "0 0 20 20",
    "paths": [
      "M10 17.25C14.0041 17.25 17.25 14.0041 17.25 10C17.25 5.99594 14.0041 2.75 10 2.75C5.99594 2.75 2.75 5.99594 2.75 10C2.75 14.0041 5.99594 17.25 10 17.25Z",
      "M10 6.25V10.25L12.75 11.75"
    ]
  },
  "settings": {
    "viewBox": "0 0 24 24",
    "paths": [
      "M12.22 2H11.78C11.2496 2 10.7409 2.21071 10.3658 2.58579C9.99071 2.96086 9.78 3.46957 9.78 4V4.18C9.77964 4.53073 9.68706 4.87519 9.51154 5.17884C9.33602 5.48248 9.08374 5.73464 8.78 5.91L8.35 6.16C8.04596 6.33554 7.70107 6.42795 7.35 6.42795C6.99893 6.42795 6.65404 6.33554 6.35 6.16L6.2 6.08C5.74106 5.81526 5.19584 5.74344 4.684 5.88031C4.17217 6.01717 3.73555 6.35154 3.47 6.81L3.25 7.19C2.98526 7.64893 2.91344 8.19416 3.05031 8.706C3.18717 9.21783 3.52154 9.65445 3.98 9.92L4.13 10.01C4.43521 10.1862 4.68844 10.4399 4.86404 10.7455C5.03965 11.051 5.1314 11.3976 5.13 11.75V12.25C5.1314 12.6024 5.03965 12.949 4.86404 13.2545C4.68844 13.5601 4.43521 13.8138 4.13 13.99L3.98 14.08C3.52154 14.3456 3.18717 14.7822 3.05031 15.294C2.91344 15.8058 2.98526 16.3511 3.25 16.81L3.47 17.19C3.73555 17.6485 4.17217 17.9828 4.684 18.1197C5.19584 18.2566 5.74106 18.1847 6.2 17.92L6.35 17.84C6.65404 17.6645 6.99893 17.5721 7.35 17.5721C7.70107 17.5721 8.04596 17.6645 8.35 17.84L8.78 18.09C9.08374 18.2654 9.33602 18.5175 9.51154 18.8212C9.68706 19.1248 9.77964 19.4693 9.78 19.82V20C9.78 20.5304 9.99071 21.0391 10.3658 21.4142C10.7409 21.7893 11.2496 22 11.78 22H12.22C12.7504 22 13.2591 21.7893 13.6342 21.4142C14.0093 21.0391 14.22 20.5304 14.22 20V19.82C14.2204 19.4693 14.3129 19.1248 14.4885 18.8212C14.664 18.5175 14.9163 18.2654 15.22 18.09L15.65 17.84C15.954 17.6645 16.2989 17.5721 16.65 17.5721C17.0011 17.5721 17.346 17.6645 17.65 17.84L17.8 17.92C18.2589 18.1847 18.8042 18.2566 19.316 18.1197C19.8278 17.9828 20.2644 17.6485 20.53 17.19L20.75 16.81C21.0147 16.3511 21.0866 15.8058 20.9497 15.294C20.8128 14.7822 20.4785 14.3456 20.02 14.08L19.87 13.99C19.5648 13.8138 19.3116 13.5601 19.136 13.2545C18.9603 12.949 18.8686 12.6024 18.87 12.25V11.75C18.8686 11.3976 18.9603 11.051 19.136 10.7455C19.3116 10.4399 19.5648 10.1862 19.87 10.01L20.02 9.92C20.4785 9.65445 20.8128 9.21783 20.9497 8.706C21.0866 8.19416 21.0147 7.64893 20.75 7.19L20.53 6.81C20.2644 6.35154 19.8278 6.01717 19.316 5.88031C18.8042 5.74344 18.2589 5.81526 17.8 6.08L17.65 6.16C17.346 6.33554 17.0011 6.42795 16.65 6.42795C16.2989 6.42795 15.954 6.33554 15.65 6.16L15.22 5.91C14.9163 5.73464 14.664 5.48248 14.4885 5.17884C14.3129 4.87519 14.2204 4.53073 14.22 4.18V4C14.22 3.46957 14.0093 2.96086 13.6342 2.58579C13.2591 2.21071 12.7504 2 12.22 2Z",
      "M12 15C13.6569 15 15 13.6569 15 12C15 10.3431 13.6569 9 12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15Z"
    ]
  },
  "arrow-right": {
    "viewBox": "0 0 32 32",
    "paths": [
      "M6.66667 16H25.3333M19.3333 22L25.3333 16L19.3333 10"
    ]
  },
  "paperclip": {
    "viewBox": "0 0 20 20",
    "paths": [
      "M17.8667 9.20833L10.2083 16.8667C8.25834 18.8167 5.09167 18.8167 3.13334 16.8667C1.18334 14.9167 1.18334 11.75 3.13334 9.8L10.7917 2.13333C12.0917 0.833333 14.2083 0.833333 15.5083 2.13333C16.8083 3.43333 16.8083 5.55 15.5083 6.85L7.84167 14.5083C7.19167 15.1583 6.14167 15.1583 5.49167 14.5083C4.84167 13.8583 4.84167 12.8083 5.49167 12.1583L12.5667 5.08333"
    ]
  },
  "chevron-down": {
    "viewBox": "0 0 16 16",
    "paths": [
      "M4.5 6.5L8 10L11.5 6.5"
    ]
  }
};

function FigmaIcon({ name }: { name: FigmaIconName }) {
  const icon = FIGMA_ICON_PATHS[name];
  return <svg className="figma-icon" viewBox={icon.viewBox} fill="none" aria-hidden="true" focusable="false">
    {icon.paths.map((path) => <path key={path} d={path} stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />)}
  </svg>;
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
  const sourceUploadRef = useRef<HTMLInputElement>(null);
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
  const [productOperation, setProductOperation] = useState<ProductWorkflowOperation | null>(null);
  const [productWorkflowBusy, setProductWorkflowBusy] = useState(false);
  const [productWorkflowError, setProductWorkflowError] = useState<UiFailure | null>(null);
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
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('upload');
  const [developerToolsOpen, setDeveloperToolsOpen] = useState(false);
  const [auditRefreshError, setAuditRefreshError] = useState<UiFailure | null>(null);
  const workspaceViewTouchedRef = useRef(false);
  const workspaceViewInitializedRef = useRef(false);
  const filesRef = useRef(files);
  const templateScanRef = useRef(templateScan);
  const selectedTemplateRef = useRef(templateFile);
  const templatePreparationRequestRef = useRef(0);
  const autoPreparedTemplateRef = useRef<string | null>(null);
  filesRef.current = files;
  templateScanRef.current = templateScan;
  selectedTemplateRef.current = templateFile;

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

  const loadTemplateScan = useCallback(async (options: { quiet?: boolean } = {}) => {
    if (!options.quiet) {
      setTemplateFetching(true);
      setTemplateError(null);
    }
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/template`, { cache: 'no-store' });
      if (!response.ok) throw await errorMessage(response, 'template');
      const scan = parseTemplateCompileResponse(await response.json());
      setTemplateScan(scan);
      return scan;
    } catch (err) {
      if (!options.quiet) setTemplateError(uiFailure(err, ru.errors.template));
      return null;
    } finally {
      if (!options.quiet) setTemplateFetching(false);
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

  const loadProductOperation = useCallback(async () => {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/workflow`, { cache: 'no-store' });
    if (!response.ok) throw await errorMessage(response, 'generation');
    const body = await response.json() as { operation?: ProductWorkflowOperation | null };
    const operation = body.operation ?? null;
    setProductOperation(operation);
    if (operation?.status === 'ready') setProductWorkflowError(null);
    if (operation?.contextualAudit?.status === 'ready' && !operation.contextualAudit.stale) setAuditRefreshError(null);
    return operation;
  }, [projectId]);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [, loadedFiles, , loadedScan, savedPlanning] = await Promise.all([
        loadProject(), loadFiles(), loadDesignSystems(), loadTemplateScan(), loadPlanning(), loadProductOperation(),
      ]);
      restoreDraft(savedPlanning, loadedFiles, loadedScan);
      draftHydratedRef.current = true;
      setDraftHydrated(true);
    } catch (err) {
      setError(uiFailure(err));
    }
  }, [loadDesignSystems, loadFiles, loadPlanning, loadProductOperation, loadProject, loadTemplateScan, restoreDraft]);

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
  const templateIR = record(templateScan?.templateIR);
  const scanSourcePath = sourcePathOf(templateScan);
  const scanSelectionMismatch = Boolean(scanSourcePath && templateFile !== scanSourcePath);
  const matchingScan = Boolean(templateIR && !scanSelectionMismatch);
  const rawTemplateProfileStatus = matchingScan ? templateScan?.semanticProfile?.status ?? 'missing' : 'missing';
  const templateProfileStatus = rawTemplateProfileStatus === 'disabled' ? 'missing' : rawTemplateProfileStatus;
  const templatePreparationPending = templateAnalyzing || Boolean(matchingScan && templateScan?.status === 'ready'
    && templateProfileStatus === 'processing');
  const templatePreparationReady = matchingScan && templateScan?.status === 'ready'
    && isUsableTemplateProfileState(templateProfileStatus);
  const visibleTemplateStatus: TemplateCompileStatus | null = scanSelectionMismatch
    ? 'stale'
    : templateScan?.status === 'ready' && !templatePreparationReady && templateProfileStatus !== 'processing'
      ? templateProfileStatus === 'failed' ? 'failed' : 'uncompiled'
      : templateScan?.status ?? null;
  const templateBadgeStatus = templatePreparationPending ? 'processing' : visibleTemplateStatus ?? (templateFetching ? 'loading' : templateError ? 'unavailable' : 'uncompiled');
  const templateBadgeLabel = templatePreparationPending
    ? ru.template.analyzing
    : templateFetching ? ru.template.fetching
      : templatePreparationReady ? templateProfileStatus === 'degraded-ready' ? ru.template.profileDegradedBadge : ru.template.ready
        : templateProfileStatus === 'failed' ? ru.template.profileFailed
        : templateScan?.status === 'ready' ? ru.template.profileRequired
        : visibleTemplateStatus === 'ready' ? ru.template.ready
        : templateFile && (visibleTemplateStatus === 'uncompiled' || !visibleTemplateStatus) && !templateError ? ru.template.selected
        : !templateFile && (visibleTemplateStatus === 'uncompiled' || !visibleTemplateStatus) && !templateError ? ru.template.selectTemplate
          : templateStatusLabel(visibleTemplateStatus ?? (templateError ? 'unavailable' : 'uncompiled'));
  const productWorkflowRunning = productWorkflowBusy || productOperation?.status === 'running';
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
  const visibleTemplateError = visibleRequestFailure(templateError,
    templatePreparationReady ? 'ready' : visibleTemplateStatus === 'failed' ? 'failed' : null, ['ready', 'failed']);
  const visiblePlanningError = visibleRequestFailure(planningError,
    savedPlanReady ? 'ready' : planning?.status === 'failed' ? 'failed' : null, ['ready', 'failed']);
  const productReadyWithAuditFailure = Boolean(productOperation?.status === 'failed'
    && productOperation.failure?.stage === 'contextual_audit' && productOperation.generationId);
  const visibleProductWorkflowError = visibleRequestFailure(productWorkflowError,
    productReadyWithAuditFailure ? 'ready' : productOperation?.status === 'failed' && productOperation.failure ? 'failed' : productOperation?.status, ['ready', 'failed']);
  const visiblePlanningFailure = visiblePersistedFailure(planningFailure, planning?.status);

  useEffect(() => {
    if (!draftHydrated || workspaceViewInitializedRef.current) return;
    workspaceViewInitializedRef.current = true;
    const initialView = persistedWorkspaceView({
      operationStatus: productOperation?.status,
      operationFailureStage: productOperation?.failure?.stage,
      operationGenerationId: productOperation?.generationId,
      savedPlanReady,
      templateReady: templatePreparationReady,
    });
    if (initialView) setWorkspaceView(initialView);
  }, [draftHydrated, productOperation?.failure?.stage, productOperation?.generationId, productOperation?.status, savedPlanReady, templatePreparationReady]);

  const chooseWorkspaceView = (view: WorkspaceView) => {
    workspaceViewTouchedRef.current = true;
    setWorkspaceView(view);
  };

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
      if (body.status === 'ready') chooseWorkspaceView('outline');
      try { if (typeof window !== 'undefined') clearWorkspaceDraft(window.sessionStorage, projectId); }
      catch { /* Saved planning state is on the server even if browser storage is unavailable. */ }
    } catch (err) {
      await loadPlanning();
      setPlanningError(uiFailure(err, ru.errors.plan));
    } finally {
      setPlanningGenerating(false);
    }
  };

  const selectTemplateFile = (nextFilePath: string | null) => {
    templatePreparationRequestRef.current += 1;
    autoPreparedTemplateRef.current = null;
    selectedTemplateRef.current = nextFilePath;
    setTemplateAnalyzing(false);
    setTemplateFile(nextFilePath);
    setTemplateScan(null);
    setTemplateError(null);
  };

  const analyzeTemplate = async (filePath: string | null = templateFile) => {
    if (!filePath) return;
    const requestId = ++templatePreparationRequestRef.current;
    autoPreparedTemplateRef.current = filePath;
    setTemplateAnalyzing(true);
    setTemplateError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/template/compile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const failed = record(body);
        const failure = record(failed?.failure);
        const code = stringValue(failure?.code) || undefined;
        throw new ApplicationUiError({ message: friendlyErrorMessage(code, response.status, 'template'), ...(code ? { code } : {}), status: response.status });
      }
      if (requestId === templatePreparationRequestRef.current && selectedTemplateRef.current === filePath) {
        setTemplateScan(parseTemplateCompileResponse(body));
        await loadPlanning();
      }
    } catch (err) {
      if (requestId === templatePreparationRequestRef.current && selectedTemplateRef.current === filePath) {
        const [recoveredScan] = await Promise.all([loadTemplateScan({ quiet: true }), loadPlanning()]);
        const recoveredPath = sourcePathOf(recoveredScan);
        const recoveredProfileStatus = recoveredScan?.semanticProfile?.status;
        const backendHasTruthfulPreparationState = isPersistedTemplatePreparationState(
          recoveredScan?.status, recoveredProfileStatus, recoveredPath, filePath,
        );
        if (backendHasTruthfulPreparationState) {
          setTemplateScan(recoveredScan);
          setTemplateError(null);
        } else {
          setTemplateError(uiFailure(err, ru.errors.template));
        }
      }
    } finally {
      if (requestId === templatePreparationRequestRef.current) setTemplateAnalyzing(false);
    }
  };

  const generatePresentation = async () => {
    setProductWorkflowError(null);
    setAuditRefreshError(null);
    if (!templateFile) {
      setProductWorkflowError({ message: ru.template.uploadFirst });
      return;
    }
    if (!templatePreparationReady) {
      setProductWorkflowError({ message: ru.template.prepareBeforeGenerate, code: 'TEMPLATE_NOT_READY', status: 409 });
      return;
    }
    if (!briefPurpose.trim()) {
      setProductWorkflowError({ message: ru.validation.briefRequired });
      return;
    }
    const count = requestedSlideCount.trim() ? Number(requestedSlideCount) : undefined;
    if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 30)) {
      setProductWorkflowError({ message: ru.validation.slideCount });
      return;
    }
    const preferences = normalizePreferenceLines(briefPreferences).split('\n').filter(Boolean);
    if (preferences.length > 12 || preferences.some((item) => item.length > 200)) {
      setProductWorkflowError({ message: ru.validation.preferences });
      return;
    }
    setProductWorkflowBusy(true);
    chooseWorkspaceView('progress');
    try {
      const brief = {
        audience: briefAudience.trim(),
        purpose: briefPurpose.trim(),
        expectedOutcome: briefExpectedOutcome.trim(),
        context: briefContext.trim(),
        preferences,
        ...(count === undefined ? {} : { requestedSlideCount: count }),
      };
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/workflow/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateFilePath: templateFile, contentFiles: planningSelectedPaths, brief }),
      });
      if (!response.ok) throw await errorMessage(response, 'generation');
      const body = await response.json() as { operation?: ProductWorkflowOperation };
      if (body.operation) setProductOperation(body.operation);
      if (body.operation?.status === 'ready') {
        await Promise.all([loadTemplateScan(), loadPlanning()]);
        chooseWorkspaceView('editor');
      } else if (body.operation?.status === 'failed' && body.operation.failure?.stage === 'contextual_audit' && body.operation.generationId) {
        await Promise.all([loadTemplateScan(), loadPlanning()]);
        chooseWorkspaceView('audit');
      }
      try { if (typeof window !== 'undefined') clearWorkspaceDraft(window.sessionStorage, projectId); }
      catch { /* Server-owned operation and plan remain available after reload. */ }
    } catch (err) {
      const latest = await loadProductOperation().catch(() => null);
      if (latest?.status === 'ready') {
        await Promise.all([loadTemplateScan(), loadPlanning()]);
        chooseWorkspaceView('editor');
      } else if (latest?.status === 'failed' && latest.failure?.stage === 'contextual_audit' && latest.generationId) {
        await Promise.all([loadTemplateScan(), loadPlanning()]);
        setProductOperation(latest);
        chooseWorkspaceView('audit');
      } else {
        setProductWorkflowError(uiFailure(err, ru.workflow.error));
        if (latest?.status === 'failed') setProductOperation(latest);
      }
    } finally {
      setProductWorkflowBusy(false);
    }
  };

  const repeatContextualAudit = async () => {
    setAuditRefreshError(null);
    setProductWorkflowBusy(true);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/workflow/contextual-audit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!response.ok) throw await errorMessage(response, 'generation');
      const body = await response.json() as { operation?: ProductWorkflowOperation };
      if (body.operation) setProductOperation(body.operation);
    } catch (err) {
      const latest = await loadProductOperation().catch(() => null);
      if (latest?.contextualAudit?.status !== 'ready' || latest.contextualAudit.stale) {
        setAuditRefreshError(uiFailure(err, ru.workflow.auditTransportUnavailable));
      }
    } finally {
      setProductWorkflowBusy(false);
    }
  };

  useEffect(() => {
    if (!productOperation || productOperation.status !== 'running') return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      let next: ProductWorkflowOperation | null = null;
      try {
        next = await loadProductOperation();
        if (!cancelled && next) {
          const refreshed = await refreshPersistedWorkflowSnapshots(next.status, {
            template: loadTemplateScan,
            planning: loadPlanning,
          });
          if (refreshed && next.status === 'ready') {
            chooseWorkspaceView('editor');
          } else if (next.status === 'failed') {
            chooseWorkspaceView(next.failure?.stage === 'contextual_audit' && next.generationId ? 'audit' : 'progress');
          }
        }
      } catch (err) {
        if (!cancelled) setProductWorkflowError(uiFailure(err, ru.workflow.error));
      }
      if (!cancelled && (!next || next.status === 'running')) timer = window.setTimeout(() => void poll(), 900);
    };
    timer = window.setTimeout(() => void poll(), 900);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loadPlanning, loadProductOperation, loadTemplateScan, productOperation?.operationId, productOperation?.status]);

  useEffect(() => {
    const paths = templateFiles.map(filePath);
    if (templateFile && paths.includes(templateFile)) return;
    const compiledSource = sourcePathOf(templateScan);
    const next = compiledSource && paths.includes(compiledSource) ? compiledSource : paths[0] ?? null;
    setTemplateFile(next);
    selectedTemplateRef.current = next;
  }, [templateFile, templateFiles, templateScan]);

  useEffect(() => {
    if (!templateFile || !templateFiles.some((file) => filePath(file) === templateFile)
        || templatePreparationReady || templateProfileStatus === 'processing' || templateProfileStatus === 'failed'
        || templateAnalyzing || templateFetching || busy || productWorkflowRunning
        || autoPreparedTemplateRef.current === templateFile) return;
    void analyzeTemplate(templateFile);
  }, [analyzeTemplate, busy, productWorkflowRunning, templateAnalyzing, templateFetching, templateFile,
    templateFiles, templatePreparationReady, templateProfileStatus]);

  useEffect(() => {
    if (!templateAnalyzing && templateProfileStatus !== 'processing') return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      const scan = await loadTemplateScan({ quiet: true });
      if (cancelled) return;
      if (templateAnalyzing || scan?.semanticProfile?.status === 'processing') timer = window.setTimeout(() => void poll(), 900);
    };
    timer = window.setTimeout(() => void poll(), 900);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loadTemplateScan, templateAnalyzing, templateProfileStatus]);

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
      if (uploadedPath) selectTemplateFile(uploadedPath);
      else await loadTemplateScan();
      await loadPlanning();
      const uploadedSourcePaths = uploadedFiles
        .filter((file) => !/\.pptx$/i.test(filePath(file) || file.originalName || ''))
        .map(filePath)
        .filter((path): path is string => Boolean(path));
      if (uploadedSourcePaths.length) {
        setSelectedContentFiles((current) => includeUploadedContentFiles(current, uploadedSourcePaths));
      }
    } catch (err) {
      if (uploadedFiles.length) await loadFiles();
      setError(uiFailure(err));
    } finally {
      if (uploadRef.current) uploadRef.current.value = '';
      if (sourceUploadRef.current) sourceUploadRef.current.value = '';
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

  const reportGenerationState = useCallback((complete: boolean, exported: boolean, status?: string | null) => {
    setGenerationComplete(complete);
    setGenerationExported(exported);
    if (workspaceViewTouchedRef.current) return;
    if (status === 'preparing' || status === 'generating') setWorkspaceView('progress');
    else if (complete) setWorkspaceView('editor');
  }, []);

  if (!project && !error) return <div className="boot-state" role="status">{ru.workspace.boot}</div>;

  return (
    <main className="workspace-shell" data-view={workspaceView}>
      <header className="workspace-topbar">
        <button className="workspace-menu" aria-label={ru.workspace.back} title={ru.workspace.back} onClick={onBack}><FigmaIcon name="menu" /></button>
        <div className="project-title-block">
          <strong>{project?.name ?? projectId}</strong>
          <FigmaIcon name="chevron-down" />
        </div>
        <div className="topbar-actions">
          <button className="quiet" onClick={() => void reload()}>{ru.workspace.reload}</button>
        </div>
      </header>

      <nav className="workspace-rail" aria-label={ru.workspace.stagesLabel}>
        <button className={workspaceView === 'upload' || workspaceView === 'template' || workspaceView === 'brief' || workspaceView === 'outline' ? 'rail-button active' : 'rail-button'}
          aria-label={ru.workspace.templateStage} title={ru.workspace.templateStage} onClick={() => chooseWorkspaceView('upload')}><FigmaIcon name="folder" /></button>
        <button className="rail-button" aria-label={ru.home.projects} title={ru.home.projects} onClick={onBack}><FigmaIcon name="clock" /></button>
        <button className="rail-button rail-settings" aria-label={ru.workspace.technicalTools} title={ru.workspace.technicalTools}
          aria-expanded={developerToolsOpen} aria-controls="developer-tools-panel"
          onClick={() => setDeveloperToolsOpen((open) => !open)}><FigmaIcon name="settings" /></button>
      </nav>

      <div className="workspace-content" data-view={workspaceView}>
        <ErrorNotice failure={error} className="error-banner workspace-error" />
        <ErrorNotice failure={visibleProductWorkflowError} className="product-workflow-error" onRetry={() => void generatePresentation()} />
        {uploading ? <p className="workspace-operation-status" role="status" aria-live="polite">{ru.workspace.uploading}</p> : null}

      <section className="template-panel" id="template-panel" aria-labelledby="template-panel-title">
        <div className="template-panel-head">
          <div>
          <span className="eyebrow">{ru.template.eyebrow}</span>
            <h2 id="template-panel-title">{workspaceView === 'upload' && !templateFile ? ru.workspace.emptyPresentation : ru.template.title}</h2>
            <p>{ru.template.description}</p>
          </div>
          <span className={`template-status status-${templateBadgeStatus}`} role="status">
            {templateBadgeLabel}
          </span>
        </div>

        <div className="template-toolbar">
          <label htmlFor="template-source">{ru.template.sourceLabel} <span aria-hidden="true">*</span></label>
          <select
            id="template-source"
            value={templateFile ?? ''}
            onChange={(event) => selectTemplateFile(event.target.value || null)}
            disabled={templateFiles.length === 0 || templateFetching || templateAnalyzing || productWorkflowRunning}
          >
            {templateFiles.length === 0 ? <option value="">{ru.template.uploadFirst}</option> : null}
            {templateFiles.map((file) => {
              const path = filePath(file);
              return <option key={path} value={path}>{path}</option>;
            })}
          </select>
          <button className={templateFile ? 'quiet' : 'primary'} onClick={() => uploadRef.current?.click()} disabled={busy}>
            {templateFile ? ru.template.replace : ru.template.upload}
          </button>
          <input ref={uploadRef} className="visually-hidden" type="file" accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation" aria-hidden="true" tabIndex={-1} onChange={(event) => void upload(event.target.files)} />
          {templateScan?.compiledAt ? <span className="template-compiled-at">{ru.template.lastScan(formatUiDateTime(new Date(templateScan.compiledAt)))}</span> : null}
        </div>

        <p className="template-scope-note">{ru.template.scope}</p>
        <ErrorNotice failure={visibleTemplateError} className="error-banner template-error" />

        {visibleTemplateStatus === 'uncompiled' && templateFiles.length > 0 ? (
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
        {templateProfileStatus === 'failed' && templateScan?.status === 'ready' ? (
          <ErrorNotice failure={{ message: ru.template.profileFailed, ...(templateScan.semanticProfile?.failureCode ? { code: templateScan.semanticProfile.failureCode } : {}) }}
            className="template-message template-message-warning" role="status" onRetry={() => void analyzeTemplate(templateFile)} />
        ) : null}
        {templateProfileStatus === 'degraded-ready' && templateScan?.status === 'ready' ? (
          <div className="template-message template-message-warning" role="status">
            <span>{ru.template.profileDegraded}</span>
            {templateScan.semanticProfile?.degradationCode ? (
              <details className="diagnostic-details">
                <summary>{ru.template.diagnosticLabel}</summary>
                <code>{templateScan.semanticProfile.degradationCode}</code>
              </details>
            ) : null}
          </div>
        ) : null}
        {!templateFetching && !templateAnalyzing && !templateScan && visibleTemplateError ? (
          <div className="template-message template-message-warning">{ru.template.scanUnavailable}</div>
        ) : null}

        {workspaceView === 'upload' ? <div className="upload-materials-row">
          <div><span className="eyebrow">{ru.planning.sourceFiles}</span>
            <strong>{ru.planning.materialsSummary(planningSelectedPaths.length, planningSourceFiles.length)}</strong>
            <span className="upload-materials-note">{planningSourceFiles.length ? ru.planning.materialsOptional : ru.planning.uploadSources}</span>
          </div>
          <button className="quiet" onClick={() => sourceUploadRef.current?.click()} disabled={busy || planningGenerating || productWorkflowRunning}>
            <FigmaIcon name="paperclip" />{ru.planning.addSources}
          </button>
        </div> : null}

        {workspaceView === 'upload' ? <label className="upload-brief-field" htmlFor="upload-presentation-purpose">
          <span>{ru.workspace.briefOnUpload}</span>
          <textarea id="upload-presentation-purpose" value={briefPurpose} onChange={(event) => setBriefPurpose(event.target.value)}
            placeholder={ru.workspace.briefOnUploadPlaceholder} disabled={productWorkflowRunning || planningGenerating} />
        </label> : null}

        {templatePreparationPending ? <div className="template-progress" role="status" aria-live="polite">
          <span>{ru.template.analyzing}</span>
          <div className="template-progress-track"><i /></div>
        </div> : null}

        {workspaceView === 'upload' ? <div className="workspace-flow-actions upload-flow-actions">
          <span>{templatePreparationReady ? ru.template.ready : templateBadgeLabel}</span>
          <button className="primary icon-next" aria-label={ru.workspace.continueToTemplate} title={ru.workspace.continueToTemplate}
            disabled={!templatePreparationReady} onClick={() => chooseWorkspaceView('template')}><span>{ru.workspace.continueToTemplate}</span><FigmaIcon name="arrow-right" /></button>
        </div> : null}

        {workspaceView === 'template' && matchingScan && templateIR ? <section className="template-design-summary" aria-label={ru.template.designSystemSummary}>
          <div className="template-summary-heading"><h3>{ru.template.designSystemSummary}</h3><span className="template-status status-ready">{templateBadgeLabel}</span></div>
          <div className="template-metrics template-summary-metrics">
            <div className="template-metric"><span>{ru.template.slides}</span><strong>{countLabel(templateIR, ['slides'], ['slideCount', 'summary.slideCount'])}</strong></div>
            <div className="template-metric"><span>{ru.template.layouts}</span><strong>{ru.template.layoutCount(layouts.length)}</strong></div>
            <div className="template-metric"><span>{ru.template.palette}</span><strong>{directColors.length || themeColors.length || '—'}</strong></div>
            <div className="template-metric"><span>{ru.template.fonts}</span><strong>{fonts.length || '—'}</strong></div>
          </div>
          <div className="template-summary-grid">
            <section className="template-summary-column">
              <h4>{ru.template.palette}</h4>
              {directColors.length || themeColors.length ? <div className="template-summary-palette">
                {(directColors.length ? directColors : themeColors).slice(0, 12).map((color, index) => (
                  <span className="template-summary-color" key={`${color.label}-${index}`} title={`${color.label}: ${color.value}`}>
                    <i aria-hidden="true" style={safeColor(color.value) ? { backgroundColor: safeColor(color.value) as string } : undefined} />
                    <small>{color.label}</small>
                  </span>
                ))}
              </div> : <p className="template-muted">{ru.template.noPalette}</p>}
              <h4>{ru.template.fonts}</h4>
              <div className="template-summary-fonts">
                {fonts.length ? fonts.map((font) => <span key={font}>{font}</span>) : <span>{ru.template.noFonts}</span>}
                {fontSizes.map((size) => <span key={size}>{size} pt</span>)}
              </div>
            </section>
            <section className="template-summary-column">
              <h4>{ru.template.layouts}</h4>
              <p>{ru.template.layoutCount(layouts.length)}</p>
              {layouts.length ? <div className="template-summary-layouts">
                {layouts.slice(0, 6).map((entry, index) => {
                  const layout = record(entry);
                  if (!layout) return null;
                  const title = stringValue(firstValue(layout, ['matchingName', 'declaredName', 'name', 'title']), ru.template.layoutUnknown(index + 1));
                  const usageCount = firstValue(layout, ['usageCount', 'slideUsageCount']);
                  const roles = uniqueStrings(arrayValue(layout, ['placeholderRoles', 'structure.placeholderRoles']));
                  return <article className="template-summary-layout" key={`${title}-${index}`}>
                    <strong>{title}</strong>
                    <span>{typeof usageCount === 'number' ? ru.template.usage(usageCount) : ru.template.usageUnknown}</span>
                    {roles.length ? <small>{roles.slice(0, 3).join(' · ')}</small> : null}
                  </article>;
                })}
              </div> : <p className="template-muted">{ru.template.noLayoutDetails}</p>}
            </section>
          </div>
        </section> : null}

        {matchingScan && templateIR ? (
          <details className="advanced-tools template-report-disclosure">
            <summary>{ru.template.reportSummary}</summary>
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
          </details>
        ) : null}

        {workspaceView === 'template' ? <div className="workspace-flow-actions">
          <button className="quiet" onClick={() => chooseWorkspaceView('upload')}>{ru.workspace.back}</button>
          <span>{templateBadgeLabel}</span>
          <button className="primary icon-next" aria-label={ru.workspace.continueToBrief} title={ru.workspace.continueToBrief}
            disabled={!templatePreparationReady} onClick={() => chooseWorkspaceView('brief')}><span>{ru.workspace.continueToBrief}</span><FigmaIcon name="arrow-right" /></button>
        </div> : null}
      </section>

      <section className="planning-panel" id="planning-panel" aria-labelledby="planning-panel-title">
        <div className="planning-panel-head">
          <div>
            <span className="eyebrow">{workspaceView === 'outline' ? ru.planning.outlineEyebrow : ru.planning.eyebrow}</span>
            <h2 id="planning-panel-title">{workspaceView === 'outline' ? ru.planning.outlineTitle : ru.planning.briefTitle}</h2>
            <p>{workspaceView === 'outline' ? ru.planning.outlineDescription : ru.planning.description}</p>
          </div>
          <div className="planning-head-actions">
            <span className={`planning-status planning-status-${planningGenerating ? 'generating' : planningDraftDirty ? 'stale' : planning?.status ?? 'loading'}`} role="status">
              {planningLoading ? ru.planning.loading : planningGenerating ? ru.planning.understanding : planningStatusLabel(planningDraftDirty ? 'stale' : planning?.status)}
            </span>
          </div>
        </div>

        {planning?.templateStatus !== 'ready' || !matchingScan ? (
          <div className="planning-notice" role="status">
            {templateFile ? ru.planning.oneClickWillAnalyze : ru.planning.uploadTemplateFirst}
          </div>
        ) : null}
        {planningLoading && !planning ? <div className="planning-notice" role="status">{ru.planning.loading}</div> : null}
        <ErrorNotice failure={visiblePlanningError} className="error-banner planning-error" />
        {planning?.status === 'stale' ? <div className="planning-notice planning-notice-warning" role="status">{ru.planning.stale}</div> : null}
        {planningDraftDirty ? <div className="planning-notice planning-notice-warning" role="status">{ru.planning.draftChanged}</div> : null}
        {visiblePlanningFailure?.message ? <ErrorNotice role="status" className="planning-notice planning-notice-warning" failure={{
          message: friendlyErrorMessage(stringValue(visiblePlanningFailure.code), 422, 'planning'),
          ...(visiblePlanningFailure.code ? { code: stringValue(visiblePlanningFailure.code) } : {}),
        }} /> : null}

        <details className="advanced-tools planning-advanced">
          <summary>{ru.workspace.advancedMode}</summary>
          <div className="advanced-tools-content">
            <div className="advanced-actions">
              <button className="quiet" onClick={() => void loadPlanning()} disabled={planningLoading || planningGenerating}>{ru.planning.reload}</button>
              <button className="quiet" onClick={() => void analyzeTemplate()} disabled={!templateFile || busy || templateFetching || templateAnalyzing || productWorkflowRunning}>
                {templateAnalyzing ? ru.template.analyzing : ru.template.analyze}
              </button>
              <button className="quiet" onClick={() => void generatePlan()} disabled={planningGenerating || planningLoading || templateFetching || templateAnalyzing || !templatePreparationReady || planning?.templateStatus !== 'ready' || !matchingScan || !briefPurpose.trim()}>
                {planningGenerating ? ru.planning.generating : ru.planning.generate}
              </button>
            </div>
          </div>
        </details>

        <div className="planning-form-grid">
          <div className="planning-brief">
            <label className="planning-required-field">{ru.planning.purpose} <span aria-hidden="true">*</span>
              <textarea id="presentation-purpose" required maxLength={1000} value={briefPurpose} onChange={(event) => setBriefPurpose(event.target.value)} disabled={planningGenerating || productWorkflowRunning} rows={3} placeholder={ru.planning.purposePlaceholder} />
            </label>
          <details className="advanced-tools optional-settings">
              <summary>{ru.planning.optionalSettings}</summary>
              <div className="advanced-tools-content">
            <label>{ru.planning.audience}
              <input maxLength={500} value={briefAudience} onChange={(event) => setBriefAudience(event.target.value)} disabled={planningGenerating || productWorkflowRunning} placeholder={ru.planning.audiencePlaceholder} />
            </label>
            <label>{ru.planning.outcome}
              <textarea maxLength={1000} value={briefExpectedOutcome} onChange={(event) => setBriefExpectedOutcome(event.target.value)} disabled={planningGenerating || productWorkflowRunning} rows={2} placeholder={ru.planning.outcomePlaceholder} />
            </label>
            <label className="planning-optional-context">{ru.planning.context}
              <textarea maxLength={16_000} value={briefContext} onChange={(event) => setBriefContext(event.target.value)} disabled={planningGenerating || productWorkflowRunning} rows={3} placeholder={ru.planning.contextPlaceholder} />
            </label>
            <label>{ru.planning.preferences} · {ru.planning.optionalLabel} <span className="planning-label-note">{ru.planning.perLine}</span>
              <textarea value={briefPreferences} onChange={(event) => setBriefPreferences(event.target.value)} disabled={planningGenerating || productWorkflowRunning} rows={2} placeholder={ru.planning.preferencesPlaceholder} />
            </label>
            <label className="planning-slide-count">{ru.planning.slideCount} <span className="planning-label-note">{ru.planning.optionalRange}</span>
              <input type="number" min="1" max="30" step="1" value={requestedSlideCount} onChange={(event) => setRequestedSlideCount(event.target.value)} disabled={planningGenerating || productWorkflowRunning} placeholder={ru.planning.automatic} />
            </label>
                <fieldset className="planning-file-picker">
                  <legend>{ru.planning.sourceFiles} <span>{ru.planning.selected(planningSelectedPaths.length)}</span></legend>
                  <div className="source-upload-row">
                    <button className="quiet" onClick={() => sourceUploadRef.current?.click()} disabled={busy || planningGenerating || productWorkflowRunning}>{ru.planning.addSources}</button>
                    <input ref={sourceUploadRef} className="visually-hidden" type="file" multiple aria-hidden="true" tabIndex={-1} onChange={(event) => void upload(event.target.files)} />
                  </div>
                  {planningSourceFiles.length ? (
                    <div className="planning-file-list">
                      {planningSourceFiles.map((file) => {
                        const path = filePath(file);
                        const sourceStatus = contentSourceStatusByPath.get(path) as ContentSourceStatus | undefined ?? 'not-parsed';
                        return (
                          <label className="planning-file-option" key={path} title={path}>
                            <input type="checkbox" checked={planningSelectedPaths.includes(path)}
                              onChange={(event) => togglePlanningFile(path, event.target.checked)}
                              disabled={planningGenerating || productWorkflowRunning || (!planningSelectedPaths.includes(path) && planningSelectedPaths.length >= 12)} />
                            <span>{path}</span>
                            <small className="content-source-status" data-status={sourceStatus} aria-label={`${contentSourceStatusLabel(sourceStatus)}: ${path}`}>{contentSourceStatusLabel(sourceStatus)}</small>
                            <small>{formatBytes(file.size)}</small>
                          </label>
                        );
                      })}
                    </div>
                  ) : <p className="planning-muted">{ru.planning.uploadSources}</p>}
                </fieldset>
              </div>
            </details>
            <div className="planning-submit-row">
              <span className="planning-muted">{ru.planning.requiredTaskNote}</span>
              <button className="primary" onClick={() => void generatePresentation()} disabled={!templateFile || !templatePreparationReady || !briefPurpose.trim() || busy || templatePreparationPending || productWorkflowRunning}>
                {productWorkflowRunning ? ru.workflow.working : ru.workflow.action}
              </button>
            </div>
          </div>
        </div>

        {planningWarnings.length || planningDeckPlan || planningReview ? <details className="advanced-tools planning-review-advanced" open={workspaceView === 'outline'}>
          <summary>{ru.planning.planDetails}</summary>
          <div className="advanced-tools-content">
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
                {planningSelectedPaths.length ? null : <span className="planning-provenance">{ru.planning.noSource}</span>}
              </div>
              {planning?.updatedAt ? <span className="planning-updated">{ru.planning.planUpdated(formatUiDateTime(new Date(planning.updatedAt)))}</span> : null}
            </div>
            <div className="planning-slide-grid">
              {planningSlides.map((slide, index) => {
                const item = record(slide);
                const narrativeRole = stringValue(firstValue(item, ['narrativeRole']));
                const visualType = stringValue(firstValue(item, ['semanticVisualType']), 'unknown');
                const density = stringValue(firstValue(item, ['targetDensity']), 'unknown');
                const hasNarrativeRole = narrativeRole && !['slide', 'unknown', 'none', 'unspecified'].includes(narrativeRole);
                const hasVisualType = !['unknown', 'none', 'unspecified'].includes(visualType);
                const refs = arrayValue(item, ['contentRefs']).filter((ref): ref is string => typeof ref === 'string');
                const paths = [...new Set(refs.map((ref) => unitSourceById.get(ref)).filter((sourceId): sourceId is string => Boolean(sourceId))
                  .map((sourceId) => sourcePathById.get(sourceId)).filter((path): path is string => Boolean(path)))];
                return (
                  <article className="planning-slide-card" key={stringValue(firstValue(item, ['id']), `slide-${index + 1}`)}>
                    <div className="planning-slide-card-head">
                      <strong>{stringValue(firstValue(item, ['order']), String(index + 1)).padStart(2, '0')}</strong>
                      {hasNarrativeRole ? <span>{ru.planning.narrativeRole(narrativeRole)}</span> : null}
                    </div>
                    <h4>{stringValue(firstValue(item, ['purpose']), ru.planning.purposeUnknown)}</h4>
                    <p className="planning-takeaway">{stringValue(firstValue(item, ['takeaway']), ru.planning.takeawayUnknown)}</p>
                    {hasVisualType || density !== 'unknown' ? <div className="planning-slide-meta">
                      {hasVisualType ? <span>{ru.planning.visualType(visualType)}</span> : null}
                      {density !== 'unknown' ? <span>{ru.planning.density(density)}</span> : null}
                    </div> : null}
                    {paths.length ? <div className="planning-source-paths" data-has-sources="true">
                      <strong>{ru.planning.sources}</strong>{paths.map((path) => <span key={path} title={path}>{path}</span>)}
                    </div> : null}
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
          </div>
        </details> : null}

        {workspaceView === 'brief' ? <div className="workspace-flow-actions brief-flow-actions">
          <button className="quiet" onClick={() => chooseWorkspaceView('template')}>{ru.workspace.backToTemplate}</button>
        </div> : null}
        {workspaceView === 'outline' ? <div className="workspace-flow-actions outline-flow-actions">
          <button className="quiet" onClick={() => chooseWorkspaceView('brief')}>{ru.planning.editBrief}</button>
          <span>{planningSlides.length ? ru.planning.slideCountLabel(planningSlides.length) : ru.planning.generatedTitle}</span>
          <button className="primary icon-next" aria-label={ru.workflow.action} title={ru.workflow.action}
            disabled={!savedPlanReady || planningDraftDirty || productWorkflowRunning} onClick={() => void generatePresentation()}><span>{ru.workflow.action}</span><FigmaIcon name="arrow-right" /></button>
        </div> : null}
      </section>

      <PresentationGenerationPanel
        key={productOperation?.status === 'ready' ? productOperation.operationId : 'workflow-initial'}
        projectId={projectId}
        planningReady={savedPlanReady}
        inputFingerprint={planning?.inputFingerprint ?? null}
        planHash={stringValue(firstValue(planningDeckPlan, ['hash']))}
        contentIRHash={stringValue(firstValue(contentIR, ['hash']))}
        templateIRHash={stringValue(firstValue(templateIR, ['hash']))}
        view={workspaceView}
        productOperation={productOperation}
        auditRefreshError={auditRefreshError}
        auditBusy={productWorkflowBusy}
        onRepeatContextualAudit={() => void repeatContextualAudit()}
        onRetryWorkflow={() => void generatePresentation()}
        onViewChange={chooseWorkspaceView}
        onStateChange={reportGenerationState}
      />

      <details className="advanced-tools developer-tools" id="developer-tools-panel" open={developerToolsOpen}
        onToggle={(event) => setDeveloperToolsOpen(event.currentTarget.open)}>
        <summary>{ru.workspace.technicalTools}</summary>
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
      </details>
      </div>
    </main>
  );
}

function PresentationGenerationPanel({ projectId, planningReady, inputFingerprint, planHash, contentIRHash, templateIRHash, view, productOperation, auditRefreshError, auditBusy, onRepeatContextualAudit, onRetryWorkflow, onViewChange, onStateChange }: {
  projectId: string;
  planningReady: boolean;
  inputFingerprint: string | null;
  planHash: string;
  contentIRHash: string;
  templateIRHash: string;
  view: WorkspaceView;
  productOperation: ProductWorkflowOperation | null;
  auditRefreshError: UiFailure | null;
  auditBusy: boolean;
  onRepeatContextualAudit: () => void;
  onRetryWorkflow: () => void;
  onViewChange: (view: WorkspaceView) => void;
  onStateChange: (complete: boolean, exported: boolean, status?: string | null) => void;
}) {
  const [generation, setGeneration] = useState<GenerationState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<UiFailure | null>(null);
  const [errorOrigin, setErrorOrigin] = useState<'start' | 'action' | null>(null);
  const [activeSlideId, setActiveSlideId] = useState<string | null>(null);
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
    onStateChange(Boolean(isCurrent && generation?.status === 'completed'), Boolean(isCurrent && generation?.exports.length), generation?.status);
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

  useEffect(() => { void load(); }, [load, projectId, productOperation?.generationId]);

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
    setErrorOrigin(null);
    try { await operation(); }
    catch (err) {
      setError(uiFailure(err, ru.errors.render));
      setErrorOrigin(key === 'start' ? 'start' : 'action');
    }
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
  const auditOnlyWorkflowFailure = productOperation?.status === 'failed'
    && productOperation.failure?.stage === 'contextual_audit' && Boolean(productOperation.generationId);
  const generationStatusClass = auditOnlyWorkflowFailure && currentGeneration && generation?.status === 'completed'
    ? 'completed' : productOperation?.status ?? generation?.status ?? 'idle';
  const canExport = currentGeneration && generation?.status === 'completed' && generation.readySlides === generation.totalSlides;
  const canChooseTrack = Boolean(generation?.slides.length) && generation!.slides.every((pack) => pack.status === 'ready'
    && ['A', 'B', 'C'].every((variant) => pack.variants[variant as GenerationVariantId]?.status === 'ready'));
  const visibleGenerationError = visibleGenerationOperationError(error, errorOrigin,
    currentGeneration && generation?.status === 'completed' ? 'completed'
      : currentGeneration && generation?.status === 'failed' && generation.failure ? 'failed' : null);
  const visibleGenerationFailure = visiblePersistedFailure(generation?.failure, generation?.status);
  const activePack = generation?.slides.find((pack) => pack.slideId === activeSlideId)
    ?? generation?.slides.find((pack) => pack.slideId === generation?.currentSlideId)
    ?? generation?.slides[0]
    ?? null;
  const activeVariant = activePack?.variants[activePack.selectedVariant] ?? null;
  const showAuditTransportFailure = Boolean(auditRefreshError || productOperation?.contextualAudit?.status === 'failed');
  const currentWorkflowLabel = productOperation?.status === 'running'
    ? productWorkflowStageLabel(productOperation.stage, productOperation.readySlides, productOperation.totalSlides)
    : currentGeneration && generation?.status === 'completed'
      ? ru.workflow.stages.ready
      : generation?.status === 'generating' || generation?.status === 'preparing'
        ? productWorkflowStageLabel('generating', generation.readySlides, generation.totalSlides)
        : productOperation?.status === 'failed' && !(productOperation.failure?.stage === 'contextual_audit' && productOperation.generationId)
          ? ru.workflow.stages.failed
          : generation?.status === 'failed' ? generationStatusLabel(generation.status)
            : loading ? ru.generation.loading : planningReady ? ru.planning.readyToGenerate : ru.planning.waiting;
  const realProgress = productOperation?.status === 'running' && productOperation.stage === 'generating'
      && productOperation.totalSlides && productOperation.totalSlides > 0
      ? Math.max(0, Math.min(100, productOperation.readySlides / productOperation.totalSlides * 100))
      : currentGeneration && generation && generation.totalSlides > 0
        ? Math.max(0, Math.min(100, generation.readySlides / generation.totalSlides * 100))
        : null;

  const workflowFailure = productOperation?.status === 'failed' && !auditOnlyWorkflowFailure ? productOperation.failure : null;
  const canEditVariants = currentGeneration && canChooseTrack;
  const activePreviewUrl = activeVariant?.previewUrl ? activeVariant.previewUrl + '?v=' + activeVariant.version : null;
  const contextualFindings = productOperation?.contextualAudit?.findings ?? [];
  const contextualAudit = productOperation?.contextualAudit ?? null;
  const viewTitle = view === 'progress' ? currentWorkflowLabel : view === 'audit' ? ru.workflow.reviewTitle : ru.workflow.editSlides;

  return (
    <section className="generation-panel" id="generation-panel" data-view={view} aria-labelledby="generation-panel-title">
      <div className="generation-panel-head">
        <div>
          <span className="eyebrow">{view === 'audit' ? ru.workflow.audit : ru.generation.eyebrow}</span>
          <h2 id="generation-panel-title">{view === 'audit' ? viewTitle : view === 'editor' && canExport ? ru.generation.resultReady : viewTitle}</h2>
          <p>{view === 'progress' ? ru.workflow.working : view === 'audit' ? ru.workflow.suggestionsOnly
            : canExport ? ru.generation.resultSummary(generation?.totalSlides ?? 0) : ru.generation.description}</p>
        </div>
        <div className="generation-actions">
          <span className={'generation-status generation-status-' + generationStatusClass} role="status">
            {loading ? ru.generation.loading : currentWorkflowLabel}
          </span>
          {isActive ? <button className="quiet" onClick={() => void cancel()} disabled={Boolean(busy)}>{ru.generation.cancel}</button> : null}
          {view === 'progress' && productOperation?.status === 'failed' && !auditOnlyWorkflowFailure
            ? <button className="primary" onClick={onRetryWorkflow} disabled={Boolean(busy)}>{ru.errors.retry}</button> : null}
          {view === 'progress' && generation?.status === 'completed' && currentGeneration
            ? <button className="primary" onClick={() => onViewChange('editor')}>{ru.workflow.openResult}</button> : null}
          {view === 'editor' ? <button className="quiet" onClick={() => onViewChange('audit')}>{ru.workflow.openAudit}</button> : null}
          {view === 'audit' ? <button className="quiet" onClick={() => onViewChange('editor')}>{ru.workflow.openEditor}</button> : null}
          {view === 'progress' && !isActive && productOperation?.status !== 'failed'
            ? <button className="quiet" onClick={() => onViewChange('outline')}>{ru.planning.editBrief}</button> : null}
        </div>
      </div>

      {workflowFailure ? <ErrorNotice role="status" className="generation-notice" failure={{
        message: ru.workflow.workflowFailed, ...(workflowFailure.code ? { code: workflowFailure.code } : {}),
      }} onRetry={workflowFailure.retryable ? onRetryWorkflow : undefined} /> : null}
      <ErrorNotice failure={visibleGenerationError} className="generation-error" />
      {visibleGenerationFailure ? <ErrorNotice role="status" className="generation-notice" failure={{
        message: friendlyErrorMessage(visibleGenerationFailure.code, 500, 'generation'),
        ...(visibleGenerationFailure.code ? { code: visibleGenerationFailure.code } : {}),
      }} onRetry={visibleGenerationFailure.code === 'VARIANTS_NOT_DISTINCT' ? undefined : () => void start()} /> : null}
      {view === 'progress' && showAuditTransportFailure && productOperation?.contextualAudit?.status === 'failed'
        ? <div className="audit-transport-note" role="status">{ru.workflow.contextualFailed}</div> : null}
      {generation && !currentGeneration ? <div className="planning-notice planning-notice-warning" role="status">{ru.workflow.previousGeneration}</div> : null}

      {view === 'progress' ? (
        <div className="workflow-progress-shell" role="status" aria-live="polite" aria-busy={isActive || productOperation?.status === 'running'}>
          <div className="workflow-progress-copy">
            <strong>{currentWorkflowLabel}</strong>
            {productOperation?.status === 'running' && productOperation.stage === 'generating'
              && productOperation.totalSlides && productOperation.totalSlides > 0
              ? <span>{ru.generation.slideProgress(productOperation.readySlides, productOperation.totalSlides)}</span>
              : currentGeneration && generation && generation.totalSlides > 0 && productOperation?.status !== 'running'
                ? <span>{ru.generation.slideProgress(generation.readySlides, generation.totalSlides)}</span>
                : <span>{productOperation?.status === 'failed' ? ru.workflow.workflowFailed : ru.workflow.working}</span>}
          </div>
          <div className="workflow-progress-track" role="progressbar" aria-label={currentWorkflowLabel}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={realProgress ?? undefined} data-indeterminate={realProgress === null}>
            <i style={realProgress === null ? undefined : { width: realProgress + '%' }} />
          </div>
          {generation?.slides.length && (productOperation?.status !== 'running' || productOperation.generationId === generation.generationId) ? <ol className="workflow-slide-status-list">
            {generation.slides.map((pack) => <li key={pack.slideId}>
              <span className="workflow-slide-index">{String(pack.index).padStart(2, '0')}</span>
              <span className="workflow-slide-title">{pack.title}</span>
              <span className={'workflow-slide-state pack-status-' + pack.status}>{slidePackStatusLabel(pack.status, pack.failure?.code)}</span>
            </li>)}
          </ol> : null}
          {!generation && !productOperation ? <p className="generation-empty-hint">{ru.generation.noGeneration}</p> : null}
        </div>
      ) : null}

      {(view === 'editor' || view === 'audit') ? generation?.slides.length ? (
        <div className={'presentation-editor' + (view === 'audit' ? ' presentation-audit-editor' : '')}>
          <nav className="editor-slide-rail" aria-label={ru.workflow.chooseSlide}>
            {generation.slides.map((pack) => {
              const selected = pack.variants[pack.selectedVariant];
              const preview = selected?.previewUrl ? selected.previewUrl + '?v=' + selected.version : null;
              return <button type="button" key={pack.slideId}
                className={'editor-slide-thumb' + (activePack?.slideId === pack.slideId ? ' active' : '')}
                aria-current={activePack?.slideId === pack.slideId ? 'true' : undefined}
                onClick={() => setActiveSlideId(pack.slideId)}>
                <span>{String(pack.index).padStart(2, '0')}</span>
                {preview ? <img src={preview} alt="" /> : <span className="editor-thumb-empty">{ru.workflow.slidePreviewUnavailable}</span>}
                <strong>{pack.title}</strong>
              </button>;
            })}
          </nav>
          <div className="editor-canvas-column">
            <div className="editor-canvas">
              {activePreviewUrl ? <img src={activePreviewUrl} alt={ru.generation.previewAlt(activePack?.index ?? 0, activePack?.selectedVariant ?? 'A')} />
                : <div className="editor-preview-empty" role="status">{ru.workflow.slidePreviewUnavailable}</div>}
            </div>
            {view === 'audit' && activePack ? <div className="audited-slide-caption">
              <span>{ru.workflow.slideLabel(activePack.index)}</span><strong>{activePack.title}</strong>
            </div> : null}
            {view === 'editor' && activePack ? <div className="editor-variant-grid" role="group" aria-label={ru.generation.defaultTrack}>
              {(['A', 'B', 'C'] as const).map((variant) => {
                const item = activePack.variants[variant];
                const available = activePack.status === 'ready' && item.status === 'ready' && Boolean(item.previewUrl);
                return <article className={'editor-variant-card' + (activePack.selectedVariant === variant ? ' selected' : '')} key={variant}>
                  <button type="button" className="editor-variant-preview" disabled={!item.previewUrl}
                    onClick={() => setActiveSlideId(activePack.slideId)} aria-label={ru.generation.slideVariantLabel(activePack.index, variant)}>
                    {item.previewUrl ? <img src={item.previewUrl + '?v=' + item.version} alt={ru.generation.previewAlt(activePack.index, variant)} />
                      : <span>{ru.workflow.slidePreviewUnavailable}</span>}
                  </button>
                  <div className="editor-variant-card-footer">
                    <strong>{ru.generation.variant(variant)}</strong>
                    {activePack.recommendedVariant === variant ? <span className="recommended-mark">{ru.generation.recommended}</span> : null}
                    <button type="button" className={activePack.selectedVariant === variant ? 'primary' : 'quiet'}
                      disabled={!available || !canEditVariants || Boolean(busy)} aria-pressed={activePack.selectedVariant === variant}
                      onClick={() => chooseSlide(activePack, variant)}>
                      {activePack.selectedVariant === variant ? ru.generation.selected(variant) : ru.generation.choose(variant)}
                    </button>
                  </div>
                </article>;
              })}
            </div> : null}
          </div>
          <aside className={'editor-inspector' + (view === 'audit' ? ' audit-inspector' : '')}>
            {view === 'audit' ? <>
              <section data-audit-source="contextual" aria-labelledby="contextual-audit-title">
                <div className="audit-panel-heading">
                  <div><span className="eyebrow">{ru.workflow.audit}</span><h3 id="contextual-audit-title">{ru.workflow.reviewTitle}</h3></div>
                  <button type="button" className="quiet compact" disabled={auditBusy || Boolean(busy) || productOperation?.status === 'running'}
                    onClick={onRepeatContextualAudit}>{ru.workflow.retryAudit}</button>
                </div>
                {auditRefreshError ? <ErrorNotice failure={auditRefreshError} className="generation-error" /> : null}
                {contextualAudit?.status === 'failed' ? <div className="audit-transport-note" role="status">
                  {ru.workflow.auditTransportUnavailable}
                  {contextualAudit.failureCode ? <details className="diagnostic-details"><summary>{ru.template.diagnosticLabel}</summary><code>{contextualAudit.failureCode}</code></details> : null}
                </div> : contextualAudit?.status === 'ready' ? <>
                  {contextualAudit.stale ? <div className="planning-notice planning-notice-warning">{ru.workflow.auditStale}</div> : null}
                  {contextualFindings.filter((finding) => !finding.slideId || finding.slideId === activePack?.slideId).length ? <ul className="contextual-audit-list">
                    {contextualFindings.filter((finding) => !finding.slideId || finding.slideId === activePack?.slideId).map((finding, index) => (
                      <li key={finding.ruleId + '-' + index} className={'audit-finding severity-' + finding.severity}>
                        <span className="finding-severity">{ru.planning.findingSeverity(finding.severity)}</span>
                        <div><strong>{finding.slideId ? ru.workflow.slideLabel(activePack?.index ?? 0) : ru.workflow.deckLabel}</strong>
                          <p>{ru.workflow.messages[finding.messageCode]}</p>
                          {finding.evidenceRefs.length ? <details><summary>{ru.workflow.findings}</summary><code>{finding.evidenceRefs.join(' · ')}</code></details> : null}
                        </div>
                      </li>
                    ))}
                  </ul> : <p className="planning-muted">{ru.workflow.noContextualFindings}</p>}
                </> : <p className="planning-muted">{ru.workflow.auditResultsUnavailable}</p>}
              </section>
              <section className="audit-inspector-deterministic" data-audit-source="deterministic" aria-labelledby="deterministic-audit-title">
                <div className="audit-panel-heading"><div><span className="eyebrow">{ru.generation.audit}</span><h3 id="deterministic-audit-title">{ru.workflow.deterministicAudit}</h3></div></div>
                {activePack && activeVariant?.audit?.findings?.length ? <ul className="deterministic-audit-findings">
                  {activeVariant.audit.findings.map((value, index) => {
                    const finding = record(value);
                    const findingId = stringValue(firstValue(finding, ['id']));
                    const rule = stringValue(firstValue(finding, ['ruleId']), 'audit');
                    const rawSeverity = stringValue(firstValue(finding, ['severity', 'level']), 'info');
                    const severity = rawSeverity === 'error' || rawSeverity === 'warning' || rawSeverity === 'info' ? rawSeverity : 'info';
                    const safeFix = firstValue(finding, ['autofixAvailable']) === true;
                    return <li className={'audit-finding severity-' + severity} key={findingId + '-' + index}>
                      <span className="finding-severity">{ru.planning.findingSeverity(severity)}</span>
                      <div><p>{auditFindingMessage(rule)}</p>
                        {safeFix ? <button type="button" className="quiet compact" disabled={!currentGeneration || Boolean(busy) || !findingId} onClick={() => repair(activePack, activePack.selectedVariant, findingId)}>{ru.generation.applyFix}</button>
                          : <small>{ru.workflow.replan}</small>}
                      </div>
                    </li>;
                  })}
                </ul> : <div className="audit-pass-note"><strong>{ru.generation.auditSummary(0, 0)}</strong><p>{ru.generation.noAuditFindings}</p></div>}
              </section>
            </> : activePack ? <>
              <span className="eyebrow">{ru.generation.slide(String(activePack.index).padStart(2, '0'))}</span>
              <h3>{activePack.title}</h3>
              <span className={'generation-pack-status pack-status-' + activePack.status}>{slidePackStatusLabel(activePack.status, activePack.failure?.code)}</span>
              <div className="editor-audit-summary"><strong>{ru.workflow.deterministicAudit}</strong>
                <span className="generation-audit-badge" data-errors={activePack.auditSummary.errors > 0}>
                  {ru.generation.auditSummary(activePack.auditSummary.errors, activePack.auditSummary.warnings)}
                </span>
              </div>
              <button type="button" className="quiet editor-lock-button" disabled={!canEditVariants || activePack.status !== 'ready' || Boolean(busy)}
                onClick={() => toggleLock(activePack)}>
                {activePack.lockedVariant ? ru.generation.unlock(activePack.lockedVariant) : ru.generation.lock(activePack.selectedVariant)}
              </button>
              <details className="advanced-tools editor-audit-details">
                <summary>{ru.workflow.deterministicAudit}</summary>
                {activeVariant?.audit?.findings?.length ? <ul>{activeVariant.audit.findings.map((value, index) => {
                  const finding = record(value);
                  const findingId = stringValue(firstValue(finding, ['id']));
                  const rule = stringValue(firstValue(finding, ['ruleId']), 'audit');
                  const safeFix = firstValue(finding, ['autofixAvailable']) === true;
                  return <li key={findingId + '-' + index}>
                    <span>{auditFindingMessage(rule)}</span>
                    {safeFix ? <button type="button" className="quiet compact" disabled={!currentGeneration || Boolean(busy) || !findingId} onClick={() => repair(activePack, activePack.selectedVariant, findingId)}>{ru.generation.applyFix}</button>
                      : <small>{ru.workflow.replan}</small>}
                  </li>;
                })}</ul> : <p>{ru.generation.noAuditFindings}</p>}
              </details>
            </> : <p className="generation-empty-hint">{ru.workflow.chooseSlide}</p>}
          </aside>
        </div>
      ) : <p className="generation-empty-hint">{ru.generation.noGeneration}</p> : null}

      {(view === 'editor' || view === 'audit') && generation ? (
        <section className="generation-export generation-export-compact" aria-label={ru.generation.exportTitle}>
          <div><span className="eyebrow">{ru.generation.exportTitle}</span><h3>{ru.generation.exportHeading}</h3>
            <p>{ru.generation.exportDescription}</p></div>
          <div className="generation-export-actions">
            <button type="button" className="primary" disabled={!canExport || Boolean(busy)} onClick={() => exportDeck('selected', 'pptx')}>
              {busy === 'export-selected-pptx' ? ru.generation.assembling : ru.generation.downloadPptx}
            </button>
            <button type="button" className="quiet" disabled={!canExport || Boolean(busy)} onClick={() => exportDeck('selected', 'pdf')}>{ru.generation.downloadPdf}</button>
            <button type="button" className="quiet" disabled={!canExport || Boolean(busy)} onClick={() => exportDeck('selected', 'html')}>{ru.generation.downloadHtml}</button>
          </div>
          {generation.exports.length ? <ul className="generation-export-list">{generation.exports.map((artifact) => <li key={artifact.id}>
            <a href={artifact.downloadUrl} download>{ru.generation.exportAction(artifact.mode, artifact.format ?? 'pptx')}</a>
            <span>{ru.generation.validated}</span>
          </li>)}</ul> : null}
        </section>
      ) : null}
      {(view === 'editor' || view === 'progress') && generation ? (
        <details className="advanced-tools generation-advanced"><summary>{ru.workspace.advancedMode}</summary>
          <div className="advanced-tools-content"><div className="generation-track-picker" role="group" aria-label={ru.generation.defaultTrack}>
            <span>{ru.generation.defaultTrack}</span>
            {(['A', 'B', 'C'] as const).map((variant) => <button type="button" key={variant} className={generation.defaultTrack === variant ? 'active' : ''}
              aria-pressed={generation.defaultTrack === variant} disabled={!canEditVariants || Boolean(busy)} onClick={() => chooseTrack(variant)}>
              {ru.generation.track(variant, variant === 'A')}
            </button>)}
          </div>
          <div className="selected-export">
            <span className="selected-export-label">{ru.generation.editablePowerPoint}</span>
            <button className="quiet" onClick={() => void start()}
              disabled={!planningReady || loading || Boolean(busy) || currentGeneration && (generation?.status === 'completed' || generation?.status === 'cancelled')}>
              {currentGeneration && generation?.status === 'failed' ? ru.generation.resume : ru.generation.generate}
            </button>
          </div>
          <details className="advanced-tools variant-exports">
            <summary>{ru.generation.otherVariants}</summary>
            <div className="advanced-tools-content">
              {(['A', 'B', 'C'] as const).map((mode) => <div className="variant-export-row" key={mode}>
                <strong>{ru.generation.variant(mode)}</strong>
                {(['pptx', 'pdf', 'html'] as const).map((format) => <button key={format} className="quiet"
                  disabled={!canExport || Boolean(busy)} onClick={() => exportDeck(mode, format)}>
                  {busy === 'export-' + mode + '-' + format ? ru.generation.assembling : ru.generation.exportAction(mode, format)}
                </button>)}
              </div>)}
            </div>
          </details>
          </div>
        </details>
      ) : null}
    </section>
  );
}
