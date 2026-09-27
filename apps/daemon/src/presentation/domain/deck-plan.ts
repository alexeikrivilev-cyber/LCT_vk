import { createHash } from 'node:crypto';

export type NarrativeRole = 'opening' | 'agenda' | 'section-divider' | 'content' | 'closing';
export type SemanticVisualType = 'none' | 'image' | 'chart' | 'table' | 'diagram' | 'timeline' | 'process' | 'comparison' | 'kpi';
export type TargetDensity = 'compact' | 'balanced' | 'detailed';
export type GeneratedBodyOrigin = 'generated-from-brief';

/** Generated copy is not source evidence; refs identify optional factual support. */
export interface GeneratedBodyPoint {
  text: string;
  origin: GeneratedBodyOrigin;
  evidenceRefs: string[];
}

/** The model-produced portion only. Slide IDs and order are app-authoritative. */
export interface DeckPlanDraftSlide {
  narrativeRole: NarrativeRole;
  purpose: string;
  takeaway: string;
  contentRefs: string[];
  /** Replaceable planning extension; origin is fixed and source refs stay separate. */
  bodyPoints?: GeneratedBodyPoint[];
  /** Replaceable pre-TZ extension: optional visual-only ContentIR media IDs, never factual evidence. */
  mediaRefs?: string[];
  semanticVisualType: SemanticVisualType;
  targetDensity: TargetDensity;
}

/** Runtime-guarded model output. Server-authoritative metadata is excluded. */
export interface DeckPlanDraft {
  workingTitle: string;
  narrativeSummary: string;
  slides: DeckPlanDraftSlide[];
}

export interface DeckPlanSlide extends DeckPlanDraftSlide {
  id: string;
  order: number;
}

export interface DeckPlanHashPayload {
  schemaVersion: 1;
  id: string;
  version: number;
  createdAt: string;
  inputFingerprint: string;
  briefHash: string;
  workingTitle: string;
  narrativeSummary: string;
  slides: DeckPlanSlide[];
}

export interface DeckPlan extends DeckPlanHashPayload {
  hash: string;
}

export interface DeckPlanMetadata {
  id: string;
  version: number;
  createdAt: string;
  inputFingerprint: string;
  briefHash: string;
  allowedContentIds: ReadonlySet<string>;
  /** Replaceable pre-TZ validation allowlist for optional visual-only mediaRefs. */
  allowedMediaIds?: ReadonlySet<string>;
  requestedSlideCount?: number;
}

const NON_FACTUAL_ROLES = new Set<NarrativeRole>(['opening', 'agenda', 'section-divider', 'closing']);
const NARRATIVE_ROLES = new Set<string>(['opening', 'agenda', 'section-divider', 'content', 'closing']);
const VISUAL_TYPES = new Set<string>(['none', 'image', 'chart', 'table', 'diagram', 'timeline', 'process', 'comparison', 'kpi']);
const TARGET_DENSITIES = new Set<string>(['compact', 'balanced', 'detailed']);

const LIMITS = {
  id: 128,
  metadataText: 512,
  workingTitle: 240,
  narrative: 1_000,
  slidePurpose: 1_000,
  takeaway: 1_000,
  bodyPoint: 180,
} as const;

const MAX_BODY_POINTS = 4;
const MAX_BODY_POINT_EVIDENCE_REFS = 8;
const MAX_GENERATED_TITLE_LENGTH = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactDataRecord(value: unknown, allowedKeys: readonly string[], requiredKeys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) return false;
  const keys = ownKeys as string[];
  if (keys.some((key) => !allowedKeys.includes(key)) || requiredKeys.some((key) => !keys.includes(key))) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor;
  });
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)))) return false;
  if (keys.length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return false;
  }
  return true;
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength * 2
    && value.trim().length > 0 && Array.from(value).length <= maxLength;
}

function isValidRequestedSlideCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 30;
}

function validateRequestedSlideCount(value: number | undefined): void {
  if (value !== undefined && !isValidRequestedSlideCount(value)) {
    throw new TypeError('requestedSlideCount must be an integer from 1 through 30');
  }
}

function validateAllowedContentIds(value: ReadonlySet<string>): void {
  if (value === null || typeof value !== 'object' || typeof value.has !== 'function'
    || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0) {
    throw new TypeError('allowedContentIds must be a readonly set of content unit IDs');
  }
}

