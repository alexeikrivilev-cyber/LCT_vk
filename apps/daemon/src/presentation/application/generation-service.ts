import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';

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
import { assessVariantCompositionDistinctness } from './exemplar-slide-selector.js';
import { renderPresentation } from '../adapters/pptx-renderer-factory.js';
import { OfficeKitPreviewAdapter } from '../adapters/office-kit-preview-adapter.js';
import { inspectOfficeKitPackage } from '../adapters/office-kit-package-inspector.js';
import type { PptxBackendId, PptxRendererPort, PptxRenderResult } from './pptx-backend-port.js';
import type { PptxPreviewPort } from './pptx-preview-port.js';
import type { ContentIR } from '../domain/content-ir.js';
import type { DeckPlan } from '../domain/deck-plan.js';
import type { TemplateIR } from '../domain/template-ir.js';
import type { TemplateSemanticProfile } from './template-semantic-profiler.js';

export type GenerationStatus = 'preparing' | 'generating' | 'completed' | 'failed' | 'cancelled' | 'stale';
export type SlideGenerationStatus = 'pending' | 'rendering' | 'ready' | 'failed';
export type VisualSlotStatus = 'not-applicable' | 'ready' | 'unresolved';
export type GenerationExportMode = 'selected' | PresentationVariantId;

