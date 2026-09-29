import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileContentIR } from './content-compiler.js';
import {
  briefHash,
  validateBrief,
  type Brief,
} from '../domain/brief.js';
import {
  canonicalizeDeckPlan,
  validateDeckPlan,
  validateDeckPlanDraft,
  type DeckPlan,
  type DeckPlanDraft,
  type DeckPlanDraftSlide,
} from '../domain/deck-plan.js';
import { validateContentIR, type ContentIR } from '../domain/content-ir.js';
import {
  AGENT_WORKFLOW_CONTRACT_SHA256,
  AGENT_WORKFLOW_VERSIONS,
  LEGACY_UNRECORDED_WORKFLOW_VERSIONS,
  isAgentWorkflowVersions,
  type AgentWorkflowVersions,
} from './workflow-versions.js';
import {
  getTemplateCompilation,
  type TemplateCompilationResponse,
} from './template-compiler.js';
import { resolvePresentationFilePath } from '../../presentation-files.js';
import {
  planningContentProfileFingerprint,
  PLANNING_CONTENT_BUDGET_VERSION,
  validateDraftAgainstContentBudgets,
  type PlanningContentBudgets,
} from './planning-content-budgets.js';
import type { TemplateSemanticProfile } from './template-semantic-profiler.js';
import type { TemplateIR } from '../domain/template-ir.js';
import {
  SemanticInferenceError,
  type SemanticInferenceAdapter,
  type SemanticInferenceRequest,
  type SemanticJsonSchema,
  type SemanticInferenceTelemetry,
} from './semantic-inference-port.js';

export const WORKER_PLAN_PROMPT_VERSION = AGENT_WORKFLOW_VERSIONS.worker.promptVersion;
export const SUPERVISOR_PLAN_REVIEW_PROMPT_VERSION = AGENT_WORKFLOW_VERSIONS.supervisor.promptVersion;
const MAX_SELECTED_FILES = 12;
const MAX_EVIDENCE_CHARS = 256 * 1024;
const MAX_FINDINGS = 12;
const MAX_REPAIR_OPERATIONS = 8;
export const DEFAULT_PLANNING_DEADLINE_MS = 300_000;
export const MAX_PLANNING_DEADLINE_MS = 900_000;
const ROLE_VALUES = ['opening', 'agenda', 'section-divider', 'content', 'closing'] as const;
const VISUAL_VALUES = ['none', 'image', 'chart', 'table', 'diagram', 'timeline', 'process', 'comparison', 'kpi'] as const;
const DENSITY_VALUES = ['compact', 'balanced', 'detailed'] as const;

export function planningDeadlineFromEnvironment(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_PLANNING_DEADLINE_MS;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new TypeError(`LCT_PLANNING_TIMEOUT_MS must be an integer between 1 and ${MAX_PLANNING_DEADLINE_MS}`);
  }
  const timeoutMs = Number(normalized);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_PLANNING_DEADLINE_MS) {
    throw new TypeError(`LCT_PLANNING_TIMEOUT_MS must be an integer between 1 and ${MAX_PLANNING_DEADLINE_MS}`);
  }
  return timeoutMs;
}

export type PlanningStatus =
  | 'unconfigured'
  | 'ready_for_planning'
  | 'generating'
  | 'ready'
  | 'stale'
  | 'needs_revision'
  | 'failed';

export interface PlanningFailure {
  code: string;
  message: string;
}

export interface PlanningFinding {
  targetType: 'deck' | 'slide';
  slideId: string | null;
  severity: 'low' | 'medium' | 'high' | 'critical';
  reason: string;
  evidenceRefs: string[];
}

export type PlanRepairOperation =
  | { type: 'replace_takeaway'; slideId: string; takeaway: string; purpose: null; contentRef: null; semanticVisualType: null }
  | { type: 'replace_purpose'; slideId: string; takeaway: null; purpose: string; contentRef: null; semanticVisualType: null }
  | { type: 'add_content_ref'; slideId: string; takeaway: null; purpose: null; contentRef: string; semanticVisualType: null }
  | { type: 'remove_content_ref'; slideId: string; takeaway: null; purpose: null; contentRef: string; semanticVisualType: null }
  | { type: 'change_visual_type'; slideId: string; takeaway: null; purpose: null; contentRef: null; semanticVisualType: typeof VISUAL_VALUES[number] };

export interface PlanReview {
  checkpointVersion: number;
  outcome: 'pass' | 'warn' | 'repair' | 'local-replan';
  findings: PlanningFinding[];
  operations: PlanRepairOperation[];
}

interface TelemetrySummary {
  model: string;
  requestId: string;
  providerRequestId: string | null;
  startedAt: string;
  finishedAt: string;
  wallTimeMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  finishReason: string | null;
}

export interface PlanningTelemetry {
  worker: TelemetrySummary;
  supervisor: TelemetrySummary;
  revisionWorker?: TelemetrySummary;
  totalWallTimeMs: number;
}

interface PlanningInputs {
  contentFiles: string[];
  brief: Brief;
  contentIR: ContentIR;
  inputFingerprint: string;
}

interface SuccessfulPlanSnapshot {
  contentFiles: string[];
  brief: Brief;
  contentIR: ContentIR;
  inputFingerprint: string;
  checkpoint: DeckPlan;
  deckPlan: DeckPlan;
  review: PlanReview;
  telemetry: PlanningTelemetry;
  promptVersions: { worker: string; supervisor: string };
  agentWorkflowVersions: AgentWorkflowVersions;
  model: string;
  createdAt: string;
}

interface StoredPlanningState {
  schemaVersion: 1;
  updatedAt: string;
  status: PlanningStatus;
  inputs: PlanningInputs | null;
  lastSuccessful: SuccessfulPlanSnapshot | null;
  failure: PlanningFailure | null;
  currentCheckpoint: DeckPlan | null;
}

export interface PlanningResponse {
  status: PlanningStatus;
  templateStatus: TemplateCompilationResponse['status'];
  contentFiles: string[];
  brief: Brief | null;
  contentIR: ContentIR | null;
  inputFingerprint: string | null;
  deckPlan: DeckPlan | null;
  checkpoint: DeckPlan | null;
  review: PlanReview | null;
  telemetry: PlanningTelemetry | null;
  promptVersions: { worker: string; supervisor: string };
  agentWorkflowVersions: AgentWorkflowVersions | null;
  failure: PlanningFailure | null;
  warnings: string[];
  updatedAt: string | null;
}

export interface GeneratePlanInput {
  contentFiles: string[];
  brief: unknown;
}

export interface PlanningServiceOptions {
  projectRoot: string;
  projectsRoot: string;
  getInferenceAdapter: () => SemanticInferenceAdapter;
  planningDeadlineMs?: number;
  getPreparedTemplateProfile?: (projectId: string, template: TemplateCompilationResponse) => Promise<TemplateSemanticProfile | null>;
  getPlanningContentBudgets?: (input: {
    projectId: string;
    template: TemplateIR;
    semanticProfile: TemplateSemanticProfile;
    requestedSlideCount: number;
  }) => Promise<PlanningContentBudgets | null>;
  now?: () => Date;
  createId?: () => string;
}

export class PlanningServiceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PlanningServiceError';
    this.code = code;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function planningInputFingerprint(input: {
  templateIRHash: string;
  presentationDesignSystemHash: string;
  contentIRHash: string;
  briefHash: string;
  workerPromptSha256: string;
  supervisorPromptSha256: string;
  contentBudgetProfileSha256?: string;
  agentWorkflowContractSha256?: string;
}): string {
  return sha256({
    templateIRHash: input.templateIRHash,
    presentationDesignSystemHash: input.presentationDesignSystemHash,
    contentIRHash: input.contentIRHash,
    briefHash: input.briefHash,
    contentBudgetVersion: PLANNING_CONTENT_BUDGET_VERSION,
    contentBudgetProfileSha256: input.contentBudgetProfileSha256 ?? planningContentProfileFingerprint(null),
    workerPromptVersion: WORKER_PLAN_PROMPT_VERSION,
    workerPromptSha256: input.workerPromptSha256,
    supervisorPromptVersion: SUPERVISOR_PLAN_REVIEW_PROMPT_VERSION,
    supervisorPromptSha256: input.supervisorPromptSha256,
    agentWorkflowContractSha256: input.agentWorkflowContractSha256 ?? AGENT_WORKFLOW_CONTRACT_SHA256,
  });
}

