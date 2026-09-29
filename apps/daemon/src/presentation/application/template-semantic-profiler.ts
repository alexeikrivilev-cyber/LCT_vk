import {
  validatePresentationDesignSystem,
  validateTemplateIR,
  type PresentationDesignSystem,
  type TemplateElement,
  type TemplateIR,
} from '../domain/template-ir.js';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import templateProfilerWorkflow from '../contracts/template-profiler.v1.json' with { type: 'json' };
import type {
  SemanticInferenceAdapter,
  SemanticInferenceRequest,
  SemanticJsonSchema,
  SemanticOutputContract,
} from './semantic-inference-port.js';
import { SemanticInferenceError as InferenceError } from './semantic-inference-port.js';
import { resolvePresentationFilePath } from '../../presentation-files.js';

export const TEMPLATE_SLIDE_ARCHETYPES = [
  'cover', 'section-divider', 'content', 'content-split', 'content-dense',
  'metric-evidence', 'table-data', 'visual-led', 'closing',
] as const;

export const TEMPLATE_CONTENT_MODES = ['text', 'metrics', 'table', 'chart', 'diagram', 'image', 'mixed'] as const;

export type TemplateSlideArchetype = typeof TEMPLATE_SLIDE_ARCHETYPES[number];
export type TemplateContentMode = typeof TEMPLATE_CONTENT_MODES[number];

export interface TemplateSemanticSlideProfile {
  sourceSlideIndex: number;
  archetype: TemplateSlideArchetype;
  supportedContentModes: TemplateContentMode[];
  titleElementId: string | null;
  bodyElementIds: string[];
  visualElementIds: string[];
  /** Semantic evidence for template labels, branding, and other text that must survive donor projection. */
  preservedElementIds?: string[];
  /** Semantic evidence for sample copy outside the mapped title/body that is safe to remove. */
  replaceableTextElementIds?: string[];
  confidence: number;
  reasonCodes: string[];
}

export interface TemplateSemanticProfile {
  templateIRHash: string;
  slides: TemplateSemanticSlideProfile[];
}

export type TemplateSemanticProfileValidationFailureCode =
  | 'HASH_MISMATCH'
  | 'INVALID_PROFILE_SHAPE'
  | 'UNEXPECTED_SLIDE_INDEX'
  | 'DUPLICATE_SLIDE_INDEX'
  | 'MISSING_SLIDE_INDEX'
  | 'UNKNOWN_ELEMENT_ID'
  | 'ELEMENT_FROM_DIFFERENT_SLIDE'
  | 'DUPLICATE_ELEMENT_ROLE'
  | 'TITLE_NOT_TEXT'
  | 'BODY_NOT_TEXT'
  | 'INVALID_REPLACEABLE_ELEMENT';

export interface TemplateSemanticProfileCache {
  read(cacheKey: string): Promise<unknown | null>;
  write(profile: TemplateSemanticProfile, cacheKey?: string): Promise<void>;
  invalidate?(cacheKey: string): Promise<void>;
}

export type TemplateSemanticProfilePreparationStatus = 'processing' | 'ready' | 'degraded-ready' | 'failed';

export interface TemplateSemanticProfilePreparationRecord {
  schemaVersion: 1;
  templateIRHash: string;
  profileCacheKey: string;
  status: TemplateSemanticProfilePreparationStatus;
  updatedAt: string;
  failureCode?: string;
  profileOrigin?: 'semantic' | 'deterministic-fallback';
  degradationCode?: string;
  recoveryCount?: number;
  templatePreparationMs?: number;
  templateStructuralMs?: number;
  templateSemanticProfileMs?: number;
}

/** Stores replaceable semantic evidence inside the owning project, keyed by TemplateIR and prompt/config fingerprints. */
export function projectTemplateSemanticProfileCache(projectsRoot: string, projectId: string): TemplateSemanticProfileCache {
  const profilePath = async (hash: string, createParent = false) => {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new TypeError('Template semantic profile hash is invalid.');
    return (await resolvePresentationFilePath(projectsRoot, projectId,
      `.template-compiler/semantic-profiles/${hash}.json`, { createParent })).absolute;
  };
  return {
    async read(hash) {
      let raw: string;
      const target = await profilePath(hash);
      try { raw = await readFile(target, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      try { return JSON.parse(raw) as unknown; }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        // Reads stay side-effect free. A later preparation may replace this file
        // atomically after it has produced a fully validated profile.
        return null;
      }
    },
    async write(profile, cacheKey = profile.templateIRHash) {
      const target = await profilePath(cacheKey, true);
      const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, { flag: 'wx' });
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },
    async invalidate(hash) {
      await rm(await profilePath(hash), { force: true });
    },
  };
}