function validateAllowedMediaIds(value: ReadonlySet<string> | undefined): ReadonlySet<string> {
  if (value === undefined) return new Set();
  if (value === null || typeof value !== 'object' || typeof value.has !== 'function'
    || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0) {
    throw new TypeError('allowedMediaIds must be a readonly set of media unit IDs');
  }
  return value;
}

function normalizedBoundedText(value: string): string {
  return value.trim();
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256 hash`);
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new TypeError('Cannot hash a value outside canonical JSON');
}

function validateBodyPoints(
  value: unknown,
  allowedContentIds: ReadonlySet<string>,
  slideContentRefs: readonly string[],
): GeneratedBodyPoint[] {
  if (!isDenseArray(value) || value.length < 1 || value.length > MAX_BODY_POINTS) {
    throw new TypeError(`DeckPlan bodyPoints must contain from 1 through ${MAX_BODY_POINTS} items`);
  }
  const slideRefs = new Set(slideContentRefs);
  let totalCharacters = 0;
  return value.map((item) => {
    if (!exactDataRecord(item, ['text', 'origin', 'evidenceRefs'], ['text', 'origin', 'evidenceRefs'])
        || !boundedText(item.text, LIMITS.bodyPoint) || item.origin !== 'generated-from-brief'
        || !isDenseArray(item.evidenceRefs) || item.evidenceRefs.length > MAX_BODY_POINT_EVIDENCE_REFS) {
      throw new TypeError('DeckPlan bodyPoints must be bounded generated-from-brief points with evidenceRefs');
    }
    totalCharacters += Array.from(item.text).length;
    if (totalCharacters > 600) throw new TypeError('DeckPlan bodyPoints exceed their aggregate text limit');
    const evidenceRefs: string[] = [];
    const seenEvidence = new Set<string>();
    for (const ref of item.evidenceRefs) {
      if (typeof ref !== 'string' || !allowedContentIds.has(ref) || !slideRefs.has(ref)) {
        throw new TypeError('DeckPlan body point evidenceRefs must resolve to source refs on the same slide');
      }
      if (seenEvidence.has(ref)) throw new TypeError('DeckPlan body point evidenceRefs must be unique');
      seenEvidence.add(ref);
      evidenceRefs.push(ref);
    }
    return { text: normalizedBoundedText(item.text), origin: 'generated-from-brief', evidenceRefs };
  });
}

function validateDraftSlide(
  value: unknown,
  allowedContentIds: ReadonlySet<string>,
  allowedMediaIds: ReadonlySet<string>,
  requireGeneratedBody: boolean,
): DeckPlanDraftSlide {
  if (!exactDataRecord(value,
    ['narrativeRole', 'purpose', 'takeaway', 'contentRefs', 'bodyPoints', 'mediaRefs', 'semanticVisualType', 'targetDensity'],
    ['narrativeRole', 'purpose', 'takeaway', 'contentRefs', 'semanticVisualType', 'targetDensity'])) {
    throw new TypeError('Invalid DeckPlan draft slide fields');
  }
  if (typeof value.narrativeRole !== 'string' || !NARRATIVE_ROLES.has(value.narrativeRole)) {
    throw new TypeError('Invalid DeckPlan narrativeRole');
  }
  if (!boundedText(value.purpose, LIMITS.slidePurpose) || !boundedText(value.takeaway, LIMITS.takeaway)) {
    throw new TypeError('DeckPlan slide purpose and takeaway must be non-empty and within their limits');
  }
  if (!isDenseArray(value.contentRefs)) throw new TypeError('DeckPlan contentRefs must be a dense array');
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const ref of value.contentRefs) {
    if (typeof ref !== 'string' || ref.trim().length === 0 || !allowedContentIds.has(ref)) {
      throw new TypeError('DeckPlan contentRefs must resolve to known content unit IDs');
    }
    if (seen.has(ref)) throw new TypeError('DeckPlan contentRefs must be unique within a slide');
    seen.add(ref);
    refs.push(ref);
  }
  let bodyPoints: GeneratedBodyPoint[] | undefined;
  if (Object.hasOwn(value, 'bodyPoints')) bodyPoints = validateBodyPoints(value.bodyPoints, allowedContentIds, refs);
  if (requireGeneratedBody && bodyPoints === undefined) {
    throw new TypeError('Each newly planned slide requires generated body copy');
  }
  if (bodyPoints !== undefined
      && Array.from(value.takeaway as string).length > MAX_GENERATED_TITLE_LENGTH) {
    throw new TypeError(`DeckPlan title with generated body copy must not exceed ${MAX_GENERATED_TITLE_LENGTH} characters`);
  }
  let mediaRefs: string[] | undefined;
  if (Object.hasOwn(value, 'mediaRefs')) {
    if (!isDenseArray(value.mediaRefs) || value.mediaRefs.length > 20) throw new TypeError('DeckPlan mediaRefs must be a bounded dense array');
    mediaRefs = [];
    const seenMedia = new Set<string>();
    for (const ref of value.mediaRefs) {
      if (typeof ref !== 'string' || ref.trim().length === 0 || !allowedMediaIds.has(ref)) {
        throw new TypeError('DeckPlan mediaRefs must resolve to known media unit IDs');
      }
      if (seenMedia.has(ref)) throw new TypeError('DeckPlan mediaRefs must be unique within a slide');
      seenMedia.add(ref);
      mediaRefs.push(ref);
    }
  }
  const role = value.narrativeRole as NarrativeRole;
  if (refs.length === 0 && !NON_FACTUAL_ROLES.has(role) && bodyPoints === undefined) {
    throw new TypeError('DeckPlan content slides require at least one content reference');
  }
  if (typeof value.semanticVisualType !== 'string' || !VISUAL_TYPES.has(value.semanticVisualType)) {
    throw new TypeError('Invalid DeckPlan semanticVisualType');
  }
  if (typeof value.targetDensity !== 'string' || !TARGET_DENSITIES.has(value.targetDensity)) {
    throw new TypeError('Invalid DeckPlan targetDensity');
  }
  return {
    narrativeRole: role,
    purpose: normalizedBoundedText(value.purpose),
    takeaway: normalizedBoundedText(value.takeaway),
    contentRefs: refs,
    ...(bodyPoints === undefined ? {} : { bodyPoints }),
    ...(mediaRefs === undefined ? {} : { mediaRefs }),
    semanticVisualType: value.semanticVisualType as SemanticVisualType,
    targetDensity: value.targetDensity as TargetDensity,
  };
}

/** Strict runtime guard for model output; rejects IDs, order, and server metadata. */
export function validateDeckPlanDraft(
  value: unknown,
  allowedContentIds: ReadonlySet<string>,
  requestedSlideCount?: number,
  allowedMediaIds?: ReadonlySet<string>,
  requireGeneratedBody = false,
): DeckPlanDraft {
  validateAllowedContentIds(allowedContentIds);
  const mediaIds = validateAllowedMediaIds(allowedMediaIds);
  validateRequestedSlideCount(requestedSlideCount);
  if (!exactDataRecord(value, ['workingTitle', 'narrativeSummary', 'slides'], ['workingTitle', 'narrativeSummary', 'slides'])) {
    throw new TypeError('Invalid DeckPlan draft fields');
  }
  if (!boundedText(value.workingTitle, LIMITS.workingTitle)
    || !boundedText(value.narrativeSummary, LIMITS.narrative)) {
    throw new TypeError('DeckPlan workingTitle and narrativeSummary must be non-empty and within their limits');
  }
  if (!isDenseArray(value.slides) || value.slides.length < 1 || value.slides.length > 30) {
    throw new TypeError('DeckPlan must contain from 1 through 30 slides');
  }
  if (requestedSlideCount !== undefined && value.slides.length !== requestedSlideCount) {
    throw new TypeError('DeckPlan slide count must match requestedSlideCount exactly');
  }
  return {
    workingTitle: normalizedBoundedText(value.workingTitle),
    narrativeSummary: normalizedBoundedText(value.narrativeSummary),
    slides: value.slides.map((slide) => validateDraftSlide(slide, allowedContentIds, mediaIds, requireGeneratedBody)),
  };
}

function validateMetadata(metadata: DeckPlanMetadata): void {
  if (!isRecord(metadata) || !boundedText(metadata.id, LIMITS.id) || !Number.isSafeInteger(metadata.version)
    || metadata.version < 1 || !isCanonicalUtcTimestamp(metadata.createdAt)
    || !boundedText(metadata.inputFingerprint, LIMITS.metadataText)) {
    throw new TypeError('Invalid DeckPlan app metadata');
  }
  assertHash(metadata.briefHash, 'briefHash');
  validateAllowedContentIds(metadata.allowedContentIds);
  validateAllowedMediaIds(metadata.allowedMediaIds);
  validateRequestedSlideCount(metadata.requestedSlideCount);
}

function hashPayloadFromPlan(value: unknown): DeckPlanHashPayload {
  if (!exactDataRecord(value,
    ['schemaVersion', 'id', 'version', 'createdAt', 'inputFingerprint', 'briefHash', 'workingTitle', 'narrativeSummary', 'slides'],
    ['schemaVersion', 'id', 'version', 'createdAt', 'inputFingerprint', 'briefHash', 'workingTitle', 'narrativeSummary', 'slides'])) {
    throw new TypeError('Invalid DeckPlan hash payload fields');
  }
  if (value.schemaVersion !== 1 || !boundedText(value.id, LIMITS.id) || !Number.isSafeInteger(value.version)
    || (value.version as number) < 1 || !isCanonicalUtcTimestamp(value.createdAt)
    || !boundedText(value.inputFingerprint, LIMITS.metadataText)) {
    throw new TypeError('Invalid DeckPlan hash payload metadata');
  }
  assertHash(value.briefHash, 'briefHash');
  if (!boundedText(value.workingTitle, LIMITS.workingTitle) || !boundedText(value.narrativeSummary, LIMITS.narrative)
    || !isDenseArray(value.slides) || value.slides.length < 1 || value.slides.length > 30) {
    throw new TypeError('Invalid DeckPlan hash payload content');
  }
  const slides: DeckPlanSlide[] = value.slides.map((entry, index) => {
    if (!exactDataRecord(entry,
      ['id', 'order', 'narrativeRole', 'purpose', 'takeaway', 'contentRefs', 'bodyPoints', 'mediaRefs', 'semanticVisualType', 'targetDensity'],
      ['id', 'order', 'narrativeRole', 'purpose', 'takeaway', 'contentRefs', 'semanticVisualType', 'targetDensity'])) {
      throw new TypeError('Invalid DeckPlan hash payload slide fields');
    }
    if (!boundedText(entry.id, LIMITS.metadataText) || entry.order !== index + 1
      || typeof entry.narrativeRole !== 'string' || !NARRATIVE_ROLES.has(entry.narrativeRole)
      || !boundedText(entry.purpose, LIMITS.slidePurpose) || !boundedText(entry.takeaway, LIMITS.takeaway)
      || !isDenseArray(entry.contentRefs) || !entry.contentRefs.every((ref) => typeof ref === 'string')
      || (Object.hasOwn(entry, 'bodyPoints') && (!isDenseArray(entry.bodyPoints)
        || entry.bodyPoints.length < 1 || entry.bodyPoints.length > MAX_BODY_POINTS))
      || (Object.hasOwn(entry, 'mediaRefs') && (!isDenseArray(entry.mediaRefs) || entry.mediaRefs.length > 20
        || !entry.mediaRefs.every((ref) => typeof ref === 'string')))
      || typeof entry.semanticVisualType !== 'string' || !VISUAL_TYPES.has(entry.semanticVisualType)
      || typeof entry.targetDensity !== 'string' || !TARGET_DENSITIES.has(entry.targetDensity)) {
      throw new TypeError('Invalid DeckPlan hash payload slide');
    }
    return {
      id: entry.id.trim(),
      order: index + 1,
      narrativeRole: entry.narrativeRole as NarrativeRole,
      purpose: entry.purpose.trim(),
      takeaway: entry.takeaway.trim(),
      contentRefs: [...entry.contentRefs] as string[],
      ...(Object.hasOwn(entry, 'bodyPoints') ? {
        bodyPoints: validateBodyPoints(entry.bodyPoints, new Set(entry.contentRefs as string[]), entry.contentRefs as string[]),
      } : {}),
      ...(Object.hasOwn(entry, 'mediaRefs') ? { mediaRefs: [...entry.mediaRefs as string[]] } : {}),
      semanticVisualType: entry.semanticVisualType as SemanticVisualType,
      targetDensity: entry.targetDensity as TargetDensity,
    };
  });
  return {
    schemaVersion: 1,
    id: value.id.trim(),
    version: value.version as number,
    createdAt: value.createdAt,
    inputFingerprint: value.inputFingerprint.trim(),
    briefHash: value.briefHash,
    workingTitle: value.workingTitle.trim(),
    narrativeSummary: value.narrativeSummary.trim(),
    slides,
  };
}

/** SHA-256 over canonical DeckPlan v1 fields, excluding the `hash` field. */
export function deckPlanHash(planWithoutHash: DeckPlanHashPayload): string {
  const payload = hashPayloadFromPlan(planWithoutHash);
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/** Assign server-authoritative metadata, stable slide IDs, order, and content hash. */
export function canonicalizeDeckPlan(draft: unknown, metadata: DeckPlanMetadata): DeckPlan {
  validateMetadata(metadata);
  const cleanDraft = validateDeckPlanDraft(draft, metadata.allowedContentIds, metadata.requestedSlideCount, metadata.allowedMediaIds);
  const payload: DeckPlanHashPayload = {
    schemaVersion: 1,
    id: metadata.id.trim(),
    version: metadata.version,
    createdAt: metadata.createdAt,
    inputFingerprint: metadata.inputFingerprint.trim(),
    briefHash: metadata.briefHash,
    workingTitle: cleanDraft.workingTitle,
    narrativeSummary: cleanDraft.narrativeSummary,
    slides: cleanDraft.slides.map((slide, index) => ({
      id: `slide_${metadata.id.trim()}_${index + 1}`,
      order: index + 1,
      ...slide,
    })),
  };
  return validateDeckPlan({ ...payload, hash: deckPlanHash(payload) }, metadata.allowedContentIds, metadata.requestedSlideCount, metadata.allowedMediaIds);
}

/** Validate persisted/canonical DeckPlan v1 including references and content hash. */
export function validateDeckPlan(
  value: unknown,
  allowedContentIds: ReadonlySet<string>,
  requestedSlideCount?: number,
  allowedMediaIds?: ReadonlySet<string>,
): DeckPlan {
  validateAllowedContentIds(allowedContentIds);
  const mediaIds = validateAllowedMediaIds(allowedMediaIds);
  validateRequestedSlideCount(requestedSlideCount);
  if (!exactDataRecord(value,
    ['schemaVersion', 'id', 'version', 'createdAt', 'inputFingerprint', 'briefHash', 'workingTitle', 'narrativeSummary', 'slides', 'hash'],
    ['schemaVersion', 'id', 'version', 'createdAt', 'inputFingerprint', 'briefHash', 'workingTitle', 'narrativeSummary', 'slides', 'hash'])) {
    throw new TypeError('Invalid DeckPlan v1 fields');
  }
  const payload = hashPayloadFromPlan({
    schemaVersion: value.schemaVersion,
    id: value.id,
    version: value.version,
    createdAt: value.createdAt,
    inputFingerprint: value.inputFingerprint,
    briefHash: value.briefHash,
    workingTitle: value.workingTitle,
    narrativeSummary: value.narrativeSummary,
    slides: value.slides,
  });
  if (requestedSlideCount !== undefined && payload.slides.length !== requestedSlideCount) {
    throw new TypeError('DeckPlan slide count must match requestedSlideCount exactly');
  }
  const validatedDraft = validateDeckPlanDraft({
    workingTitle: payload.workingTitle,
    narrativeSummary: payload.narrativeSummary,
    slides: payload.slides.map(({ id: _id, order: _order, ...slide }) => slide),
  }, allowedContentIds, requestedSlideCount, mediaIds);
  const slideIds = new Set<string>();
  for (let index = 0; index < payload.slides.length; index += 1) {
    const slide = payload.slides[index];
    if (!slide || !boundedText(slide.id, LIMITS.metadataText) || slideIds.has(slide.id)) {
      throw new TypeError('DeckPlan slide IDs must be non-empty and unique');
    }
    if (slide.order !== index + 1) throw new TypeError('DeckPlan slide order must be one-based and contiguous');
    slideIds.add(slide.id);
  }
  assertHash(value.hash, 'DeckPlan hash');
  if (value.hash !== deckPlanHash(payload)) throw new TypeError('DeckPlan content hash mismatch');
  return {
    ...payload,
    workingTitle: validatedDraft.workingTitle,
    narrativeSummary: validatedDraft.narrativeSummary,
    slides: payload.slides.map((slide) => ({
      ...slide,
      contentRefs: [...slide.contentRefs],
      ...(slide.bodyPoints === undefined ? {} : { bodyPoints: slide.bodyPoints.map((point) => ({ ...point, evidenceRefs: [...point.evidenceRefs] })) }),
      ...(slide.mediaRefs === undefined ? {} : { mediaRefs: [...slide.mediaRefs] }),
    })),
    hash: value.hash,
  };
}
