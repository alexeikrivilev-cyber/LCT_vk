import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertSafeProjectId, resolvePresentationFilePath } from '../../presentation-files.js';
import type { PlanningResponse, PlanningService } from './planning-service.js';
import { PlanningServiceError } from './planning-service.js';
import type { PresentationGenerationService, PublicPresentationGeneration } from './generation-service.js';
import { PresentationGenerationError } from './generation-service.js';
import { compileTemplate, getTemplateCompilation, TemplateCompilerError, type TemplateCompilationResponse } from './template-compiler.js';
import { validateBrief, type Brief } from '../domain/brief.js';
import type { ContentIR } from '../domain/content-ir.js';
import type { DeckPlan } from '../domain/deck-plan.js';
import type { SemanticInferenceAdapter, SemanticInferenceRequest, SemanticJsonSchema, SemanticInferenceTelemetry } from './semantic-inference-port.js';
import { SemanticInferenceError } from './semantic-inference-port.js';
import {
  CONTEXTUAL_AUDIT_RULE_SET_VERSION,
  CONTEXTUAL_AUDIT_RULES,
  CONTEXTUAL_AUDIT_SCHEMA_VERSION,
  CONTEXTUAL_AUDIT_SCHEMA_NAME,
  CONTEXTUAL_AUDIT_VERSION_FINGERPRINT,
  contextualDeckAuditSchema,
  validateContextualDeckAuditResponse,
  type ContextualDeckAuditFinding,
  type ContextualDeckAuditResponse,
  type ContextualDeckAuditValidationContext,
} from './contextual-audit-port.js';
import { CONTEXTUAL_AUDITOR_WORKFLOW } from './workflow-versions.js';

export const CONTEXTUAL_DECK_AUDIT_PROMPT_VERSION = CONTEXTUAL_AUDITOR_WORKFLOW.promptVersion;
const LEGACY_CONTEXTUAL_AUDIT_RULES = [
  'titleTakeaway', 'titleContentAlignment', 'factGrounding', 'visualSemanticFit', 'languageConsistency',
  'narrativeContinuity', 'redundancy', 'garbage', 'oneSentenceSummary',
] as const;
const MAX_SELECTED_FILES = 12;
const MAX_AUDIT_INPUT_CHARS = 128 * 1024;
const GENERATION_WAIT_MS = 12 * 60 * 1000;

export type ProductWorkflowStage =
  | 'analyzing_template'
  | 'understanding_template'
  | 'planning'
  | 'generating'
  | 'contextual_audit'
  | 'ready'
  | 'failed';

export type ProductWorkflowStatus = 'running' | 'ready' | 'failed';

export interface ProductWorkflowInput {
  templateFilePath: string;
  contentFiles: string[];
  brief: Brief;
}

export interface ProductWorkflowFailure {
  code: string;
  stage: ProductWorkflowStage;
  retryable: boolean;
}

export interface ProductWorkflowTelemetry {
  model: string;
  wallTimeMs: number;
  finishReason: string | null;
}

export interface ProductContextualAuditState {
  schemaVersion: 1 | typeof CONTEXTUAL_AUDIT_SCHEMA_VERSION;
  ruleSetVersion: 'contextual-deck-audit.v1' | typeof CONTEXTUAL_AUDIT_RULE_SET_VERSION;
  auditVersionFingerprint: string | null;
  status: 'ready' | 'failed';
  deckFingerprint: string;
  findings: ContextualDeckAuditFinding[] | null;
  telemetry: ProductWorkflowTelemetry | null;
  checkedAt: string;
  failureCode: string | null;
}

interface StoredProductWorkflow {
  schemaVersion: 1;
  operationId: string;
  inputFingerprint: string;
  inputs: ProductWorkflowInput;
  status: ProductWorkflowStatus;
  stage: ProductWorkflowStage;
  readySlides: number;
  totalSlides: number | null;
  planningFingerprint: string | null;
  generationId: string | null;
  contextualAudit: ProductContextualAuditState | null;
  failure: ProductWorkflowFailure | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductWorkflowSnapshot {
  operationId: string;
  inputFingerprint: string;
  status: ProductWorkflowStatus;
  stage: ProductWorkflowStage;
  readySlides: number;
  totalSlides: number | null;
  planningFingerprint: string | null;
  generationId: string | null;
  contextualAudit: (ProductContextualAuditState & { stale: boolean }) | null;
  failure: ProductWorkflowFailure | null;
  createdAt: string;
  updatedAt: string;
}

export class ProductWorkflowError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProductWorkflowError';
    this.code = code;
    this.status = status;
  }
}

export interface ProductWorkflowServiceOptions {
  projectRoot: string;
  projectsRoot: string;
  planningService: PlanningService;
  generationService: PresentationGenerationService;
  getInferenceAdapter: () => SemanticInferenceAdapter;
  profileTemplate?: (projectId: string, template: TemplateCompilationResponse) => Promise<unknown>;
  now?: () => Date;
}