/** Persist only preparation status metadata, separate from the profile cache itself. */
export function projectTemplateSemanticProfilePreparationStore(projectsRoot: string, projectId: string) {
  const recordPath = async (profileCacheKey: string, createParent = false) => {
    if (!/^[a-f0-9]{64}$/.test(profileCacheKey)) throw new TypeError('Template semantic profile status key is invalid.');
    return (await resolvePresentationFilePath(projectsRoot, projectId,
      `.template-compiler/semantic-profile-status/${profileCacheKey}.json`, { createParent })).absolute;
  };
  return {
    async read(profileCacheKey: string): Promise<TemplateSemanticProfilePreparationRecord | null> {
      let raw: string;
      try { raw = await readFile(await recordPath(profileCacheKey), 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      try {
        const value = JSON.parse(raw) as Partial<TemplateSemanticProfilePreparationRecord>;
        if (value.schemaVersion !== 1 || value.profileCacheKey !== profileCacheKey
            || typeof value.templateIRHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.templateIRHash)
            || !['processing', 'ready', 'degraded-ready', 'failed'].includes(String(value.status))
            || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
            || (value.failureCode !== undefined && (typeof value.failureCode !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(value.failureCode)))
            || (value.profileOrigin !== undefined && !['semantic', 'deterministic-fallback'].includes(value.profileOrigin))
            || (value.degradationCode !== undefined && (typeof value.degradationCode !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(value.degradationCode)))
            || (value.recoveryCount !== undefined && (!Number.isSafeInteger(value.recoveryCount) || value.recoveryCount < 0 || value.recoveryCount > 1))
            || ['templatePreparationMs', 'templateStructuralMs', 'templateSemanticProfileMs'].some((key) => {
              const duration = (value as Record<string, unknown>)[key];
              return duration !== undefined && (!Number.isSafeInteger(duration) || Number(duration) < 0);
            })) return null;
        return value as TemplateSemanticProfilePreparationRecord;
      } catch (error) {
        if (error instanceof SyntaxError) return null;
        throw error;
      }
    },
    async write(record: TemplateSemanticProfilePreparationRecord): Promise<void> {
      const target = await recordPath(record.profileCacheKey, true);
      const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  };
}

const TEMPLATE_PROFILE_WORKFLOW = templateProfilerWorkflow;
const PROFILE_MAX_SLIDES = TEMPLATE_PROFILE_WORKFLOW.maxSlides;
const PROFILE_MAX_ELEMENTS_PER_SLIDE = TEMPLATE_PROFILE_WORKFLOW.maxElementsPerSlide;
const PROFILE_MAX_NON_TEXT_EVIDENCE_ELEMENTS_PER_SLIDE = TEMPLATE_PROFILE_WORKFLOW.maxNonTextEvidenceElementsPerSlide;
const TEMPLATE_PROFILE_VERSION = TEMPLATE_PROFILE_WORKFLOW.promptVersion;
const DEFAULT_PROMPT_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../prompts');
const PROFILE_BATCH_SLIDE_LIMIT = TEMPLATE_PROFILE_WORKFLOW.maxSlidesPerBatch;
const PROFILE_BATCH_EVIDENCE_BYTE_LIMIT = TEMPLATE_PROFILE_WORKFLOW.maxBatchEvidenceBytes;
const PROFILE_BATCH_COUNT_LIMIT = TEMPLATE_PROFILE_WORKFLOW.maxBatches;
const PROFILE_REQUEST_BYTE_LIMIT = TEMPLATE_PROFILE_WORKFLOW.maxEstimatedRequestBytes;
const PROFILE_REQUEST_ENVELOPE_OVERHEAD_BYTES = TEMPLATE_PROFILE_WORKFLOW.requestEnvelopeOverheadBytes;
const PROFILE_OUTPUT_TOKEN_BYTE_RESERVE = TEMPLATE_PROFILE_WORKFLOW.outputTokenByteReserve;
const PROFILE_BATCH_CONCURRENCY_LIMIT = 2;

export function templateSemanticProfileCacheKey(templateIRHash: string, promptSha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(templateIRHash) || !/^[a-f0-9]{64}$/.test(promptSha256)) {
    throw new TypeError('Template semantic profile cache fingerprint is invalid.');
  }
  return createHash('sha256').update(JSON.stringify({
    templateIRHash,
    promptVersion: TEMPLATE_PROFILE_VERSION,
    promptSha256,
    schemaCompatibility: TEMPLATE_PROFILE_WORKFLOW.schemaCompatibility,
    configVersion: TEMPLATE_PROFILE_WORKFLOW.configVersion,
  })).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isStringArray(value: unknown, maximum: number): value is string[] {
  return Array.isArray(value) && value.length <= maximum && value.every((item) => typeof item === 'string' && item.length > 0);
}

function isTemplateSemanticSlideProfile(value: unknown): value is TemplateSemanticSlideProfile {
  if (!isRecord(value)) return false;
  const legacyKeys = ['sourceSlideIndex', 'archetype', 'supportedContentModes', 'titleElementId', 'bodyElementIds', 'visualElementIds', 'confidence', 'reasonCodes'];
  const currentKeys = [...legacyKeys.slice(0, 6), 'preservedElementIds', 'replaceableTextElementIds', ...legacyKeys.slice(6)];
  return (exactKeys(value, legacyKeys) || exactKeys(value, currentKeys))
    && Number.isSafeInteger(value.sourceSlideIndex) && Number(value.sourceSlideIndex) > 0
    && TEMPLATE_SLIDE_ARCHETYPES.includes(value.archetype as TemplateSlideArchetype)
    && Array.isArray(value.supportedContentModes) && value.supportedContentModes.length <= TEMPLATE_CONTENT_MODES.length
    && value.supportedContentModes.every((mode) => TEMPLATE_CONTENT_MODES.includes(mode as TemplateContentMode))
    && (value.titleElementId === null || typeof value.titleElementId === 'string')
    && isStringArray(value.bodyElementIds, PROFILE_MAX_ELEMENTS_PER_SLIDE)
    && isStringArray(value.visualElementIds, PROFILE_MAX_ELEMENTS_PER_SLIDE)
    && (value.preservedElementIds === undefined || isStringArray(value.preservedElementIds, PROFILE_MAX_ELEMENTS_PER_SLIDE))
    && (value.replaceableTextElementIds === undefined || isStringArray(value.replaceableTextElementIds, PROFILE_MAX_ELEMENTS_PER_SLIDE))
    && typeof value.confidence === 'number' && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1
    && isStringArray(value.reasonCodes, 8) && value.reasonCodes.every((code) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(code));
}

export function templateSemanticProfileJsonSchema(
  templateIR: TemplateIR,
  expectedSlides: readonly TemplateIR['slides'][number][],
): SemanticJsonSchema {
  if (expectedSlides.length === 0 || expectedSlides.length > PROFILE_BATCH_SLIDE_LIMIT) {
    throw new TypeError(`Template profile schema requires between 1 and ${PROFILE_BATCH_SLIDE_LIMIT} expected slides.`);
  }
  const definitions: Record<string, unknown> = {};
  const idArray = (ids: readonly string[], definitionName: string) => ({
    type: 'array',
    maxItems: Math.min(PROFILE_MAX_ELEMENTS_PER_SLIDE, ids.length),
    ...(ids.length > 0 ? { items: { $ref: `#/$defs/${definitionName}` } } : {}),
  });
  const slideSchemas = expectedSlides.map((slide) => {
    // Keep the strict output enum limited to the same prioritized set that
    // profileEvidenceSlide supplies; omitted IDs cannot be classified safely.
    const visibleElements = profileElementsForSlide(slide);
    const allIds = visibleElements.map((element) => element.id);
    const textIds = visibleElements.filter((element) => Boolean(element.text?.trim())).map((element) => element.id);
    const replaceableTextIds = visibleElements.filter((element) => element.kind.toLowerCase() === 'shape'
      && Boolean(element.nativeId) && Boolean(element.text?.trim())).map((element) => element.id);
    const definitionsForSlide = {
      all: `slide_${slide.index}_element_id`,
      text: `slide_${slide.index}_text_element_id`,
      replaceable: `slide_${slide.index}_replaceable_text_element_id`,
    };
    if (allIds.length) definitions[definitionsForSlide.all] = { type: 'string', enum: allIds };
    if (textIds.length) definitions[definitionsForSlide.text] = { type: 'string', enum: textIds };
    if (replaceableTextIds.length) definitions[definitionsForSlide.replaceable] = { type: 'string', enum: replaceableTextIds };
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        sourceSlideIndex: { type: 'integer', enum: [slide.index] },
        archetype: { type: 'string', enum: [...TEMPLATE_SLIDE_ARCHETYPES] },
        supportedContentModes: { type: 'array', maxItems: TEMPLATE_CONTENT_MODES.length, items: { type: 'string', enum: [...TEMPLATE_CONTENT_MODES] } },
        titleElementId: textIds.length
          ? { anyOf: [{ type: 'null' }, { $ref: `#/$defs/${definitionsForSlide.text}` }] }
          : { type: 'null' },
        bodyElementIds: idArray(textIds, definitionsForSlide.text),
        visualElementIds: idArray(allIds, definitionsForSlide.all),
        preservedElementIds: idArray(allIds, definitionsForSlide.all),
        replaceableTextElementIds: idArray(replaceableTextIds, definitionsForSlide.replaceable),
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        reasonCodes: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z0-9][a-z0-9._-]*$' } },
      },
      required: ['sourceSlideIndex', 'archetype', 'supportedContentModes', 'titleElementId', 'bodyElementIds', 'visualElementIds', 'preservedElementIds', 'replaceableTextElementIds', 'confidence', 'reasonCodes'],
    };
  });
  return {
    type: 'object',
    additionalProperties: false,
    ...(Object.keys(definitions).length ? { $defs: definitions } : {}),
    properties: {
      templateIRHash: { type: 'string', enum: [templateIR.hash] },
      slides: {
        type: 'array',
        minItems: expectedSlides.length,
        maxItems: expectedSlides.length,
        items: { anyOf: slideSchemas },
      },
    },
    required: ['templateIRHash', 'slides'],
  };
}

