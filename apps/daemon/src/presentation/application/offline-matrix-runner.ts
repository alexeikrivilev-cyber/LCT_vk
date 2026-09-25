import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import type { ContentIR } from '../domain/content-ir.js';
import type { DeckPlan } from '../domain/deck-plan.js';
import type { TemplateIR } from '../domain/template-ir.js';
import { auditCompiledPresentation } from './deterministic-audit.js';
import { assessVariantCompositionDistinctness } from './exemplar-slide-selector.js';
import { renderPresentation, resolvePptxBackend } from '../adapters/pptx-renderer-factory.js';
import type { PptxBackendId, PptxRenderResult } from './pptx-backend-port.js';
import type { PptxPreviewPort } from './pptx-preview-port.js';
import { compilePresentation, extractCanonicalFactualPayload, VARIANT_POLICIES, type VariantPolicy } from './slide-compilation.js';

export interface OfflineMatrixTemplate {
  pptxPath: string;
  templateIR: TemplateIR;
  contentRoot?: string;
}

export interface OfflineMatrixResult {
  schemaVersion: 1;
  inferenceRequests: 0;
  planId: string;
  planHash: string;
  templateCount: number;
  variantCount: number;
  outputCount: number;
  timingsMs: { total: number; compile: number; audit: number; render: number; preview: number | null };
  backend: PptxBackendId;
  outputs: Array<{
    templateIndex: number;
    variantId: string;
    pptxPath: string;
    auditPath: string;
    findingCount: number;
    compiledPresentationId: string;
    artifactSha256: string;
    renderStatus: 'passed';
    reopenStatus: PptxRenderResult['reopenStatus'];
    validationStatus: PptxRenderResult['validationStatus'];
    nativeObjectCounts: { text: number; tables: number; charts: number; images: number; shapes: number; connectors: number; notes: number; rasterSlides: 0 };
    previewStatus: 'passed' | 'failed' | 'unknown';
    templatePreservationStatus: PptxRenderResult['templatePreservationStatus'];
    factualEquivalenceStatus: 'passed' | 'failed';
    unresolvedVisualTypes: readonly string[];
  }>;
}