interface PlanningPromptAssets {
  worker: string;
  supervisor: string;
  workerSha256: string;
  supervisorSha256: string;
}

async function readPlanningPromptAssets(projectRoot: string): Promise<PlanningPromptAssets> {
  const promptFile = (version: string) => {
    if (!/^[a-z0-9][a-z0-9.-]*\.v[0-9]+$/.test(version)) {
      throw new PlanningServiceError('PROMPT_ASSET_UNAVAILABLE', 'Planning prompt version is invalid.', 500);
    }
    return `${version}.md`;
  };
  const workerFile = promptFile(WORKER_PLAN_PROMPT_VERSION);
  const supervisorFile = promptFile(SUPERVISOR_PLAN_REVIEW_PROMPT_VERSION);
  const modulePromptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../prompts');
  const promptRoots = [...new Set([
    path.join(projectRoot, 'apps', 'daemon', 'prompts'),
    modulePromptRoot,
  ])];
  let cause: unknown;
  for (const promptRoot of promptRoots) {
    try {
      const [worker, supervisor] = await Promise.all([
        readFile(path.join(promptRoot, workerFile), 'utf8'),
        readFile(path.join(promptRoot, supervisorFile), 'utf8'),
      ]);
      return {
        worker,
        supervisor,
        workerSha256: createHash('sha256').update(worker, 'utf8').digest('hex'),
        supervisorSha256: createHash('sha256').update(supervisor, 'utf8').digest('hex'),
      };
    } catch (error) {
      cause = error;
    }
  }
  throw new PlanningServiceError('PROMPT_ASSET_UNAVAILABLE', 'Versioned planning instructions are unavailable. Restore the prompt assets and retry.', 500, { cause });
}

async function statePath(projectsRoot: string, projectId: string): Promise<string> {
  return (await resolvePresentationFilePath(projectsRoot, projectId, '.planning/state.json', { createParent: true })).absolute;
}

async function writeStoredState(projectsRoot: string, projectId: string, state: StoredPlanningState): Promise<void> {
  const target = await statePath(projectsRoot, projectId);
  const temp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isHexHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validateFailure(value: unknown): PlanningFailure | null {
  if (value === null) return null;
  if (!isRecord(value) || !exactKeys(value, ['code', 'message'])
      || typeof value.code !== 'string' || value.code.length < 1 || value.code.length > 80
      || typeof value.message !== 'string' || value.message.length < 1 || value.message.length > 1000) {
    throw new TypeError('Saved planning failure is invalid');
  }
  return { code: value.code, message: value.message };
}

function allowedContentIds(contentIR: ContentIR): Set<string> {
  // Factual citations must be text/data units. Media uses a separate field.
  return new Set(contentIR.units.filter((unit) => unit.kind !== 'media-reference').map((unit) => unit.id));
}

function allowedPlanningContentIds(contentIR: ContentIR): Set<string> {
  const sourceKinds = new Map(contentIR.sources.map((source) => [source.id, source.kind]));
  return new Set(contentIR.units.filter((unit) => unit.kind !== 'media-reference'
    && sourceKinds.get(unit.sourceId) === 'text').map((unit) => unit.id));
}

function allowedMediaIds(contentIR: ContentIR): Set<string> {
  return new Set(contentIR.units.filter((unit) => unit.kind === 'media-reference').map((unit) => unit.id));
}

function validateFinding(value: unknown, plan: DeckPlan, contentIds: ReadonlySet<string>): PlanningFinding {
  if (!isRecord(value) || !exactKeys(value, ['targetType', 'slideId', 'severity', 'reason', 'evidenceRefs'])) {
    throw new TypeError('Supervisor finding has an invalid shape');
  }
  const targetType = value.targetType;
  const slideId = value.slideId;
  if (targetType !== 'deck' && targetType !== 'slide') throw new TypeError('Supervisor finding target is invalid');
  if (targetType === 'deck' ? slideId !== null : typeof slideId !== 'string' || !plan.slides.some((slide) => slide.id === slideId)) {
    throw new TypeError('Supervisor finding target does not match the checkpoint');
  }
  if (!['low', 'medium', 'high', 'critical'].includes(String(value.severity))) throw new TypeError('Supervisor finding severity is invalid');
  if (typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 500) throw new TypeError('Supervisor finding reason is invalid');
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length > 8
      || value.evidenceRefs.some((id) => typeof id !== 'string' || !contentIds.has(id))
      || new Set(value.evidenceRefs).size !== value.evidenceRefs.length) {
    throw new TypeError('Supervisor finding references unknown or duplicate content');
  }
  return {
    targetType,
    slideId: slideId as string | null,
    severity: value.severity as PlanningFinding['severity'],
    reason: value.reason,
    evidenceRefs: [...value.evidenceRefs] as string[],
  };
}

function validateOperation(value: unknown, plan: DeckPlan, contentIds: ReadonlySet<string>): PlanRepairOperation {
  const keys = ['type', 'slideId', 'takeaway', 'purpose', 'contentRef', 'semanticVisualType'] as const;
  if (!isRecord(value) || !exactKeys(value, keys)) throw new TypeError('Supervisor repair operation has an invalid shape');
  if (typeof value.slideId !== 'string' || !plan.slides.some((slide) => slide.id === value.slideId)) {
    throw new TypeError('Supervisor repair target does not exist in the checkpoint');
  }
  const nullable = (key: string) => value[key] === null;
  if (value.type === 'replace_takeaway'
      && typeof value.takeaway === 'string' && value.takeaway.trim().length > 0 && value.takeaway.length <= 1000
      && nullable('purpose') && nullable('contentRef') && nullable('semanticVisualType')) {
    return value as unknown as PlanRepairOperation;
  }
  if (value.type === 'replace_purpose'
      && typeof value.purpose === 'string' && value.purpose.trim().length > 0 && value.purpose.length <= 1000
      && nullable('takeaway') && nullable('contentRef') && nullable('semanticVisualType')) {
    return value as unknown as PlanRepairOperation;
  }
  if ((value.type === 'add_content_ref' || value.type === 'remove_content_ref')
      && typeof value.contentRef === 'string' && contentIds.has(value.contentRef)
      && nullable('takeaway') && nullable('purpose') && nullable('semanticVisualType')) {
    return value as unknown as PlanRepairOperation;
  }
  if (value.type === 'change_visual_type'
      && typeof value.semanticVisualType === 'string' && (VISUAL_VALUES as readonly string[]).includes(value.semanticVisualType)
      && nullable('takeaway') && nullable('purpose') && nullable('contentRef')) {
    return value as unknown as PlanRepairOperation;
  }
  throw new TypeError('Supervisor repair operation is outside the bounded allowlist');
}

function validatePlanReviewAgainstContentIds(value: unknown, checkpoint: DeckPlan, contentIds: ReadonlySet<string>): PlanReview {
  if (!isRecord(value) || !exactKeys(value, ['checkpointVersion', 'outcome', 'findings', 'operations'])) {
    throw new TypeError('Supervisor output has an invalid shape');
  }
  if (value.checkpointVersion !== checkpoint.version) throw new TypeError('Supervisor output refers to a stale checkpoint version');
  if (!['pass', 'warn', 'repair', 'local-replan'].includes(String(value.outcome))) throw new TypeError('Supervisor decision is invalid');
  if (!Array.isArray(value.findings) || value.findings.length > MAX_FINDINGS) throw new TypeError('Supervisor findings exceed the limit');
  if (!Array.isArray(value.operations) || value.operations.length > MAX_REPAIR_OPERATIONS) throw new TypeError('Supervisor operations exceed the limit');
  const findings = value.findings.map((finding) => validateFinding(finding, checkpoint, contentIds));
  const operations = value.operations.map((operation) => validateOperation(operation, checkpoint, contentIds));
  if ((value.outcome === 'pass' || value.outcome === 'warn' || value.outcome === 'local-replan') && operations.length !== 0) {
    throw new TypeError('This Supervisor outcome cannot carry repair operations');
  }
  if (value.outcome === 'repair' && operations.length === 0) throw new TypeError('Repair decision requires a bounded operation');
  if (value.outcome === 'local-replan' && findings.length === 0) throw new TypeError('Local re-plan requires at least one finding');
  return {
    checkpointVersion: checkpoint.version,
    outcome: value.outcome as PlanReview['outcome'],
    findings,
    operations,
  };
}