/** Returns false for any unknown slide or element reference so adapter validation fails closed. */
export function isValidTemplateSemanticProfile(value: unknown, templateIR: TemplateIR): value is TemplateSemanticProfile {
  if (!isRecord(value) || !exactKeys(value, ['templateIRHash', 'slides']) || value.templateIRHash !== templateIR.hash
      || !Array.isArray(value.slides) || value.slides.length !== templateIR.slides.length || value.slides.length > PROFILE_MAX_SLIDES) return false;
  const sourceSlides = new Map(templateIR.slides.map((slide) => [slide.index, slide]));
  const seenIndexes = new Set<number>();
  for (const candidate of value.slides) {
    if (!isTemplateSemanticSlideProfile(candidate)) return false;
    if (seenIndexes.has(candidate.sourceSlideIndex)) return false;
    seenIndexes.add(candidate.sourceSlideIndex);
    const sourceSlide = sourceSlides.get(candidate.sourceSlideIndex);
    if (!sourceSlide) return false;
    const allElements = new Map(sourceSlide.elements.map((element) => [element.id, element]));
    const selectedIds = [
      ...(candidate.titleElementId ? [candidate.titleElementId] : []),
      ...candidate.bodyElementIds,
      ...candidate.visualElementIds,
      ...(candidate.preservedElementIds ?? []),
      ...(candidate.replaceableTextElementIds ?? []),
    ];
    if (new Set(selectedIds).size !== selectedIds.length || selectedIds.some((id) => !allElements.has(id))) return false;
    if (candidate.titleElementId && !allElements.get(candidate.titleElementId)?.text?.trim()) return false;
    if (candidate.bodyElementIds.some((id) => !allElements.get(id)?.text?.trim())) return false;
    if ((candidate.replaceableTextElementIds ?? []).some((id) => {
      const element = allElements.get(id)!;
      return element.kind.toLowerCase() !== 'shape' || !element.nativeId || !element.text?.trim();
    })) return false;
  }
  return seenIndexes.size === sourceSlides.size;
}

export function validateTemplateSemanticProfile(value: unknown, templateIR: TemplateIR): TemplateSemanticProfile {
  if (!isValidTemplateSemanticProfile(value, templateIR)) throw new TypeError('Template semantic profile contains an invalid slide or element reference.');
  return {
    ...structuredClone(value),
    slides: value.slides.map((slide) => ({
      ...structuredClone(slide),
      preservedElementIds: [...(slide.preservedElementIds ?? [])],
      replaceableTextElementIds: [...(slide.replaceableTextElementIds ?? [])],
  })),
  };
}

/** Build a low-confidence profile from generic, same-slide structural evidence only. */
export function createDeterministicTemplateSemanticProfile(
  templateIRInput: TemplateIR,
  designSystemInput: PresentationDesignSystem,
  degradationReason = 'semantic_unavailable',
): TemplateSemanticProfile {
  const templateIR = validateTemplateIR(templateIRInput);
  validatePresentationDesignSystem(designSystemInput, templateIR);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(degradationReason)) throw new TypeError('Template profile degradation reason is invalid.');

  const canvasArea = Math.max(1, templateIR.slideSize.width * templateIR.slideSize.height);
  const layoutById = new Map(templateIR.layouts.map((layout) => [layout.id, layout]));
  const maxFontSize = (element: TemplateElement): number => Math.max(0,
    ...(element.effectiveFontSizesPt ?? []), ...(element.directStyles.fontSizesPt ?? []));
  const geometry = (element: TemplateElement) => element.geometry.resolved ?? element.geometry.direct;
  const isText = (element: TemplateElement) => Boolean(element.text?.trim());
  const placeholder = (element: TemplateElement) => `${element.placeholder?.type ?? ''} ${element.placeholder?.role ?? ''}`
    .toLowerCase().replace(/[^a-z]/g, '');
  const isTitlePlaceholder = (element: TemplateElement) => /title|ctrtitle/.test(placeholder(element));
  const isBodyPlaceholder = (element: TemplateElement) => /body|obj|content|subtitle/.test(placeholder(element))
    && !isTitlePlaceholder(element);
  const isFurniture = (element: TemplateElement) => /date|footer|header|slidenumber|slidenum|sldnum/.test(placeholder(element));
  const area = (element: TemplateElement) => {
    const box = geometry(element);
    return box ? Math.max(0, box.width) * Math.max(0, box.height) : 0;
  };
  const isLargeTextRegion = (element: TemplateElement) => {
    const box = geometry(element);
    return Boolean(box && box.width >= templateIR.slideSize.width * 0.2
      && box.height >= templateIR.slideSize.height * 0.025 && area(element) / canvasArea >= 0.008);
  };
  const compareTextRegions = (left: TemplateElement, right: TemplateElement) =>
    maxFontSize(right) - maxFontSize(left)
      || area(right) - area(left)
      || (geometry(left)?.y ?? Number.MAX_SAFE_INTEGER) - (geometry(right)?.y ?? Number.MAX_SAFE_INTEGER)
      || left.order - right.order;
  const isMedia = (element: TemplateElement) => /picture|image|chart|table|graphicframe|media/i.test(element.kind);

  const slides = templateIR.slides.map((slide) => {
    const textElements = slide.elements.filter(isText).slice(0, PROFILE_MAX_ELEMENTS_PER_SLIDE);
    const selectedIds = new Set<string>();
    const explicitTitles = textElements.filter(isTitlePlaceholder).sort(compareTextRegions);
    let title: TemplateElement | undefined = explicitTitles[0];
    if (!title) {
      const plausibleTitles = textElements.filter((element) => {
        const box = geometry(element);
        return !isFurniture(element) && isLargeTextRegion(element) && box !== null
          && box.y <= templateIR.slideSize.height * 0.45;
      }).sort(compareTextRegions);
      const candidate = plausibleTitles[0];
      const otherSizes = textElements.filter((element) => element !== candidate).map(maxFontSize).filter((size) => size > 0);
      const candidateSize = candidate ? maxFontSize(candidate) : 0;
      if (candidate && (otherSizes.length === 0 || candidateSize > Math.max(...otherSizes))) title = candidate;
    }
    if (title) selectedIds.add(title.id);

    const explicitBody = textElements.filter((element) => isBodyPlaceholder(element) && !isFurniture(element))
      .sort((left, right) => area(right) - area(left) || left.order - right.order);
    const geometricBody = textElements.filter((element) => {
      const box = geometry(element);
      if (selectedIds.has(element.id) || isFurniture(element) || !isLargeTextRegion(element) || !box) return false;
      return maxFontSize(element) === 0 || !title || maxFontSize(element) <= maxFontSize(title);
    }).sort((left, right) => area(right) - area(left) || left.order - right.order);
    const bodyCandidates = explicitBody.length > 0 ? explicitBody : geometricBody;
    const body: string[] = [];
    for (const element of bodyCandidates) {
      if (selectedIds.has(element.id) || body.length >= 4) continue;
      selectedIds.add(element.id);
      body.push(element.id);
    }

    const visual: string[] = [];
    for (const element of slide.elements) {
      if (element.text?.trim() || !isMedia(element) || selectedIds.has(element.id)) continue;
      if (visual.length >= PROFILE_MAX_ELEMENTS_PER_SLIDE) break;
      selectedIds.add(element.id);
      visual.push(element.id);
    }
    const preserved = textElements.filter((element) => !selectedIds.has(element.id)).map((element) => element.id);
    const layoutType = (slide.layoutId ? layoutById.get(slide.layoutId)?.declaredType : null)?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
    const archetype = /^title$/.test(layoutType) ? 'cover'
      : /sectionheader|sectiondivider|section/.test(layoutType) ? 'section-divider' : 'content';
    const kinds = slide.elements.filter((element) => visual.includes(element.id)).map((element) => element.kind.toLowerCase());
    const supportedContentModes: TemplateContentMode[] = ['text'];
    if (kinds.some((kind) => /picture|image/.test(kind))) supportedContentModes.push('image');
    if (kinds.some((kind) => /chart/.test(kind))) supportedContentModes.push('chart', 'metrics');
    if (kinds.some((kind) => /table/.test(kind))) supportedContentModes.push('table');
    if (visual.length > 0 && (body.length > 0 || title)) supportedContentModes.push('mixed');
    return {
      sourceSlideIndex: slide.index,
      archetype: archetype as TemplateSlideArchetype,
      supportedContentModes: [...new Set(supportedContentModes)],
      titleElementId: title?.id ?? null,
      bodyElementIds: body,
      visualElementIds: visual,
      preservedElementIds: preserved,
      replaceableTextElementIds: [],
      confidence: 0.1,
      reasonCodes: ['deterministic_fallback', degradationReason],
    } satisfies TemplateSemanticSlideProfile;
  });
  return validateTemplateSemanticProfile({ templateIRHash: templateIR.hash, slides }, templateIR);
}