export interface GeneratedVariantState {
  status: 'pending' | 'ready' | 'failed';
  version: number;
  layoutCandidateIndex: number;
  previewRef: string | null;
  layoutIssueCount: number;
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

export interface PublicGeneratedVariant extends Omit<GeneratedVariantState, 'previewRef'> {
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
  /** Replaceable dependency seams for offline API tests. */
  inspectPackage?: typeof inspectOfficeKitPackage;
  profileTemplate?: (projectId: string, template: TemplateCompilationResponse) => Promise<TemplateSemanticProfile>;
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

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
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
    status: 'pending', version: 0, layoutCandidateIndex: 0, previewRef: null, layoutIssueCount: 0,
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
          || !(generated.previewRef === null || typeof generated.previewRef === 'string'
            && generated.previewRef.startsWith(`${state.generationId}/slides/`)
            && !generated.previewRef.includes('..') && !path.isAbsolute(generated.previewRef))
          || !Number.isSafeInteger(generated.layoutIssueCount) || generated.layoutIssueCount < 0
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
        || typeof artifact.fileRef !== 'string' || !artifact.fileRef.startsWith(`${state.generationId}/exports/`)
        || artifact.fileRef.includes('..') || path.isAbsolute(artifact.fileRef)
        || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)
        || artifact.slideCount !== state.totalSlides || artifact.validationStatus !== 'passed'
        || artifact.nativeOfficeStatus !== 'unknown' || !Array.isArray(artifact.unresolvedVisualTypes)
        || typeof artifact.createdAt !== 'string' || !Number.isFinite(Date.parse(artifact.createdAt))) {
      throw new PresentationGenerationError('GENERATION_STATE_INVALID', 'Saved PowerPoint export metadata is invalid.', 500);
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

function selectedVariant(state: PresentationGenerationState, slideId: string): PresentationVariantId {
  return state.selectionOverrides[slideId] ?? state.defaultTrack;
}

function publicSnapshot(stateValue: PresentationGenerationState): PublicPresentationGeneration {
  const state = validateStoredGeneration(stateValue);
  const slides = state.slides.map((pack): PublicGeneratedSlidePack => ({
    ...pack,
    selectedVariant: selectedVariant(state, pack.slideId),
    variants: Object.fromEntries(VARIANT_IDS.map((variant) => {
      const { previewRef, ...metadata } = pack.variants[variant];
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
  private readonly now: () => Date;
  private readonly renderer: PptxRendererPort;
  private readonly preview: PptxPreviewPort;
  private readonly inspectPackage: typeof inspectOfficeKitPackage;

  constructor(private readonly options: PresentationGenerationServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.renderer = options.renderer ?? { id: options.backend, render: (input) => renderPresentation(input, options.backend) };
    this.preview = options.preview ?? new OfficeKitPreviewAdapter();
    this.inspectPackage = options.inspectPackage ?? inspectOfficeKitPackage;
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

  async shutdown(): Promise<void> {
    for (const [projectId, task] of this.tasks) {
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
    await Promise.allSettled([...this.tasks.values()].map((task) => task.promise));
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
    if (task) await task.promise;
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
    const tracks = this.applyPersistedRepairs(this.compileTracks(context), initial);
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
    };
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
    return publicSnapshot(updated.state);
  }

  async export(projectIdValue: string, modeValue: unknown): Promise<{ state: PublicPresentationGeneration; artifact: Omit<GeneratedExport, 'fileRef'> & { downloadUrl: string } }> {
    const projectId = assertSafeProjectId(projectIdValue);
    const mode = this.exportMode(modeValue);
    const initial = this.current(projectId);
    if (initial.status !== 'completed' || initial.slides.some((pack) => pack.status !== 'ready')) {
      throw new PresentationGenerationError('GENERATION_INCOMPLETE', 'Wait until every slide pack is ready before exporting.', 409);
    }
    const context = await this.context(projectId);
    this.assertSameContext(initial, context);
    const tracks = this.applyPersistedRepairs(this.compileTracks(context), initial);
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
    const exportId = randomUUID();
    const output = await this.generatedFile(projectId, [initial.generationId, 'exports', `${exportId}.pptx`], true);
    let renderResult: PptxRenderResult;
    try {
      renderResult = await this.renderer.render({
        compiledPresentation: selectedPresentation,
        contentIR: context.contentIR,
        templateIR: context.templateIR,
        ...(context.semanticProfile ? { semanticProfile: context.semanticProfile } : {}),
        templatePath: context.templatePath,
        outputPath: output.absolute,
        contentRoot: path.join(this.options.projectsRoot, projectId),
      });
      const bytes = await readFile(output.absolute);
      const inspected = await this.inspectPackage(bytes);
      if (inspected.slideCount !== slides.length || inspected.validationIssues.some((issue) => issue.severity === 'error')) {
        throw new PresentationGenerationError('EXPORT_VALIDATION_FAILED', 'The generated PowerPoint did not pass package reopen validation.', 422);
      }
      if (renderResult.validationStatus === 'failed' || renderResult.reopenStatus === 'failed') {
        throw new PresentationGenerationError('EXPORT_VALIDATION_FAILED', 'The selected PowerPoint backend reported a validation failure.', 422);
      }
      const artifact: GeneratedExport = {
        id: exportId,
        mode,
        fileRef: `${initial.generationId}/exports/${exportId}.pptx`,
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
        return { ...fresh, exports: [...fresh.exports, artifact], updatedAt: this.now().toISOString() };
      });
      if (!updated) throw new PresentationGenerationError('GENERATION_NOT_FOUND', 'Generation state changed while exporting.', 409);
      const publicArtifact = publicSnapshot(updated.state).exports.find((item) => item.id === exportId)!;
      return { state: publicSnapshot(updated.state), artifact: publicArtifact };
    } catch (error) {
      await rm(output.absolute, { force: true }).catch(() => undefined);
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
    if (!artifact) throw new PresentationGenerationError('EXPORT_NOT_FOUND', 'The validated PowerPoint export was not found.', 404);
    const absolute = await this.resolveGeneratedRef(projectId, artifact.fileRef);
    try { return { bytes: await readFile(absolute), artifact }; }
    catch { throw new PresentationGenerationError('EXPORT_NOT_FOUND', 'The validated PowerPoint artifact is missing.', 404); }
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
    let currentSlideId: string | null = null;
    try {
      const initial = this.current(projectId);
      if (initial.generationId !== generationId || initial.status === 'cancelled') return;
      const context = await this.context(projectId);
      this.assertSameContext(initial, context);
      const tracks = this.compileTracks(context);
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
        const variantSlides = VARIANT_IDS.map((variant) => {
          const presentation = variantsById(tracks, variant);
          const slide = presentation.slides.find((candidate) => candidate.sourceDeckPlanSlideId === currentSlideId);
          if (!slide) throw new PresentationGenerationError('PLAN_CHANGED', 'A planned slide is missing from the compiled output.', 409);
          return slide;
        });
        const compositionDistinctness = assessVariantCompositionDistinctness(variantSlides, context.templateIR, this.options.backend, context.semanticProfile);
        if (!compositionDistinctness.distinct) {
          throw new PresentationGenerationError(
            'VARIANTS_NOT_DISTINCT',
            `Slide ${pack.index} has only ${compositionDistinctness.availableDistinctFamilies} distinct safe projected composition(s); A/B/C were withheld. ${compositionDistinctness.evidence.join('; ')}`,
            422,
          );
        }
        const pendingResults = {} as Record<PresentationVariantId, Omit<GeneratedVariantState, 'status' | 'version'>>;
        for (const variant of VARIANT_IDS) {
          if (signal.aborted || this.current(projectId).status === 'cancelled') return;
          const presentation = variantsById(tracks, variant);
          const slide = presentation.slides.find((candidate) => candidate.sourceDeckPlanSlideId === currentSlideId);
          if (!slide) throw new PresentationGenerationError('PLAN_CHANGED', 'A planned slide is missing from the compiled output.', 409);
          const audit = auditForSlide(presentation, context.contentIR, context.templateIR, slide);
          if (audit.findings.some((finding) => finding.severity === 'error')) {
            throw new PresentationGenerationError('AUDIT_BLOCKED', 'A deterministic audit error prevents publishing this slide pack.', 422);
          }
          const currentPack = this.current(projectId).slides.find((item) => item.slideId === currentSlideId)!;
          const variantState = await this.renderVariant(projectId, this.current(projectId), currentPack, variant, presentation, slide, context, 1);
          pendingResults[variant] = { ...variantState, audit };
        }
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
      this.update(projectId, generationId, (state) => ({
        ...state,
        status: 'completed',
        currentSlideId: null,
        readySlides: state.slides.filter((pack) => pack.status === 'ready').length,
        failure: null,
        updatedAt: this.now().toISOString(),
      }));
    } catch (error) {
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
      const unresolved = rendered.unresolvedVisualTypes.length > 0 || slide.visualization.status === 'unresolved';
      return {
        previewRef,
        layoutCandidateIndex,
        layoutIssueCount: preview.textLayoutIssues.length,
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
        const candidateIndex = pack?.variants[variant].layoutCandidateIndex ?? 0;
        const candidate = slide.layoutCandidates[candidateIndex];
        if (!candidate || candidateIndex === slide.selectedCandidateIndex) return slide;
        return {
          ...slide,
          layoutId: candidate.layoutId,
          layoutSourcePart: candidate.sourcePart,
          placements: { title: candidate.titleBox, body: candidate.bodyBox, visual: candidate.visualBox },
          selectedCandidateIndex: candidateIndex,
        };
      });
      repaired.set(variant, { ...base, slides });
    }
    return repaired;
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
    const stored = updatePresentationGeneration<PresentationGenerationState>(this.options.db, projectId, generationId, (value) => {
      const current = validateStoredGeneration(value);
      const next = mutate(current);
      next.updatedAt = this.now().toISOString();
      return next;
    });
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

  private async generatedFile(projectId: string, parts: string[], createParent: boolean): Promise<{ absolute: string }> {
    if (parts.length < 2 || parts.length > 8 || parts.some((part) => !/^[A-Za-z0-9._-]{1,128}$/.test(part) || part === '.' || part === '..')) {
      throw new PresentationGenerationError('INVALID_ARTIFACT_REF', 'Generated artifact reference is invalid.', 500);
    }
    const projectDir = path.join(this.options.projectsRoot, projectId);
    await mkdir(projectDir, { recursive: true });
    const canonicalProject = await realpath(projectDir);
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
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, content, { flag: 'wx' });
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
