import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { PDFDocument } from 'pdf-lib';

import { assertSafeProjectId } from '../../presentation-files.js';
import {
  getPresentationGeneration,
  listRecoverablePresentationGenerations,
  startPresentationGeneration,
  updatePresentationGeneration,
} from '../../presentation-generation-store.js';
import { resolvePresentationFilePath } from '../../presentation-files.js';
import type { PlanningResponse, PlanningService } from './planning-service.js';
import { getTemplateCompilation, type TemplateCompilationResponse } from './template-compiler.js';
import { compilePresentation, UnsupportedTemplateLayoutError, VARIANT_POLICIES, type CompiledPresentation, type CompiledSlide, type PresentationVariantId } from './slide-compilation.js';
import { auditCompiledPresentation, type DeterministicAuditReport } from './deterministic-audit.js';
import {
  applyPersistedExemplarSelection,
  applyVariantCompositionAssignment,
  assessVariantCompositionDistinctness,
  createCompositionVisualClassificationCache,
  exemplarSelectionReference,
  type ExemplarSelectionReference,
  type VariantCompositionAssignment,
} from './exemplar-slide-selector.js';
import { renderPresentation } from '../adapters/pptx-renderer-factory.js';
import { OfficeKitPreviewAdapter } from '../adapters/office-kit-preview-adapter.js';
import { inspectOfficeKitPackage } from '../adapters/office-kit-package-inspector.js';
import { OfficeKitPdfExportAdapter } from '../adapters/office-kit-pdf-export-adapter.js';
import { SemanticHtmlExportAdapter } from '../adapters/semantic-html-export-adapter.js';
import type { PptxBackendId, PptxRendererPort, PptxRenderResult } from './pptx-backend-port.js';
import type { PptxPreviewPort } from './pptx-preview-port.js';
import type { ContentIR } from '../domain/content-ir.js';
import type { DeckPlan } from '../domain/deck-plan.js';
import type { TemplateIR } from '../domain/template-ir.js';
import type { TemplateSemanticProfile } from './template-semantic-profiler.js';
import { recordElapsed, type PerformanceDiagnosticsPort } from '../../presentation/performance-diagnostics.js';
import { isPreviewLayoutIssueSummary, summarizePreviewLayoutEvidence, type PreviewLayoutIssueSummary } from './preview-layout-evidence.js';

export type GenerationStatus = 'preparing' | 'generating' | 'completed' | 'failed' | 'cancelled' | 'stale';
export type SlideGenerationStatus = 'pending' | 'rendering' | 'ready' | 'failed';
export type VisualSlotStatus = 'not-applicable' | 'ready' | 'unresolved';
export type GenerationExportMode = 'selected' | PresentationVariantId;
export type GenerationExportFormat = 'pptx' | 'pdf' | 'html';

export interface GeneratedVariantState {
  status: 'pending' | 'ready' | 'failed';
  version: number;
  layoutCandidateIndex: number;
  /** Persisted internal renderer choice; intentionally omitted from the public generation API. */
  nativeLayoutFallback: boolean;
  /** Exact internal composition assignment; omitted from the public generation API. */
  compositionChoice: {
    kind: VariantCompositionAssignment['compositionKind'];
    signature: string;
    exemplar: ExemplarSelectionReference | null;
  } | null;
  previewRef: string | null;
  layoutIssueCount: number;
  /** Additive, replaceable preview diagnostics; omitted on older saved generations. */
  layoutIssueSummary?: PreviewLayoutIssueSummary;
  visualSlotStatus: VisualSlotStatus;
  audit: DeterministicAuditReport | null;
  renderCheck: Pick<PptxRenderResult, 'backend' | 'slideCount' | 'reopenStatus' | 'validationStatus' | 'templatePreservationStatus' | 'unresolvedVisualTypes'> | null;
}

export interface GeneratedSlidePack {
  slideId: string;
  index: number;
  title: string;
  recommendedVariant: PresentationVariantId;
  status: SlideGenerationStatus;
  version: number;
  lockedVariant: PresentationVariantId | null;
  variants: Record<PresentationVariantId, GeneratedVariantState>;
  auditSummary: { errors: number; warnings: number; infos: number };
  failure: { code: string; message: string } | null;
}

export interface GeneratedExport {
  id: string;
  mode: GenerationExportMode;
  format: GenerationExportFormat;
  fileRef: string;
  sha256: string;
  slideCount: number;
  validationStatus: 'passed';
  nativeOfficeStatus: 'unknown';
  unresolvedVisualTypes: string[];
  createdAt: string;
}

export interface PresentationGenerationState {
  schemaVersion: 1;
  projectId: string;
  generationId: string;
  idempotencyKey: string;
  inputFingerprint: string;
  planId: string;
  planHash: string;
  contentIRHash: string;
  templateIRHash: string;
  templateFilePath: string;
  backend: PptxBackendId;
  status: GenerationStatus;
  revision: number;
  readySlides: number;
  totalSlides: number;
  currentSlideId: string | null;
  defaultTrack: PresentationVariantId;
  selectionOverrides: Record<string, PresentationVariantId>;
  selectionVersion: number;
  slides: GeneratedSlidePack[];
  exports: GeneratedExport[];
  failure: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicGeneratedVariant extends Omit<GeneratedVariantState, 'previewRef' | 'nativeLayoutFallback' | 'compositionChoice'> {
  previewUrl: string | null;
}
export interface PublicGeneratedSlidePack extends Omit<GeneratedSlidePack, 'variants'> {
  selectedVariant: PresentationVariantId;
  variants: Record<PresentationVariantId, PublicGeneratedVariant>;
}
export interface PublicPresentationGeneration extends Omit<PresentationGenerationState, 'slides' | 'templateFilePath' | 'exports'> {
  slides: PublicGeneratedSlidePack[];
  exports: Array<Omit<GeneratedExport, 'fileRef'> & { downloadUrl: string }>;
}

export interface GenerationContext {
  planning: PlanningResponse;
  deckPlan: DeckPlan;
  contentIR: ContentIR;
  template: TemplateCompilationResponse;
  templateIR: TemplateIR;
  semanticProfile?: TemplateSemanticProfile;
  templatePath: string;
  fingerprint: string;
}

export interface PresentationGenerationServiceOptions {
  db: Database.Database;
  projectsRoot: string;
  planningService: PlanningService;
  backend: PptxBackendId;
  renderer?: PptxRendererPort;
  preview?: PptxPreviewPort;
  pdfExporter?: Pick<OfficeKitPdfExportAdapter, 'export'>;
  htmlExporter?: Pick<SemanticHtmlExportAdapter, 'export'>;
  /** Replaceable dependency seams for offline API tests. */
  inspectPackage?: typeof inspectOfficeKitPackage;
  profileTemplate?: (projectId: string, template: TemplateCompilationResponse) => Promise<TemplateSemanticProfile>;
  performanceDiagnostics?: PerformanceDiagnosticsPort;
  now?: () => Date;
}

export class PresentationGenerationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PresentationGenerationError';
    this.code = code;
    this.status = status;
  }
}

const VARIANT_IDS = ['A', 'B', 'C'] as const satisfies readonly PresentationVariantId[];
const SLIDE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVariantId(value: unknown): value is PresentationVariantId {
  return value === 'A' || value === 'B' || value === 'C';
}

function isSafeFailure(value: unknown): value is { code: string; message: string } {
  return value === null || isRecord(value) && typeof value.code === 'string'
    && value.code.length > 0 && value.code.length <= 80
    && typeof value.message === 'string' && value.message.length > 0 && value.message.length <= 1000;
}