const TRANSIENT_RENAME_RETRY_DELAYS_MS = [20, 40, 80, 160, 320] as const;

export async function renameWithTransientRetry(
  source: string,
  target: string,
  renameFile: typeof rename = rename,
  delay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryDelay = TRANSIENT_RENAME_RETRY_DELAYS_MS[attempt];
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || retryDelay === undefined) throw error;
      await delay(retryDelay);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function normalizeInput(value: unknown): ProductWorkflowInput {
  if (!isRecord(value) || Object.keys(value).length !== 3
      || !Object.hasOwn(value, 'templateFilePath') || !Object.hasOwn(value, 'contentFiles') || !Object.hasOwn(value, 'brief')) {
    throw new ProductWorkflowError('INVALID_PRODUCT_WORKFLOW_INPUT', 'Provide a selected PPTX template, task brief, and optional project source files.', 400);
  }
  if (typeof value.templateFilePath !== 'string' || !value.templateFilePath.trim() || value.templateFilePath.length > 512
      || !Array.isArray(value.contentFiles) || value.contentFiles.length > MAX_SELECTED_FILES
      || value.contentFiles.some((item) => typeof item !== 'string' || !item.trim() || item.length > 512)
      || new Set(value.contentFiles).size !== value.contentFiles.length) {
    throw new ProductWorkflowError('INVALID_PRODUCT_WORKFLOW_INPUT', 'Choose one project PPTX and at most 12 unique source files.', 400);
  }
  if (value.contentFiles.includes(value.templateFilePath)) {
    throw new ProductWorkflowError('INVALID_PRODUCT_WORKFLOW_INPUT', 'The presentation template cannot also be selected as source content.', 400);
  }
  let brief: Brief;
  try { brief = validateBrief(value.brief); }
  catch (error) {
    throw new ProductWorkflowError('INVALID_BRIEF', 'Enter a task and check the optional presentation settings.', 400, { cause: error });
  }
  return { templateFilePath: value.templateFilePath.trim(), contentFiles: [...value.contentFiles], brief };
}

function isStage(value: unknown): value is ProductWorkflowStage {
  return ['analyzing_template', 'understanding_template', 'planning', 'generating', 'contextual_audit', 'ready', 'failed'].includes(String(value));
}

function isSafeAuditState(value: unknown): value is ProductContextualAuditState | Record<string, unknown> {
  if (!isRecord(value) || !['ready', 'failed'].includes(String(value.status)) || !safeFingerprint(value.deckFingerprint)
      || typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt))
      || !(value.failureCode === null || typeof value.failureCode === 'string' && value.failureCode.length <= 80)) return false;
  const legacy = value.schemaVersion === undefined && value.ruleSetVersion === undefined && value.auditVersionFingerprint === undefined;
  const current = value.schemaVersion === CONTEXTUAL_AUDIT_SCHEMA_VERSION
    && value.ruleSetVersion === CONTEXTUAL_AUDIT_RULE_SET_VERSION
    && value.auditVersionFingerprint === CONTEXTUAL_AUDIT_VERSION_FINGERPRINT;
  if (!legacy && !current) return false;
  if (value.telemetry !== null && (!isRecord(value.telemetry) || typeof value.telemetry.model !== 'string' || value.telemetry.model.length > 160
      || !Number.isFinite(value.telemetry.wallTimeMs) || Number(value.telemetry.wallTimeMs) < 0
      || !(value.telemetry.finishReason === null || typeof value.telemetry.finishReason === 'string' && value.telemetry.finishReason.length <= 64))) return false;
  if (value.status === 'ready' && (!Array.isArray(value.findings)
      || value.findings.length !== (legacy ? LEGACY_CONTEXTUAL_AUDIT_RULES.length : CONTEXTUAL_AUDIT_RULES.length)
      || value.failureCode !== null || value.telemetry === null)) return false;
  if (value.status === 'failed' && (value.findings !== null || value.failureCode === null)) return false;
  if (Array.isArray(value.findings)) {
    const ruleIds = new Set<string>();
    for (const finding of value.findings) {
      const allowedRules: readonly string[] = legacy ? LEGACY_CONTEXTUAL_AUDIT_RULES : CONTEXTUAL_AUDIT_RULES;
      if (!isRecord(finding) || typeof finding.ruleId !== 'string' || !allowedRules.includes(finding.ruleId)
          || ruleIds.has(finding.ruleId) || !(finding.slideId === null || typeof finding.slideId === 'string' && finding.slideId.length <= 128)
          || !['info', 'warning', 'error'].includes(String(finding.severity)) || typeof finding.messageCode !== 'string'
          || finding.messageCode.length > 64 || !Array.isArray(finding.evidenceRefs) || finding.evidenceRefs.length > 8
          || finding.evidenceRefs.some((ref) => typeof ref !== 'string' || ref.length > 128)
          || typeof finding.repairable !== 'boolean'
          || !(finding.suggestedActionCode === null || typeof finding.suggestedActionCode === 'string' && finding.suggestedActionCode.length <= 64)) return false;
      ruleIds.add(finding.ruleId);
    }
    const expectedRules: readonly string[] = legacy ? LEGACY_CONTEXTUAL_AUDIT_RULES : CONTEXTUAL_AUDIT_RULES;
    if (ruleIds.size !== expectedRules.length || expectedRules.some((ruleId) => !ruleIds.has(ruleId))) return false;
  }
  return true;
}