/** Prioritize readable text, then the largest/media-like non-text objects inside the bounded profile evidence. */
function profileElementsForSlide(slide: TemplateIR['slides'][number]): TemplateIR['slides'][number]['elements'] {
  const area = (element: TemplateIR['slides'][number]['elements'][number]) => {
    const geometry = element.geometry.resolved ?? element.geometry.direct;
    return geometry ? Math.max(0, geometry.width) * Math.max(0, geometry.height) : 0;
  };
  const textBearing = slide.elements.filter((element) => Boolean(element.text?.trim()) || element.placeholder !== null)
    .sort((left, right) => area(right) - area(left) || left.order - right.order);
  const nonText = slide.elements.filter((element) => !element.text?.trim() && element.placeholder === null)
    .sort((left, right) => {
      const mediaRank = (element: TemplateIR['slides'][number]['elements'][number]) =>
        /picture|image|chart|table|graphicframe|group/i.test(element.kind) ? 1 : 0;
      return mediaRank(right) - mediaRank(left) || area(right) - area(left) || left.order - right.order;
    }).slice(0, PROFILE_MAX_NON_TEXT_EVIDENCE_ELEMENTS_PER_SLIDE);
  return [...textBearing, ...nonText].slice(0, PROFILE_MAX_ELEMENTS_PER_SLIDE)
    .sort((left, right) => left.order - right.order);
}

function profileEvidenceSlide(
  slide: TemplateIR['slides'][number],
  textLimit = 320,
  compactFallback = false,
): Record<string, unknown> {
  const visibleElements = profileElementsForSlide(slide);
  return {
    sourceSlideIndex: slide.index,
    elements: visibleElements.map((element) => {
      const rawText = typeof element.text === 'string' ? element.text.trim() : '';
      const text = rawText && textLimit > 0 ? rawText.slice(0, textLimit) : null;
      const textBearing = text !== null || element.placeholder !== null;
      const geometry = element.geometry.resolved ?? element.geometry.direct;
      const evidence: Record<string, unknown> = {
        id: element.id,
        ...(!compactFallback ? { order: element.order } : {}),
        kind: element.kind,
        ...(text === null ? {} : { text }),
        ...(element.placeholder?.role ? { placeholderRole: element.placeholder.role } : {}),
        ...(element.parentId === null ? {} : { parentId: element.parentId }),
        ...(geometry === null ? {} : compactFallback
          ? { box: [geometry.x, geometry.y, geometry.width, geometry.height] }
          : { geometry: { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height } }),
        ...(!compactFallback && element.placeholder?.type ? { placeholderType: element.placeholder.type } : {}),
      };
      if (textBearing && !compactFallback) {
        const styles = {
          ...(element.directStyles.fontSizesPt?.length
            ? { fontSizesPt: [...new Set(element.directStyles.fontSizesPt)].slice(0, 4) }
            : {}),
          ...(element.directStyles.bold === null ? {} : { bold: element.directStyles.bold }),
        };
        if (Object.keys(styles).length) evidence.styles = styles;
      }
      return evidence;
    }),
    ...(slide.elements.length > visibleElements.length ? { evidenceTruncated: true } : {}),
    ...(slide.elements.some((element) => typeof element.text === 'string' && element.text.trim().length > textLimit)
      || slide.elements.some((element) => (Boolean(element.text?.trim()) || element.placeholder !== null) && !visibleElements.includes(element))
      ? { textEvidenceTruncated: true } : {}),
  };
}

function profileEvidence(
  templateIR: TemplateIR,
  slides: readonly TemplateIR['slides'][number][],
  textLimit = 320,
  compactFallback = false,
): Record<string, unknown> {
  if (templateIR.slides.length > PROFILE_MAX_SLIDES) throw new TypeError(`Template semantic profiling is limited to ${PROFILE_MAX_SLIDES} slides.`);
  return profileEvidenceEnvelope(templateIR, slides.map((slide) => profileEvidenceSlide(slide, textLimit, compactFallback)));
}

function profileEvidenceEnvelope(templateIR: TemplateIR, slides: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    templateIRHash: templateIR.hash,
    canvas: { width: templateIR.slideSize.width, height: templateIR.slideSize.height },
    slides,
  };
}