function isSafeCompositionChoice(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!isRecord(value) || !['exemplar-backed', 'layout-placeholder-backed', 'safe-generated-fallback'].includes(String(value.kind))
      || typeof value.signature !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.signature)) return false;
  if (value.exemplar === null) return value.kind !== 'exemplar-backed';
  return value.kind === 'exemplar-backed' && isRecord(value.exemplar)
    && typeof value.exemplar.sourcePart === 'string'
    && /^\/?ppt\/slides\/[^/]+\.xml$/.test(value.exemplar.sourcePart)
    && !value.exemplar.sourcePart.includes('..')
    && Number.isSafeInteger(value.exemplar.sourceSlideIndex) && Number(value.exemplar.sourceSlideIndex) >= 0
    && value.exemplar.projectedCompositionSignature === value.signature;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function deterministicUuid(seed: string): string {
  const hex = seed.slice(0, 32);
  const variant = (8 + (Number.parseInt(hex[16]!, 16) % 4)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function sourceContextFingerprint(input: {
  inputFingerprint: string;
  planHash: string;
  contentIRHash: string;
  templateIRHash: string;
}): string {
  return sha256(JSON.stringify(input));
}

function emptyVariant(): GeneratedVariantState {
  return {
    status: 'pending', version: 0, layoutCandidateIndex: 0, nativeLayoutFallback: false, compositionChoice: null,
    previewRef: null, layoutIssueCount: 0, layoutIssueSummary: { total: 0, blocking: 0, warnings: 0, approximate: 0, details: [] },
    visualSlotStatus: 'unresolved', audit: null, renderCheck: null,
  };
}

function validateStoredGeneration(value: unknown): PresentationGenerationState {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.projectId !== 'string'
      || typeof value.generationId !== 'string' || typeof value.idempotencyKey !== 'string'
      || typeof value.inputFingerprint !== 'string' || typeof value.planId !== 'string'
      || typeof value.planHash !== 'string' || typeof value.contentIRHash !== 'string'
      || typeof value.templateIRHash !== 'string' || typeof value.templateFilePath !== 'string'
      || !['custom', 'office-kit'].includes(String(value.backend))
      || !['preparing', 'generating', 'completed', 'failed', 'cancelled', 'stale'].includes(String(value.status))
      || !Number.isSafeInteger(value.revision) || !Number.isSafeInteger(value.readySlides)
      || !Number.isSafeInteger(value.totalSlides) || !Array.isArray(value.slides)
      || !Array.isArray(value.exports) || !['A', 'B', 'C'].includes(String(value.defaultTrack))
      || !isRecord(value.selectionOverrides) || !Number.isSafeInteger(value.selectionVersion)
      || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
      || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
      || !isSafeFailure(value.failure) || !/^[a-f0-9]{64}$/.test(value.inputFingerprint)
      || !/^[a-f0-9]{64}$/.test(value.planHash) || !/^[a-f0-9]{64}$/.test(value.contentIRHash)
      || !/^[a-f0-9]{64}$/.test(value.templateIRHash) || path.isAbsolute(value.templateFilePath)
      || !SLIDE_ID.test(value.planId) || !IDEMPOTENCY_KEY.test(value.idempotencyKey)
      || Number(value.totalSlides) < 1 || value.slides.length !== Number(value.totalSlides)
      || Number(value.readySlides) < 0 || Number(value.readySlides) > Number(value.totalSlides) || Number(value.revision) < 1
      || Number(value.selectionVersion) < 0) {
    throw new PresentationGenerationError('GENERATION_STATE_INVALID', 'Saved slide generation state is invalid. Reload the project and start generation again.', 500);
  }
  const state = value as unknown as PresentationGenerationState;
  const slideIds = new Set<string>();
  for (const [index, pack] of state.slides.entries()) {
    if (!isRecord(pack) || typeof pack.slideId !== 'string' || !SLIDE_ID.test(pack.slideId) || slideIds.has(pack.slideId)
        || pack.index !== index + 1 || typeof pack.title !== 'string' || pack.title.length > 1000
        || !isVariantId(pack.recommendedVariant) || !['pending', 'rendering', 'ready', 'failed'].includes(String(pack.status))
        || !Number.isSafeInteger(pack.version) || pack.version < 1 || !(pack.lockedVariant === null || isVariantId(pack.lockedVariant))
        || !isRecord(pack.variants) || !isRecord(pack.auditSummary)
        || ![pack.auditSummary.errors, pack.auditSummary.warnings, pack.auditSummary.infos].every((count) => Number.isSafeInteger(count) && Number(count) >= 0)
        || !isSafeFailure(pack.failure)) {
      throw new PresentationGenerationError('GENERATION_STATE_INVALID', 'Saved slide pack state is invalid.', 500);
    }
    slideIds.add(pack.slideId);
    for (const variant of VARIANT_IDS) {
      const generated = pack.variants[variant];
      if (!isRecord(generated) || !['pending', 'ready', 'failed'].includes(String(generated.status))
          || !Number.isSafeInteger(generated.version) || generated.version < 0
          || !Number.isSafeInteger(generated.layoutCandidateIndex) || generated.layoutCandidateIndex < 0
          || !(generated.nativeLayoutFallback === undefined || typeof generated.nativeLayoutFallback === 'boolean')
          || !isSafeCompositionChoice(generated.compositionChoice)
          || !(generated.previewRef === null || typeof generated.previewRef === 'string'
            && generated.previewRef.startsWith(`${state.generationId}/slides/`)
            && !generated.previewRef.includes('..') && !path.isAbsolute(generated.previewRef))
          || !Number.isSafeInteger(generated.layoutIssueCount) || generated.layoutIssueCount < 0
          || !(generated.layoutIssueSummary === undefined || isPreviewLayoutIssueSummary(generated.layoutIssueSummary))
          || !['not-applicable', 'ready', 'unresolved'].includes(String(generated.visualSlotStatus))
          || !(generated.audit === null || isRecord(generated.audit) && Array.isArray(generated.audit.findings))
          || !(generated.renderCheck === null || isRecord(generated.renderCheck))) {
        throw new PresentationGenerationError('GENERATION_STATE_INVALID', 'Saved slide variant state is invalid.', 500);
      }
      if (pack.status === 'ready' && (generated.status !== 'ready' || !generated.previewRef || !generated.audit)) {
        throw new PresentationGenerationError('GENERATION_STATE_INVALID', 'A ready pack is missing a rendered variant or audit.', 500);
      }
    }
  }
  for (const [slideId, variant] of Object.entries(state.selectionOverrides)) {
    if (!slideIds.has(slideId) || !isVariantId(variant)) throw new PresentationGenerationError('GENERATION_STATE_INVALID', 'Saved slide selections are invalid.', 500);
  }
  if (state.readySlides !== state.slides.filter((pack) => pack.status === 'ready').length
      || state.status === 'completed' && state.readySlides !== state.totalSlides) {
    throw new PresentationGenerationError('GENERATION_STATE_INVALID', 'Saved generation progress does not match its slide packs.', 500);
  }
  for (const artifact of state.exports) {
    if (!isRecord(artifact) || typeof artifact.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(artifact.id)
        || !(artifact.mode === 'selected' || isVariantId(artifact.mode))
        || !(artifact.format === undefined || artifact.format === 'pptx' || artifact.format === 'pdf' || artifact.format === 'html')
        || typeof artifact.fileRef !== 'string' || !artifact.fileRef.startsWith(`${state.generationId}/exports/`)
        || artifact.fileRef.includes('..') || path.isAbsolute(artifact.fileRef)
        || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)
        || artifact.slideCount !== state.totalSlides || artifact.validationStatus !== 'passed'
        || artifact.nativeOfficeStatus !== 'unknown' || !Array.isArray(artifact.unresolvedVisualTypes)
        || typeof artifact.createdAt !== 'string' || !Number.isFinite(Date.parse(artifact.createdAt))) {
      throw new PresentationGenerationError('GENERATION_STATE_INVALID', 'Saved PowerPoint export metadata is invalid.', 500);
    }
    // Older persisted state predates the format field; those artifacts were always PPTX.
    if (artifact.format === undefined) artifact.format = 'pptx';
    const extension = artifact.format === 'pptx' ? '.pptx' : artifact.format === 'pdf' ? '.pdf' : '.html';
    if (!artifact.fileRef.endsWith(extension)) {
      throw new PresentationGenerationError('GENERATION_STATE_INVALID', 'Saved export format does not match its artifact file.', 500);
    }
  }
  return state;
}

function variantsById<T>(map: Map<PresentationVariantId, T>, variant: PresentationVariantId): T {
  const item = map.get(variant);
  if (!item) throw new PresentationGenerationError('VARIANT_NOT_READY', `Variant ${variant} is unavailable.`, 409);
  return item;
}

function singleSlidePresentation(presentation: CompiledPresentation, slide: CompiledSlide): CompiledPresentation {
  const copy = structuredClone(slide);
  const payload = { ...presentation, slides: [copy] };
  return { ...payload, id: `compiled_${sha256(`${presentation.id}/${slide.id}`).slice(0, 24)}` };
}

function auditForSlide(
  presentation: CompiledPresentation,
  contentIR: ContentIR,
  templateIR: TemplateIR,
  slide: CompiledSlide,
): DeterministicAuditReport {
  return auditCompiledPresentation(singleSlidePresentation(presentation, slide), contentIR, templateIR);
}

function auditSummary(reports: Array<DeterministicAuditReport | null>): GeneratedSlidePack['auditSummary'] {
  const findings = reports.flatMap((report) => report?.findings ?? []);
  return {
    errors: findings.filter((finding) => finding.severity === 'error').length,
    warnings: findings.filter((finding) => finding.severity === 'warning').length,
    infos: findings.filter((finding) => finding.severity === 'info').length,
  };
}

