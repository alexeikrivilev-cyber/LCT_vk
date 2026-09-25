import {
  validatePresentationDesignSystem,
  validateTemplateIR,
  type PresentationDesignSystem,
  type TemplateIR,
} from '../domain/template-ir.js';
import type {
  SemanticInferenceAdapter,
  SemanticInferenceRequest,
  SemanticJsonSchema,
  SemanticOutputContract,
} from './semantic-inference-port.js';

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
  confidence: number;
  reasonCodes: string[];
}

export interface TemplateSemanticProfile {
  templateIRHash: string;
  slides: TemplateSemanticSlideProfile[];
}

const PROFILE_MAX_SLIDES = 500;
const PROFILE_MAX_ELEMENTS_PER_SLIDE = 120;
const PROFILE_SYSTEM_PROMPT = [
  'Classify each PowerPoint slide from the supplied deterministic evidence.',
  'Return one profile entry for every supplied sourceSlideIndex, preserving that index exactly.',
  'Use only supplied element IDs. Return null when a role is unclear.',
  'Do not infer meaning from filenames, layout names, or organizer identity; none are supplied.',
  'Treat text and style as evidence, state uncertainty with confidence and short reason codes.',
].join(' ');

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
  return isRecord(value)
    && exactKeys(value, ['sourceSlideIndex', 'archetype', 'supportedContentModes', 'titleElementId', 'bodyElementIds', 'visualElementIds', 'confidence', 'reasonCodes'])
    && Number.isSafeInteger(value.sourceSlideIndex) && Number(value.sourceSlideIndex) > 0
    && TEMPLATE_SLIDE_ARCHETYPES.includes(value.archetype as TemplateSlideArchetype)
    && Array.isArray(value.supportedContentModes) && value.supportedContentModes.length <= TEMPLATE_CONTENT_MODES.length
    && value.supportedContentModes.every((mode) => TEMPLATE_CONTENT_MODES.includes(mode as TemplateContentMode))
    && (value.titleElementId === null || typeof value.titleElementId === 'string')
    && isStringArray(value.bodyElementIds, PROFILE_MAX_ELEMENTS_PER_SLIDE)
    && isStringArray(value.visualElementIds, PROFILE_MAX_ELEMENTS_PER_SLIDE)
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
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reasonCodes: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z0-9][a-z0-9._-]*$' } },
          },
          required: ['sourceSlideIndex', 'archetype', 'supportedContentModes', 'titleElementId', 'bodyElementIds', 'visualElementIds', 'confidence', 'reasonCodes'],
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
    ];
    if (new Set(selectedIds).size !== selectedIds.length || selectedIds.some((id) => !allElements.has(id))) return false;
    if (candidate.titleElementId && !allElements.get(candidate.titleElementId)?.text?.trim()) return false;
    if (candidate.bodyElementIds.some((id) => !allElements.get(id)?.text?.trim())) return false;
  }
  return seenIndexes.size === sourceSlides.size;
}

export function validateTemplateSemanticProfile(value: unknown, templateIR: TemplateIR): TemplateSemanticProfile {
  if (!isValidTemplateSemanticProfile(value, templateIR)) throw new TypeError('Template semantic profile contains an invalid slide or element reference.');
  return structuredClone(value);
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
        kind: element.kind,
        text: element.text?.slice(0, 320) ?? null,
        placeholderRole: element.placeholder?.role ?? null,
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

function requestFor(templateIR: TemplateIR, presentationDesignSystem: PresentationDesignSystem): SemanticInferenceRequest<TemplateSemanticProfile> {
  const contract: SemanticOutputContract<TemplateSemanticProfile> = {
    name: 'template_semantic_profile_v1',
    schema: templateSemanticProfileJsonSchema(),
    validate: (value): value is TemplateSemanticProfile => isValidTemplateSemanticProfile(value, templateIR),
  };
  return {
    role: 'worker',
    operation: 'template-semantic-profile',
    messages: [
      { role: 'system', content: PROFILE_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(profileEvidence(templateIR, presentationDesignSystem)) },
    ],
    output: contract,
    maxOutputTokens: Math.min(8192, Math.max(1024, templateIR.slides.length * 96)),
    temperature: 0,
    timeoutMs: 90_000,
  };
}

/**
 * Replaceable semantic evidence adapter for templates. Cached per TemplateIR hash;
 * deterministic selector and safety checks remain responsible for final choices.
 */
export class TemplateSemanticProfiler {
  private readonly cache = new Map<string, TemplateSemanticProfile>();
  private readonly inFlight = new Map<string, Promise<TemplateSemanticProfile>>();

  constructor(private readonly inference: SemanticInferenceAdapter) {}

  async profile(templateIRInput: TemplateIR, designSystemInput: PresentationDesignSystem, signal?: AbortSignal): Promise<TemplateSemanticProfile> {
    const templateIR = validateTemplateIR(templateIRInput);
    const presentationDesignSystem = validatePresentationDesignSystem(designSystemInput, templateIR);
    const cached = this.cache.get(templateIR.hash);
    if (cached) return structuredClone(cached);
    const pending = this.inFlight.get(templateIR.hash);
    if (pending) return structuredClone(await pending);

    const task = (async () => {
      const response = await this.inference.infer({ ...requestFor(templateIR, presentationDesignSystem), signal });
      const profile = validateTemplateSemanticProfile(response.value, templateIR);
      this.cache.set(templateIR.hash, profile);
      return profile;
    })();
    this.inFlight.set(templateIR.hash, task);
    try { return structuredClone(await task); }
    finally { if (this.inFlight.get(templateIR.hash) === task) this.inFlight.delete(templateIR.hash); }
  }

  clear(): void {
    this.cache.clear();
  }
}