function boundedBatchEvidence(
  templateIR: TemplateIR,
  slides: readonly TemplateIR['slides'][number][],
  systemPrompt: string,
): {
  evidence: Record<string, unknown>;
  evidenceJson: string;
  evidenceBytes: number;
  schema: SemanticJsonSchema;
  schemaBytes: number;
  systemPromptBytes: number;
  envelopeOverheadBytes: number;
  outputTokenReserveBytes: number;
  estimatedTotalRequestBytes: number;
  maxOutputTokens: number;
} | null {
  const schema = templateSemanticProfileJsonSchema(templateIR, slides);
  const schemaBytes = Buffer.byteLength(JSON.stringify(schema), 'utf8');
  const systemPromptBytes = Buffer.byteLength(systemPrompt, 'utf8');
  const maxOutputTokens = Math.min(TEMPLATE_PROFILE_WORKFLOW.maxOutputTokens, Math.max(
    TEMPLATE_PROFILE_WORKFLOW.minOutputTokens,
    slides.length * TEMPLATE_PROFILE_WORKFLOW.outputTokensPerSlide,
  ));
  const outputTokenReserveBytes = maxOutputTokens * PROFILE_OUTPUT_TOKEN_BYTE_RESERVE;
  for (const textLimit of [320, 160, 80, 32, 0]) {
    for (const compactFallback of [false, true]) {
      const slideEvidence = slides.map((slide) => profileEvidenceSlide(slide, textLimit, compactFallback));
      const evidence = profileEvidenceEnvelope(templateIR, slideEvidence);
      const evidenceJson = JSON.stringify(evidence);
      const evidenceBytes = Buffer.byteLength(evidenceJson, 'utf8');
      const estimatedTotalRequestBytes = systemPromptBytes + evidenceBytes + schemaBytes
        + PROFILE_REQUEST_ENVELOPE_OVERHEAD_BYTES + outputTokenReserveBytes;
      if (evidenceBytes <= PROFILE_BATCH_EVIDENCE_BYTE_LIMIT
          && estimatedTotalRequestBytes <= PROFILE_REQUEST_BYTE_LIMIT) {
        return {
          evidence,
          evidenceJson,
          evidenceBytes,
          schema,
          schemaBytes,
          systemPromptBytes,
          envelopeOverheadBytes: PROFILE_REQUEST_ENVELOPE_OVERHEAD_BYTES,
          outputTokenReserveBytes,
          estimatedTotalRequestBytes,
          maxOutputTokens,
        };
      }
    }
  }
  return null;
}

export interface TemplateSemanticProfileBatchPlan {
  batchNumber: number;
  totalBatches: number;
  sourceSlideIndexes: number[];
  evidence: string;
  evidenceBytes: number;
  schema: SemanticJsonSchema;
  schemaBytes: number;
  systemPromptBytes: number;
  envelopeOverheadBytes: number;
  outputTokenReserveBytes: number;
  estimatedTotalRequestBytes: number;
  maxOutputTokens: number;
}

/** Plans deterministic profiler requests bounded by slide count, evidence, full request estimate, and output reserve. */
export function planTemplateSemanticProfileBatches(templateIRInput: TemplateIR, systemPrompt: string): {
  totalEvidenceBytes: number;
  systemPromptBytes: number;
  batches: TemplateSemanticProfileBatchPlan[];
} {
  const templateIR = validateTemplateIR(templateIRInput);
  if (templateIR.slides.length > PROFILE_MAX_SLIDES) throw new TypeError(`Template semantic profiling is limited to ${PROFILE_MAX_SLIDES} slides.`);
  if (typeof systemPrompt !== 'string' || Buffer.byteLength(systemPrompt, 'utf8') > TEMPLATE_PROFILE_WORKFLOW.maxPromptBytes) {
    throw new TypeError(`Template profiler system prompt must be a string within ${TEMPLATE_PROFILE_WORKFLOW.maxPromptBytes} bytes.`);
  }
  const systemPromptBytes = Buffer.byteLength(systemPrompt, 'utf8');
  const totalEvidenceBytes = Buffer.byteLength(JSON.stringify(profileEvidence(templateIR, templateIR.slides)), 'utf8');
  type PlannedBatch = {
    slides: TemplateIR['slides'][number][];
    evidence: Record<string, unknown>;
    evidenceJson: string;
    evidenceBytes: number;
    schema: SemanticJsonSchema;
    schemaBytes: number;
    systemPromptBytes: number;
    envelopeOverheadBytes: number;
    outputTokenReserveBytes: number;
    estimatedTotalRequestBytes: number;
    maxOutputTokens: number;
  };
  type Partition = { batches: PlannedBatch[]; totalEstimatedBytes: number };
  const candidateCache = new Map<string, PlannedBatch | null>();
  const candidateForRange = (start: number, end: number): PlannedBatch | null => {
    const key = `${start}:${end}`;
    if (candidateCache.has(key)) return candidateCache.get(key)!;
    const slides = templateIR.slides.slice(start, end + 1);
    const measured = slides.length <= PROFILE_BATCH_SLIDE_LIMIT
      ? boundedBatchEvidence(templateIR, slides, systemPrompt)
      : null;
    const candidate = measured ? { slides, ...measured } : null;
    candidateCache.set(key, candidate);
    return candidate;
  };
  const betterPartition = (candidate: Partition, current: Partition | null): boolean => {
    if (!current || candidate.batches.length !== current.batches.length) return !current || candidate.batches.length < current.batches.length;
    if (candidate.totalEstimatedBytes !== current.totalEstimatedBytes) return candidate.totalEstimatedBytes < current.totalEstimatedBytes;
    // Stable tie-break: consume the longest valid source-order batch first.
    for (let index = 0; index < candidate.batches.length; index += 1) {
      const candidateLength = candidate.batches[index]!.slides.length;
      const currentLength = current.batches[index]!.slides.length;
      if (candidateLength !== currentLength) return candidateLength > currentLength;
    }
    return false;
  };
  const bestFrom = new Array<Partition | null>(templateIR.slides.length + 1).fill(null);
  bestFrom[templateIR.slides.length] = { batches: [], totalEstimatedBytes: 0 };
  for (let start = templateIR.slides.length - 1; start >= 0; start -= 1) {
    let best: Partition | null = null;
    const maximumEnd = Math.min(templateIR.slides.length - 1, start + PROFILE_BATCH_SLIDE_LIMIT - 1);
    for (let end = start; end <= maximumEnd; end += 1) {
      const candidate = candidateForRange(start, end);
      const suffix = bestFrom[end + 1];
      if (!candidate || !suffix) continue;
      const option: Partition = {
        batches: [candidate, ...suffix.batches],
        totalEstimatedBytes: candidate.estimatedTotalRequestBytes + suffix.totalEstimatedBytes,
      };
      if (betterPartition(option, best)) best = option;
    }
    bestFrom[start] = best;
  }
  const batches = bestFrom[0]?.batches ?? [];
  if (!batches.length && templateIR.slides.length > 0) {
    const oversized = templateIR.slides.find((slide) => !boundedBatchEvidence(templateIR, [slide], systemPrompt));
    if (oversized) throw new InferenceError('REQUEST_TOO_LARGE', `Template profiler request for source slide ${oversized.index} exceeds the safe evidence or estimated request byte limit.`);
    throw new InferenceError('REQUEST_TOO_LARGE', 'Template profiler batches could not be partitioned within the safe request limits.');
  }
  if (batches.length > PROFILE_BATCH_COUNT_LIMIT) {
    throw new InferenceError('REQUEST_TOO_LARGE', `Template requires ${batches.length} profiler batches; the configured safe maximum is ${PROFILE_BATCH_COUNT_LIMIT}.`);
  }
  const totalBatches = batches.length;
  return {
    totalEvidenceBytes,
    systemPromptBytes,
    batches: batches.map((batch, index) => {
      const sourceSlideIndexes = batch.slides.map((slide) => slide.index);
      return {
        batchNumber: index + 1,
        totalBatches,
        sourceSlideIndexes,
        evidence: batch.evidenceJson,
        evidenceBytes: batch.evidenceBytes,
        schema: batch.schema,
        schemaBytes: batch.schemaBytes,
        systemPromptBytes: batch.systemPromptBytes,
        envelopeOverheadBytes: batch.envelopeOverheadBytes,
        outputTokenReserveBytes: batch.outputTokenReserveBytes,
        estimatedTotalRequestBytes: batch.estimatedTotalRequestBytes,
        maxOutputTokens: batch.maxOutputTokens,
      };
    }),
  };
}