/** Offline-only fan-out: validates once, reuses the same plan for all template/variant renders. */
export async function runOfflinePresentationMatrix(input: {
  deckPlan: DeckPlan;
  contentIR: ContentIR;
  templates: readonly OfflineMatrixTemplate[];
  outputRoot: string;
  policies?: readonly VariantPolicy[];
  backend?: PptxBackendId;
  previewAdapter?: PptxPreviewPort;
  previewAllSlides?: boolean;
}): Promise<OfflineMatrixResult> {
  if (input.templates.length < 1 || input.templates.length > 10) throw new TypeError('The matrix runner expects one through ten PPTX templates');
  const policies = input.policies ?? VARIANT_POLICIES;
  if (policies.length !== 3 || new Set(policies.map((policy) => policy.id)).size !== 3) {
    throw new TypeError('The current matrix runner expects three distinct A/B/C variant policies');
  }
  const started = performance.now();
  const timings = { compile: 0, audit: 0, render: 0, preview: input.previewAdapter ? 0 : null as number | null };
  const outputs: OfflineMatrixResult['outputs'] = [];
  const outputRoot = path.resolve(input.outputRoot);
  const backend = input.backend ?? resolvePptxBackend();
  let canonicalFacts: string | null = null;
  await mkdir(outputRoot, { recursive: true });

  for (let templateIndex = 0; templateIndex < input.templates.length; templateIndex += 1) {
    const template = input.templates[templateIndex]!;
    const compileStarted = performance.now();
    const compiledByVariant = new Map(policies.map((policy) => [
      policy.id,
      compilePresentation(input.deckPlan, input.contentIR, template.templateIR, policy),
    ] as const));
    timings.compile += performance.now() - compileStarted;
    for (let slideIndex = 0; slideIndex < input.deckPlan.slides.length; slideIndex += 1) {
      const variantSlides = policies.map((policy) => compiledByVariant.get(policy.id)!.slides[slideIndex]!);
      const distinctness = assessVariantCompositionDistinctness(variantSlides, template.templateIR, backend);
      if (!distinctness.distinct) {
        throw new TypeError(`Template ${templateIndex + 1}, slide ${slideIndex + 1} has only ${distinctness.availableDistinctFamilies} distinct safe projected composition(s); A/B/C outputs were withheld. ${distinctness.evidence.join('; ')}`);
      }
    }
    const templateDirectory = path.join(outputRoot, `template-${templateIndex + 1}`);
    await mkdir(templateDirectory, { recursive: true });
    for (const policy of policies) {
      const variantDirectory = path.join(templateDirectory, `variant-${policy.id.toLowerCase()}`);
      await mkdir(variantDirectory, { recursive: true });
      const compiled = compiledByVariant.get(policy.id)!;
      const factualPayload = JSON.stringify(extractCanonicalFactualPayload(compiled));
      canonicalFacts ??= factualPayload;
      const factualEquivalenceStatus = factualPayload === canonicalFacts ? 'passed' as const : 'failed' as const;
      const auditStarted = performance.now();
      const audit = auditCompiledPresentation(compiled, input.contentIR, template.templateIR);
      timings.audit += performance.now() - auditStarted;
      const pptxPath = path.join(variantDirectory, 'presentation.pptx');
      const renderStarted = performance.now();
      const rendered = await renderPresentation({
        compiledPresentation: compiled,
        contentIR: input.contentIR,
        templateIR: template.templateIR,
        templatePath: template.pptxPath,
        outputPath: pptxPath,
        contentRoot: template.contentRoot,
      }, backend);
      timings.render += performance.now() - renderStarted;
      const previews: Array<{ slideIndex: number; status: 'passed' | 'failed'; textLayoutIssueCount: number; svgPath: string; pngPath: string; limitations: readonly string[] }> = [];
      if (input.previewAdapter) {
        const previewBytes = await readFile(pptxPath);
        const previewIndexes = input.previewAllSlides ? compiled.slides.map((_slide, index) => index) : [0];
        const previewDirectory = path.join(variantDirectory, 'previews');
        await mkdir(previewDirectory, { recursive: true });
        for (const slideIndex of previewIndexes) {
          const previewStarted = performance.now();
          const preview = await input.previewAdapter.preview(previewBytes, slideIndex);
          timings.preview = (timings.preview ?? 0) + performance.now() - previewStarted;
          const fileStem = `slide-${String(slideIndex + 1).padStart(2, '0')}`;
          await Promise.all([
            writeFile(path.join(previewDirectory, `${fileStem}.svg`), preview.svg, 'utf8'),
            writeFile(path.join(previewDirectory, `${fileStem}.png`), preview.png),
          ]);
          previews.push({
            slideIndex,
            status: preview.status,
            textLayoutIssueCount: preview.textLayoutIssues.length,
            svgPath: `previews/${fileStem}.svg`,
            pngPath: `previews/${fileStem}.png`,
            limitations: preview.limitations,
          });
        }
      }
      const auditPath = path.join(variantDirectory, 'audit.json');
      await writeFile(auditPath, `${JSON.stringify({
        schemaVersion: 1,
        planId: input.deckPlan.id,
        planHash: input.deckPlan.hash,
        contentIRHash: input.contentIR.hash,
        templateIRId: template.templateIR.id,
        templateIRHash: template.templateIR.hash,
        variantId: policy.id,
        variantPolicyVersion: policy.version,
        compiledPresentationId: compiled.id,
        renderer: backend,
        audit,
        render: rendered,
        preview: previews.length > 0
          ? {
            status: previews.every((preview) => preview.status === 'passed') ? 'passed' : 'failed',
            slideCount: previews.length,
            textLayoutIssueCount: previews.reduce((sum, preview) => sum + preview.textLayoutIssueCount, 0),
            artifacts: previews.map(({ slideIndex, svgPath, pngPath }) => ({ slideIndex, svg: svgPath, png: pngPath })),
            limitations: previews[0]!.limitations,
          }
          : { status: 'unknown', reason: 'No preview adapter was supplied.' },
        factualEquivalenceStatus,
      }, null, 2)}\n`, 'utf8');
      outputs.push({
        templateIndex: templateIndex + 1,
        variantId: policy.id,
        pptxPath,
        auditPath,
        findingCount: rendered.auditFindingCount,
        compiledPresentationId: compiled.id,
        artifactSha256: rendered.artifactSha256,
        renderStatus: 'passed',
        reopenStatus: rendered.reopenStatus,
        validationStatus: rendered.validationStatus,
        nativeObjectCounts: {
          text: rendered.nativeTextShapeCount, tables: rendered.nativeTableCount, charts: rendered.nativeChartCount,
          images: rendered.nativeImageCount, shapes: rendered.nativeShapeCount, connectors: rendered.nativeConnectorCount,
          notes: rendered.nativeNotesCount, rasterSlides: rendered.rasterSlideCount,
        },
        previewStatus: previews.length > 0 ? previews.every((preview) => preview.status === 'passed') ? 'passed' : 'failed' : 'unknown',
        templatePreservationStatus: rendered.templatePreservationStatus,
        factualEquivalenceStatus,
        unresolvedVisualTypes: rendered.unresolvedVisualTypes,
      });
    }
  }
  const result: OfflineMatrixResult = {
    schemaVersion: 1,
    inferenceRequests: 0,
    planId: input.deckPlan.id,
    planHash: input.deckPlan.hash,
    templateCount: input.templates.length,
    variantCount: policies.length,
    outputCount: outputs.length,
    backend,
    timingsMs: { total: performance.now() - started, ...timings },
    outputs,
  };
  await writeFile(path.join(outputRoot, 'matrix.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}