function normalizeStoredAudit(value: unknown): ProductContextualAuditState | null {
  if (value === null) return null;
  if (!isSafeAuditState(value) || !isRecord(value)) return null;
  if (value.schemaVersion === undefined) {
    // Keep old evidence explicitly tagged as v1/legacy so freshness checks can only expose it as stale.
    return { ...(value as unknown as Omit<ProductContextualAuditState, 'schemaVersion' | 'ruleSetVersion' | 'auditVersionFingerprint'>),
      schemaVersion: 1, ruleSetVersion: 'contextual-deck-audit.v1', auditVersionFingerprint: null };
  }
  return value as unknown as ProductContextualAuditState;
}

export function isCurrentContextualAuditState(value: unknown): value is ProductContextualAuditState {
  return isSafeAuditState(value) && isRecord(value) && value.schemaVersion === CONTEXTUAL_AUDIT_SCHEMA_VERSION
    && value.ruleSetVersion === CONTEXTUAL_AUDIT_RULE_SET_VERSION
    && value.auditVersionFingerprint === CONTEXTUAL_AUDIT_VERSION_FINGERPRINT
    && value.status === 'ready' && Array.isArray(value.findings) && value.findings.length === CONTEXTUAL_AUDIT_RULES.length;
}

function validateStored(value: unknown): StoredProductWorkflow {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.operationId !== 'string' || value.operationId.length > 80
      || !safeFingerprint(value.inputFingerprint) || !isRecord(value.inputs) || typeof value.inputs.templateFilePath !== 'string'
      || !Array.isArray(value.inputs.contentFiles) || !value.inputs.contentFiles.every((item) => typeof item === 'string')
      || !['running', 'ready', 'failed'].includes(String(value.status)) || !isStage(value.stage)
      || !Number.isSafeInteger(value.readySlides) || Number(value.readySlides) < 0
      || !(value.totalSlides === null || Number.isSafeInteger(value.totalSlides) && Number(value.totalSlides) >= 0)
      || !(value.planningFingerprint === null || safeFingerprint(value.planningFingerprint))
      || !(value.generationId === null || typeof value.generationId === 'string' && value.generationId.length <= 80)
      || !(value.contextualAudit === null || isSafeAuditState(value.contextualAudit))
      || !(value.failure === null || isRecord(value.failure) && typeof value.failure.code === 'string' && value.failure.code.length <= 80
        && isStage(value.failure.stage) && typeof value.failure.retryable === 'boolean')
      || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
      || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new ProductWorkflowError('PRODUCT_WORKFLOW_STATE_INVALID', 'Saved presentation operation state is invalid. Reload the project and retry.', 500);
  }
  const inputs = normalizeInput(value.inputs);
  if (sha256(canonicalJson(inputs)) !== value.inputFingerprint) {
    throw new ProductWorkflowError('PRODUCT_WORKFLOW_STATE_INVALID', 'Saved presentation inputs do not match their fingerprint.', 500);
  }
  return { ...value, contextualAudit: normalizeStoredAudit(value.contextualAudit) } as unknown as StoredProductWorkflow;
}

async function statePath(projectsRoot: string, projectId: string): Promise<string> {
  return (await resolvePresentationFilePath(projectsRoot, projectId, '.workflow/state.json', { createParent: true })).absolute;
}