export function diagnoseTemplateSemanticProfileBatch(
  value: unknown,
  templateIR: TemplateIR,
  expectedSlides: readonly TemplateIR['slides'][number][],
): TemplateSemanticProfileValidationFailureCode | null {
  if (!isRecord(value) || !exactKeys(value, ['templateIRHash', 'slides'])
      || typeof value.templateIRHash !== 'string' || !Array.isArray(value.slides)) return 'INVALID_PROFILE_SHAPE';
  if (value.templateIRHash !== templateIR.hash) return 'HASH_MISMATCH';
  if (value.slides.length < expectedSlides.length) return 'MISSING_SLIDE_INDEX';
  if (value.slides.length > expectedSlides.length) return 'INVALID_PROFILE_SHAPE';
  const expectedByIndex = new Map(expectedSlides.map((slide) => [slide.index, slide]));
  const allTemplateElementIds = new Set(templateIR.slides.flatMap((slide) => slide.elements.map((element) => element.id)));
  const seen = new Set<number>();
  for (const candidate of value.slides) {
    if (!isTemplateSemanticSlideProfile(candidate)) return 'INVALID_PROFILE_SHAPE';
    if (seen.has(candidate.sourceSlideIndex)) return 'DUPLICATE_SLIDE_INDEX';
    const sourceSlide = expectedByIndex.get(candidate.sourceSlideIndex);
    if (!sourceSlide) return 'UNEXPECTED_SLIDE_INDEX';
    seen.add(candidate.sourceSlideIndex);
    const allElements = new Map(sourceSlide.elements.map((element) => [element.id, element]));
    const selectedIds = [
      ...(candidate.titleElementId ? [candidate.titleElementId] : []),
      ...candidate.bodyElementIds,
      ...candidate.visualElementIds,
      ...(candidate.preservedElementIds ?? []),
      ...(candidate.replaceableTextElementIds ?? []),
    ];
    if (new Set(selectedIds).size !== selectedIds.length) return 'DUPLICATE_ELEMENT_ROLE';
    for (const id of selectedIds) {
      if (!allElements.has(id)) return allTemplateElementIds.has(id) ? 'ELEMENT_FROM_DIFFERENT_SLIDE' : 'UNKNOWN_ELEMENT_ID';
    }
    if (candidate.titleElementId && !allElements.get(candidate.titleElementId)?.text?.trim()) return 'TITLE_NOT_TEXT';
    if (candidate.bodyElementIds.some((id) => !allElements.get(id)?.text?.trim())) return 'BODY_NOT_TEXT';
    if ((candidate.replaceableTextElementIds ?? []).some((id) => {
      const element = allElements.get(id)!;
      return element.kind.toLowerCase() !== 'shape' || !element.nativeId || !element.text?.trim();
    })) return 'INVALID_REPLACEABLE_ELEMENT';
  }
  return seen.size === expectedSlides.length ? null : 'MISSING_SLIDE_INDEX';
}

function isValidTemplateSemanticProfileBatch(
  value: unknown,
  templateIR: TemplateIR,
  expectedSlides: readonly TemplateIR['slides'][number][],
): value is TemplateSemanticProfile {
  return diagnoseTemplateSemanticProfileBatch(value, templateIR, expectedSlides) === null;
}

/** Remove repeated assignments, preserving first occurrence and the highest-precedence role. */
function normalizeDuplicateElementRoles(value: unknown): number {
  if (!isRecord(value) || !Array.isArray(value.slides)) return 0;
  let resolvedConflictCount = 0;
  for (const candidate of value.slides) {
    if (!isRecord(candidate)) continue;
    const seenRoles = new Map<string, string>();
    const resolvedIds = new Set<string>();
    const titleId = candidate.titleElementId;
    if (typeof titleId === 'string') seenRoles.set(titleId, 'titleElementId');
    const arrayRoles = [
      'bodyElementIds',
      'visualElementIds',
      'preservedElementIds',
      'replaceableTextElementIds',
    ] as const;
    for (const role of arrayRoles) {
      const ids = candidate[role];
      if (!Array.isArray(ids)) continue;
      const retained: unknown[] = [];
      for (const id of ids) {
        if (typeof id !== 'string') {
          retained.push(id);
          continue;
        }
        const priorRole = seenRoles.get(id);
        if (priorRole !== undefined) {
          resolvedIds.add(id);
          continue;
        }
        seenRoles.set(id, role);
        retained.push(id);
      }
      candidate[role] = retained;
    }
    resolvedConflictCount += resolvedIds.size;
  }
  return resolvedConflictCount;
}

