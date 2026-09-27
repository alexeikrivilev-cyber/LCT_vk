import {
  validatePresentationDesignSystem,
  validateTemplateIR,
  type PresentationDesignSystem,
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

export interface TemplateSemanticProfileCache {
  read(cacheKey: string): Promise<unknown | null>;
  write(profile: TemplateSemanticProfile, cacheKey?: string): Promise<void>;
  invalidate?(cacheKey: string): Promise<void>;
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
        await rm(target, { force: true });
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

const TEMPLATE_PROFILE_WORKFLOW = templateProfilerWorkflow;
const PROFILE_MAX_SLIDES = TEMPLATE_PROFILE_WORKFLOW.maxSlides;
const PROFILE_MAX_ELEMENTS_PER_SLIDE = TEMPLATE_PROFILE_WORKFLOW.maxElementsPerSlide;
const TEMPLATE_PROFILE_VERSION = TEMPLATE_PROFILE_WORKFLOW.promptVersion;
const DEFAULT_PROMPT_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../prompts');
const PROFILE_BATCH_SLIDE_LIMIT = TEMPLATE_PROFILE_WORKFLOW.maxSlidesPerBatch;
const PROFILE_BATCH_EVIDENCE_BYTE_LIMIT = TEMPLATE_PROFILE_WORKFLOW.maxBatchEvidenceBytes;
const PROFILE_BATCH_COUNT_LIMIT = TEMPLATE_PROFILE_WORKFLOW.maxBatches;

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

export function templateSemanticProfileJsonSchema(sourceSlideIndexes?: readonly number[]): SemanticJsonSchema {
  const stringArray = { type: 'array', maxItems: PROFILE_MAX_ELEMENTS_PER_SLIDE, items: { type: 'string', minLength: 1 } };
  const slideCount = sourceSlideIndexes?.length;
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      templateIRHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      slides: {
        type: 'array',
        ...(slideCount === undefined ? { maxItems: PROFILE_MAX_SLIDES } : { minItems: slideCount, maxItems: slideCount }),
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            sourceSlideIndex: sourceSlideIndexes
              ? { type: 'integer', enum: [...sourceSlideIndexes] }
              : { type: 'integer', minimum: 1 },
            archetype: { type: 'string', enum: [...TEMPLATE_SLIDE_ARCHETYPES] },
            supportedContentModes: { type: 'array', maxItems: TEMPLATE_CONTENT_MODES.length, items: { type: 'string', enum: [...TEMPLATE_CONTENT_MODES] } },
            titleElementId: { type: ['string', 'null'] },
            bodyElementIds: stringArray,
            visualElementIds: stringArray,
            preservedElementIds: stringArray,
            replaceableTextElementIds: stringArray,
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reasonCodes: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z0-9][a-z0-9._-]*$' } },
          },
          required: ['sourceSlideIndex', 'archetype', 'supportedContentModes', 'titleElementId', 'bodyElementIds', 'visualElementIds', 'preservedElementIds', 'replaceableTextElementIds', 'confidence', 'reasonCodes'],
        },
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

function profileEvidenceSlide(
  slide: TemplateIR['slides'][number],
  textLimit = 320,
  compactFallback = false,
): Record<string, unknown> {
  return {
    sourceSlideIndex: slide.index,
    elements: slide.elements.slice(0, PROFILE_MAX_ELEMENTS_PER_SLIDE).map((element) => {
      const rawText = typeof element.text === 'string' ? element.text.trim() : '';
      const text = rawText && textLimit > 0 ? rawText.slice(0, textLimit) : null;
      const textBearing = text !== null || element.placeholder !== null;
      const geometry = element.geometry.resolved ?? element.geometry.direct;
      const evidence: Record<string, unknown> = {
        id: element.id,
        order: element.order,
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
    ...(slide.elements.length > PROFILE_MAX_ELEMENTS_PER_SLIDE ? { evidenceTruncated: true } : {}),
    ...(slide.elements.some((element) => typeof element.text === 'string' && element.text.trim().length > textLimit)
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
): { evidence: Record<string, unknown>; evidenceJson: string; evidenceBytes: number } | null {
  for (const textLimit of [320, 160, 80, 32, 0]) {
    for (const compactFallback of [false, true]) {
      const slideEvidence = slides.map((slide) => profileEvidenceSlide(slide, textLimit, compactFallback));
      const evidence = profileEvidenceEnvelope(templateIR, slideEvidence);
      const evidenceJson = JSON.stringify(evidence);
      const evidenceBytes = Buffer.byteLength(evidenceJson, 'utf8');
      if (evidenceBytes <= PROFILE_BATCH_EVIDENCE_BYTE_LIMIT) return { evidence, evidenceJson, evidenceBytes };
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
  maxOutputTokens: number;
}

/** Plans deterministic, byte- and slide-bounded profiler requests without inference. */
export function planTemplateSemanticProfileBatches(templateIRInput: TemplateIR): {
  totalEvidenceBytes: number;
  batches: TemplateSemanticProfileBatchPlan[];
} {
  const templateIR = validateTemplateIR(templateIRInput);
  if (templateIR.slides.length > PROFILE_MAX_SLIDES) throw new TypeError(`Template semantic profiling is limited to ${PROFILE_MAX_SLIDES} slides.`);
  const totalEvidenceBytes = Buffer.byteLength(JSON.stringify(profileEvidence(templateIR, templateIR.slides)), 'utf8');
  const batches: Array<{ slides: TemplateIR['slides'][number][]; evidence: Record<string, unknown>; evidenceJson: string }> = [];
  let currentSlides: TemplateIR['slides'][number][] = [];
  let currentEvidence: { evidence: Record<string, unknown>; evidenceJson: string; evidenceBytes: number } | null = null;
  for (const slide of templateIR.slides) {
    const candidateSlides = [...currentSlides, slide];
    const candidate = candidateSlides.length <= PROFILE_BATCH_SLIDE_LIMIT
      ? boundedBatchEvidence(templateIR, candidateSlides)
      : null;
    if (candidate) {
      currentSlides = candidateSlides;
      currentEvidence = candidate;
      continue;
    }
    if (currentSlides.length > 0 && currentEvidence) {
      batches.push({ slides: currentSlides, evidence: currentEvidence.evidence, evidenceJson: currentEvidence.evidenceJson });
    }
    const single = boundedBatchEvidence(templateIR, [slide]);
    if (!single) {
      throw new InferenceError('REQUEST_TOO_LARGE', `Template profiler evidence for source slide ${slide.index} exceeds the safe batch byte limit.`);
    }
    currentSlides = [slide];
    currentEvidence = single;
  }
  if (currentSlides.length > 0 && currentEvidence) {
    batches.push({ slides: currentSlides, evidence: currentEvidence.evidence, evidenceJson: currentEvidence.evidenceJson });
  }
  if (batches.length > PROFILE_BATCH_COUNT_LIMIT) {
    throw new InferenceError('REQUEST_TOO_LARGE', `Template requires ${batches.length} profiler batches; the configured safe maximum is ${PROFILE_BATCH_COUNT_LIMIT}.`);
  }
  const totalBatches = batches.length;
  return {
    totalEvidenceBytes,
    batches: batches.map((batch, index) => {
      const sourceSlideIndexes = batch.slides.map((slide) => slide.index);
      const evidenceBytes = Buffer.byteLength(batch.evidenceJson, 'utf8');
      return {
        batchNumber: index + 1,
        totalBatches,
        sourceSlideIndexes,
        evidence: batch.evidenceJson,
        evidenceBytes,
        maxOutputTokens: Math.min(TEMPLATE_PROFILE_WORKFLOW.maxOutputTokens, Math.max(
          TEMPLATE_PROFILE_WORKFLOW.minOutputTokens,
          sourceSlideIndexes.length * TEMPLATE_PROFILE_WORKFLOW.outputTokensPerSlide,
        )),
      };
    }),
  };
}

function isValidTemplateSemanticProfileBatch(
  value: unknown,
  templateIR: TemplateIR,
  expectedSlides: readonly TemplateIR['slides'][number][],
): value is TemplateSemanticProfile {
  if (!isRecord(value) || !exactKeys(value, ['templateIRHash', 'slides']) || value.templateIRHash !== templateIR.hash
      || !Array.isArray(value.slides) || value.slides.length !== expectedSlides.length) return false;
  const expectedByIndex = new Map(expectedSlides.map((slide) => [slide.index, slide]));
  const seen = new Set<number>();
  for (const candidate of value.slides) {
    if (!isTemplateSemanticSlideProfile(candidate) || seen.has(candidate.sourceSlideIndex)) return false;
    const sourceSlide = expectedByIndex.get(candidate.sourceSlideIndex);
    if (!sourceSlide) return false;
    seen.add(candidate.sourceSlideIndex);
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
  return seen.size === expectedSlides.length;
}

function requestFor(
  templateIR: TemplateIR,
  systemPrompt: string,
  batch: TemplateSemanticProfileBatchPlan,
  batchSlides: readonly TemplateIR['slides'][number][],
): SemanticInferenceRequest<TemplateSemanticProfile> {
  const contract: SemanticOutputContract<TemplateSemanticProfile> = {
    name: TEMPLATE_PROFILE_WORKFLOW.schemaCompatibility,
    schema: templateSemanticProfileJsonSchema(batch.sourceSlideIndexes),
    validate: (value): value is TemplateSemanticProfile => isValidTemplateSemanticProfileBatch(value, templateIR, batchSlides),
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
    metadata: {
      templateProfilerBatch: {
        batchNumber: batch.batchNumber,
        totalBatches: batch.totalBatches,
        sourceSlideIndexes: [...batch.sourceSlideIndexes],
      },
    },
  };
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
    private readonly options: { promptDirectory?: string } = {},
  ) {}

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

  async profile(templateIRInput: TemplateIR, designSystemInput: PresentationDesignSystem, signal?: AbortSignal): Promise<TemplateSemanticProfile> {
    const templateIR = validateTemplateIR(templateIRInput);
    validatePresentationDesignSystem(designSystemInput, templateIR);
    const prompt = await this.loadPromptAsset();
    const cacheKey = templateSemanticProfileCacheKey(templateIR.hash, prompt.sha256);
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
      const plan = planTemplateSemanticProfileBatches(templateIR);
      const mergedSlides: TemplateSemanticSlideProfile[] = [];
      for (const batch of plan.batches) {
        if (signal?.aborted) throw new InferenceError('CANCELLED', 'Template profiler was cancelled before the next batch.');
        const batchIndexes = new Set(batch.sourceSlideIndexes);
        const batchSlides = templateIR.slides.filter((slide) => batchIndexes.has(slide.index));
        const response = await this.inference.infer({ ...requestFor(templateIR, prompt.content, batch, batchSlides), signal });
        mergedSlides.push(...response.value.slides);
      }
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

  clear(): void {
    this.cache.clear();
  }
}