function publicSnapshot(state: StoredProductWorkflow, stale = false): ProductWorkflowSnapshot {
  return {
    operationId: state.operationId,
    inputFingerprint: state.inputFingerprint,
    status: state.status,
    stage: state.stage,
    readySlides: state.readySlides,
    totalSlides: state.totalSlides,
    planningFingerprint: state.planningFingerprint,
    generationId: state.generationId,
    contextualAudit: state.contextualAudit ? { ...state.contextualAudit, stale } : null,
    failure: state.failure,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

function samePlanningInputs(planning: PlanningResponse, input: ProductWorkflowInput): boolean {
  return planning.status === 'ready' && planning.brief !== null
    && canonicalJson(planning.brief) === canonicalJson(input.brief)
    && canonicalJson(planning.contentFiles) === canonicalJson(input.contentFiles);
}

function safeFailureCode(error: unknown): { code: string; status: number } {
  if (error instanceof ProductWorkflowError || error instanceof TemplateCompilerError
      || error instanceof PlanningServiceError || error instanceof PresentationGenerationError) {
    return { code: error.code, status: error.status };
  }
  if (error instanceof SemanticInferenceError) {
    return { code: error.code, status: error.code === 'CONFIGURATION_ERROR' ? 503 : 502 };
  }
  return { code: 'PRODUCT_WORKFLOW_FAILED', status: 500 };
}

function slideRefs(plan: DeckPlan): Map<string, ReadonlySet<string>> {
  return new Map(plan.slides.map((slide) => [slide.id, new Set(slide.contentRefs)]));
}

function selectedDeckFingerprint(generation: PublicPresentationGeneration): string {
  return sha256(canonicalJson({
    generationId: generation.generationId,
    selectionVersion: generation.selectionVersion,
    slides: generation.slides.map((pack) => ({
      slideId: pack.slideId,
      selectedVariant: pack.selectedVariant,
      variantVersion: pack.variants[pack.selectedVariant]?.version ?? -1,
      packVersion: pack.version,
    })),
  }));
}

function auditTextForUnit(unit: ContentIR['units'][number]): string | null {
  if (typeof unit.text === 'string') {
    return unit.kind === 'heading' ? unit.text.replace(/^ {0,3}#{1,6}(?:[\t ]+|$)/u, '').trim() : unit.text;
  }
  if (typeof unit.cellValue === 'string') return unit.cellValue;
  if (typeof unit.numericLexeme === 'string') return unit.numericLexeme;
  return null;
}

export function auditEvidence(contentIR: ContentIR, plan: DeckPlan, generation: PublicPresentationGeneration) {
  const units = new Map(contentIR.units.filter((unit) => unit.kind !== 'media-reference').map((unit) => [unit.id, unit]));
  const slideById = new Map(plan.slides.map((slide) => [slide.id, slide]));
  const slideContentRefs = slideRefs(plan);
  const knownEvidenceRefs = new Set(plan.slides.flatMap((slide) => slide.contentRefs));
  const slides = generation.slides.map((pack) => {
    const planSlide = slideById.get(pack.slideId);
    const variant = pack.variants[pack.selectedVariant];
    if (!planSlide || !variant || variant.status !== 'ready') {
      throw new ProductWorkflowError('CONTEXTUAL_AUDIT_DECK_NOT_READY', 'The selected deck is incomplete; finish or choose ready slide variants before the semantic review.', 409);
    }
    if (!variant.audit || !Array.isArray(variant.audit.findings)) {
      throw new ProductWorkflowError('DETERMINISTIC_AUDIT_NOT_READY', 'The selected slide has no completed deterministic audit.', 409);
    }
    if (variant.audit.findings.some((finding) => finding.severity === 'error')) {
      throw new ProductWorkflowError('DETERMINISTIC_AUDIT_FAILED', 'The selected slide has a deterministic error. Resolve it before contextual review.', 409);
    }
    const bodyText = planSlide.contentRefs.flatMap((ref) => {
      const unit = units.get(ref);
      if (!unit) {
        throw new ProductWorkflowError('CONTEXTUAL_AUDIT_EVIDENCE_MISSING', 'The selected slide refers to source evidence that is no longer available.', 409);
      }
      const text = auditTextForUnit(unit);
      return text === null || !text.trim() ? [] : [text];
    });
    return {
      slideId: pack.slideId,
      order: pack.index,
      title: pack.title,
      bodyText,
      evidenceRefs: [...planSlide.contentRefs],
      narrativeRole: planSlide.narrativeRole,
      purpose: planSlide.purpose,
      takeaway: planSlide.takeaway,
      semanticVisualType: planSlide.semanticVisualType,
      targetDensity: planSlide.targetDensity,
      selectedVariant: pack.selectedVariant,
      composition: {
        variant: pack.selectedVariant,
        layoutCandidateIndex: variant.layoutCandidateIndex,
        visualSlotStatus: variant.visualSlotStatus,
      },
    };
  });
  const evidence = contentIR.units.filter((unit) => knownEvidenceRefs.has(unit.id)).map((unit) => ({
    id: unit.id,
    kind: unit.kind,
    text: auditTextForUnit(unit) ?? '',
  }));
  if (evidence.length !== knownEvidenceRefs.size) {
    throw new ProductWorkflowError('CONTEXTUAL_AUDIT_EVIDENCE_MISSING', 'Source evidence for the selected presentation is incomplete.', 409);
  }
  return { slides, slideContentRefs, knownEvidenceRefs, evidence };
}

export class ProductWorkflowService {
  private readonly active = new Map<string, { fingerprint: string; promise: Promise<void> }>();
  private readonly stateLocks = new Map<string, Promise<void>>();
  private readonly now: () => Date;
  private shuttingDown = false;

  constructor(private readonly options: ProductWorkflowServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async start(projectIdValue: string, value: unknown): Promise<ProductWorkflowSnapshot> {
    const projectId = assertSafeProjectId(projectIdValue);
    const inputs = normalizeInput(value);
    const fingerprint = sha256(canonicalJson(inputs));
    let launchSaved: StoredProductWorkflow | null = null;
    const result = await this.withStateLock(projectId, async () => {
      const inFlight = this.active.get(projectId);
      if (inFlight) {
        if (inFlight.fingerprint !== fingerprint) {
          throw new ProductWorkflowError('PRODUCT_WORKFLOW_ALREADY_RUNNING', 'A different presentation operation is already running for this project.', 409);
        }
        const current = await this.read(projectId);
        if (current) return publicSnapshot(current);
      }
      let saved = await this.read(projectId);
      if (saved?.status === 'running' && saved.inputFingerprint !== fingerprint) {
        throw new ProductWorkflowError('PRODUCT_WORKFLOW_ALREADY_RUNNING', 'A different presentation operation is already running for this project.', 409);
      }
      if (saved?.inputFingerprint === fingerprint && saved.status === 'ready') {
        const current = await this.snapshotWithFreshness(projectId, saved);
        if (current.contextualAudit && !current.contextualAudit.stale) return current;
      }
      if (saved?.inputFingerprint === fingerprint && saved.status === 'running') {
        launchSaved = saved;
        return publicSnapshot(saved);
      }
      const timestamp = this.now().toISOString();
      saved = {
        schemaVersion: 1,
        operationId: randomUUID(),
        inputFingerprint: fingerprint,
        inputs,
        status: 'running',
        stage: 'analyzing_template',
        readySlides: 0,
        totalSlides: null,
        planningFingerprint: null,
        generationId: null,
        contextualAudit: null,
        failure: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.writeUnlocked(projectId, saved);
      launchSaved = saved;
      return publicSnapshot(saved);
    });
    if (launchSaved) this.launch(projectId, launchSaved);
    return result;
  }

  async get(projectIdValue: string): Promise<ProductWorkflowSnapshot | null> {
    const projectId = assertSafeProjectId(projectIdValue);
    const saved = await this.read(projectId);
    if (!saved) return null;
    if (saved.status === 'running' && !this.active.has(projectId)) this.launch(projectId, saved);
    return this.snapshotWithFreshness(projectId, saved);
  }

  async auditCurrentSelection(projectIdValue: string): Promise<ProductWorkflowSnapshot> {
    const projectId = assertSafeProjectId(projectIdValue);
    const saved = await this.read(projectId);
    if (!saved || saved.status !== 'ready') throw new ProductWorkflowError('PRODUCT_WORKFLOW_NOT_READY', 'Generate the presentation before reviewing its meaning.', 409);
    const generation = await this.options.generationService.getSnapshot(projectId);
    if (!generation || generation.status !== 'completed') throw new ProductWorkflowError('GENERATION_NOT_READY', 'Wait until slide generation finishes.', 409);
    const deckFingerprint = selectedDeckFingerprint(generation);
    const operationKey = `audit:${deckFingerprint}`;
    const active = this.active.get(projectId);
    if (active) {
      if (active.fingerprint === operationKey) return this.get(projectId) as Promise<ProductWorkflowSnapshot>;
      throw new ProductWorkflowError('PRODUCT_WORKFLOW_ALREADY_RUNNING', 'Wait until the current presentation operation finishes.', 409);
    }
    const latest = await this.read(projectId);
    if (latest?.contextualAudit?.deckFingerprint === deckFingerprint && isCurrentContextualAuditState(latest.contextualAudit)) {
      return (await this.snapshotWithFreshness(projectId, latest))!;
    }
    const task = Promise.resolve().then(async () => {
      const current = await this.read(projectId);
      if (!current || current.operationId !== saved.operationId) return;
      await this.update(projectId, current, { status: 'running', stage: 'contextual_audit', failure: null });
      await this.performContextualAudit(projectId, current, generation, deckFingerprint);
      const afterAudit = await this.read(projectId);
      if (afterAudit?.operationId === current.operationId) {
        await this.update(projectId, afterAudit, { status: 'ready', stage: 'ready', failure: null });
      }
    }).catch(async (error: unknown) => {
      await this.fail(projectId, saved.operationId, 'contextual_audit', error);
    }).finally(() => {
      if (this.active.get(projectId)?.fingerprint === operationKey) this.active.delete(projectId);
    });
    this.active.set(projectId, { fingerprint: operationKey, promise: task });
    await task;
    return (await this.get(projectId))!;
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((item) => item.promise));
  }

  /** Stop in-memory orchestration while leaving the last persisted stage resumable. */
  requestShutdown(): void {
    this.shuttingDown = true;
  }

  private launch(projectId: string, saved: StoredProductWorkflow): void {
    if (this.active.has(projectId)) return;
    const fingerprint = saved.inputFingerprint;
    const task = Promise.resolve().then(() => this.run(projectId, saved.operationId)).catch(async (error: unknown) => {
      await this.fail(projectId, saved.operationId, saved.stage, error);
    }).finally(() => {
      if (this.active.get(projectId)?.fingerprint === fingerprint) this.active.delete(projectId);
    });
    this.active.set(projectId, { fingerprint, promise: task });
  }

  private async run(projectId: string, operationId: string): Promise<void> {
    let saved = await this.read(projectId);
    if (!saved || saved.operationId !== operationId) return;
    const inputs = saved.inputs;
    try {
      this.throwIfShuttingDown();
      let template = await getTemplateCompilation(this.options.projectsRoot, projectId);
      if (template.status !== 'ready' || template.source?.filePath !== inputs.templateFilePath) {
        await this.update(projectId, saved, { stage: 'analyzing_template', failure: null, status: 'running' });
        template = await compileTemplate(this.options.projectsRoot, projectId, inputs.templateFilePath);
      }
      this.throwIfShuttingDown();
      if (template.status !== 'ready' || !template.templateIR || !template.presentationDesignSystem) {
        throw new ProductWorkflowError('TEMPLATE_NOT_READY', 'Не удалось подготовить выбранный шаблон.', 409);
      }
      saved = (await this.read(projectId))!;
      await this.update(projectId, saved, { stage: 'understanding_template' });
      if (this.options.profileTemplate) await this.options.profileTemplate(projectId, template);

      this.throwIfShuttingDown();
      saved = (await this.read(projectId))!;
      await this.update(projectId, saved, { stage: 'planning' });
      let planning = await this.options.planningService.get(projectId);
      if (!samePlanningInputs(planning, inputs)) {
        planning = await this.options.planningService.generate(projectId, { contentFiles: inputs.contentFiles, brief: inputs.brief });
      }
      this.throwIfShuttingDown();
      if (planning.status !== 'ready' || !planning.deckPlan || !planning.contentIR || !planning.inputFingerprint) {
        throw new ProductWorkflowError('PLANNING_NOT_READY', 'Не удалось подготовить план презентации.', 422);
      }

      saved = (await this.read(projectId))!;
      await this.update(projectId, saved, {
        stage: 'generating',
        planningFingerprint: planning.inputFingerprint,
        totalSlides: planning.deckPlan.slides.length,
      });
      const generationKey = `workflow-${sha256(`${planning.inputFingerprint}:${planning.deckPlan.hash}`).slice(0, 48)}`;
      const existingGeneration = await this.options.generationService.getSnapshot(projectId);
      const isSameGeneration = Boolean(existingGeneration
        && existingGeneration.planHash === planning.deckPlan.hash
        && existingGeneration.templateIRHash === template.templateIR!.hash
        && existingGeneration.contentIRHash === planning.contentIR.hash
        && ['preparing', 'generating', 'completed'].includes(existingGeneration.status));
      const generationStart = isSameGeneration
        ? { state: existingGeneration!, created: false }
        : await this.options.generationService.start(projectId, generationKey);
      const generation = await this.waitForGeneration(projectId, generationStart.state.generationId, async (next) => {
        const current = await this.read(projectId);
        if (current?.operationId === operationId) await this.update(projectId, current, {
          readySlides: next.readySlides,
          totalSlides: next.totalSlides,
          generationId: next.generationId,
        });
      });
      saved = (await this.read(projectId))!;
      await this.update(projectId, saved, { stage: 'contextual_audit', generationId: generation.generationId, readySlides: generation.readySlides, totalSlides: generation.totalSlides });
      await this.performContextualAudit(projectId, saved, generation, selectedDeckFingerprint(generation));
      this.throwIfShuttingDown();
      saved = (await this.read(projectId))!;
      await this.update(projectId, saved, { status: 'ready', stage: 'ready', failure: null });
    } catch (error) {
      if (this.shuttingDown) return;
      await this.fail(projectId, operationId, (await this.read(projectId))?.stage ?? 'failed', error);
    }
  }

  private throwIfShuttingDown(): void {
    if (this.shuttingDown) throw new ProductWorkflowError('PRODUCT_WORKFLOW_INTERRUPTED', 'The operation will resume after restart.', 503);
  }

  private async waitForGeneration(
    projectId: string,
    generationId: string,
    onProgress: (generation: PublicPresentationGeneration) => Promise<void>,
  ): Promise<PublicPresentationGeneration> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < GENERATION_WAIT_MS) {
      if (this.shuttingDown) throw new ProductWorkflowError('PRODUCT_WORKFLOW_INTERRUPTED', 'The operation will resume after restart.', 503);
      const generation = await this.options.generationService.getSnapshot(projectId);
      if (!generation || generation.generationId !== generationId) {
        throw new ProductWorkflowError('GENERATION_STATE_LOST', 'Состояние создания презентации недоступно. Обновите проект и повторите попытку.', 409);
      }
      const current = await this.read(projectId);
      if (current && (current.readySlides !== generation.readySlides || current.totalSlides !== generation.totalSlides
          || current.generationId !== generation.generationId)) await onProgress(generation);
      if (generation.status === 'completed') return generation;
      if (['failed', 'cancelled', 'stale'].includes(generation.status)) {
        throw new ProductWorkflowError(generation.failure?.code ?? 'GENERATION_FAILED', 'Не удалось завершить создание слайдов. Готовые варианты сохранены.', 422);
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 500);
        timer.unref?.();
      });
    }
    throw new ProductWorkflowError('GENERATION_TIMEOUT', 'Создание презентации превысило допустимое время ожидания.', 504);
  }

  private async performContextualAudit(
    projectId: string,
    saved: StoredProductWorkflow,
    generation: PublicPresentationGeneration,
    deckFingerprint: string,
  ): Promise<void> {
    const planning = await this.options.planningService.get(projectId);
    if (planning.status !== 'ready' || !planning.brief || !planning.deckPlan || !planning.contentIR) {
      throw new ProductWorkflowError('PLANNING_NOT_READY', 'Сохранённый план больше не соответствует входным данным.', 409);
    }
    const selected = auditEvidence(planning.contentIR, planning.deckPlan, generation);
    const payload = {
      task: planning.brief.purpose,
      context: planning.brief.context ?? '',
      evidence: selected.evidence,
      plan: { workingTitle: planning.deckPlan.workingTitle, narrativeSummary: planning.deckPlan.narrativeSummary },
      selectedDeckFingerprint: deckFingerprint,
      slides: selected.slides,
    };
    const content = JSON.stringify(payload);
    if (content.length > MAX_AUDIT_INPUT_CHARS) {
      throw new ProductWorkflowError('CONTEXTUAL_AUDIT_INPUT_TOO_LARGE', 'Для смысловой проверки слишком много текста. Сократите задачу или выбранные материалы.', 413);
    }
    const validationContext: ContextualDeckAuditValidationContext = {
      slideContentRefs: selected.slideContentRefs,
      knownEvidenceRefs: selected.knownEvidenceRefs,
    };
    const contract = {
      name: CONTEXTUAL_AUDIT_SCHEMA_NAME,
      schema: contextualDeckAuditSchema() as SemanticJsonSchema,
      validate: (value: unknown): value is ContextualDeckAuditResponse => {
        try { validateContextualDeckAuditResponse(value, validationContext); return true; }
        catch { return false; }
      },
    };
    const prompt = await this.readAuditPrompt();
    const response = await this.options.getInferenceAdapter().infer({
      role: 'supervisor',
      operation: 'contextual-deck-audit',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content },
      ],
      output: contract,
      maxOutputTokens: 3072,
      temperature: 0,
      timeoutMs: 60_000,
      metadata: { projectId, generationId: generation.generationId },
    } satisfies SemanticInferenceRequest<ContextualDeckAuditResponse>);
    const report = validateContextualDeckAuditResponse(response.value, validationContext);
    const currentGeneration = await this.options.generationService.getSnapshot(projectId);
    if (!currentGeneration || selectedDeckFingerprint(currentGeneration) !== deckFingerprint) {
      throw new ProductWorkflowError('CONTEXTUAL_AUDIT_STALE', 'Выбранные варианты изменились во время проверки. Запустите её снова.', 409);
    }
    const current = await this.read(projectId);
    if (!current || current.operationId !== saved.operationId) return;
    const checkedAt = this.now().toISOString();
    const auditState: ProductContextualAuditState = {
      schemaVersion: CONTEXTUAL_AUDIT_SCHEMA_VERSION,
      ruleSetVersion: CONTEXTUAL_AUDIT_RULE_SET_VERSION,
      auditVersionFingerprint: CONTEXTUAL_AUDIT_VERSION_FINGERPRINT,
      status: 'ready',
      deckFingerprint,
      findings: report.findings,
      telemetry: summarizeTelemetry(response.telemetry),
      checkedAt,
      failureCode: null,
    };
    await this.update(projectId, current, { contextualAudit: auditState });
  }

  private async readAuditPrompt(): Promise<string> {
    const file = `${CONTEXTUAL_DECK_AUDIT_PROMPT_VERSION}.md`;
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const roots = [path.join(this.options.projectRoot, 'apps', 'daemon', 'prompts'), path.resolve(moduleDir, '../../../prompts')];
    for (const root of roots) {
      let prompt: string | null = null;
      try {
        prompt = await readFile(path.join(root, file), 'utf8');
      }
      catch { /* try packaged daemon prompt location */ }
      if (prompt === null) continue;
      const digest = createHash('sha256').update(prompt).digest('hex');
      if (digest !== CONTEXTUAL_AUDITOR_WORKFLOW.promptSha256) {
        throw new ProductWorkflowError('PROMPT_ASSET_VERSION_MISMATCH', 'Версия инструкции смысловой проверки не совпадает с контрактом.', 500);
      }
      return prompt;
    }
    throw new ProductWorkflowError('PROMPT_ASSET_UNAVAILABLE', 'Версия инструкции смысловой проверки отсутствует.', 500);
  }

  private async fail(projectId: string, operationId: string, stage: ProductWorkflowStage, error: unknown): Promise<void> {
    await this.withStateLock(projectId, async () => {
      const current = await this.read(projectId).catch(() => null);
      if (!current || current.operationId !== operationId) return;
      const safe = safeFailureCode(error);
      const timestamp = this.now().toISOString();
      const auditFailure: ProductContextualAuditState | null = stage === 'contextual_audit'
        ? {
          schemaVersion: CONTEXTUAL_AUDIT_SCHEMA_VERSION,
          ruleSetVersion: CONTEXTUAL_AUDIT_RULE_SET_VERSION,
          auditVersionFingerprint: CONTEXTUAL_AUDIT_VERSION_FINGERPRINT,
          status: 'failed',
          deckFingerprint: sha256(`${current.inputFingerprint}:failed-audit:${timestamp}`),
          findings: null,
          telemetry: error instanceof SemanticInferenceError && error.telemetry ? summarizeTelemetry(error.telemetry) : null,
          checkedAt: timestamp,
          failureCode: safe.code,
        }
        : current.contextualAudit;
      const failed: StoredProductWorkflow = {
        ...current,
        status: 'failed',
        stage,
        failure: { code: safe.code, stage, retryable: safe.status >= 500 || safe.status === 429 },
        contextualAudit: auditFailure,
        updatedAt: timestamp,
      };
      await this.writeUnlocked(projectId, failed).catch(() => undefined);
    });
  }

  private async snapshotWithFreshness(projectId: string, saved: StoredProductWorkflow): Promise<ProductWorkflowSnapshot> {
    if (!saved.contextualAudit || saved.contextualAudit.status !== 'ready') return publicSnapshot(saved);
    try {
      const current = await this.options.generationService.getSnapshot(projectId);
      const stale = !isCurrentContextualAuditState(saved.contextualAudit) || !current || current.status !== 'completed'
        || selectedDeckFingerprint(current) !== saved.contextualAudit.deckFingerprint;
      return publicSnapshot(saved, stale);
    } catch {
      return publicSnapshot(saved, true);
    }
  }

  private async read(projectId: string): Promise<StoredProductWorkflow | null> {
    let raw: string;
    try { raw = await readFile(await statePath(this.options.projectsRoot, projectId), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try { return validateStored(JSON.parse(raw)); }
    catch (error) {
      if (error instanceof ProductWorkflowError) throw error;
      throw new ProductWorkflowError('PRODUCT_WORKFLOW_STATE_INVALID', 'Saved presentation operation state is invalid.', 500, { cause: error });
    }
  }

  private async update(projectId: string, state: StoredProductWorkflow, patch: Partial<StoredProductWorkflow>): Promise<void> {
    await this.withStateLock(projectId, async () => {
      const latest = await this.read(projectId);
      if (!latest || latest.operationId !== state.operationId) return;
      await this.writeUnlocked(projectId, { ...latest, ...patch, updatedAt: this.now().toISOString() });
    });
  }

  private async withStateLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.stateLocks.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.stateLocks.set(projectId, queued);
    await previous.catch(() => undefined);
    try { return await operation(); }
    finally {
      release();
      if (this.stateLocks.get(projectId) === queued) this.stateLocks.delete(projectId);
    }
  }

  private async writeUnlocked(projectId: string, state: StoredProductWorkflow): Promise<void> {
    const target = await statePath(this.options.projectsRoot, projectId);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
      await renameWithTransientRetry(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function summarizeTelemetry(value: SemanticInferenceTelemetry): ProductWorkflowTelemetry {
  return { model: value.model.slice(0, 160), wallTimeMs: Math.max(0, value.wallTimeMs), finishReason: value.finishReason?.slice(0, 64) ?? null };
}