export function validatePlanReview(value: unknown, checkpoint: DeckPlan, contentIR: ContentIR): PlanReview {
  return validatePlanReviewAgainstContentIds(value, checkpoint, allowedPlanningContentIds(contentIR));
}

export function applyPlanRepair(
  checkpoint: DeckPlan,
  review: PlanReview,
  contentIR: ContentIR,
  brief: Brief,
  inputFingerprint: string,
): DeckPlan {
  if (review.checkpointVersion !== checkpoint.version || review.outcome !== 'repair') {
    throw new TypeError('Repair is not bound to the current checkpoint');
  }
  const slides = checkpoint.slides.map((slide) => ({ ...slide, contentRefs: [...slide.contentRefs],
    ...(slide.bodyPoints === undefined ? {} : { bodyPoints: slide.bodyPoints.map((point) => ({ ...point, evidenceRefs: [...point.evidenceRefs] })) }),
  }));
  for (const operation of review.operations) {
    const index = slides.findIndex((slide) => slide.id === operation.slideId);
    if (index < 0) throw new TypeError('Repair target no longer exists');
    const slide = slides[index];
    if (operation.type === 'replace_takeaway') slide.takeaway = operation.takeaway;
    else if (operation.type === 'replace_purpose') slide.purpose = operation.purpose;
    else if (operation.type === 'add_content_ref') {
      if (slide.contentRefs.includes(operation.contentRef)) throw new TypeError('Repair cannot add a duplicate content reference');
      slide.contentRefs.push(operation.contentRef);
    } else if (operation.type === 'remove_content_ref') {
      if (!slide.contentRefs.includes(operation.contentRef)) throw new TypeError('Repair cannot remove a missing content reference');
      slide.contentRefs = slide.contentRefs.filter((id) => id !== operation.contentRef);
    } else if (operation.type === 'change_visual_type') slide.semanticVisualType = operation.semanticVisualType;
  }
  const draft: DeckPlanDraft = {
    workingTitle: checkpoint.workingTitle,
    narrativeSummary: checkpoint.narrativeSummary,
    slides: slides.map(({ narrativeRole, purpose, takeaway, contentRefs, bodyPoints, mediaRefs, semanticVisualType, targetDensity }) => ({
      narrativeRole, purpose, takeaway, contentRefs,
      ...(bodyPoints === undefined ? {} : { bodyPoints }),
      ...(mediaRefs === undefined ? {} : { mediaRefs }),
      semanticVisualType, targetDensity,
    })),
  };
  const contentIds = allowedPlanningContentIds(contentIR);
  const mediaIds = allowedMediaIds(contentIR);
  const validDraft = validateDeckPlanDraft(draft, contentIds, brief.requestedSlideCount, mediaIds);
  return canonicalizeDeckPlan(validDraft, {
    id: checkpoint.id,
    version: checkpoint.version + 1,
    createdAt: checkpoint.createdAt,
    inputFingerprint,
    briefHash: briefHash(brief),
    allowedContentIds: contentIds,
    allowedMediaIds: mediaIds,
    requestedSlideCount: brief.requestedSlideCount,
  });
}

function reviewSchema(): SemanticJsonSchema {
  const nullableString = { type: ['string', 'null'] };
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      checkpointVersion: { type: 'integer', minimum: 1 },
      outcome: { type: 'string', enum: ['pass', 'warn', 'repair', 'local-replan'] },
      findings: {
        type: 'array', maxItems: MAX_FINDINGS,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            targetType: { type: 'string', enum: ['deck', 'slide'] },
            slideId: nullableString,
            severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
            reason: { type: 'string', minLength: 1, maxLength: 500 },
            evidenceRefs: { type: 'array', maxItems: 8, items: { type: 'string' } },
          },
          required: ['targetType', 'slideId', 'severity', 'reason', 'evidenceRefs'],
        },
      },
      operations: {
        type: 'array', maxItems: MAX_REPAIR_OPERATIONS,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            type: { type: 'string', enum: ['replace_takeaway', 'replace_purpose', 'add_content_ref', 'remove_content_ref', 'change_visual_type'] },
            slideId: { type: 'string', minLength: 1 },
            takeaway: nullableString,
            purpose: nullableString,
            contentRef: nullableString,
            semanticVisualType: { anyOf: [{ type: 'string', enum: [...VISUAL_VALUES] }, { type: 'null' }] },
          },
          required: ['type', 'slideId', 'takeaway', 'purpose', 'contentRef', 'semanticVisualType'],
        },
      },
    },
    required: ['checkpointVersion', 'outcome', 'findings', 'operations'],
  };
}

function isPlanReviewShape(value: unknown): value is PlanReview {
  return isRecord(value) && Number.isSafeInteger(value.checkpointVersion)
    && ['pass', 'warn', 'repair', 'local-replan'].includes(String(value.outcome))
    && Array.isArray(value.findings) && Array.isArray(value.operations);
}

function telemetrySummary(value: SemanticInferenceTelemetry): TelemetrySummary {
  return {
    model: value.model,
    requestId: value.requestId,
    providerRequestId: value.providerRequestId ?? null,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    wallTimeMs: value.wallTimeMs,
    promptTokens: value.promptTokens ?? null,
    completionTokens: value.completionTokens ?? null,
    finishReason: value.finishReason ?? null,
  };
}

function validateTelemetrySummary(value: unknown): TelemetrySummary {
  const legacyKeys = ['model', 'requestId', 'providerRequestId', 'startedAt', 'finishedAt', 'wallTimeMs', 'promptTokens', 'completionTokens'];
  const currentKeys = [...legacyKeys, 'finishReason'];
  if (!isRecord(value) || (!exactKeys(value, legacyKeys) && !exactKeys(value, currentKeys))
      || typeof value.model !== 'string' || value.model.length > 256
      || typeof value.requestId !== 'string' || value.requestId.length > 256
      || (value.providerRequestId !== null && (typeof value.providerRequestId !== 'string' || value.providerRequestId.length > 256))
      || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))
      || typeof value.finishedAt !== 'string' || !Number.isFinite(Date.parse(value.finishedAt))
      || !Number.isSafeInteger(value.wallTimeMs) || Number(value.wallTimeMs) < 0
      || (value.promptTokens !== null && (!Number.isSafeInteger(value.promptTokens) || Number(value.promptTokens) < 0))
      || (value.completionTokens !== null && (!Number.isSafeInteger(value.completionTokens) || Number(value.completionTokens) < 0))
      || (Object.hasOwn(value, 'finishReason') && value.finishReason !== null
        && (typeof value.finishReason !== 'string' || value.finishReason.length === 0 || value.finishReason.length > 64
          || !/^[A-Za-z0-9_.-]+$/.test(value.finishReason)))) {
    throw new TypeError('Saved planning telemetry is invalid');
  }
  return { ...value, finishReason: value.finishReason ?? null } as unknown as TelemetrySummary;
}

function validatePlanReviewState(
  value: unknown,
  plan: DeckPlan,
  contentIR: ContentIR,
  allowLegacyInstructionRefs: boolean,
): PlanReview {
  // Earlier planning snapshots allowed brief/task units in review evidence. They remain
  // readable for stale-state recovery, while all new Worker/Supervisor calls stay source-only.
  return validatePlanReviewAgainstContentIds(value, plan,
    allowLegacyInstructionRefs ? allowedContentIds(contentIR) : allowedPlanningContentIds(contentIR));
}

