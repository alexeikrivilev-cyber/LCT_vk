import type { ContentIR } from '../domain/content-ir.js';
import type { TemplateIR } from '../domain/template-ir.js';
import type { TemplateSemanticProfile } from './template-semantic-profiler.js';
import type { CompiledPresentation } from './slide-compilation.js';
import type { SemanticVisualType } from '../domain/deck-plan.js';

/** Internal replaceable renderer boundary; not an external application API. */
export type PptxBackendId = 'custom' | 'office-kit';
export const QUALIFICATION_PPTX_BACKEND: PptxBackendId = 'office-kit';
export const DEFAULT_PPTX_BACKEND: PptxBackendId = QUALIFICATION_PPTX_BACKEND;

export interface PptxRenderInput {
  compiledPresentation: CompiledPresentation;
  contentIR: ContentIR;
  templateIR: TemplateIR;
  semanticProfile?: TemplateSemanticProfile;
  templatePath: string;
  outputPath: string;
  /** Absolute project content directory used only to resolve ContentIR media source paths. */
  contentRoot?: string;
}

export interface PptxRenderResult {
  backend: PptxBackendId;
  outputPath: string;
  presentationId: string;
  slideCount: number;
  nativeTextShapeCount: number;
  nativeTableCount: number;
  nativeChartCount: number;
  nativeImageCount: number;
  nativeShapeCount: number;
  nativeConnectorCount: number;
  nativeNotesCount: number;
  rasterSlideCount: 0;
  auditFindingCount: number;
  artifactSha256: string;
  reopenStatus: 'not-run' | 'passed' | 'failed';
  validationStatus: 'not-run' | 'passed' | 'failed';
  templatePreservationStatus: 'passed' | 'failed' | 'unknown';
  validationIssues: readonly { severity: 'error' | 'warning'; message: string; partName: string | null }[];
  unresolvedVisualTypes: readonly string[];
  /** Replaceable internal evidence of the visual intent actually materialized by this renderer. */
  visualIntents: readonly {
    slideId: string;
    requestedType: SemanticVisualType;
    realizedType: SemanticVisualType | 'text-only' | 'unresolved';
    fallbackReason: string | null;
  }[];
  /** Replaceable internal evidence describing the post-cleanup native composition selected for each slide. */
  projectedCompositions: readonly {
    slideId: string;
    variantId: string;
    sourceSlideIndex: number | null;
    semanticArchetype: string | null;
    confidence: number | null;
    projectedCompositionSignature: string;
    availableDistinctFamilies: number | null;
    titleGeometryNormalized: { x: number; y: number; width: number; height: number; rotation: number } | null;
    bodyGeometryNormalized: { x: number; y: number; width: number; height: number; rotation: number } | null;
    titleBodyFontHierarchy: { titlePt: number; bodyPt: number; ratio: number } | null;
    selectionReason: string;
  }[];
  /** Internal post-reopen visual evidence. It is diagnostic data, not part of the safety audit/API. */
  qualityEvidence?: {
    textObjects: readonly {
      slideId: string;
      shapeId: string;
      role: 'title' | 'body' | 'other';
      textSha256: string;
      textLength: number;
      fontSizePt: number | null;
      color: string | null;
      autoFitScale: number | null;
      bounds: { x: number; y: number; width: number; height: number } | null;
    }[];
    sourceContentResidue: {
      status: 'checked' | 'not-applicable';
      findings: readonly { slideId: string; sourceSlideIndex: number; sourceElementId: string; textSha256: string; outputShapeId: string }[];
    };
  };
}

/** A backend materializes one already-compiled deck without narrative decisions. */
export interface PptxRendererPort {
  readonly id: PptxBackendId;
  render(input: PptxRenderInput): Promise<PptxRenderResult>;
}

export function parsePptxBackend(value: unknown): PptxBackendId {
  if (value === undefined || value === null || value === '') return DEFAULT_PPTX_BACKEND;
  if (value === 'custom' || value === 'office-kit') return value;
  throw new TypeError('LCT_PPTX_BACKEND must be custom or office-kit');
}