function requestFor(
  templateIR: TemplateIR,
  systemPrompt: string,
  batch: TemplateSemanticProfileBatchPlan,
  batchSlides: readonly TemplateIR['slides'][number][],
): SemanticInferenceRequest<TemplateSemanticProfile> {
  const batchMetadata = {
    batchNumber: batch.batchNumber,
    totalBatches: batch.totalBatches,
    sourceSlideIndexes: [...batch.sourceSlideIndexes],
    systemPromptBytes: batch.systemPromptBytes,
    evidenceBytes: batch.evidenceBytes,
    schemaBytes: batch.schemaBytes,
    envelopeOverheadBytes: batch.envelopeOverheadBytes,
    outputTokenReserveBytes: batch.outputTokenReserveBytes,
    estimatedTotalRequestBytes: batch.estimatedTotalRequestBytes,
    roleConflictResolved: false,
    resolvedConflictCount: 0,
  };
  const contract: SemanticOutputContract<TemplateSemanticProfile> = {
    name: TEMPLATE_PROFILE_WORKFLOW.schemaCompatibility,
    schema: batch.schema,
    validate: (value): value is TemplateSemanticProfile => {
      if (diagnoseTemplateSemanticProfileBatch(value, templateIR, batchSlides) === 'DUPLICATE_ELEMENT_ROLE') {
        const resolvedConflictCount = normalizeDuplicateElementRoles(value);
        batchMetadata.resolvedConflictCount = resolvedConflictCount;
        batchMetadata.roleConflictResolved = resolvedConflictCount > 0;
      }
      return isValidTemplateSemanticProfileBatch(value, templateIR, batchSlides);
    },
    diagnoseValidationFailure: (value) => diagnoseTemplateSemanticProfileBatch(value, templateIR, batchSlides) ?? undefined,
  };
  return {
    role: 'worker',
    operation: 'template-semantic-profile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: batch.evidence },
    ],
    output: contract,
    maxOutputTokens: batch.maxOutputTokens,
    temperature: TEMPLATE_PROFILE_WORKFLOW.temperature,
    timeoutMs: TEMPLATE_PROFILE_WORKFLOW.timeoutMs,
    metadata: { templateProfilerBatch: batchMetadata },
  };
}

function measuredProfileBatchForSlides(
  templateIR: TemplateIR,
  systemPrompt: string,
  slides: readonly TemplateIR['slides'][number][],
  parent: TemplateSemanticProfileBatchPlan,
): TemplateSemanticProfileBatchPlan {
  const measured = boundedBatchEvidence(templateIR, [...slides], systemPrompt);
  if (!measured) throw new InferenceError('REQUEST_TOO_LARGE', 'A recovered template profiler request exceeded its safe evidence or request-size limit.');
  return {
    batchNumber: parent.batchNumber,
    totalBatches: parent.totalBatches,
    sourceSlideIndexes: slides.map((slide) => slide.index),
    evidence: measured.evidenceJson,
    evidenceBytes: measured.evidenceBytes,
    schema: measured.schema,
    schemaBytes: measured.schemaBytes,
    systemPromptBytes: measured.systemPromptBytes,
    envelopeOverheadBytes: measured.envelopeOverheadBytes,
    outputTokenReserveBytes: measured.outputTokenReserveBytes,
    estimatedTotalRequestBytes: measured.estimatedTotalRequestBytes,
    maxOutputTokens: measured.maxOutputTokens,
  };
}

function profileBatchWithOutputBudget(
  batch: TemplateSemanticProfileBatchPlan,
  maxOutputTokens: number,
): TemplateSemanticProfileBatchPlan | null {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= batch.maxOutputTokens
      || maxOutputTokens > TEMPLATE_PROFILE_WORKFLOW.maxOutputTokens) return null;
  const outputTokenReserveBytes = maxOutputTokens * PROFILE_OUTPUT_TOKEN_BYTE_RESERVE;
  const estimatedTotalRequestBytes = batch.systemPromptBytes + batch.evidenceBytes + batch.schemaBytes
    + batch.envelopeOverheadBytes + outputTokenReserveBytes;
  if (estimatedTotalRequestBytes > PROFILE_REQUEST_BYTE_LIMIT) return null;
  return { ...batch, maxOutputTokens, outputTokenReserveBytes, estimatedTotalRequestBytes };
}

function isLengthTruncation(error: unknown): error is InferenceError {
  return error instanceof InferenceError && error.code === 'INVALID_STRUCTURED_OUTPUT'
    && error.telemetry?.finishReason === 'length';
}

function isRecoverablePairFailure(error: unknown): error is InferenceError {
  return isLengthTruncation(error) || error instanceof InferenceError && error.code === 'SERVICE_UNAVAILABLE';
}

/**
 * Replaceable semantic evidence adapter for templates. Cached per TemplateIR hash;
 * deterministic selector and safety checks remain responsible for final choices.
 */
export class TemplateSemanticProfiler {
  private readonly cache = new Map<string, TemplateSemanticProfile>();
  private readonly inFlight = new Map<string, Promise<TemplateSemanticProfile>>();
  private promptAsset?: Promise<{ content: string; sha256: string }>;

  constructor(
    private readonly inference: SemanticInferenceAdapter,
    private readonly persistentCache?: TemplateSemanticProfileCache,
    private readonly options: { promptDirectory?: string; concurrency?: number } = {},
  ) {
    if (options.concurrency !== undefined && (!Number.isSafeInteger(options.concurrency)
        || options.concurrency < 1 || options.concurrency > PROFILE_BATCH_CONCURRENCY_LIMIT)) {
      throw new TypeError(`Template profiler concurrency must be an integer between 1 and ${PROFILE_BATCH_CONCURRENCY_LIMIT}.`);
    }
  }

  private loadPromptAsset(): Promise<{ content: string; sha256: string }> {
    if (!this.promptAsset) {
      this.promptAsset = (async () => {
        const promptFile = TEMPLATE_PROFILE_WORKFLOW.promptFile;
        if (!/^[a-z0-9][a-z0-9._-]*\.md$/.test(promptFile)) throw new TypeError('Template profiler prompt asset name is invalid.');
        const raw = await readFile(path.join(this.options.promptDirectory ?? DEFAULT_PROMPT_DIRECTORY, promptFile), 'utf8');
        const content = raw.replace(/\s+/g, ' ').trim();
        if (!content || Buffer.byteLength(content, 'utf8') > TEMPLATE_PROFILE_WORKFLOW.maxPromptBytes) {
          throw new TypeError('Template profiler prompt asset is empty or too large.');
        }
        return { content, sha256: createHash('sha256').update(content, 'utf8').digest('hex') };
      })();
    }
    return this.promptAsset;
  }

  private async fingerprint(templateIRInput: TemplateIR, designSystemInput: PresentationDesignSystem) {
    const templateIR = validateTemplateIR(templateIRInput);
    validatePresentationDesignSystem(designSystemInput, templateIR);
    const prompt = await this.loadPromptAsset();
    const cacheKey = templateSemanticProfileCacheKey(templateIR.hash, prompt.sha256);
    return { templateIR, prompt, cacheKey };
  }

  async profileCacheKey(templateIRInput: TemplateIR): Promise<string> {
    const templateIR = validateTemplateIR(templateIRInput);
    const prompt = await this.loadPromptAsset();
    return templateSemanticProfileCacheKey(templateIR.hash, prompt.sha256);
  }

  private async readPrepared(
    templateIR: TemplateIR,
    cacheKey: string,
    invalidateInvalid: boolean,
  ): Promise<TemplateSemanticProfile | null> {
    const cached = this.cache.get(cacheKey);
    if (cached) return structuredClone(cached);
    const persisted = await this.persistentCache?.read(cacheKey);
    if (persisted === null || persisted === undefined) return null;
    try {
      const profile = validateTemplateSemanticProfile(persisted, templateIR);
      this.cache.set(cacheKey, profile);
      return structuredClone(profile);
    } catch {
      if (invalidateInvalid) await this.persistentCache?.invalidate?.(cacheKey);
      return null;
    }
  }