function validateStoredState(value: unknown): StoredPlanningState {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'updatedAt', 'status', 'inputs', 'lastSuccessful', 'failure', 'currentCheckpoint'])
      || value.schemaVersion !== 1 || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
      || !['unconfigured', 'ready_for_planning', 'generating', 'ready', 'stale', 'needs_revision', 'failed'].includes(String(value.status))) {
    throw new TypeError('Saved planning state has an unsupported shape');
  }
  let inputs: PlanningInputs | null = null;
  if (value.inputs !== null) {
    if (!isRecord(value.inputs) || !exactKeys(value.inputs, ['contentFiles', 'brief', 'contentIR', 'inputFingerprint'])
        || !Array.isArray(value.inputs.contentFiles) || value.inputs.contentFiles.length > MAX_SELECTED_FILES
        || value.inputs.contentFiles.some((item) => typeof item !== 'string') || !isHexHash(value.inputs.inputFingerprint)) {
      throw new TypeError('Saved planning inputs are invalid');
    }
    const brief = validateBrief(value.inputs.brief);
    const contentIR = validateContentIR(value.inputs.contentIR);
    inputs = { contentFiles: value.inputs.contentFiles as string[], brief, contentIR, inputFingerprint: value.inputs.inputFingerprint };
  }
  const failure = validateFailure(value.failure);
  let currentCheckpoint: DeckPlan | null = null;
  if (value.currentCheckpoint !== null) {
    if (!inputs) throw new TypeError('Saved checkpoint has no planning inputs');
    currentCheckpoint = validateDeckPlan(value.currentCheckpoint, allowedContentIds(inputs.contentIR), inputs.brief.requestedSlideCount, allowedMediaIds(inputs.contentIR));
  }
  let lastSuccessful: SuccessfulPlanSnapshot | null = null;
  if (value.lastSuccessful !== null) {
    const saved = value.lastSuccessful;
    const savedKeys = [
      'contentFiles', 'brief', 'contentIR', 'inputFingerprint', 'checkpoint', 'deckPlan', 'review', 'telemetry', 'promptVersions', 'model', 'createdAt',
    ];
    if (!isRecord(saved) || !(exactKeys(saved, savedKeys) || exactKeys(saved, [...savedKeys, 'agentWorkflowVersions']))
        || !Array.isArray(saved.contentFiles) || saved.contentFiles.length > MAX_SELECTED_FILES
        || saved.contentFiles.some((item) => typeof item !== 'string') || !isHexHash(saved.inputFingerprint)
        || !isRecord(saved.promptVersions) || !exactKeys(saved.promptVersions, ['worker', 'supervisor'])
        || !['worker-deck-plan.v1', 'worker-deck-plan.v2', 'worker-deck-plan.v3', 'worker-deck-plan.v4', 'worker-deck-plan.v5', WORKER_PLAN_PROMPT_VERSION].includes(String(saved.promptVersions.worker))
        || saved.promptVersions.supervisor !== SUPERVISOR_PLAN_REVIEW_PROMPT_VERSION
        || !(saved.agentWorkflowVersions === undefined || isAgentWorkflowVersions(saved.agentWorkflowVersions))
        || typeof saved.model !== 'string' || saved.model.length > 256
        || typeof saved.createdAt !== 'string' || !Number.isFinite(Date.parse(saved.createdAt))
        || !isRecord(saved.telemetry)
        || !(exactKeys(saved.telemetry, ['worker', 'supervisor', 'totalWallTimeMs'])
          || exactKeys(saved.telemetry, ['worker', 'supervisor', 'revisionWorker', 'totalWallTimeMs']))
        || !Number.isSafeInteger(saved.telemetry.totalWallTimeMs) || Number(saved.telemetry.totalWallTimeMs) < 0) {
      throw new TypeError('Saved successful planning snapshot is invalid');
    }
    const brief = validateBrief(saved.brief);
    const contentIR = validateContentIR(saved.contentIR);
    const contentIds = allowedContentIds(contentIR);
    const mediaIds = allowedMediaIds(contentIR);
    const checkpoint = validateDeckPlan(saved.checkpoint, contentIds, brief.requestedSlideCount, mediaIds);
    const deckPlan = validateDeckPlan(saved.deckPlan, contentIds, brief.requestedSlideCount, mediaIds);
    const expectedBriefHash = briefHash(brief);
    if (deckPlan.id !== checkpoint.id || deckPlan.version < checkpoint.version
        || deckPlan.inputFingerprint !== saved.inputFingerprint || checkpoint.inputFingerprint !== saved.inputFingerprint
        || deckPlan.briefHash !== expectedBriefHash || checkpoint.briefHash !== expectedBriefHash) {
      throw new TypeError('Saved plan does not match its checkpoint/input snapshot');
    }
    const telemetry = {
      worker: validateTelemetrySummary(saved.telemetry.worker),
      supervisor: validateTelemetrySummary(saved.telemetry.supervisor),
      ...(saved.telemetry.revisionWorker === undefined ? {} : { revisionWorker: validateTelemetrySummary(saved.telemetry.revisionWorker) }),
      totalWallTimeMs: Number(saved.telemetry.totalWallTimeMs),
    };
    lastSuccessful = {
      contentFiles: saved.contentFiles as string[],
      brief,
      contentIR,
      inputFingerprint: saved.inputFingerprint,
      checkpoint,
      deckPlan,
      review: validatePlanReviewState(saved.review, checkpoint, contentIR,
        saved.promptVersions.worker === 'worker-deck-plan.v1' || saved.promptVersions.worker === 'worker-deck-plan.v2'),
      telemetry,
      promptVersions: { worker: String(saved.promptVersions.worker), supervisor: String(saved.promptVersions.supervisor) },
      agentWorkflowVersions: saved.agentWorkflowVersions === undefined ? LEGACY_UNRECORDED_WORKFLOW_VERSIONS : saved.agentWorkflowVersions,
      model: saved.model,
      createdAt: saved.createdAt,
    };
  }
  return {
    schemaVersion: 1,
    updatedAt: value.updatedAt,
    status: value.status as PlanningStatus,
    inputs,
    lastSuccessful,
    failure,
    currentCheckpoint,
  };
}

/**
 * Replace only the saved v4 task-only plan shape that predates the current
 * generated-title limit. Its user inputs remain trustworthy after validation;
 * the incompatible plan itself must be regenerated rather than rewritten.
 */
function recoverLegacyGeneratedCopyTitleLimit(value: unknown, error: unknown): StoredPlanningState | null {
  if (!(error instanceof TypeError)
      || error.message !== 'DeckPlan title with generated body copy must not exceed 40 characters'
      || !isRecord(value)
      || !exactKeys(value, ['schemaVersion', 'updatedAt', 'status', 'inputs', 'lastSuccessful', 'failure', 'currentCheckpoint'])
      || value.schemaVersion !== 1 || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
      || !isRecord(value.lastSuccessful) || !isRecord(value.lastSuccessful.promptVersions)
      || value.lastSuccessful.promptVersions.worker !== 'worker-deck-plan.v4'
      || !isRecord(value.inputs)
      || !exactKeys(value.inputs, ['contentFiles', 'brief', 'contentIR', 'inputFingerprint'])
      || !Array.isArray(value.inputs.contentFiles) || value.inputs.contentFiles.length > MAX_SELECTED_FILES
      || value.inputs.contentFiles.some((item) => typeof item !== 'string')
      || !isHexHash(value.inputs.inputFingerprint)) return null;
  try {
    const brief = validateBrief(value.inputs.brief);
    const contentIR = validateContentIR(value.inputs.contentIR);
    validateFailure(value.failure);
    return {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      status: 'ready_for_planning',
      inputs: {
        contentFiles: value.inputs.contentFiles as string[],
        brief,
        contentIR,
        inputFingerprint: value.inputs.inputFingerprint,
      },
      lastSuccessful: null,
      failure: null,
      currentCheckpoint: null,
    };
  } catch {
    return null;
  }
}