async function applicationVersion(): Promise<string | null> {
  try {
    const metadata = JSON.parse(await readFile(new URL('../../../../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof metadata.version === 'string' && metadata.version.length <= 64 ? metadata.version : null;
  } catch {
    return null;
  }
}

function selectedVariant(state: PresentationGenerationState, slideId: string): PresentationVariantId {
  return state.selectionOverrides[slideId] ?? state.defaultTrack;
}

function publicSnapshot(stateValue: PresentationGenerationState): PublicPresentationGeneration {
  const state = validateStoredGeneration(stateValue);
  const slides = state.slides.map((pack): PublicGeneratedSlidePack => ({
    ...pack,
    selectedVariant: selectedVariant(state, pack.slideId),
    variants: Object.fromEntries(VARIANT_IDS.map((variant) => {
      const { previewRef, nativeLayoutFallback: _nativeLayoutFallback, compositionChoice: _compositionChoice, ...metadata } = pack.variants[variant];
      return [variant, {
        ...metadata,
        previewUrl: previewRef ? `/api/projects/${encodeURIComponent(state.projectId)}/generation/previews/${encodeURIComponent(pack.slideId)}/${variant}` : null,
      }];
    })) as Record<PresentationVariantId, PublicGeneratedVariant>,
  }));
  const exports = state.exports.map(({ fileRef: _fileRef, ...item }) => ({
    ...item,
    downloadUrl: `/api/projects/${encodeURIComponent(state.projectId)}/generation/exports/${encodeURIComponent(item.id)}`,
  }));
  const { templateFilePath: _templateFilePath, ...publicState } = state;
  return { ...publicState, slides, exports };
}

export class PresentationGenerationService {
  private readonly tasks = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  private readonly repairTasks = new Map<string, Promise<PublicPresentationGeneration>>();
  private readonly exportTasks = new Map<string, Promise<{ state: PublicPresentationGeneration; artifact: Omit<GeneratedExport, 'fileRef'> & { downloadUrl: string } }>>();
  private readonly now: () => Date;
  private readonly renderer: PptxRendererPort;
  private readonly preview: PptxPreviewPort;
  private readonly inspectPackage: typeof inspectOfficeKitPackage;
  private readonly pdfExporter: Pick<OfficeKitPdfExportAdapter, 'export'>;
  private readonly htmlExporter: Pick<SemanticHtmlExportAdapter, 'export'>;

  constructor(private readonly options: PresentationGenerationServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.renderer = options.renderer ?? { id: options.backend, render: (input) => renderPresentation(input, options.backend) };
    this.preview = options.preview ?? new OfficeKitPreviewAdapter(options.performanceDiagnostics);
    this.inspectPackage = options.inspectPackage ?? inspectOfficeKitPackage;
    this.pdfExporter = options.pdfExporter ?? new OfficeKitPdfExportAdapter();
    this.htmlExporter = options.htmlExporter ?? new SemanticHtmlExportAdapter();
  }

  async context(projectIdValue: string): Promise<GenerationContext> {
    const projectId = assertSafeProjectId(projectIdValue);
    const [planning, template] = await Promise.all([
      this.options.planningService.get(projectId),
      getTemplateCompilation(this.options.projectsRoot, projectId),
    ]);
    if (planning.status !== 'ready' || !planning.deckPlan || !planning.contentIR || !planning.inputFingerprint) {
      throw new PresentationGenerationError('PLANNING_NOT_READY', 'Generate or refresh the outline and wait until the saved plan is ready.', 409);
    }
    if (template.status !== 'ready' || !template.templateIR) {
      throw new PresentationGenerationError('TEMPLATE_NOT_READY', 'Analyze the current PowerPoint template before generating slide packs.', 409);
    }
    const templateFilePath = template.templateIR.source.filePath;
    let templatePath: string;
    try {
      templatePath = (await resolvePresentationFilePath(this.options.projectsRoot, projectId, templateFilePath, { requireExisting: true })).absolute;
    } catch (error) {
      throw new PresentationGenerationError('TEMPLATE_SOURCE_MISSING', 'The analyzed PowerPoint template is missing or outside the project. Reanalyze the template.', 409, { cause: error });
    }
    const fingerprint = sourceContextFingerprint({
      inputFingerprint: planning.inputFingerprint,
      planHash: planning.deckPlan.hash,
      contentIRHash: planning.contentIR.hash,
      templateIRHash: template.templateIR.hash,
    });
    const semanticProfile = this.options.profileTemplate
      ? await this.options.profileTemplate(projectId, template)
      : undefined;
    return {
      planning,
      deckPlan: planning.deckPlan,
      contentIR: planning.contentIR,
      template,
      templateIR: template.templateIR,
      ...(semanticProfile ? { semanticProfile } : {}),
      templatePath,
      fingerprint,
    };
  }

  async start(projectIdValue: string, keyValue: unknown): Promise<{ state: PublicPresentationGeneration; created: boolean }> {
    const projectId = assertSafeProjectId(projectIdValue);
    if (typeof keyValue !== 'string' || !IDEMPOTENCY_KEY.test(keyValue)) {
      throw new PresentationGenerationError('INVALID_IDEMPOTENCY_KEY', 'Send an Idempotency-Key containing 8 to 128 safe characters.', 400);
    }
    if (!this.tasks.has(projectId) && this.tasks.size >= 2) {
      throw new PresentationGenerationError('GENERATION_CAPACITY', 'Generation capacity is full. Wait for another presentation to finish and retry.', 429);
    }
    const context = await this.context(projectId);
    const now = this.now().toISOString();
    const state: PresentationGenerationState = {
      schemaVersion: 1,
      projectId,
      generationId: randomUUID(),
      idempotencyKey: keyValue,
      inputFingerprint: context.fingerprint,
      planId: context.deckPlan.id,
      planHash: context.deckPlan.hash,
      contentIRHash: context.contentIR.hash,
      templateIRHash: context.templateIR.hash,
      templateFilePath: context.templateIR.source.filePath,
      backend: this.options.backend,
      status: 'generating',
      revision: 1,
      readySlides: 0,
      totalSlides: context.deckPlan.slides.length,
      currentSlideId: null,
      defaultTrack: 'A',
      selectionOverrides: {},
      selectionVersion: 0,
      slides: context.deckPlan.slides.map((slide, index) => ({
        slideId: slide.id,
        index: index + 1,
        title: slide.takeaway,
        recommendedVariant: 'A',
        status: 'pending',
        version: 1,
        lockedVariant: null,
        variants: { A: emptyVariant(), B: emptyVariant(), C: emptyVariant() },
        auditSummary: { errors: 0, warnings: 0, infos: 0 },
        failure: null,
      })),
      exports: [],
      failure: null,
      createdAt: now,
      updatedAt: now,
    };
    const result = startPresentationGeneration(this.options.db, {
      projectId,
      idempotencyKey: keyValue,
      inputFingerprint: context.fingerprint,
      state,
    });
    if (result.kind === 'active-conflict') {
      throw new PresentationGenerationError('GENERATION_ALREADY_RUNNING', 'Slide pack generation is already running for this project.', 409);
    }
    if (result.kind === 'idempotency-conflict') {
      throw new PresentationGenerationError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for different planning inputs.', 409);
    }
    const stored = validateStoredGeneration(result.generation.state);
    if (result.kind === 'created') this.schedule(projectId, stored.generationId);
    else if (stored.status === 'failed' && stored.idempotencyKey === keyValue) {
      const resumed = this.update(projectId, stored.generationId, (current) => ({
        ...current, status: 'generating', failure: null, currentSlideId: null, updatedAt: this.now().toISOString(),
        slides: current.slides.map((pack) => pack.status === 'failed' ? { ...pack, status: 'pending', failure: null } : pack),
      }));
      if (resumed) this.schedule(projectId, stored.generationId);
      return { state: publicSnapshot(resumed?.state ?? stored), created: false };
    }
    return { state: publicSnapshot(stored), created: result.kind === 'created' };
  }

  get(projectIdValue: string): PublicPresentationGeneration | null {
    const projectId = assertSafeProjectId(projectIdValue);
    const stored = getPresentationGeneration<PresentationGenerationState>(this.options.db, projectId);
    if (!stored) return null;
    const state = validateStoredGeneration(stored.state);
    if (['preparing', 'generating'].includes(state.status) && !this.tasks.has(projectId)) {
      this.recoverOne(projectId, state.generationId);
    }
    return publicSnapshot(state);
  }

  async getSnapshot(projectIdValue: string): Promise<PublicPresentationGeneration | null> {
    const projectId = assertSafeProjectId(projectIdValue);
    const snapshot = this.get(projectId);
    if (!snapshot || snapshot.status !== 'completed' || this.tasks.has(projectId)) return snapshot;
    try {
      const context = await this.context(projectId);
      const state = this.current(projectId);
      this.assertSameContext(state, context);
      return publicSnapshot(state);
    } catch (error) {
      if (!(error instanceof PresentationGenerationError)
          || !['PLANNING_STATE_STALE', 'PLANNING_NOT_READY', 'TEMPLATE_NOT_READY', 'TEMPLATE_SOURCE_MISSING'].includes(error.code)) throw error;
      const current = this.current(projectId);
      const updated = this.update(projectId, current.generationId, (state) => ({
        ...state,
        status: 'stale',
        failure: { code: error.code, message: 'The plan, source material, or template changed after slide generation. Refresh the plan before export.' },
        updatedAt: this.now().toISOString(),
      }));
      return updated ? publicSnapshot(updated.state) : snapshot;
    }
  }

  async recover(): Promise<void> {
    for (const stored of listRecoverablePresentationGenerations<PresentationGenerationState>(this.options.db)) {
      const state = validateStoredGeneration(stored.state);
      const resumed = this.update(stored.projectId, state.generationId, (current) => ({
        ...current,
        status: 'generating',
        currentSlideId: null,
        slides: current.slides.map((pack) => pack.status === 'rendering' ? { ...pack, status: 'pending' } : pack),
        updatedAt: this.now().toISOString(),
      }));
      if (resumed) this.schedule(stored.projectId, state.generationId);
    }
  }

  async shutdown(): Promise<boolean> {
    const tasks = [...this.tasks.entries()];
    for (const [projectId, task] of tasks) {
      const stored = getPresentationGeneration<PresentationGenerationState>(this.options.db, projectId);
      if (stored && ['preparing', 'generating'].includes(stored.state.status)) {
        this.update(projectId, stored.generationId, (current) => ['preparing', 'generating'].includes(current.status) ? ({
          ...current,
          status: 'generating',
          currentSlideId: null,
          slides: current.slides.map((pack) => pack.status === 'rendering' ? { ...pack, status: 'pending' } : pack),
          updatedAt: this.now().toISOString(),
        }) : current);
      }
      task.controller.abort();
    }
    const outstanding = [
      ...tasks.map(([, task]) => task.promise),
      ...this.repairTasks.values(),
      ...this.exportTasks.values(),
    ];
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([Promise.allSettled(outstanding).then(() => true), new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 5_000);
        timer.unref?.();
      })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async waitForIdle(): Promise<void> {
    while (this.tasks.size || this.repairTasks.size || this.exportTasks.size) {
      const pending = [
        ...[...this.tasks.values()].map((task) => task.promise),
        ...this.repairTasks.values(),
        ...this.exportTasks.values(),
      ];
      await Promise.allSettled(pending);
    }
  }

  async drainProject(projectIdValue: string): Promise<boolean> {
    const projectId = assertSafeProjectId(projectIdValue);
    const matching = () => [
      ...(this.tasks.has(projectId) ? [this.tasks.get(projectId)!.promise] : []),
      ...[...this.repairTasks.entries()].filter(([key]) => key.startsWith(`${projectId}:`)).map(([, task]) => task),
      ...[...this.exportTasks.entries()].filter(([key]) => key.startsWith(`${projectId}:`)).map(([, task]) => task),
    ];
    const deadline = Date.now() + 5_000;
    while (true) {
      const pending = matching();
      if (!pending.length) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let timer: NodeJS.Timeout | undefined;
      try {
        const drained = await Promise.race([Promise.allSettled(pending).then(() => true), new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), remaining);
          timer.unref?.();
        })]);
        if (!drained) return false;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  async cancel(projectIdValue: string): Promise<PublicPresentationGeneration> {
    const projectId = assertSafeProjectId(projectIdValue);
    const current = getPresentationGeneration<PresentationGenerationState>(this.options.db, projectId);
    if (!current) throw new PresentationGenerationError('GENERATION_NOT_FOUND', 'Slide generation has not been started.', 404);
    const state = validateStoredGeneration(current.state);
    if (['completed', 'failed', 'cancelled', 'stale'].includes(state.status)) return publicSnapshot(state);
    const updated = this.update(projectId, state.generationId, (fresh) => ({
      ...fresh, status: 'cancelled', currentSlideId: null,
      slides: fresh.slides.map((pack) => pack.status === 'rendering' ? { ...pack, status: 'pending' } : pack),
      failure: { code: 'CANCELLED', message: 'Generation was cancelled. Ready slide packs remain available.' },
      updatedAt: this.now().toISOString(),
    }));
    const task = this.tasks.get(projectId);
    task?.controller.abort();
    if (task) {
      let timer: NodeJS.Timeout | undefined;
      let completed: boolean;
      try {
        completed = await Promise.race([task.promise.then(() => true), new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 5_000);
          timer.unref?.();
        })]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!completed) throw new PresentationGenerationError('CANCELLATION_TIMEOUT', 'Generation cancellation is still draining. Retry the operation shortly.', 503);
    }
    const latest = getPresentationGeneration<PresentationGenerationState>(this.options.db, projectId);
    return publicSnapshot(latest ? validateStoredGeneration(latest.state) : updated?.state ?? state);
  }

  async setDefaultTrack(projectIdValue: string, variantValue: unknown, expectedVersion: unknown): Promise<PublicPresentationGeneration> {
    const projectId = assertSafeProjectId(projectIdValue);
    const variant = this.variant(variantValue);
    if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 0) {
      throw new PresentationGenerationError('INVALID_VERSION', 'expectedVersion must be a non-negative selection version.', 400);
    }
    const current = this.current(projectId);
    const updated = this.update(projectId, current.generationId, (state) => {
      if (state.selectionVersion !== expectedVersion) throw new PresentationGenerationError('STALE_VERSION', 'Deck track changed since it was loaded. Reload and retry.', 409);
      const overrides: Record<string, PresentationVariantId> = {};
      for (const pack of state.slides) if (pack.lockedVariant) overrides[pack.slideId] = pack.lockedVariant;
      return { ...state, defaultTrack: variant, selectionOverrides: overrides, selectionVersion: state.selectionVersion + 1, updatedAt: this.now().toISOString() };
    });
    if (!updated) throw new PresentationGenerationError('GENERATION_NOT_FOUND', 'Slide generation state changed. Reload the project.', 409);
    return publicSnapshot(updated.state);
  }

  async selectVariant(projectIdValue: string, slideIdValue: unknown, variantValue: unknown, expectedVersion: unknown): Promise<PublicPresentationGeneration> {
    const projectId = assertSafeProjectId(projectIdValue);
    const slideId = this.slideId(slideIdValue);
    const variant = this.variant(variantValue);
    this.expectedVersion(expectedVersion);
    const current = this.current(projectId);
    const updated = this.update(projectId, current.generationId, (state) => {
      const pack = this.ensureVersion(state, expectedVersion, slideId);
      this.ensureReady(pack);
      if (pack.lockedVariant && pack.lockedVariant !== variant) {
        throw new PresentationGenerationError('SLIDE_LOCKED', `Slide ${pack.index} is locked to variant ${pack.lockedVariant}.`, 409);
      }
      return {
        ...state,
        selectionOverrides: { ...state.selectionOverrides, [slideId]: variant },
        selectionVersion: state.selectionVersion + 1,
        slides: state.slides.map((item) => item.slideId === slideId ? { ...item, version: item.version + 1 } : item),
        updatedAt: this.now().toISOString(),
      };
    });
    if (!updated) throw new PresentationGenerationError('GENERATION_NOT_FOUND', 'Slide generation state changed. Reload the project.', 409);
    return publicSnapshot(updated.state);
  }

  async lockSlide(projectIdValue: string, slideIdValue: unknown, lockedValue: unknown, variantValue: unknown, expectedVersion: unknown): Promise<PublicPresentationGeneration> {
    const projectId = assertSafeProjectId(projectIdValue);
    const slideId = this.slideId(slideIdValue);
    if (typeof lockedValue !== 'boolean') throw new PresentationGenerationError('INVALID_LOCK', 'locked must be true or false.', 400);
    const requestedVariant = variantValue === undefined ? null : this.variant(variantValue);
    this.expectedVersion(expectedVersion);
    const current = this.current(projectId);
    const updated = this.update(projectId, current.generationId, (state) => {
      const pack = this.ensureVersion(state, expectedVersion, slideId);
      this.ensureReady(pack);
      const currentVariant = selectedVariant(state, slideId);
      const variant = requestedVariant ?? currentVariant;
      if (lockedValue && pack.lockedVariant && pack.lockedVariant !== variant) {
        throw new PresentationGenerationError('SLIDE_LOCKED', `Slide ${pack.index} is already locked to variant ${pack.lockedVariant}.`, 409);
      }
      return {
        ...state,
        selectionOverrides: lockedValue ? { ...state.selectionOverrides, [slideId]: variant } : state.selectionOverrides,
        selectionVersion: lockedValue ? state.selectionVersion + 1 : state.selectionVersion,
        slides: state.slides.map((item) => item.slideId === slideId
          ? { ...item, version: item.version + 1, lockedVariant: lockedValue ? variant : null }
          : item),
        updatedAt: this.now().toISOString(),
      };
    });
    if (!updated) throw new PresentationGenerationError('GENERATION_NOT_FOUND', 'Slide generation state changed. Reload the project.', 409);
    return publicSnapshot(updated.state);
  }

  audit(projectIdValue: string, slideIdValue: unknown, variantValue: unknown): DeterministicAuditReport {
    const projectId = assertSafeProjectId(projectIdValue);
    const slideId = this.slideId(slideIdValue);
    const variant = this.variant(variantValue);
    const current = this.current(projectId);
    const pack = current.slides.find((item) => item.slideId === slideId);
    this.ensureReady(pack);
    const report = pack.variants[variant].audit;
    if (!report) throw new PresentationGenerationError('AUDIT_NOT_READY', 'Audit is not ready for this slide variant.', 409);
    return report;
  }

  async repair(projectIdValue: string, input: { slideId: unknown; variant: unknown; findingId: unknown; expectedVersion: unknown }): Promise<PublicPresentationGeneration> {
    const projectId = assertSafeProjectId(projectIdValue);
    const slideId = this.slideId(input.slideId);
    const variant = this.variant(input.variant);
    if (typeof input.findingId !== 'string' || input.findingId.length > 240) throw new PresentationGenerationError('INVALID_FINDING_ID', 'findingId is invalid.', 400);
    this.expectedVersion(input.expectedVersion);
    const taskKey = `${projectId}:${slideId}:${variant}:${input.findingId}:${String(input.expectedVersion)}`;
    const pending = this.repairTasks.get(taskKey);
    if (pending) return pending;
    if (this.repairTasks.size >= 2) throw new PresentationGenerationError('REPAIR_CAPACITY', 'Repair capacity is full. Wait for an active repair to finish and retry.', 429);
    const task = Promise.resolve().then(() => this.performRepair(projectId, input));
    this.repairTasks.set(taskKey, task);
    try { return await task; }
    finally { if (this.repairTasks.get(taskKey) === task) this.repairTasks.delete(taskKey); }
  }

  private async performRepair(projectIdValue: string, input: { slideId: unknown; variant: unknown; findingId: unknown; expectedVersion: unknown }): Promise<PublicPresentationGeneration> {
    const projectId = assertSafeProjectId(projectIdValue);
    const slideId = this.slideId(input.slideId);
    const variant = this.variant(input.variant);
    if (typeof input.findingId !== 'string' || input.findingId.length > 240) throw new PresentationGenerationError('INVALID_FINDING_ID', 'findingId is invalid.', 400);
    this.expectedVersion(input.expectedVersion);
    const initial = this.current(projectId);
    const pack = this.ensureVersion(initial, input.expectedVersion, slideId);
    this.ensureReady(pack);
    if (pack.lockedVariant === variant) throw new PresentationGenerationError('SLIDE_LOCKED', 'Unlock this variant before applying a local repair.', 409);
    const variantState = pack.variants[variant];
    const report = variantState.audit;
    const finding = report?.findings.find((candidate) => candidate.id === input.findingId);
    if (!finding) throw new PresentationGenerationError('FINDING_NOT_FOUND', 'That audit finding is no longer present. Reload the audit panel.', 409);
    if (!finding.autofixAvailable) throw new PresentationGenerationError('REPLAN_REQUIRED', 'This finding needs a semantic change to the plan and cannot be repaired locally.', 409);

    const context = await this.context(projectId);
    this.assertSameContext(initial, context);
    const tracks = this.applyPersistedCompositionChoices(
      this.applyPersistedRepairs(this.compileTracks(context), initial), initial, context,
    );
    const sourceSlideId = slideId;
    const presentation = variantsById(tracks, variant);
    const originalSlide = presentation.slides.find((slide) => slide.sourceDeckPlanSlideId === sourceSlideId);
    if (!originalSlide || originalSlide.layoutCandidates.length < 2) {
      throw new PresentationGenerationError('REPLAN_REQUIRED', 'No compatible alternate layout is available for a safe local repair.', 409);
    }
    const candidateIndex = Math.min(originalSlide.selectedCandidateIndex + 1, originalSlide.layoutCandidates.length - 1);
    if (candidateIndex === originalSlide.selectedCandidateIndex) {
      throw new PresentationGenerationError('REPLAN_REQUIRED', 'No later compatible layout is available for a safe local repair.', 409);
    }
    const candidate = originalSlide.layoutCandidates[candidateIndex]!;
    const repairedSlide: CompiledSlide = {
      ...originalSlide,
      layoutId: candidate.layoutId,
      layoutSourcePart: candidate.sourcePart,
      placements: { title: candidate.titleBox, body: candidate.bodyBox, visual: candidate.visualBox },
      selectedCandidateIndex: candidateIndex,
      nativeLayoutFallback: true,
    };
    delete repairedSlide.exemplarSelection;
    const repairedPresentation = { ...presentation, slides: presentation.slides.map((slide) => slide.id === repairedSlide.id ? repairedSlide : slide) };
    const repairedAudit = auditForSlide(repairedPresentation, context.contentIR, context.templateIR, repairedSlide);
    if (repairedAudit.findings.some((item) => item.severity === 'error')) {
      throw new PresentationGenerationError('REPLAN_REQUIRED', 'The alternate layout did not clear the deterministic error; replan this slide.', 409);
    }
    const result = await this.renderVariant(projectId, initial, pack, variant, repairedPresentation, repairedSlide, context, variantState.version + 1, candidateIndex);
    const updated = this.update(projectId, initial.generationId, (fresh) => {
      const latest = this.ensureVersion(fresh, input.expectedVersion, slideId);
      if (latest.lockedVariant === variant) throw new PresentationGenerationError('SLIDE_LOCKED', 'The slide was locked while repair was running.', 409);
      const old = latest.variants[variant];
      const variants = { ...latest.variants, [variant]: { ...old, ...result, status: 'ready' as const, version: old.version + 1 } };
      const nextPack = { ...latest, version: latest.version + 1, variants, auditSummary: auditSummary(VARIANT_IDS.map((id) => variants[id].audit)) };
      return {
        ...fresh,
        slides: fresh.slides.map((item) => item.slideId === slideId ? nextPack : item),
        updatedAt: this.now().toISOString(),
      };
    });
    if (!updated) throw new PresentationGenerationError('GENERATION_NOT_FOUND', 'Generation state changed while repairing. Reload the project.', 409);
    await this.writeRunManifest(projectId, updated.state, context);
    return publicSnapshot(updated.state);
  }

  async export(projectIdValue: string, modeValue: unknown, formatValue: unknown = 'pptx'): Promise<{ state: PublicPresentationGeneration; artifact: Omit<GeneratedExport, 'fileRef'> & { downloadUrl: string } }> {
    const projectId = assertSafeProjectId(projectIdValue);
    const mode = this.exportMode(modeValue);
    const format = this.exportFormat(formatValue);
    const initial = this.current(projectId);
    if (initial.status !== 'completed' || initial.slides.some((pack) => pack.status !== 'ready')) {
      throw new PresentationGenerationError('GENERATION_INCOMPLETE', 'Wait until every slide pack is ready before exporting.', 409);
    }
    const selection = initial.slides.map((pack) => {
      const variant = mode === 'selected' ? selectedVariant(initial, pack.slideId) : mode;
      return { slideId: pack.slideId, variant, version: pack.variants[variant].version };
    });
    const exportId = deterministicUuid(sha256(JSON.stringify({
      generationId: initial.generationId, mode, format, selection,
      selectionVersion: mode === 'selected' ? initial.selectionVersion : null,
    })));
    const taskKey = `${projectId}:${exportId}`;
    const pending = this.exportTasks.get(taskKey);
    if (pending) return pending;
    const existing = initial.exports.find((item) => item.id === exportId);
    if (existing) {
      try {
        const file = await readFile(await this.resolveGeneratedRef(projectId, existing.fileRef));
        if (sha256(file) !== existing.sha256) throw new PresentationGenerationError('EXPORT_ARTIFACT_CORRUPT', 'The saved export failed its integrity check.', 500);
        const state = publicSnapshot(initial);
        const artifact = state.exports.find((item) => item.id === exportId);
        if (artifact) return { state, artifact };
      } catch (error) {
        if (error instanceof PresentationGenerationError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (this.exportTasks.size >= 2) {
      throw new PresentationGenerationError('EXPORT_CAPACITY', 'Export capacity is full. Wait for an export to finish and retry.', 429);
    }
    const task = Promise.resolve().then(() => this.performExport(initial, projectId, mode, format, exportId));
    this.exportTasks.set(taskKey, task);
    const exportStartedAt = performance.now();
    try { return await task; }
    finally {
      recordElapsed(this.options.performanceDiagnostics, 'export.total', exportStartedAt);
      recordElapsed(this.options.performanceDiagnostics, `export.${mode}`, exportStartedAt);
      if (this.exportTasks.get(taskKey) === task) this.exportTasks.delete(taskKey);
    }
  }

  private async performExport(
    initial: PresentationGenerationState,
    projectId: string,
    mode: GenerationExportMode,
    format: GenerationExportFormat,
    exportId: string,
  ): Promise<{ state: PublicPresentationGeneration; artifact: Omit<GeneratedExport, 'fileRef'> & { downloadUrl: string } }> {
    const context = await this.context(projectId);
    this.assertSameContext(initial, context);
    const tracks = this.applyPersistedCompositionChoices(
      this.applyPersistedRepairs(this.compileTracks(context), initial), initial, context,
    );
    const selected = initial.slides.map((pack) => mode === 'selected' ? selectedVariant(initial, pack.slideId) : mode);
    const firstVariant = selected[0] ?? 'A';
    const base = variantsById(tracks, firstVariant);
    const slides = initial.slides.map((pack, index) => {
      const variant = selected[index] ?? firstVariant;
      const track = variantsById(tracks, variant);
      const slide = track.slides.find((item) => item.sourceDeckPlanSlideId === pack.slideId);
      if (!slide) throw new PresentationGenerationError('PLAN_CHANGED', 'Saved slide order no longer matches the plan.', 409);
      return structuredClone(slide);
    });
    const selectedPresentation: CompiledPresentation = {
      ...base,
      id: `compiled_${sha256(`${initial.generationId}/${mode}/${initial.selectionVersion}/${selected.join('')}`).slice(0, 24)}`,
      variantId: firstVariant,
      slides,
    };
    const extension = format === 'pptx' ? '.pptx' : format === 'pdf' ? '.pdf' : '.html';
    const output = await this.generatedFile(projectId, [initial.generationId, 'exports', `${exportId}${extension}`], true);
    const pptxOutput = format === 'pptx' ? output : await this.generatedFile(projectId, [initial.generationId, 'exports', `${exportId}.source.pptx`], true);
    let renderResult: PptxRenderResult;
    try {
      await rm(output.absolute, { force: true });
      if (pptxOutput.absolute !== output.absolute) await rm(pptxOutput.absolute, { force: true });
      renderResult = await this.renderer.render({
        compiledPresentation: selectedPresentation,
        contentIR: context.contentIR,
        templateIR: context.templateIR,
        ...(context.semanticProfile ? { semanticProfile: context.semanticProfile } : {}),
        templatePath: context.templatePath,
        outputPath: pptxOutput.absolute,
        contentRoot: path.join(this.options.projectsRoot, projectId),
      });
      for (const [index, slide] of slides.entries()) {
        const variant = selected[index] ?? firstVariant;
        const choice = initial.slides[index]?.variants[variant]?.compositionChoice;
        const projected = renderResult.projectedCompositions.find((item) => item.variantId === variant && item.slideId === slide.id);
        if (choice && (!projected || projected.projectedCompositionSignature !== choice.signature)) {
          throw new PresentationGenerationError('COMPOSITION_ASSIGNMENT_CHANGED',
            'The saved slide composition no longer matches its qualified variant. Regenerate the slide before exporting.', 409);
        }
      }
      const pptxBytes = await readFile(pptxOutput.absolute);
      const inspected = await this.inspectPackage(pptxBytes);
      if (inspected.slideCount !== slides.length || inspected.validationIssues.some((issue) => issue.severity === 'error')) {
        throw new PresentationGenerationError('EXPORT_VALIDATION_FAILED', 'The generated PowerPoint did not pass package reopen validation.', 422);
      }
      if (renderResult.validationStatus === 'failed' || renderResult.reopenStatus === 'failed') {
        throw new PresentationGenerationError('EXPORT_VALIDATION_FAILED', 'The selected PowerPoint backend reported a validation failure.', 422);
      }
      let bytes: Buffer;
      if (format === 'pptx') bytes = pptxBytes;
      else if (format === 'pdf') {
        try { bytes = await this.pdfExporter.export(pptxBytes, slides.length, context.templateIR.slideSize); }
        catch (error) { throw new PresentationGenerationError('PDF_EXPORT_UNAVAILABLE', 'PDF export could not render and reopen every slide.', 503, { cause: error }); }
        const reopenedPdf = await PDFDocument.load(bytes, { updateMetadata: false });
        if (reopenedPdf.getPageCount() !== slides.length) throw new PresentationGenerationError('PDF_EXPORT_VALIDATION_FAILED', 'The PDF page count does not match the presentation.', 422);
      } else {
        try {
          bytes = await this.htmlExporter.export({
            compiledPresentation: selectedPresentation,
            contentIR: context.contentIR,
            templateIR: context.templateIR,
            ...(context.template.presentationDesignSystem ? { designSystem: context.template.presentationDesignSystem } : {}),
            contentRoot: path.join(this.options.projectsRoot, projectId),
          });
        } catch (error) {
          throw new PresentationGenerationError('HTML_EXPORT_FAILED', 'The semantic HTML deck could not be assembled safely.', 500, { cause: error });
        }
        const html = bytes.toString('utf8');
        if (!html.startsWith('<!doctype html>') || (html.match(/<section class="slide"/g) ?? []).length !== slides.length
            || !html.includes('<main>') || !html.includes('</main>')) {
          throw new PresentationGenerationError('HTML_EXPORT_VALIDATION_FAILED', 'The HTML deck structure or slide count is invalid.', 422);
        }
      }
      if (format !== 'pptx') await writeFile(output.absolute, bytes, { flag: 'wx' });
      if (pptxOutput.absolute !== output.absolute) await rm(pptxOutput.absolute, { force: true });
      const artifact: GeneratedExport = {
        id: exportId,
        mode,
        format,
        fileRef: `${initial.generationId}/exports/${exportId}${extension}`,
        sha256: sha256(bytes),
        slideCount: inspected.slideCount,
        validationStatus: 'passed',
        nativeOfficeStatus: 'unknown',
        unresolvedVisualTypes: [...new Set(renderResult.unresolvedVisualTypes)],
        createdAt: this.now().toISOString(),
      };
      const updated = this.update(projectId, initial.generationId, (fresh) => {
        if (mode === 'selected' && fresh.selectionVersion !== initial.selectionVersion) {
          throw new PresentationGenerationError('SELECTION_CHANGED', 'Slide selections changed during export. Export again to include the latest choices.', 409);
        }
        this.assertSameContext(fresh, context);
        return { ...fresh, exports: [...fresh.exports.filter((item) => item.id !== artifact.id), artifact], updatedAt: this.now().toISOString() };
      });
      if (!updated) throw new PresentationGenerationError('GENERATION_NOT_FOUND', 'Generation state changed while exporting.', 409);
      await this.writeRunManifest(projectId, updated.state, context);
      const publicArtifact = publicSnapshot(updated.state).exports.find((item) => item.id === exportId)!;
      return { state: publicSnapshot(updated.state), artifact: publicArtifact };
    } catch (error) {
      await rm(output.absolute, { force: true }).catch(() => undefined);
      if (pptxOutput.absolute !== output.absolute) await rm(pptxOutput.absolute, { force: true }).catch(() => undefined);
      if (error instanceof PresentationGenerationError) throw error;
      throw new PresentationGenerationError('EXPORT_FAILED', 'PowerPoint assembly failed. Ready slide packs remain available.', 500, { cause: error });
    }
  }

  async readPreview(projectIdValue: string, slideIdValue: unknown, variantValue: unknown): Promise<Buffer> {
    const projectId = assertSafeProjectId(projectIdValue);
    const slideId = this.slideId(slideIdValue);
    const variant = this.variant(variantValue);
    const state = this.current(projectId);
    const pack = state.slides.find((item) => item.slideId === slideId);
    this.ensureReady(pack);
    const ref = pack.variants[variant].previewRef;
    if (!ref) throw new PresentationGenerationError('PREVIEW_NOT_FOUND', 'Preview is not available for this variant.', 404);
    const resolved = await this.resolveGeneratedRef(projectId, ref);
    try { return await readFile(resolved); }
    catch { throw new PresentationGenerationError('PREVIEW_NOT_FOUND', 'Preview artifact is missing; regenerate the slide pack.', 404); }
  }

  async readExport(projectIdValue: string, exportIdValue: unknown): Promise<{ bytes: Buffer; artifact: GeneratedExport }> {
    const projectId = assertSafeProjectId(projectIdValue);
    if (typeof exportIdValue !== 'string' || !/^[a-f0-9-]{36}$/i.test(exportIdValue)) {
      throw new PresentationGenerationError('INVALID_EXPORT_ID', 'Export id is invalid.', 400);
    }
    const state = this.current(projectId);
    const artifact = state.exports.find((item) => item.id === exportIdValue);
    if (!artifact) throw new PresentationGenerationError('EXPORT_NOT_FOUND', 'The validated presentation export was not found.', 404);
    const absolute = await this.resolveGeneratedRef(projectId, artifact.fileRef);
    try { return { bytes: await readFile(absolute), artifact }; }
    catch { throw new PresentationGenerationError('EXPORT_NOT_FOUND', 'The validated presentation artifact is missing.', 404); }
  }

  private schedule(projectId: string, generationId: string): void {
    if (this.tasks.has(projectId)) return;
    const controller = new AbortController();
    const promise = this.run(projectId, generationId, controller.signal).finally(() => {
      if (this.tasks.get(projectId)?.controller === controller) this.tasks.delete(projectId);
    });
    this.tasks.set(projectId, { promise, controller });
  }

  private recoverOne(projectId: string, generationId: string): void {
    const recovered = this.update(projectId, generationId, (state) => ({
      ...state,
      status: 'generating',
      currentSlideId: null,
      slides: state.slides.map((pack) => pack.status === 'rendering' ? { ...pack, status: 'pending' } : pack),
      updatedAt: this.now().toISOString(),
    }));
    if (recovered) this.schedule(projectId, generationId);
  }

  private async run(projectId: string, generationId: string, signal: AbortSignal): Promise<void> {
    const generationStartedAt = performance.now();
    let currentSlideId: string | null = null;
    try {
      const initial = this.current(projectId);
      if (initial.generationId !== generationId || initial.status === 'cancelled') return;
      const context = await this.context(projectId);
      this.assertSameContext(initial, context);
      let stageStartedAt = performance.now();
      const tracks = this.compileTracks(context);
      recordElapsed(this.options.performanceDiagnostics, 'generation.compileTracks', stageStartedAt);
      // Template visual safety classification is immutable during this run; keep this
      // cache local to the generation so it cannot leak across templates/projects.
      const visualClassificationCache = createCompositionVisualClassificationCache();
      for (const initialPack of initial.slides) {
        if (signal.aborted) return;
        const fresh = this.current(projectId);
        if (fresh.generationId !== generationId || fresh.status === 'cancelled') return;
        const pack = fresh.slides.find((item) => item.slideId === initialPack.slideId)!;
        if (pack.status === 'ready') continue;
        currentSlideId = pack.slideId;
        const startUpdate = this.update(projectId, generationId, (state) => ({
          ...state,
          status: 'generating',
          currentSlideId,
          slides: state.slides.map((item) => item.slideId === currentSlideId ? { ...item, status: 'rendering', failure: null } : item),
          updatedAt: this.now().toISOString(),
        }));
        if (!startUpdate) return;
        stageStartedAt = performance.now();
        const variantSlides = VARIANT_IDS.map((variant) => {
          const presentation = variantsById(tracks, variant);
          const slide = presentation.slides.find((candidate) => candidate.sourceDeckPlanSlideId === currentSlideId);
          if (!slide) throw new PresentationGenerationError('PLAN_CHANGED', 'A planned slide is missing from the compiled output.', 409);
          return slide;
        });
        let compositionStartedAt = performance.now();
        const compositionDistinctness = assessVariantCompositionDistinctness(variantSlides, context.templateIR, this.options.backend, context.semanticProfile,
          this.options.performanceDiagnostics, visualClassificationCache);
        recordElapsed(this.options.performanceDiagnostics, 'generation.resolveCompositions', compositionStartedAt);
        this.options.performanceDiagnostics?.increment('generation.compositionResolverCallCount');
        this.options.performanceDiagnostics?.increment('generation.compositionOptionCount', compositionDistinctness.candidateCounts.safeExemplarOptions
          + compositionDistinctness.candidateCounts.safeLayoutOptions);
        if (!compositionDistinctness.distinct) {
          throw new PresentationGenerationError(
            'VARIANTS_NOT_DISTINCT',
            `Slide ${pack.index} has only ${compositionDistinctness.availableDistinctFamilies} distinct safe projected composition(s); A/B/C were withheld. ${compositionDistinctness.evidence.join('; ')}`,
            422,
          );
        }
        compositionStartedAt = performance.now();
        const assignedVariantSlides = variantSlides.map((slide) => {
          const assignment = compositionDistinctness.assignments.find((candidate) => candidate.variantId === slide.variantId);
          if (!assignment) throw new TypeError(`Qualified composition is missing the ${slide.variantId} assignment`);
          return applyVariantCompositionAssignment(slide, assignment, context.templateIR, context.semanticProfile);
        });
        recordElapsed(this.options.performanceDiagnostics, 'generation.applyCompositionAssignments', compositionStartedAt);
        recordElapsed(this.options.performanceDiagnostics, 'generation.compositionAssignment', stageStartedAt);
        const audits = {} as Record<PresentationVariantId, DeterministicAuditReport>;
        stageStartedAt = performance.now();
        for (const variant of VARIANT_IDS) {
          if (signal.aborted || this.current(projectId).status === 'cancelled') return;
          const presentation = variantsById(tracks, variant);
          const slide = assignedVariantSlides.find((candidate) => candidate.variantId === variant);
          if (!slide) throw new PresentationGenerationError('PLAN_CHANGED', 'A planned slide is missing from the compiled output.', 409);
          const audit = auditForSlide(presentation, context.contentIR, context.templateIR, slide);
          if (audit.findings.some((finding) => finding.severity === 'error')) {
            throw new PresentationGenerationError('AUDIT_BLOCKED', 'A deterministic audit error prevents publishing this slide pack.', 422);
          }
          audits[variant] = audit;
        }
        recordElapsed(this.options.performanceDiagnostics, 'generation.audit', stageStartedAt);
        const currentPack = this.current(projectId).slides.find((item) => item.slideId === currentSlideId)!;
        const pendingResults = await this.renderVariantPack(
          projectId, this.current(projectId), currentPack, variantsById(tracks, 'A'), assignedVariantSlides, audits, context,
        );
        if (signal.aborted || this.current(projectId).status === 'cancelled') return;
        const committed = this.update(projectId, generationId, (state) => {
          if (state.status === 'cancelled') return state;
          const target = state.slides.find((item) => item.slideId === currentSlideId);
          if (!target || target.status !== 'rendering') return state;
          const variants = Object.fromEntries(VARIANT_IDS.map((variant) => [variant, {
            ...target.variants[variant], ...pendingResults[variant], status: 'ready', version: 1,
          }])) as Record<PresentationVariantId, GeneratedVariantState>;
          const nextPack: GeneratedSlidePack = {
            ...target,
            status: 'ready',
            version: target.version + 1,
            variants,
            auditSummary: auditSummary(VARIANT_IDS.map((variant) => variants[variant].audit)),
            failure: null,
          };
          const slides = state.slides.map((item) => item.slideId === currentSlideId ? nextPack : item);
          return {
            ...state,
            status: 'generating',
            readySlides: slides.filter((item) => item.status === 'ready').length,
            currentSlideId: null,
            slides,
            updatedAt: this.now().toISOString(),
          };
        });
        if (!committed) return;
        currentSlideId = null;
      }
      if (signal.aborted) return;
      const latest = this.current(projectId);
      if (latest.generationId !== generationId || latest.status === 'cancelled') return;
      const completed = this.update(projectId, generationId, (state) => ({
        ...state,
        status: 'completed',
        currentSlideId: null,
        readySlides: state.slides.filter((pack) => pack.status === 'ready').length,
        failure: null,
        updatedAt: this.now().toISOString(),
      }));
      if (completed) await this.writeRunManifest(projectId, completed.state, context);
      recordElapsed(this.options.performanceDiagnostics, 'generation.total', generationStartedAt);
    } catch (error) {
      recordElapsed(this.options.performanceDiagnostics, 'generation.total', generationStartedAt);
      if (signal.aborted) return;
      const stored = getPresentationGeneration<PresentationGenerationState>(this.options.db, projectId);
      if (!stored || stored.generationId !== generationId || stored.state.status === 'cancelled') return;
      const message = error instanceof PresentationGenerationError && error.status < 500
        ? error.message
        : currentSlideId
          ? `Slide ${stored.state.slides.find((pack) => pack.slideId === currentSlideId)?.index ?? ''} could not be rendered or validated. Earlier ready slide packs remain available.`
          : 'Slide generation could not prepare the current planning inputs.';
      const stale = error instanceof PresentationGenerationError
        && ['PLANNING_STATE_STALE', 'PLANNING_NOT_READY', 'TEMPLATE_NOT_READY', 'TEMPLATE_SOURCE_MISSING'].includes(error.code);
      this.update(projectId, generationId, (state) => ({
        ...state,
        status: stale ? 'stale' : 'failed',
        currentSlideId: null,
        readySlides: state.slides.filter((pack) => pack.status === 'ready').length,
        slides: currentSlideId ? state.slides.map((pack) => pack.slideId === currentSlideId
          ? { ...pack, status: 'failed', failure: { code: error instanceof PresentationGenerationError ? error.code : 'RENDER_FAILED', message } }
          : pack) : state.slides,
        failure: { code: error instanceof PresentationGenerationError ? error.code : 'RENDER_FAILED', message },
        updatedAt: this.now().toISOString(),
      }));
    }
  }

  private async renderVariant(
    projectId: string,
    state: PresentationGenerationState,
    pack: GeneratedSlidePack,
    variant: PresentationVariantId,
    sourcePresentation: CompiledPresentation,
    slide: CompiledSlide,
    context: GenerationContext,
    version: number,
    layoutCandidateIndex = slide.selectedCandidateIndex,
  ): Promise<Omit<GeneratedVariantState, 'status' | 'version'>> {
    const oneSlide = singleSlidePresentation(sourcePresentation, slide);
    const workId = randomUUID();
    const temp = await this.generatedFile(projectId, [state.generationId, 'work', `${workId}.pptx`], true);
    const previewRef = `${state.generationId}/slides/${String(pack.index).padStart(2, '0')}/${variant}-v${version}.png`;
    const previewPath = await this.generatedFile(projectId, previewRef.split('/'), true);
    try {
      const rendered = await this.renderer.render({
        compiledPresentation: oneSlide,
        contentIR: context.contentIR,
        templateIR: context.templateIR,
        ...(context.semanticProfile ? { semanticProfile: context.semanticProfile } : {}),
        templatePath: context.templatePath,
        outputPath: temp.absolute,
        contentRoot: path.join(this.options.projectsRoot, projectId),
      });
      if (rendered.slideCount !== 1 || rendered.validationStatus === 'failed' || rendered.reopenStatus === 'failed') {
        throw new PresentationGenerationError('RENDER_VALIDATION_FAILED', 'Renderer output did not pass its slide and validation checks.', 422);
      }
      const projected = rendered.projectedCompositions.find((item) => item.variantId === variant && item.slideId === slide.id);
      if (!projected) throw new PresentationGenerationError('COMPOSITION_ASSIGNMENT_MISSING', 'Renderer omitted the selected slide composition evidence.', 422);
      const bytes = await readFile(temp.absolute);
      const inspected = await this.inspectPackage(bytes);
      if (inspected.slideCount !== 1 || inspected.validationIssues.some((issue) => issue.severity === 'error')) {
        throw new PresentationGenerationError('RENDER_REOPEN_FAILED', 'Rendered slide could not be reopened and structurally validated.', 422);
      }
      const preview = await this.preview.preview(bytes, 0, 1280);
      if (preview.slideCount !== 1 || !preview.png.length) {
        throw new PresentationGenerationError('PREVIEW_FAILED', 'The slide preview could not be rendered.', 422);
      }
      await this.writeArtifact(previewPath.absolute, preview.png);
      const layoutIssueSummary = summarizePreviewLayoutEvidence(preview, context.templateIR, slide);
      const unresolved = rendered.unresolvedVisualTypes.length > 0 || slide.visualization.status === 'unresolved';
      return {
        previewRef,
        layoutCandidateIndex,
        nativeLayoutFallback: slide.nativeLayoutFallback === true,
        compositionChoice: {
          kind: slide.exemplarSelection ? 'exemplar-backed' : slide.nativeLayoutFallback ? 'layout-placeholder-backed' : 'safe-generated-fallback',
          signature: projected.projectedCompositionSignature,
          exemplar: exemplarSelectionReference(slide.exemplarSelection),
        },
        layoutIssueCount: preview.textLayoutIssues.length,
        layoutIssueSummary,
        visualSlotStatus: slide.visualization.type === 'none' ? 'not-applicable' : unresolved ? 'unresolved' : 'ready',
        audit: auditForSlide(sourcePresentation, context.contentIR, context.templateIR, slide),
        renderCheck: {
          backend: rendered.backend,
          slideCount: inspected.slideCount,
          reopenStatus: rendered.reopenStatus === 'not-run' ? 'passed' : rendered.reopenStatus,
          validationStatus: 'passed',
          templatePreservationStatus: rendered.templatePreservationStatus,
          unresolvedVisualTypes: [...rendered.unresolvedVisualTypes],
        },
      };
    } finally {
      await rm(temp.absolute, { force: true }).catch(() => undefined);
    }
  }

  private async renderVariantPack(
    projectId: string,
    state: PresentationGenerationState,
    pack: GeneratedSlidePack,
    basePresentation: CompiledPresentation,
    slides: readonly CompiledSlide[],
    audits: Record<PresentationVariantId, DeterministicAuditReport>,
    context: GenerationContext,
  ): Promise<Record<PresentationVariantId, Omit<GeneratedVariantState, 'status' | 'version'>>> {
    if (slides.length !== VARIANT_IDS.length || slides.some((slide, index) => slide.variantId !== VARIANT_IDS[index])) {
      throw new PresentationGenerationError('VARIANT_PACK_INVALID', 'The A/B/C slide pack is incomplete or out of order.', 500);
    }
    const groupedPresentation: CompiledPresentation = {
      ...basePresentation,
      id: `compiled_${sha256(`${state.generationId}/${pack.slideId}/${VARIANT_IDS.join('')}`).slice(0, 24)}`,
      slides: slides.map((slide) => structuredClone(slide)),
    };
    const workId = randomUUID();
    const temp = await this.generatedFile(projectId, [state.generationId, 'work', `${workId}.pptx`], true);
    try {
      const rendered = await this.renderer.render({
        compiledPresentation: groupedPresentation,
        contentIR: context.contentIR,
        templateIR: context.templateIR,
        ...(context.semanticProfile ? { semanticProfile: context.semanticProfile } : {}),
        templatePath: context.templatePath,
        outputPath: temp.absolute,
        contentRoot: path.join(this.options.projectsRoot, projectId),
      });
      if (rendered.slideCount !== VARIANT_IDS.length || rendered.validationStatus === 'failed' || rendered.reopenStatus === 'failed') {
        throw new PresentationGenerationError('RENDER_VALIDATION_FAILED', 'Renderer output did not pass its A/B/C slide and validation checks.', 422);
      }
      const renderedSignatures = new Set(rendered.projectedCompositions.map((item) => item.projectedCompositionSignature));
      if (rendered.projectedCompositions.length !== VARIANT_IDS.length || renderedSignatures.size !== VARIANT_IDS.length) {
        throw new PresentationGenerationError('VARIANTS_NOT_DISTINCT', 'Renderer output did not preserve three distinct qualified A/B/C compositions.', 422);
      }
      for (const slide of slides) {
        const assignment = rendered.projectedCompositions.find((item) => item.variantId === slide.variantId && item.slideId === slide.id);
        if (!assignment || slide.exemplarSelection
            && assignment.projectedCompositionSignature !== slide.exemplarSelection.projectedCompositionSignature) {
          throw new PresentationGenerationError('COMPOSITION_ASSIGNMENT_CHANGED', 'Renderer did not preserve the exact qualified composition assignment.', 422);
        }
      }
      const bytes = await readFile(temp.absolute);
      const inspectStartedAt = performance.now();
      const inspected = await this.inspectPackage(bytes);
      recordElapsed(this.options.performanceDiagnostics, 'generation.inspectPackage', inspectStartedAt);
      this.options.performanceDiagnostics?.increment('presentationReopenCount');
      if (inspected.slideCount !== VARIANT_IDS.length || inspected.validationIssues.some((issue) => issue.severity === 'error')) {
        throw new PresentationGenerationError('RENDER_REOPEN_FAILED', 'Rendered A/B/C slide pack could not be reopened and structurally validated.', 422);
      }
      const previewBatch = this.preview.previewDeck
        ? await this.preview.previewDeck(bytes, VARIANT_IDS.map((_, index) => index), 1280)
        : null;
      if (previewBatch && (previewBatch.length !== VARIANT_IDS.length
          || new Set(previewBatch.map((item) => item.slideIndex)).size !== VARIANT_IDS.length
          || VARIANT_IDS.some((_, index) => !previewBatch.some((item) => item.slideIndex === index)))) {
        throw new PresentationGenerationError('PREVIEW_FAILED', 'The A/B/C slide previews could not be rendered as a complete batch.', 422);
      }
      const results = {} as Record<PresentationVariantId, Omit<GeneratedVariantState, 'status' | 'version'>>;
      for (const [index, variant] of VARIANT_IDS.entries()) {
        const slide = slides[index]!;
        const projected = rendered.projectedCompositions.find((item) => item.variantId === variant && item.slideId === slide.id);
        if (!projected) throw new PresentationGenerationError('COMPOSITION_ASSIGNMENT_MISSING', `Renderer omitted the ${variant} composition evidence.`, 422);
        const previewRef = `${state.generationId}/slides/${String(pack.index).padStart(2, '0')}/${variant}-v1.png`;
        const previewPath = await this.generatedFile(projectId, previewRef.split('/'), true);
        const preview = previewBatch
          ? previewBatch.find((item) => item.slideIndex === index)!.result
          : await this.preview.preview(bytes, index, 1280);
        if (preview.slideCount !== VARIANT_IDS.length || !preview.png.length) {
          throw new PresentationGenerationError('PREVIEW_FAILED', `The ${variant} slide preview could not be rendered.`, 422);
        }
        const previewWriteStartedAt = performance.now();
        await this.writeArtifact(previewPath.absolute, preview.png);
        recordElapsed(this.options.performanceDiagnostics, 'preview.writeArtifact', previewWriteStartedAt);
        const layoutIssueSummary = summarizePreviewLayoutEvidence(preview, context.templateIR, slide);
        const unresolvedVisualTypes = rendered.unresolvedVisualTypes.filter((type) => type === slide.visualization.type);
        const unresolved = unresolvedVisualTypes.length > 0 || slide.visualization.status === 'unresolved';
        results[variant] = {
          previewRef,
          layoutCandidateIndex: slide.selectedCandidateIndex,
          nativeLayoutFallback: slide.nativeLayoutFallback === true,
          compositionChoice: {
            kind: slide.exemplarSelection ? 'exemplar-backed' : slide.nativeLayoutFallback ? 'layout-placeholder-backed' : 'safe-generated-fallback',
            signature: projected.projectedCompositionSignature,
            exemplar: exemplarSelectionReference(slide.exemplarSelection),
          },
          layoutIssueCount: preview.textLayoutIssues.length,
          layoutIssueSummary,
          visualSlotStatus: slide.visualization.type === 'none' ? 'not-applicable' : unresolved ? 'unresolved' : 'ready',
          audit: audits[variant],
          renderCheck: {
            backend: rendered.backend,
            // This public field describes the individual variant in the pack, even though
            // validation used one temporary package containing all three sibling variants.
            slideCount: 1,
            reopenStatus: rendered.reopenStatus === 'not-run' ? 'passed' : rendered.reopenStatus,
            validationStatus: 'passed',
            templatePreservationStatus: rendered.templatePreservationStatus,
            unresolvedVisualTypes,
          },
        };
      }
      return results;
    } finally {
      await rm(temp.absolute, { force: true }).catch(() => undefined);
    }
  }

  private compileTracks(context: GenerationContext): Map<PresentationVariantId, CompiledPresentation> {
    try {
      return new Map(VARIANT_POLICIES.map((policy) => [
        policy.id,
        compilePresentation(context.deckPlan, context.contentIR, context.templateIR, policy),
      ]));
    } catch (error) {
      if (error instanceof UnsupportedTemplateLayoutError) {
        throw new PresentationGenerationError(error.code, error.message, 422);
      }
      throw error;
    }
  }

  private applyPersistedRepairs(
    tracks: Map<PresentationVariantId, CompiledPresentation>,
    state: PresentationGenerationState,
  ): Map<PresentationVariantId, CompiledPresentation> {
    const repaired = new Map<PresentationVariantId, CompiledPresentation>();
    for (const variant of VARIANT_IDS) {
      const base = variantsById(tracks, variant);
      const slides = base.slides.map((slide) => {
        const pack = state.slides.find((item) => item.slideId === slide.sourceDeckPlanSlideId);
        const generated = pack?.variants[variant];
        const candidateIndex = generated?.layoutCandidateIndex ?? slide.selectedCandidateIndex;
        const candidate = slide.layoutCandidates[candidateIndex];
        if (!candidate) return slide;
        const selected = candidateIndex === slide.selectedCandidateIndex ? slide : {
          ...slide,
          layoutId: candidate.layoutId,
          layoutSourcePart: candidate.sourcePart,
          placements: { title: candidate.titleBox, body: candidate.bodyBox, visual: candidate.visualBox },
          selectedCandidateIndex: candidateIndex,
        };
        if (generated?.nativeLayoutFallback === true || candidateIndex !== slide.selectedCandidateIndex) {
          const { exemplarSelection: _exemplarSelection, ...withoutExemplar } = selected;
          return { ...withoutExemplar, nativeLayoutFallback: true as const };
        }
        return selected;
      });
      repaired.set(variant, { ...base, slides });
    }
    return repaired;
  }

  private applyPersistedCompositionChoices(
    tracks: Map<PresentationVariantId, CompiledPresentation>,
    state: PresentationGenerationState,
    context: GenerationContext,
  ): Map<PresentationVariantId, CompiledPresentation> {
    const restored = new Map<PresentationVariantId, CompiledPresentation>();
    for (const variant of VARIANT_IDS) {
      const presentation = variantsById(tracks, variant);
      const slides = presentation.slides.map((slide) => {
        const pack = state.slides.find((item) => item.slideId === slide.sourceDeckPlanSlideId);
        const choice = pack?.variants[variant].compositionChoice;
        if (!choice) return slide; // Compatibility with generation rows created before exact assignments were persisted.
        if (choice.kind === 'exemplar-backed') {
          if (!choice.exemplar || slide.nativeLayoutFallback) {
            throw new PresentationGenerationError('COMPOSITION_ASSIGNMENT_INVALID', 'The saved exemplar assignment is incomplete. Regenerate the slide before exporting.', 409);
          }
          try {
            return applyPersistedExemplarSelection(slide, choice.exemplar, context.templateIR, context.semanticProfile);
          } catch (error) {
            throw new PresentationGenerationError('COMPOSITION_ASSIGNMENT_STALE', 'The saved exemplar no longer passes projection safety. Regenerate the slide before exporting.', 409, { cause: error });
          }
        }
        if (choice.kind === 'layout-placeholder-backed' && !slide.nativeLayoutFallback) {
          throw new PresentationGenerationError('COMPOSITION_ASSIGNMENT_INVALID', 'The saved native layout assignment is incomplete. Regenerate the slide before exporting.', 409);
        }
        const { exemplarSelection: _exemplarSelection, ...withoutExemplar } = slide;
        return withoutExemplar;
      });
      restored.set(variant, { ...presentation, slides });
    }
    return restored;
  }

  private assertSameContext(state: PresentationGenerationState, context: GenerationContext): void {
    if (state.inputFingerprint !== context.fingerprint || state.planHash !== context.deckPlan.hash
        || state.contentIRHash !== context.contentIR.hash || state.templateIRHash !== context.templateIR.hash) {
      throw new PresentationGenerationError('PLANNING_STATE_STALE', 'The plan, source content, or template changed. Refresh planning before continuing.', 409);
    }
  }

  private current(projectId: string): PresentationGenerationState {
    const stored = getPresentationGeneration<PresentationGenerationState>(this.options.db, projectId);
    if (!stored) throw new PresentationGenerationError('GENERATION_NOT_FOUND', 'Slide generation has not been started.', 404);
    return validateStoredGeneration(stored.state);
  }

  private update(
    projectId: string,
    generationId: string,
    mutate: (current: PresentationGenerationState) => PresentationGenerationState,
  ) {
    const startedAt = performance.now();
    const stored = updatePresentationGeneration<PresentationGenerationState>(this.options.db, projectId, generationId, (value) => {
      const current = validateStoredGeneration(value);
      const next = mutate(current);
      next.updatedAt = this.now().toISOString();
      return next;
    });
    recordElapsed(this.options.performanceDiagnostics, 'statePersistence', startedAt);
    return stored ? { ...stored, state: validateStoredGeneration(stored.state) } : null;
  }

  private ensureReady(pack: GeneratedSlidePack | undefined): asserts pack is GeneratedSlidePack {
    if (!pack || pack.status !== 'ready') throw new PresentationGenerationError('SLIDE_PACK_NOT_READY', 'Wait until this slide pack is ready.', 409);
  }

  private ensureVersion(state: PresentationGenerationState, expected: unknown, slideId?: string): GeneratedSlidePack {
    const pack = slideId ? state.slides.find((item) => item.slideId === slideId) : state.slides[0];
    if (!pack) throw new PresentationGenerationError('SLIDE_NOT_FOUND', 'The requested slide is not in the saved deck plan.', 404);
    if (pack.version !== expected) throw new PresentationGenerationError('STALE_VERSION', 'This slide changed since it was loaded. Reload and retry the action.', 409);
    return pack;
  }

  private expectedVersion(value: unknown): void {
    if (!Number.isSafeInteger(value) || Number(value) < 1) throw new PresentationGenerationError('INVALID_VERSION', 'expectedVersion must be a positive integer.', 400);
  }

  private slideId(value: unknown): string {
    if (typeof value !== 'string' || !SLIDE_ID.test(value)) throw new PresentationGenerationError('INVALID_SLIDE_ID', 'Slide id is invalid.', 400);
    return value;
  }

  private variant(value: unknown): PresentationVariantId {
    if (value !== 'A' && value !== 'B' && value !== 'C') throw new PresentationGenerationError('INVALID_VARIANT', 'Choose variant A, B, or C.', 400);
    return value;
  }

  private exportMode(value: unknown): GenerationExportMode {
    if (value === 'selected' || value === 'A' || value === 'B' || value === 'C') return value;
    throw new PresentationGenerationError('INVALID_EXPORT_MODE', 'Export mode must be selected, A, B, or C.', 400);
  }

  private exportFormat(value: unknown): GenerationExportFormat {
    if (value === 'pptx' || value === 'pdf' || value === 'html') return value;
    throw new PresentationGenerationError('INVALID_EXPORT_FORMAT', 'Export format must be pptx, pdf, or html.', 400);
  }

  private async generatedFile(projectId: string, parts: string[], createParent: boolean): Promise<{ absolute: string }> {
    if (parts.length < 2 || parts.length > 8 || parts.some((part) => !/^[A-Za-z0-9._-]{1,128}$/.test(part) || part === '.' || part === '..')) {
      throw new PresentationGenerationError('INVALID_ARTIFACT_REF', 'Generated artifact reference is invalid.', 500);
    }
    const projectDir = path.join(this.options.projectsRoot, projectId);
    await mkdir(projectDir, { recursive: true });
    const canonicalProject = await realpath(projectDir);
    const canonicalProjectsRoot = await realpath(this.options.projectsRoot);
    if (path.dirname(canonicalProject) !== canonicalProjectsRoot) {
      throw new PresentationGenerationError('ARTIFACT_PATH_UNSAFE', 'Generated artifact project directory escapes project storage.', 500);
    }
    const generationRoot = path.join(projectDir, '.generation');
    if (createParent) await mkdir(generationRoot, { recursive: true });
    const rootInfo = await lstat(generationRoot).catch(() => null);
    if (!rootInfo || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new PresentationGenerationError('ARTIFACT_PATH_UNSAFE', 'Generated artifact directory is not safe.', 500);
    }
    const canonicalRoot = await realpath(generationRoot);
    if (path.relative(canonicalProject, canonicalRoot) !== '.generation') {
      throw new PresentationGenerationError('ARTIFACT_PATH_UNSAFE', 'Generated artifact directory escapes its project.', 500);
    }
    let parent = generationRoot;
    for (const segment of parts.slice(0, -1)) {
      parent = path.join(parent, segment);
      if (createParent) await mkdir(parent, { recursive: true });
      const info = await lstat(parent).catch(() => null);
      if (!info || info.isSymbolicLink() || !info.isDirectory()) {
        throw new PresentationGenerationError('ARTIFACT_PATH_UNSAFE', 'Generated artifact directory is not safe.', 500);
      }
      const canonical = await realpath(parent);
      const relative = path.relative(canonicalRoot, canonical);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new PresentationGenerationError('ARTIFACT_PATH_UNSAFE', 'Generated artifact directory escapes its project.', 500);
      }
    }
    const absolute = path.join(parent, parts.at(-1)!);
    const finalInfo = await lstat(absolute).catch(() => null);
    if (finalInfo?.isSymbolicLink()) throw new PresentationGenerationError('ARTIFACT_PATH_UNSAFE', 'Generated artifact target is a symbolic link.', 500);
    return { absolute };
  }

  private async resolveGeneratedRef(projectId: string, ref: string): Promise<string> {
    const parts = ref.split('/');
    return (await this.generatedFile(projectId, parts, false)).absolute;
  }

  private async writeArtifact(target: string, content: Uint8Array): Promise<void> {
    const startedAt = performance.now();
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, content, { flag: 'wx' });
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    recordElapsed(this.options.performanceDiagnostics, 'artifactIO', startedAt);
  }

  private async writeRunManifest(projectId: string, state: PresentationGenerationState, context: GenerationContext): Promise<void> {
    const target = await this.generatedFile(projectId, [state.generationId, 'run-manifest.json'], true);
    const audits = state.slides.flatMap((slide) => VARIANT_IDS.flatMap((variant) => slide.variants[variant].audit?.findings ?? []));
    const telemetry = context.planning.telemetry;
    const manifest = {
      schemaVersion: 1,
      applicationVersion: await applicationVersion(),
      runtime: { node: process.version, platform: process.platform, architecture: process.arch, renderer: state.backend },
      workflowVersions: context.planning.agentWorkflowVersions,
      promptVersions: context.planning.promptVersions,
      schemaVersions: {
        deckPlan: context.deckPlan.schemaVersion,
        contentIR: context.contentIR.schemaVersion,
        templateIR: context.templateIR.schemaVersion,
      },
      run: {
        generationId: state.generationId,
        status: state.status,
        startedAt: state.createdAt,
        updatedAt: state.updatedAt,
        durationMs: Math.max(0, Date.parse(state.updatedAt) - Date.parse(state.createdAt)),
        modelAlias: telemetry?.worker.model ?? null,
        timingsMs: telemetry ? {
          planning: telemetry.totalWallTimeMs,
          worker: telemetry.worker.wallTimeMs,
          supervisor: telemetry.supervisor.wallTimeMs,
          revisionWorker: telemetry.revisionWorker?.wallTimeMs ?? null,
        } : null,
      },
      inputHashes: {
        inputFingerprint: state.inputFingerprint,
        template: state.templateIRHash,
        contentIR: state.contentIRHash,
        sources: context.contentIR.sources.map((source) => source.sha256),
        plan: state.planHash,
      },
      selections: state.slides.map((slide) => ({
        slideId: slide.slideId,
        index: slide.index,
        selectedVariant: selectedVariant(state, slide.slideId),
        lockedVariant: slide.lockedVariant,
      })),
      auditSummary: {
        errors: audits.filter((finding) => finding.severity === 'error').length,
        warnings: audits.filter((finding) => finding.severity === 'warning').length,
        infos: audits.filter((finding) => finding.severity === 'info').length,
      },
      exports: state.exports.map((artifact) => ({
        id: artifact.id,
        mode: artifact.mode,
        format: artifact.format,
        sha256: artifact.sha256,
        slideCount: artifact.slideCount,
        createdAt: artifact.createdAt,
      })),
      contentExcluded: true,
      secretsExcluded: true,
    };
    try {
      await this.writeArtifact(target.absolute, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
    } catch {
      console.error(JSON.stringify({
        event: 'run.manifest', projectId, generationId: state.generationId,
        operation: 'write', status: 'error', errorCode: 'RUN_MANIFEST_WRITE_FAILED',
      }));
    }
  }
}