  /** Read and validate only. It never calls inference or mutates the persistent profile cache. */
  async getPreparedTemplateProfile(
    templateIRInput: TemplateIR,
    designSystemInput: PresentationDesignSystem,
  ): Promise<TemplateSemanticProfile | null> {
    const { templateIR, cacheKey } = await this.fingerprint(templateIRInput, designSystemInput);
    return this.readPrepared(templateIR, cacheKey, false);
  }

  /** Prepare once, validating a complete profile before the atomic persistent cache write. */
  async prepareTemplateProfile(
    templateIRInput: TemplateIR,
    designSystemInput: PresentationDesignSystem,
    signal?: AbortSignal,
  ): Promise<TemplateSemanticProfile> {
    const { templateIR, prompt, cacheKey } = await this.fingerprint(templateIRInput, designSystemInput);
    const cached = this.cache.get(cacheKey);
    if (cached) return structuredClone(cached);
    const pending = this.inFlight.get(cacheKey);
    if (pending) return structuredClone(await pending);

    const task = (async () => {
      const persisted = await this.persistentCache?.read(cacheKey);
      if (persisted !== null && persisted !== undefined) {
        try {
          const profile = validateTemplateSemanticProfile(persisted, templateIR);
          this.cache.set(cacheKey, profile);
          return profile;
        } catch {
          await this.persistentCache?.invalidate?.(cacheKey);
        }
      }
      const plan = planTemplateSemanticProfileBatches(templateIR, prompt.content);
      const batchResults = new Map<number, TemplateSemanticSlideProfile>();
      const controller = new AbortController();
      const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const concurrency = Math.min(this.options.concurrency ?? 1, plan.batches.length);
      let nextBatch = 0;
      let firstFailure: unknown;
      let pendingInitialBatches = plan.batches.length;
      let providerCalls = 0;
      let reservedRecoveryCalls = 0;
      const reserveRecoveryCalls = (count: number): boolean => {
        if (providerCalls + reservedRecoveryCalls + pendingInitialBatches + count > PROFILE_BATCH_COUNT_LIMIT) return false;
        reservedRecoveryCalls += count;
        return true;
      };
      const dispatch = async (
        batch: TemplateSemanticProfileBatchPlan,
        slides: readonly TemplateIR['slides'][number][],
        credit: 'initial' | 'reserved',
      ) => {
        if (credit === 'initial') pendingInitialBatches = Math.max(0, pendingInitialBatches - 1);
        else {
          if (reservedRecoveryCalls < 1) throw new InferenceError('REQUEST_TOO_LARGE', 'Template profiler recovery exceeded its request budget.');
          reservedRecoveryCalls -= 1;
        }
        providerCalls += 1;
        return this.inference.infer({ ...requestFor(templateIR, prompt.content, batch, slides), signal: requestSignal });
      };
      const inferSingleSlide = async (
        batch: TemplateSemanticProfileBatchPlan,
        slide: TemplateIR['slides'][number],
        credit: 'initial' | 'reserved',
      ) => {
        try {
          return await dispatch(batch, [slide], credit);
        } catch (error) {
          if (!isLengthTruncation(error) || requestSignal.aborted) throw error;
          const larger = profileBatchWithOutputBudget(batch, TEMPLATE_PROFILE_WORKFLOW.maxOutputTokens);
          if (!larger || !reserveRecoveryCalls(1)) throw error;
          return dispatch(larger, [slide], 'reserved');
        }
      };
      const inferBatchWithRecovery = async (
        batch: TemplateSemanticProfileBatchPlan,
        batchSlides: readonly TemplateIR['slides'][number][],
      ) => {
        if (batchSlides.length === 1) {
          const response = await inferSingleSlide(batch, batchSlides[0]!, 'initial');
          return response.value.slides;
        }
        try {
          const response = await dispatch(batch, batchSlides, 'initial');
          return response.value.slides;
        } catch (error) {
          if (!isRecoverablePairFailure(error) || requestSignal.aborted) throw error;
          if (!reserveRecoveryCalls(batchSlides.length)) throw error;
          const recovered: TemplateSemanticSlideProfile[] = [];
          for (const slide of batchSlides) {
            const singleBatch = measuredProfileBatchForSlides(templateIR, prompt.content, [slide], batch);
            const response = await inferSingleSlide(singleBatch, slide, 'reserved');
            recovered.push(...response.value.slides);
          }
          return recovered;
        }
      };
      const workers = Array.from({ length: concurrency }, async () => {
        while (!firstFailure) {
          if (signal?.aborted) {
            firstFailure ??= new InferenceError('CANCELLED', 'Template profiler was cancelled before the next batch.');
            controller.abort(firstFailure);
            return;
          }
          const batchIndex = nextBatch++;
          if (batchIndex >= plan.batches.length) return;
          const batch = plan.batches[batchIndex]!;
          const batchIndexes = new Set(batch.sourceSlideIndexes);
          const batchSlides = templateIR.slides.filter((slide) => batchIndexes.has(slide.index));
          try {
            const slides = await inferBatchWithRecovery(batch, batchSlides);
            for (const slide of slides) batchResults.set(slide.sourceSlideIndex, slide);
          } catch (error) {
            if (!firstFailure) firstFailure = error;
            controller.abort(firstFailure);
            return;
          }
        }
      });
      await Promise.all(workers);
      if (firstFailure) throw firstFailure;
      const mergedSlides: TemplateSemanticSlideProfile[] = [...batchResults.values()];
      const expectedIndexOrder = new Map(templateIR.slides.map((slide, index) => [slide.index, index]));
      mergedSlides.sort((left, right) => (expectedIndexOrder.get(left.sourceSlideIndex) ?? Number.MAX_SAFE_INTEGER)
        - (expectedIndexOrder.get(right.sourceSlideIndex) ?? Number.MAX_SAFE_INTEGER));
      const profile = validateTemplateSemanticProfile({ templateIRHash: templateIR.hash, slides: mergedSlides }, templateIR);
      await this.persistentCache?.write(profile, cacheKey);
      this.cache.set(cacheKey, profile);
      return profile;
    })();
    this.inFlight.set(cacheKey, task);
    try { return structuredClone(await task); }
    finally { if (this.inFlight.get(cacheKey) === task) this.inFlight.delete(cacheKey); }
  }

  /** Kept as an internal compatibility alias for existing callers; new callers choose a phase explicitly. */
  async profile(templateIR: TemplateIR, designSystem: PresentationDesignSystem, signal?: AbortSignal): Promise<TemplateSemanticProfile> {
    return this.prepareTemplateProfile(templateIR, designSystem, signal);
  }

  clear(): void {
    this.cache.clear();
  }
}