async function readStoredState(projectsRoot: string, projectId: string): Promise<StoredPlanningState | null> {
  let raw: string;
  try {
    raw = await readFile(await statePath(projectsRoot, projectId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
    return validateStoredState(parsed);
  } catch (error) {
    const recovered = recoverLegacyGeneratedCopyTitleLimit(parsed, error);
    if (recovered) {
      await writeStoredState(projectsRoot, projectId, recovered);
      console.warn(JSON.stringify({ event: 'planning.state_migrated', projectId, reason: 'LEGACY_GENERATED_TITLE_LIMIT', status: recovered.status }));
      return recovered;
    }
    throw new PlanningServiceError('PERSISTED_STATE_INVALID', 'Saved planning state is invalid; generate a new plan after checking project sources.', 500, { cause: error });
  }
}

function publicResponse(
  status: PlanningStatus,
  templateStatus: TemplateCompilationResponse['status'],
  state: StoredPlanningState | null,
  overrides: { contentIR?: ContentIR | null; inputFingerprint?: string | null; warnings?: string[]; failure?: PlanningFailure | null } = {},
): PlanningResponse {
  const success = state?.lastSuccessful ?? null;
  const planContentIR = status === 'stale' ? success?.contentIR ?? null : null;
  return {
    status,
    templateStatus,
    contentFiles: state?.inputs?.contentFiles ?? success?.contentFiles ?? [],
    brief: state?.inputs?.brief ?? success?.brief ?? null,
    contentIR: planContentIR ?? (overrides.contentIR === undefined ? (state?.inputs?.contentIR ?? success?.contentIR ?? null) : overrides.contentIR),
    inputFingerprint: overrides.inputFingerprint === undefined ? (state?.inputs?.inputFingerprint ?? null) : overrides.inputFingerprint,
    deckPlan: success?.deckPlan ?? (status === 'needs_revision' ? state?.currentCheckpoint ?? null : null),
    checkpoint: state?.currentCheckpoint ?? success?.checkpoint ?? null,
    review: success?.review ?? null,
    telemetry: success?.telemetry ?? null,
    promptVersions: { worker: WORKER_PLAN_PROMPT_VERSION, supervisor: SUPERVISOR_PLAN_REVIEW_PROMPT_VERSION },
    agentWorkflowVersions: success?.agentWorkflowVersions ?? null,
    failure: overrides.failure === undefined ? state?.failure ?? null : overrides.failure,
    warnings: planContentIR?.warnings.map((warning) => warning.message)
      ?? overrides.warnings
      ?? (state?.inputs?.contentIR.warnings.map((warning) => warning.message) ?? success?.contentIR.warnings.map((warning) => warning.message) ?? []),
    updatedAt: state?.updatedAt ?? null,
  };
}

function scopedDesignSystem(pds: TemplateCompilationResponse['presentationDesignSystem']): unknown {
  if (!pds || typeof pds !== 'object') return null;
  const value = pds as Record<string, any>;
  return {
    canvas: value.canvas,
    typography: {
      observedFonts: (value.typography?.observedFonts ?? []).slice(0, 12),
      observedSizesPt: (value.typography?.observedSizesPt ?? []).slice(0, 16),
      theme: value.typography?.theme ?? null,
    },
    colors: {
      direct: (value.colors?.direct ?? []).slice(0, 16).map((item: any) => ({ role: item.role, value: item.value, uses: item.uses })),
      theme: (value.colors?.theme ?? []).slice(0, 16),
    },
    layouts: (value.layouts ?? []).slice(0, 24).map((layout: any) => ({
      id: layout.id,
      declaredName: layout.declaredName,
      declaredType: layout.declaredType,
      placeholderRoles: layout.placeholderRoles,
      elementCounts: layout.elementCounts,
      usageCount: layout.usageCount,
    })),
    warnings: (value.warnings ?? []).slice(0, 24),
  };
}

function compactContentIR(contentIR: ContentIR): unknown {
  const instructionSourceIds = new Set(contentIR.sources
    .filter((source) => source.kind === 'brief-task' || source.kind === 'brief-context').map((source) => source.id));
  return {
    schemaVersion: contentIR.schemaVersion,
    id: contentIR.id,
    hash: contentIR.hash,
    sources: contentIR.sources.filter((source) => source.kind === 'text')
      .map(({ id, sourcePath, originalName, mediaType, sha256, order, byteLength, warnings, kind }) => ({
      id, sourcePath, originalName, mediaType, sha256, order, byteLength, kind, warnings,
    })),
    units: contentIR.units.filter((unit) => unit.kind !== 'media-reference' && !instructionSourceIds.has(unit.sourceId)),
    // Visual references are selectors only. The text model sees no image pixels
    // and must not use asset metadata as evidence for factual claims.
    mediaAssets: contentIR.sources.filter((source) => source.kind === 'image').map(({ id, originalName, mediaType, sha256, order }) => ({
      id: contentIR.units.find((unit) => unit.kind === 'media-reference' && unit.sourceId === id)?.id ?? null,
      originalName, mediaType, sha256, order,
    })).filter((asset) => asset.id !== null),
    warnings: contentIR.warnings.map(({ code, message }) => ({ code, message })),
  };
}

function contentForReview(contentIR: ContentIR, plan: DeckPlan): unknown {
  const wanted = new Set(plan.slides.flatMap((slide) => slide.contentRefs));
  const mediaWanted = new Set(plan.slides.flatMap((slide) => slide.mediaRefs ?? []));
  const sources = new Map(contentIR.sources.map((source) => [source.id, source]));
  return {
    sources: contentIR.sources.filter((source) => plan.slides.some((slide) => slide.contentRefs.some((ref) => {
      const unit = contentIR.units.find((candidate) => candidate.id === ref);
      return unit?.sourceId === source.id;
    }))).map(({ id, sourcePath, originalName, mediaType, sha256 }) => ({ id, sourcePath, originalName, mediaType, sha256 })),
    units: contentIR.units.filter((unit) => wanted.has(unit.id)),
    visualMedia: contentIR.units.filter((unit) => mediaWanted.has(unit.id)).map((unit) => ({
      mediaRef: unit.id,
      mediaType: sources.get(unit.sourceId)?.mediaType ?? null,
      sourceHash: sources.get(unit.sourceId)?.sha256 ?? null,
    })),
    warnings: contentIR.warnings.filter((warning) => warning.sourceId === null || sources.has(warning.sourceId)).slice(0, 24),
  };
}

function telemetryModel(response: { telemetry: SemanticInferenceTelemetry }): string {
  return response.telemetry.model;
}

function isDraft(value: unknown, contentIR: ContentIR, brief: Brief): value is DeckPlanDraft {
  try {
    validateDeckPlanDraft(value, allowedPlanningContentIds(contentIR), brief.requestedSlideCount, allowedMediaIds(contentIR), true);
    return true;
  } catch {
    return false;
  }
}

function workerDraftSchema(): SemanticJsonSchema {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      workingTitle: { type: 'string', minLength: 1, maxLength: 240 },
      narrativeSummary: { type: 'string', minLength: 1, maxLength: 1000 },
      slides: {
        type: 'array', minItems: 1, maxItems: 30,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            narrativeRole: { type: 'string', enum: [...ROLE_VALUES] },
            purpose: { type: 'string', minLength: 1, maxLength: 1000 },
            takeaway: { type: 'string', minLength: 1, maxLength: 40 },
            contentRefs: { type: 'array', maxItems: 20, items: { type: 'string' } },
            bodyPoints: {
              type: 'array', minItems: 1, maxItems: 4,
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  text: { type: 'string', minLength: 1, maxLength: 180 },
                  origin: { type: 'string', enum: ['generated-from-brief'] },
                  evidenceRefs: { type: 'array', maxItems: 8, items: { type: 'string' } },
                },
                required: ['text', 'origin', 'evidenceRefs'],
              },
            },
            mediaRefs: { type: 'array', maxItems: 20, items: { type: 'string' } },
            semanticVisualType: { type: 'string', enum: [...VISUAL_VALUES] },
            targetDensity: { type: 'string', enum: [...DENSITY_VALUES] },
          },
          required: ['narrativeRole', 'purpose', 'takeaway', 'contentRefs', 'bodyPoints', 'mediaRefs', 'semanticVisualType', 'targetDensity'],
        },
      },
    },
    required: ['workingTitle', 'narrativeSummary', 'slides'],
  };
}

function asDraft(value: unknown, contentIR: ContentIR, brief: Brief): DeckPlanDraft {
  return validateDeckPlanDraft(value, allowedPlanningContentIds(contentIR), brief.requestedSlideCount, allowedMediaIds(contentIR), true);
}

function draftFromPlan(plan: DeckPlan): DeckPlanDraft {
  return {
    workingTitle: plan.workingTitle,
    narrativeSummary: plan.narrativeSummary,
    slides: plan.slides.map(({ id: _id, order: _order, ...slide }) => slide),
  };
}

