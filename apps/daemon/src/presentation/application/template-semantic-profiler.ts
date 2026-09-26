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

export function templateSemanticProfileJsonSchema(): SemanticJsonSchema {
  const stringArray = { type: 'array', maxItems: PROFILE_MAX_ELEMENTS_PER_SLIDE, items: { type: 'string', minLength: 1 } };
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      templateIRHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      slides: {
        type: 'array', maxItems: PROFILE_MAX_SLIDES,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            sourceSlideIndex: { type: 'integer', minimum: 1 },
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

function profileEvidence(templateIR: TemplateIR, presentationDesignSystem: PresentationDesignSystem): Record<string, unknown> {
  if (templateIR.slides.length > PROFILE_MAX_SLIDES) throw new TypeError(`Template semantic profiling is limited to ${PROFILE_MAX_SLIDES} slides.`);
  return {
    templateIRHash: templateIR.hash,
    canvas: { width: templateIR.slideSize.width, height: templateIR.slideSize.height, unit: templateIR.slideSize.unit },
    presentationDesignSystem: {
      typography: {
        observedFonts: presentationDesignSystem.typography.observedFonts.slice(0, 32),
        observedSizesPt: presentationDesignSystem.typography.observedSizesPt.slice(0, 32),
        theme: presentationDesignSystem.typography.theme,
      },
      colors: { theme: presentationDesignSystem.colors.theme.slice(0, 24) },
      layoutSummaries: presentationDesignSystem.layouts.slice(0, 120).map((layout) => ({
        placeholderRoles: layout.placeholderRoles.slice(0, 16),
        elementCounts: layout.elementCounts,
        usageCount: layout.usageCount,
      })),
    },
    slides: templateIR.slides.map((slide) => ({
      sourceSlideIndex: slide.index,
      elements: slide.elements.slice(0, PROFILE_MAX_ELEMENTS_PER_SLIDE).map((element) => ({
        id: element.id,
        order: element.order,
        kind: element.kind,
        text: element.text?.slice(0, 320) ?? null,
        placeholderRole: element.placeholder?.role ?? null,
        placeholderType: element.placeholder?.type ?? null,
        parentId: element.parentId,
        relationshipCount: element.relationshipIds.length,
        geometry: element.geometry.resolved ?? element.geometry.direct,
        styles: {
          fonts: element.directStyles.fonts?.slice(0, 4) ?? null,
          fontSizesPt: element.directStyles.fontSizesPt?.slice(0, 6) ?? null,
          bold: element.directStyles.bold,
          fillColor: element.directStyles.fillColor,
        },
      })),
      evidenceTruncated: slide.elements.length > PROFILE_MAX_ELEMENTS_PER_SLIDE,
    })),
  };
}

function requestFor(templateIR: TemplateIR, presentationDesignSystem: PresentationDesignSystem, systemPrompt: string): SemanticInferenceRequest<TemplateSemanticProfile> {
  const contract: SemanticOutputContract<TemplateSemanticProfile> = {
    name: TEMPLATE_PROFILE_WORKFLOW.schemaCompatibility,
    schema: templateSemanticProfileJsonSchema(),
    validate: (value): value is TemplateSemanticProfile => isValidTemplateSemanticProfile(value, templateIR),
  };
  return {
    role: 'worker',
    operation: 'template-semantic-profile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(profileEvidence(templateIR, presentationDesignSystem)) },
    ],
    output: contract,
    maxOutputTokens: Math.min(TEMPLATE_PROFILE_WORKFLOW.maxOutputTokens, Math.max(TEMPLATE_PROFILE_WORKFLOW.minOutputTokens, templateIR.slides.length * TEMPLATE_PROFILE_WORKFLOW.outputTokensPerSlide)),
    temperature: TEMPLATE_PROFILE_WORKFLOW.temperature,
    timeoutMs: TEMPLATE_PROFILE_WORKFLOW.timeoutMs,
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
    const presentationDesignSystem = validatePresentationDesignSystem(designSystemInput, templateIR);
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
      const response = await this.inference.infer({ ...requestFor(templateIR, presentationDesignSystem, prompt.content), signal });
      const profile = validateTemplateSemanticProfile(response.value, templateIR);
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