function plannedCopyBudgetFailure(
  slides: readonly DeckPlanDraftSlide[],
  budgets: PlanningContentBudgets | null,
): string | null {
  if (!budgets) return null;
  try {
    validateDraftAgainstContentBudgets(slides, budgets);
    return null;
  } catch (error) {
    if (error instanceof RangeError && error.message.includes('PLANNED_COPY_EXCEEDS_TEMPLATE_BUDGET')) return error.message;
    throw error;
  }
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

export function assertBudgetRevisionPreservesPlan(previous: DeckPlanDraft, revised: DeckPlanDraft): void {
  if (previous.workingTitle !== revised.workingTitle || previous.narrativeSummary !== revised.narrativeSummary
      || previous.slides.length !== revised.slides.length) {
    throw new PlanningServiceError('BUDGET_REPAIR_CHANGED_PLAN_STRUCTURE', 'The fit repair changed the approved narrative structure.', 422);
  }
  for (let index = 0; index < previous.slides.length; index += 1) {
    const before = previous.slides[index]!;
    const after = revised.slides[index]!;
    const unchangedFields = ['narrativeRole', 'purpose', 'contentRefs', 'mediaRefs', 'semanticVisualType', 'targetDensity'] as const;
    if (unchangedFields.some((field) => stableValue(before[field]) !== stableValue(after[field]))) {
      throw new PlanningServiceError('BUDGET_REPAIR_CHANGED_PLAN_STRUCTURE', `The fit repair changed slide ${index + 1} structure or evidence references.`, 422);
    }
    const beforeEvidence = (before.bodyPoints ?? []).flatMap((point) => point.evidenceRefs).sort();
    const afterEvidence = (after.bodyPoints ?? []).flatMap((point) => point.evidenceRefs).sort();
    if (stableValue(beforeEvidence) !== stableValue(afterEvidence)) {
      throw new PlanningServiceError('BUDGET_REPAIR_CHANGED_EVIDENCE', `The fit repair changed slide ${index + 1} evidence references.`, 422);
    }
  }
}

function outcomeMessage(error: unknown): PlanningFailure {
  if (error instanceof PlanningServiceError) return { code: error.code, message: error.message };
  if (error instanceof SemanticInferenceError) {
    if (error.code === 'CONFIGURATION_ERROR') {
      return { code: 'INFERENCE_NOT_CONFIGURED', message: 'Semantic inference is not configured. Set LCT_SEMANTIC_BASE_URL (and, when required, LCT_SEMANTIC_API_KEY), then retry.' };
    }
    if (error.code === 'TIMEOUT' || error.code === 'DEADLINE_EXCEEDED') {
      return { code: error.code, message: 'Planning exceeded its time limit. Check inference availability and retry.' };
    }
    return { code: error.code, message: 'Semantic inference failed. Check the configured endpoint and retry.' };
  }
  if (isRecord(error) && typeof error.code === 'string' && typeof error.message === 'string') {
    return { code: error.code.slice(0, 80), message: error.message.slice(0, 1000) };
  }
  return { code: 'PLANNING_FAILED', message: error instanceof Error ? error.message.slice(0, 1000) : 'Planning failed.' };
}

const RETRYABLE_PLANNING_OPERATIONS = new Set(['deck-plan', 'plan-review', 'deck-plan-revision']);
const TRANSIENT_NETWORK_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH']);

function isTransientPlanningFailure(error: unknown): boolean {
  if (error instanceof SemanticInferenceError) {
    return error.code === 'INVALID_STRUCTURED_OUTPUT' || error.code === 'SERVICE_UNAVAILABLE';
  }
  let current: unknown = error;
  for (let depth = 0; depth < 3 && isRecord(current); depth += 1) {
    if (typeof current.code === 'string' && TRANSIENT_NETWORK_ERROR_CODES.has(current.code)) return true;
    current = current.cause;
  }
  return false;
}

/** One strict, same-request retry for transient failures in the bounded planning flow only. */
export async function inferPlanningRequestWithRetry<T>(
  adapter: SemanticInferenceAdapter,
  request: SemanticInferenceRequest<T>,
  ensureActive: () => void = () => undefined,
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await adapter.infer(request);
      ensureActive();
      return response;
    } catch (error) {
      if (attempt >= 1 || !RETRYABLE_PLANNING_OPERATIONS.has(request.operation) || !isTransientPlanningFailure(error)) throw error;
      ensureActive();
    }
  }
}

export class PlanningService {
  private readonly activeProjects = new Map<string, { controller: AbortController; done: Promise<void>; resolveDone: () => void }>();
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly planningDeadlineMs: number;

  constructor(private readonly options: PlanningServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.planningDeadlineMs = options.planningDeadlineMs ?? DEFAULT_PLANNING_DEADLINE_MS;
    if (!Number.isSafeInteger(this.planningDeadlineMs) || this.planningDeadlineMs < 1
        || this.planningDeadlineMs > MAX_PLANNING_DEADLINE_MS) {
      throw new TypeError(`planningDeadlineMs must be an integer between 1 and ${MAX_PLANNING_DEADLINE_MS}`);
    }
  }

  async get(projectId: string): Promise<PlanningResponse> {
    let state = await readStoredState(this.options.projectsRoot, projectId);
    const template = await getTemplateCompilation(this.options.projectsRoot, projectId);
    if (!state) {
      const configured = template.status === 'ready';
      return publicResponse(configured ? 'ready_for_planning' : 'unconfigured', template.status, null);
    }

    if (this.activeProjects.has(projectId)) return publicResponse('generating', template.status, state);
    if (state.status === 'generating') {
      state = {
        ...state,
        status: state.currentCheckpoint && !state.lastSuccessful ? 'needs_revision' : 'failed',
        failure: { code: 'GENERATION_INTERRUPTED', message: 'Planning stopped before completion. Retry Generate plan.' },
        updatedAt: this.now().toISOString(),
      };
      await writeStoredState(this.options.projectsRoot, projectId, state);
    }
    if (template.status !== 'ready') {
      const status: PlanningStatus = state.lastSuccessful ? 'stale' : template.status === 'uncompiled' ? 'unconfigured' : 'failed';
      return publicResponse(status, template.status, state, {
        failure: { code: 'TEMPLATE_NOT_READY', message: 'Compile the current project template before generating a plan.' },
      });
    }
    if (!state.inputs) {
      return publicResponse(state.lastSuccessful ? 'ready' : state.failure ? 'failed' : 'ready_for_planning', template.status, state);
    }

    const savedInputs = state.inputs;
    try {
      const currentContentIR = await compileContentIR(this.options.projectsRoot, projectId, savedInputs.contentFiles, {
        task: savedInputs.brief.purpose,
        ...(savedInputs.brief.context ? { context: savedInputs.brief.context } : {}),
      });
      const semanticProfile = await this.options.getPreparedTemplateProfile?.(projectId, template) ?? null;
      const promptAssets = await readPlanningPromptAssets(this.options.projectRoot);
      const currentFingerprint = planningInputFingerprint({
        templateIRHash: template.templateIR!.hash,
        presentationDesignSystemHash: template.presentationDesignSystem!.hash,
        contentIRHash: currentContentIR.hash,
        briefHash: briefHash(savedInputs.brief),
        workerPromptSha256: promptAssets.workerSha256,
        supervisorPromptSha256: promptAssets.supervisorSha256,
        contentBudgetProfileSha256: planningContentProfileFingerprint(semanticProfile),
      });
      const inputs: PlanningInputs = {
        ...savedInputs,
        contentIR: currentContentIR,
        inputFingerprint: currentFingerprint,
      };
      const stale = state.lastSuccessful !== null && state.lastSuccessful.inputFingerprint !== currentFingerprint;
      const status: PlanningStatus = stale ? 'stale' : state.status === 'needs_revision' ? 'needs_revision'
          : state.status === 'failed' ? 'failed'
            : state.lastSuccessful ? 'ready' : state.failure ? 'failed' : 'ready_for_planning';
      const stateChanged = savedInputs.inputFingerprint !== currentFingerprint || state.status !== status;
      if (stateChanged) {
        state = { ...state, inputs, status, updatedAt: this.now().toISOString() };
        await writeStoredState(this.options.projectsRoot, projectId, state);
      }
      return publicResponse(status, template.status, state, { inputFingerprint: currentFingerprint, contentIR: currentContentIR });
    } catch (error) {
      if (error instanceof PlanningServiceError) throw error;
      const failure = { code: 'INPUTS_STALE', message: 'A selected source file is missing, changed beyond current limits, or cannot be read. Check the files and generate again.' };
      const status: PlanningStatus = state.lastSuccessful ? 'stale' : 'failed';
      if (state.status !== status || state.failure?.code !== failure.code || state.failure?.message !== failure.message) {
        state = { ...state, status, failure, updatedAt: this.now().toISOString() };
        await writeStoredState(this.options.projectsRoot, projectId, state);
      }
      return publicResponse(status, template.status, state, { failure });
    }
  }

  async generate(projectId: string, input: GeneratePlanInput, signal?: AbortSignal): Promise<PlanningResponse> {
    if (this.activeProjects.has(projectId)) throw new PlanningServiceError('PLANNING_ALREADY_RUNNING', 'A plan is already being generated for this project.', 409);
    if (this.activeProjects.size >= 2) throw new PlanningServiceError('PLANNING_CAPACITY', 'Planning capacity is full. Wait for another project to finish and retry.', 429);
    if (!isRecord(input) || !exactKeys(input as Record<string, unknown>, ['contentFiles', 'brief'])
        || !Array.isArray(input.contentFiles) || input.contentFiles.length > MAX_SELECTED_FILES
        || input.contentFiles.some((file) => typeof file !== 'string')
        || new Set(input.contentFiles).size !== input.contentFiles.length) {
      throw new PlanningServiceError('INVALID_PLANNING_INPUT', `Provide a task and no more than ${MAX_SELECTED_FILES} unique optional source files.`, 400);
    }
    let brief: Brief;
    try { brief = validateBrief(input.brief); }
    catch (error) { throw new PlanningServiceError('INVALID_BRIEF', error instanceof Error ? error.message : 'Brief is invalid.', 400, { cause: error }); }

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const operation = { controller: new AbortController(), done, resolveDone };
    const abortOperation = () => operation.controller.abort();
    signal?.addEventListener('abort', abortOperation, { once: true });
    if (signal?.aborted) abortOperation();
    this.activeProjects.set(projectId, operation);
    const totalStarted = Date.now();
    let state: StoredPlanningState | null = null;
    let stateLoaded = false;
    try {
      const ensureActive = () => {
        if (operation.controller.signal.aborted) {
          throw new PlanningServiceError('PLANNING_CANCELLED', 'Planning was cancelled.', 409);
        }
      };
      state = await readStoredState(this.options.projectsRoot, projectId);
      ensureActive();
      stateLoaded = true;
      const template = await getTemplateCompilation(this.options.projectsRoot, projectId);
      ensureActive();
      if (template.status !== 'ready' || !template.templateIR || !template.presentationDesignSystem) {
        throw new PlanningServiceError('TEMPLATE_NOT_READY', 'Analyze the current project PPTX template before generating a plan.', 409);
      }
      const semanticProfile = await this.options.getPreparedTemplateProfile?.(projectId, template) ?? null;
      ensureActive();
      let contentBudgets: PlanningContentBudgets | null = null;
      if (this.options.getPreparedTemplateProfile) {
        if (!semanticProfile) throw new PlanningServiceError('TEMPLATE_PROFILE_NOT_READY', 'Prepare the template profile before generating a plan.', 409);
        try {
          contentBudgets = await this.options.getPlanningContentBudgets?.({
            projectId,
            template: template.templateIR,
            semanticProfile,
            requestedSlideCount: brief.requestedSlideCount ?? 30,
          }) ?? null;
          if (!contentBudgets) throw new TypeError('Prepared profile is required to derive text budgets.');
        } catch (error) {
          throw new PlanningServiceError('TEMPLATE_TEXT_BUDGET_UNAVAILABLE', 'The prepared template does not expose measurable title and body regions for planning.', 409, { cause: error });
        }
      }
      const contentIR = await compileContentIR(this.options.projectsRoot, projectId, input.contentFiles, {
        task: brief.purpose,
        ...(brief.context ? { context: brief.context } : {}),
      });
      ensureActive();
      const promptAssets = await readPlanningPromptAssets(this.options.projectRoot);
      ensureActive();
      const fingerprint = planningInputFingerprint({
        templateIRHash: template.templateIR.hash,
        presentationDesignSystemHash: template.presentationDesignSystem.hash,
        contentIRHash: contentIR.hash,
        briefHash: briefHash(brief),
        workerPromptSha256: promptAssets.workerSha256,
        supervisorPromptSha256: promptAssets.supervisorSha256,
        contentBudgetProfileSha256: contentBudgets?.profileSha256 ?? planningContentProfileFingerprint(null),
      });
      const inputs: PlanningInputs = { contentFiles: [...input.contentFiles], brief, contentIR, inputFingerprint: fingerprint };
      state = {
        schemaVersion: 1,
        updatedAt: this.now().toISOString(),
        status: 'generating',
        inputs,
        lastSuccessful: state?.lastSuccessful ?? null,
        failure: null,
        currentCheckpoint: null,
      };
      ensureActive();
      await writeStoredState(this.options.projectsRoot, projectId, state);

      const adapter = this.options.getInferenceAdapter();
      const deadlineAtEpochMs = Date.now() + this.planningDeadlineMs;
      const designSystem = scopedDesignSystem(template.presentationDesignSystem);
      const workerEvidence = {
        brief,
        contentIR: compactContentIR(contentIR),
        presentationDesignSystem: designSystem,
        contentBudgets,
        requestedSlideCount: brief.requestedSlideCount ?? null,
      };
      const workerEvidenceText = JSON.stringify(workerEvidence);
      if (workerEvidenceText.length > MAX_EVIDENCE_CHARS) {
        throw new PlanningServiceError('PLANNING_CONTEXT_TOO_LARGE', 'Selected source evidence exceeds the planning context limit. Select fewer or shorter source files.', 413);
      }
      const workerContract = {
        name: 'deck_plan_draft_v4',
        schema: workerDraftSchema(),
        validate: (value: unknown): value is DeckPlanDraft => isDraft(value, contentIR, brief),
      };
      const workerRequest: SemanticInferenceRequest<DeckPlanDraft> = {
        role: 'worker',
        operation: 'deck-plan',
        messages: [
          { role: 'system', content: promptAssets.worker },
          { role: 'user', content: workerEvidenceText },
        ],
        output: workerContract,
        maxOutputTokens: 4096,
        temperature: 0.2,
        deadlineAtEpochMs,
        signal: operation.controller.signal,
        metadata: { projectId, generationId: this.createId() },
      };
      const workerResponse = await inferPlanningRequestWithRetry(adapter, workerRequest, ensureActive);
      const workerDraft = asDraft(workerResponse.value, contentIR, brief);
      let revisionWorkerSummary: TelemetrySummary | undefined;
      const planId = `dp_${this.createId().replaceAll('-', '')}`;
      const checkpoint = canonicalizeDeckPlan(workerDraft, {
        id: planId,
        version: 1,
        createdAt: this.now().toISOString(),
        inputFingerprint: fingerprint,
        briefHash: briefHash(brief),
        allowedContentIds: allowedContentIds(contentIR),
        allowedMediaIds: allowedMediaIds(contentIR),
        requestedSlideCount: brief.requestedSlideCount,
      });
      state = { ...state, currentCheckpoint: checkpoint, updatedAt: this.now().toISOString() };
      ensureActive();
      await writeStoredState(this.options.projectsRoot, projectId, state);

      const reviewEvidence = {
        checkpointVersion: checkpoint.version,
        checkpoint,
        brief,
        citedContent: contentForReview(contentIR, checkpoint),
        presentationDesignSystem: designSystem,
      };
      const reviewEvidenceText = JSON.stringify(reviewEvidence);
      if (reviewEvidenceText.length > MAX_EVIDENCE_CHARS) {
        throw new PlanningServiceError('PLANNING_CONTEXT_TOO_LARGE', 'Supervisor review evidence exceeds the planning context limit. Select fewer or shorter source files.', 413);
      }
      const reviewContract = {
        name: 'supervisor_plan_review_v1',
        schema: reviewSchema(),
        validate: isPlanReviewShape,
      };
      const reviewRequest: SemanticInferenceRequest<PlanReview> = {
        role: 'supervisor',
        operation: 'plan-review',
        messages: [
          { role: 'system', content: promptAssets.supervisor },
          { role: 'user', content: reviewEvidenceText },
        ],
        output: reviewContract,
        maxOutputTokens: 2048,
        temperature: 0,
        deadlineAtEpochMs,
        signal: operation.controller.signal,
        metadata: { projectId, checkpointId: checkpoint.id },
      };
      const supervisorResponse = await inferPlanningRequestWithRetry(adapter, reviewRequest, ensureActive);
      const review = validatePlanReview(supervisorResponse.value, checkpoint, contentIR);
      let deckPlan = checkpoint;
      if (review.outcome === 'repair') {
        deckPlan = applyPlanRepair(checkpoint, review, contentIR, brief, fingerprint);
      }
      const budgetFailure = plannedCopyBudgetFailure(deckPlan.slides, contentBudgets);
      if (review.outcome === 'local-replan' || budgetFailure !== null) {
        const revisionBase = draftFromPlan(deckPlan);
        const revisionEvidenceText = JSON.stringify({
          brief,
          currentPlan: revisionBase,
          review,
          fitBudgetFailure: budgetFailure,
          contentIR: compactContentIR(contentIR),
          presentationDesignSystem: designSystem,
          contentBudgets,
          requestedSlideCount: brief.requestedSlideCount ?? null,
        });
        if (revisionEvidenceText.length > MAX_EVIDENCE_CHARS) {
          throw new PlanningServiceError('PLANNING_CONTEXT_TOO_LARGE', 'Worker revision evidence exceeds the planning context limit. Select fewer or shorter source files.', 413);
        }
        const revisionInstructions = [
          promptAssets.worker,
          'BOUNDED REVISION: Supervisor review has already run. This is the only deck-plan-revision for this planning attempt. Address the supplied review findings and any fit constraint together in one complete revised draft.',
          ...(review.outcome === 'local-replan'
            ? ['Apply the Supervisor findings while preserving the supported narrative and source-backed evidence.']
            : ['Keep the current plan meaning and structure; the Supervisor has not requested a local re-plan.']),
          ...(review.outcome === 'repair'
            ? ['The Supervisor repair operations are already reflected in currentPlan. Preserve those corrections.']
            : []),
          ...(budgetFailure !== null
            ? [`FIT CONSTRAINT: currentPlan exceeds measured template text budgets (${budgetFailure}). Make complete, concise wording that fits the supplied role-compatible region budgets. Preserve every source claim and evidence reference; do not add or remove facts, change fonts, or change the template.`]
            : []),
          'Return one full DeckPlan draft. Do not request another review or another revision.',
        ].join('\n\n');
        const revisionRequest: SemanticInferenceRequest<DeckPlanDraft> = {
          ...workerRequest,
          operation: 'deck-plan-revision',
          messages: [
            { role: 'system', content: revisionInstructions },
            { role: 'user', content: revisionEvidenceText },
          ],
          signal: operation.controller.signal,
          metadata: { projectId, generationId: this.createId(), checkpointId: checkpoint.id },
        };
        const revisionResponse = await inferPlanningRequestWithRetry(adapter, revisionRequest, ensureActive);
        const revisedDraft = asDraft(revisionResponse.value, contentIR, brief);
        if (budgetFailure !== null && review.outcome !== 'local-replan') {
          assertBudgetRevisionPreservesPlan(revisionBase, revisedDraft);
        }
        if (contentBudgets) {
          const revisedBudgetFailure = plannedCopyBudgetFailure(revisedDraft.slides, contentBudgets);
          if (revisedBudgetFailure !== null) {
            throw new PlanningServiceError('PLANNED_COPY_EXCEEDS_TEMPLATE_BUDGET', 'The single bounded plan revision still exceeds the qualified template text budgets.', 422);
          }
        }
        deckPlan = canonicalizeDeckPlan(revisedDraft, {
          id: checkpoint.id,
          version: checkpoint.version + 1,
          createdAt: checkpoint.createdAt,
          inputFingerprint: fingerprint,
          briefHash: briefHash(brief),
          allowedContentIds: allowedContentIds(contentIR),
          allowedMediaIds: allowedMediaIds(contentIR),
          requestedSlideCount: brief.requestedSlideCount,
        });
        revisionWorkerSummary = telemetrySummary(revisionResponse.telemetry);
      }
      validateDeckPlan(deckPlan, allowedContentIds(contentIR), brief.requestedSlideCount, allowedMediaIds(contentIR));

      const finalTemplate = await getTemplateCompilation(this.options.projectsRoot, projectId);
      ensureActive();
      const finalContentIR = await compileContentIR(this.options.projectsRoot, projectId, input.contentFiles, {
        task: brief.purpose,
        ...(brief.context ? { context: brief.context } : {}),
      });
      ensureActive();
      const finalPromptAssets = await readPlanningPromptAssets(this.options.projectRoot);
      ensureActive();
      const finalSemanticProfile = finalTemplate.status === 'ready'
        ? await this.options.getPreparedTemplateProfile?.(projectId, finalTemplate) ?? null
        : null;
      ensureActive();
      const finalFingerprint = finalTemplate.status === 'ready' && finalTemplate.templateIR && finalTemplate.presentationDesignSystem
        ? planningInputFingerprint({
          templateIRHash: finalTemplate.templateIR.hash,
          presentationDesignSystemHash: finalTemplate.presentationDesignSystem.hash,
          contentIRHash: finalContentIR.hash,
          briefHash: briefHash(brief),
          workerPromptSha256: finalPromptAssets.workerSha256,
          supervisorPromptSha256: finalPromptAssets.supervisorSha256,
          contentBudgetProfileSha256: planningContentProfileFingerprint(finalSemanticProfile),
        })
        : null;
      if (finalFingerprint !== fingerprint) {
        throw new PlanningServiceError('INPUTS_CHANGED_DURING_GENERATION', 'Template or selected source files changed while planning. Review the inputs and generate again.', 409);
      }
      const telemetry: PlanningTelemetry = {
        worker: telemetrySummary(workerResponse.telemetry),
        supervisor: telemetrySummary(supervisorResponse.telemetry),
        ...(revisionWorkerSummary ? { revisionWorker: revisionWorkerSummary } : {}),
        totalWallTimeMs: Date.now() - totalStarted,
      };
      const snapshot: SuccessfulPlanSnapshot = {
        contentFiles: [...input.contentFiles],
        brief,
        contentIR,
        inputFingerprint: fingerprint,
        checkpoint,
        deckPlan,
        review,
        telemetry,
        promptVersions: { worker: WORKER_PLAN_PROMPT_VERSION, supervisor: SUPERVISOR_PLAN_REVIEW_PROMPT_VERSION },
        agentWorkflowVersions: AGENT_WORKFLOW_VERSIONS,
        model: telemetry.worker.model,
        createdAt: this.now().toISOString(),
      };
      state = {
        ...state,
        updatedAt: this.now().toISOString(),
        status: 'ready',
        inputs: { ...inputs, contentIR: finalContentIR },
        lastSuccessful: snapshot,
        failure: null,
        currentCheckpoint: checkpoint,
      };
      ensureActive();
      await writeStoredState(this.options.projectsRoot, projectId, state);
      return publicResponse(state.status, finalTemplate.status, state);
    } catch (error) {
      if (operation.controller.signal.aborted) {
        throw new PlanningServiceError('PLANNING_CANCELLED', 'Planning was cancelled.', 409, { cause: error });
      }
      if (!stateLoaded) throw error;
      const failure = outcomeMessage(error);
      state = {
        schemaVersion: 1,
        updatedAt: this.now().toISOString(),
        status: state?.lastSuccessful && state.lastSuccessful.inputFingerprint !== state.inputs?.inputFingerprint
          ? 'stale'
          : state?.currentCheckpoint && !state.lastSuccessful ? 'needs_revision' : 'failed',
        inputs: state?.inputs ?? null,
        lastSuccessful: state?.lastSuccessful ?? null,
        failure,
        currentCheckpoint: state?.currentCheckpoint ?? null,
      };
      await writeStoredState(this.options.projectsRoot, projectId, state);
      if (error instanceof PlanningServiceError) throw error;
      if (error instanceof SemanticInferenceError && error.code === 'CONFIGURATION_ERROR') {
        throw new PlanningServiceError('INFERENCE_NOT_CONFIGURED', failure.message, 503, { cause: error });
      }
      if (error instanceof SemanticInferenceError) {
        throw new PlanningServiceError(error.code, failure.message, 502, { cause: error });
      }
      const reportedStatus = isRecord(error) && typeof error.status === 'number' ? error.status : 422;
      throw new PlanningServiceError(failure.code, failure.message, reportedStatus, { cause: error });
    } finally {
      signal?.removeEventListener('abort', abortOperation);
      if (this.activeProjects.get(projectId) === operation) this.activeProjects.delete(projectId);
      operation.resolveDone();
    }
  }

  async cancel(projectId: string): Promise<boolean> {
    const active = this.activeProjects.get(projectId);
    if (!active) return true;
    active.controller.abort();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([active.done.then(() => true), new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 5_000);
        timer.unref?.();
      })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async shutdown(): Promise<boolean> {
    const active = [...this.activeProjects.values()];
    for (const operation of active) operation.controller.abort();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([Promise.all(active.map((operation) => operation.done)).then(() => true), new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 5_000);
        timer.unref?.();
      })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.activeProjects.values()].map((operation) => operation.done));
  }
}
