import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

import type { ContentIR } from '../domain/content-ir.js';
import type { DeckPlan } from '../domain/deck-plan.js';
import type { TemplateIR } from '../domain/template-ir.js';
import { validateTemplateSemanticProfile, type TemplateSemanticProfile } from './template-semantic-profiler.js';
import { auditCompiledPresentation } from './deterministic-audit.js';
import { buildPresentationQualityReport } from './presentation-quality-report.js';
import { assessDeckCompositionDistinctness, reviewDeckLevel, type DeckCompositionDistinctnessReport, type DeckReviewComposition } from './deck-level-review.js';
import {
  applyVariantCompositionAssignment,
  assessExemplarSelection,
  assessVariantCompositionDistinctness,
  createCompositionVisualClassificationCache,
} from './exemplar-slide-selector.js';
import { renderPresentation, resolvePptxBackend } from '../adapters/pptx-renderer-factory.js';
import type { PptxBackendId, PptxRenderResult } from './pptx-backend-port.js';
import type { PptxPreviewPort } from './pptx-preview-port.js';
import { compilePresentation, extractCanonicalFactualPayload, VARIANT_POLICIES, type VariantPolicy } from './slide-compilation.js';
import { classifySourceTemplateBleed } from './preview-layout-evidence.js';

type MatrixPreviewStatus = 'passed' | 'passed-with-warnings' | 'failed' | 'unknown';

function classifyMatrixSourceTemplateBleed(issue: unknown, compiledSlide: ReturnType<typeof compilePresentation>['slides'][number], template: TemplateIR, profile?: TemplateSemanticProfile): unknown {
  return classifySourceTemplateBleed(issue, template, assessExemplarSelection(compiledSlide, template, profile).selection);
}

function matrixPreviewStatus(preview: Awaited<ReturnType<NonNullable<PptxPreviewPort>['preview']>>, geometryIssues: readonly unknown[]): MatrixPreviewStatus {
  if (preview.status === 'failed' && geometryIssues.some((issue) => typeof issue !== 'object' || issue === null || !('severity' in issue) || issue.severity !== 'warning')) return 'failed';
  if (preview.status === 'failed' && preview.textLayoutIssues.some((issue) => typeof issue !== 'object' || issue === null || !('severity' in issue) || issue.severity === 'error')) return 'failed';
  if (preview.status === 'warning' || preview.textLayoutIssues.length || geometryIssues.length) return 'passed-with-warnings';
  return 'passed';
}

export interface OfflineMatrixTemplate {
  pptxPath: string;
  templateIR: TemplateIR;
  contentRoot?: string;
}

export interface OfflineMatrixResult {
  schemaVersion: 1;
  inferenceRequests: number;
  callCounts: { planningWorker: number; planningSupervisor: number; templateProfiler: number; generation: number; total: number };
  planId: string;
  planHash: string;
  templateCount: number;
  variantCount: number;
  outputCount: number;
  templateQualifications: Array<{
    templateIndex: number;
    templateIRHash: string;
    semanticProfileStatus: 'validated' | 'failed' | 'not-requested';
    status: 'passed' | 'blocked';
    profileFailure: string | null;
    renderStatus: 'passed' | 'failed' | 'not-run';
    previewStatus: 'passed' | 'passed-with-warnings' | 'failed' | 'not-requested' | 'not-run';
    previewIssueCounts: Array<{ variantId: string; issueCount: number; issues: unknown[] }>;
    renderFailure: string | null;
    diagnosticArtifactPath: string | null;
    deckReviewStatus: 'passed' | 'warning' | 'failed' | 'unknown' | 'not-run';
    deckReviewPath: string | null;
    deckCompositionDistinctness: DeckCompositionDistinctnessReport | null;
    slides: Array<{
      plannedSlideIndex: number;
      intent: string;
      availableDistinctCompositions: number;
      candidateCounts: ReturnType<typeof assessVariantCompositionDistinctness>['candidateCounts'];
      status: 'passed' | 'blocked';
      signatures: string[];
      evidence: string[];
      variants: Array<{
        variantId: string;
        compositionKind: 'exemplar-backed' | 'layout-placeholder-backed' | 'safe-generated-fallback' | 'unavailable';
        layoutCandidateIndex: number | null;
        layoutId: string | null;
        projectedCompositionSignature: string | null;
        selectedDonor: {
          sourceSlideIndex: number;
          structuralArchetype: string;
          semanticArchetype: string;
          semanticConfidence: number;
          titleElementId: string;
          bodyElementIds: string[];
          bodySegmentation: NonNullable<ReturnType<typeof assessExemplarSelection>['selection']>['bodySegmentation'];
          projectedCompositionSignature: string;
          projectionSafe: boolean;
          contentSafe: boolean | null;
          roleCompatible: boolean;
        } | null;
        candidateDiagnostics: ReturnType<typeof assessExemplarSelection>['candidateDiagnostics'];
      }>;
    }>;
  }>;
  timingsMs: { total: number; semanticProfile: number; compile: number; audit: number; render: number; preview: number | null };
  backend: PptxBackendId;
  outputs: Array<{
    templateIndex: number;
    variantId: string;
    pptxPath: string;
    auditPath: string;
    qualityPath: string;
    findingCount: number;
    compiledPresentationId: string;
    artifactSha256: string;
    renderStatus: 'passed';
    reopenStatus: PptxRenderResult['reopenStatus'];
    validationStatus: PptxRenderResult['validationStatus'];
    nativeObjectCounts: { text: number; tables: number; charts: number; images: number; shapes: number; connectors: number; notes: number; rasterSlides: 0 };
    previewStatus: MatrixPreviewStatus;
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
  /** Continue after a blocked template to collect qualification diagnostics; blocked templates are never rendered. */
  continueOnBlocked?: boolean;
  profileTemplate?: (template: OfflineMatrixTemplate) => Promise<TemplateSemanticProfile>;
}): Promise<OfflineMatrixResult> {
  if (input.templates.length < 1 || input.templates.length > 10) throw new TypeError('The matrix runner expects one through ten PPTX templates');
  const policies = input.policies ?? VARIANT_POLICIES;
  if (policies.length !== 3 || new Set(policies.map((policy) => policy.id)).size !== 3) {
    throw new TypeError('The current matrix runner expects three distinct A/B/C variant policies');
  }
  const started = performance.now();
  const timings = { semanticProfile: 0, compile: 0, audit: 0, render: 0, preview: input.previewAdapter ? 0 : null as number | null };
  const outputs: OfflineMatrixResult['outputs'] = [];
  const templateQualifications: OfflineMatrixResult['templateQualifications'] = [];
  const outputRoot = path.resolve(input.outputRoot);
  const backend = input.backend ?? resolvePptxBackend();
  let canonicalFacts: string | null = null;
  const semanticProfiles = new Map<string, TemplateSemanticProfile>();
  let templateProfilerRequests = 0;
  await mkdir(outputRoot, { recursive: true });

  for (let templateIndex = 0; templateIndex < input.templates.length; templateIndex += 1) {
    const template = input.templates[templateIndex]!;
    // This qualification pass uses one immutable template/profile pair for all
    // planned slides; reuse visual safety evidence only inside this template run.
    const visualClassificationCache = createCompositionVisualClassificationCache();
    let semanticProfile = semanticProfiles.get(template.templateIR.hash);
    let semanticProfileStatus: OfflineMatrixResult['templateQualifications'][number]['semanticProfileStatus'] = input.profileTemplate ? 'failed' : 'not-requested';
    let profileFailure: string | null = null;
    if (!semanticProfile && input.profileTemplate) {
      const profileStarted = performance.now();
      try {
        templateProfilerRequests += 1;
        semanticProfile = validateTemplateSemanticProfile(await input.profileTemplate(template), template.templateIR);
        semanticProfiles.set(template.templateIR.hash, semanticProfile);
        semanticProfileStatus = 'validated';
      } catch (error) {
        profileFailure = error instanceof Error ? error.message : 'Template semantic profile failed validation.';
        if (!input.continueOnBlocked) throw error;
      } finally {
        timings.semanticProfile += performance.now() - profileStarted;
      }
    } else if (semanticProfile) {
      semanticProfileStatus = 'validated';
    }
    const compileStarted = performance.now();
    const compiledByVariant = new Map(policies.map((policy) => [
      policy.id,
      compilePresentation(input.deckPlan, input.contentIR, template.templateIR, policy),
    ] as const));
    timings.compile += performance.now() - compileStarted;
    const qualifiedSlides: OfflineMatrixResult['templateQualifications'][number]['slides'] = [];
    for (let slideIndex = 0; slideIndex < input.deckPlan.slides.length; slideIndex += 1) {
      const variantSlides = policies.map((policy) => compiledByVariant.get(policy.id)!.slides[slideIndex]!);
      const distinctness = assessVariantCompositionDistinctness(variantSlides, template.templateIR, backend, semanticProfile,
        undefined, visualClassificationCache);
      // Preserve donor diagnostics from the pre-assignment candidates. A layout-backed
      // assignment is deliberately short-circuited by assessExemplarSelection once marked,
      // but the qualification report still needs to show which donors were considered.
      const donorAssessments = variantSlides.map((slide) => assessExemplarSelection(slide, template.templateIR, semanticProfile,
        undefined, visualClassificationCache));
      const assignedVariantSlides = distinctness.hasSafeAssignments
        ? variantSlides.map((slide) => {
          const assignment = distinctness.assignments.find((candidate) => candidate.variantId === slide.variantId);
          if (!assignment) throw new TypeError(`Qualified composition is missing the ${slide.variantId} assignment`);
          return applyVariantCompositionAssignment(slide, assignment, template.templateIR, semanticProfile);
        })
        : variantSlides;
      if (distinctness.hasSafeAssignments) for (const assigned of assignedVariantSlides) {
        const presentation = compiledByVariant.get(assigned.variantId)!;
        compiledByVariant.set(assigned.variantId, {
          ...presentation,
          slides: presentation.slides.map((slide, index) => index === slideIndex ? assigned : slide),
        });
      }
      const variants = assignedVariantSlides.map((slide, variantIndex) => {
        const assessment = donorAssessments[variantIndex]!;
        const assignment = distinctness.assignments.find((candidate) => candidate.variantId === slide.variantId);
        const selection = assignment?.compositionKind === 'exemplar-backed' ? assignment.exemplarSelection ?? null : null;
        return {
          variantId: slide.variantId,
          projectedCompositionSignature: assignment?.projectedCompositionSignature ?? null,
          compositionKind: assignment?.compositionKind ?? 'unavailable' as const,
          layoutCandidateIndex: assignment?.layoutCandidateIndex ?? null,
          layoutId: assignment?.compositionKind === 'layout-placeholder-backed'
            ? slide.layoutCandidates[assignment.layoutCandidateIndex]?.layoutId ?? null : selection?.layoutId ?? slide.layoutId,
          selectedDonor: selection ? {
            sourceSlideIndex: selection.sourceSlideIndex,
            structuralArchetype: assessment.candidateDiagnostics.find((candidate) => candidate.sourceSlideIndex === selection.sourceSlideIndex)?.structuralArchetype ?? selection.semanticArchetype,
            semanticArchetype: selection.semanticArchetype,
            semanticConfidence: selection.confidence,
            titleElementId: selection.slots.title.elementId,
            bodyElementIds: selection.slots.bodySlots.map((slot) => slot.elementId),
            bodySegmentation: selection.bodySegmentation,
            projectedCompositionSignature: selection.projectedCompositionSignature,
            projectionSafe: true,
            contentSafe: assessment.candidateDiagnostics.find((candidate) => candidate.sourceSlideIndex === selection.sourceSlideIndex)?.contentSafe ?? null,
            roleCompatible: assessment.candidateDiagnostics.find((candidate) => candidate.sourceSlideIndex === selection.sourceSlideIndex)?.roleCompatible ?? false,
          } : null,
          candidateDiagnostics: assessment.candidateDiagnostics,
        };
      });
      qualifiedSlides.push({
        plannedSlideIndex: slideIndex + 1,
        intent: variantSlides[0]!.intent,
        availableDistinctCompositions: distinctness.availableDistinctFamilies,
        candidateCounts: distinctness.candidateCounts,
        status: distinctness.hasSafeAssignments ? 'passed' : 'blocked',
        signatures: distinctness.signatures,
        evidence: distinctness.evidence,
        variants,
      });
    }
    const safeAssignmentsPassed = qualifiedSlides.every((slide) => slide.status === 'passed');
    const signaturesByVariant = Object.fromEntries(policies.map((policy) => [policy.id,
      qualifiedSlides.map((slide) => slide.variants.find((candidate) => candidate.variantId === policy.id)?.projectedCompositionSignature ?? ''),
    ])) as Record<VariantPolicy['id'], string[]>;
    const deckCompositionDistinctness = safeAssignmentsPassed
      ? assessDeckCompositionDistinctness(signaturesByVariant)
      : null;
    const qualificationPassed = semanticProfileStatus !== 'failed' && safeAssignmentsPassed && deckCompositionDistinctness?.distinct === true;
    const qualification: OfflineMatrixResult['templateQualifications'][number] = {
      templateIndex: templateIndex + 1,
      templateIRHash: template.templateIR.hash,
      semanticProfileStatus,
      status: qualificationPassed ? 'passed' as const : 'blocked' as const,
      profileFailure,
      renderStatus: 'not-run',
      previewStatus: 'not-run',
      previewIssueCounts: [],
      renderFailure: null,
      diagnosticArtifactPath: null,
      deckReviewStatus: 'not-run',
      deckReviewPath: null,
      deckCompositionDistinctness,
      slides: qualifiedSlides,
    };
    templateQualifications.push(qualification);
    if (!qualificationPassed) {
      if (!input.continueOnBlocked) {
        const blocked = qualifiedSlides.find((slide) => slide.status === 'blocked');
        if (profileFailure) throw new TypeError(`Template ${templateIndex + 1} semantic profile failed: ${profileFailure}`);
        if (blocked) throw new TypeError(`Template ${templateIndex + 1}, slide ${blocked.plannedSlideIndex} has no complete safe A/B/C composition assignment; outputs were withheld. ${blocked.evidence.join('; ')}`);
        const differences = deckCompositionDistinctness?.differingSlideCounts;
        throw new TypeError(`Template ${templateIndex + 1} complete A/B/C decks do not have pairwise distinct projected composition signatures; slides differing A/B=${differences?.AB ?? 0}, A/C=${differences?.AC ?? 0}, B/C=${differences?.BC ?? 0}.`);
      }
      continue;
    }
    const templateDirectory = path.join(outputRoot, `template-${templateIndex + 1}`);
    const stagingDirectory = path.join(outputRoot, `.template-${templateIndex + 1}-${randomUUID()}.tmp`);
    const templateOutputs: OfflineMatrixResult['outputs'] = [];
    const renderedByVariant = new Map<VariantPolicy['id'], PptxRenderResult>();
    const previewIssueCounts: Array<{ variantId: string; issueCount: number; issues: unknown[] }> = [];
    try {
      await mkdir(stagingDirectory, { recursive: false });
      for (const policy of policies) {
        const variantDirectory = path.join(stagingDirectory, `variant-${policy.id.toLowerCase()}`);
        await mkdir(variantDirectory, { recursive: true });
        const compiled = compiledByVariant.get(policy.id)!;
        const factualPayload = JSON.stringify(extractCanonicalFactualPayload(compiled));
        canonicalFacts ??= factualPayload;
        const factualEquivalenceStatus = factualPayload === canonicalFacts ? 'passed' as const : 'failed' as const;
        if (factualEquivalenceStatus !== 'passed') throw new TypeError(`Template ${templateIndex + 1} ${policy.id} changed the canonical factual payload`);
        const auditStarted = performance.now();
        const audit = auditCompiledPresentation(compiled, input.contentIR, template.templateIR);
        timings.audit += performance.now() - auditStarted;
        const blockingAuditFindings = audit.findings.filter((finding) => finding.severity === 'error');
        if (blockingAuditFindings.length) {
          const details = blockingAuditFindings.slice(0, 8).map((finding) =>
            `${finding.ruleId} ${finding.slideId}: ${finding.message} evidence=${JSON.stringify(finding.evidence)}`).join('; ');
          throw new TypeError(`Template ${templateIndex + 1} ${policy.id} has ${blockingAuditFindings.length} deterministic audit error(s): ${details}`);
        }
        const pptxPath = path.join(variantDirectory, 'presentation.pptx');
        const renderStarted = performance.now();
        const rendered = await renderPresentation({
          compiledPresentation: compiled,
          contentIR: input.contentIR,
          templateIR: template.templateIR,
          ...(semanticProfile ? { semanticProfile } : {}),
          templatePath: template.pptxPath,
          outputPath: pptxPath,
          contentRoot: template.contentRoot,
        }, backend);
        renderedByVariant.set(policy.id, rendered);
        timings.render += performance.now() - renderStarted;
        if (rendered.projectedCompositions.length !== compiled.slides.length) {
          throw new TypeError(`Template ${templateIndex + 1} ${policy.id} renderer projected ${rendered.projectedCompositions.length} composition(s) for ${compiled.slides.length} compiled slides`);
        }
        const variantPosition = ['A', 'B', 'C'].indexOf(policy.id);
        for (let slideIndex = 0; slideIndex < rendered.projectedCompositions.length; slideIndex += 1) {
          const actual = rendered.projectedCompositions[slideIndex]!;
          const expected = qualifiedSlides[slideIndex]?.signatures[variantPosition];
          if (!expected || actual.variantId !== policy.id || actual.slideId !== compiled.slides[slideIndex]?.id
              || actual.projectedCompositionSignature !== expected) {
            throw new TypeError(`Template ${templateIndex + 1} ${policy.id} renderer composition diverged from qualification at slide ${slideIndex + 1}: expected ${expected ?? 'none'}, received ${actual.projectedCompositionSignature}`);
          }
        }
        if (rendered.reopenStatus === 'failed' || rendered.validationStatus === 'failed') {
          throw new TypeError(`Template ${templateIndex + 1} ${policy.id} failed package reopen or validation`);
        }
        const previews: Array<{ slideIndex: number; status: MatrixPreviewStatus; textLayoutIssues: readonly unknown[]; geometryIssues: readonly unknown[]; textLayoutIssueCount: number; svgPath: string; pngPath: string; limitations: readonly string[] }> = [];
        if (input.previewAdapter) {
          const previewBytes = await readFile(pptxPath);
          const previewIndexes = input.previewAllSlides ? compiled.slides.map((_slide, index) => index) : [0];
          const previewDirectory = path.join(variantDirectory, 'previews');
          await mkdir(previewDirectory, { recursive: true });
          for (const slideIndex of previewIndexes) {
            const previewStarted = performance.now();
            const preview = await input.previewAdapter.preview(previewBytes, slideIndex);
            timings.preview = (timings.preview ?? 0) + performance.now() - previewStarted;
            const compiledSlide = compiled.slides[slideIndex]!;
            const geometryIssues = (preview.geometryIssues ?? []).map((issue) => classifyMatrixSourceTemplateBleed(issue, compiledSlide, template.templateIR, semanticProfile));
            const fileStem = `slide-${String(slideIndex + 1).padStart(2, '0')}`;
            await Promise.all([
              writeFile(path.join(previewDirectory, `${fileStem}.svg`), preview.svg, 'utf8'),
              writeFile(path.join(previewDirectory, `${fileStem}.png`), preview.png),
            ]);
            previews.push({
              slideIndex,
              status: matrixPreviewStatus(preview, geometryIssues),
              textLayoutIssues: preview.textLayoutIssues,
              geometryIssues,
              textLayoutIssueCount: preview.textLayoutIssues.length + geometryIssues.length,
              svgPath: `previews/${fileStem}.svg`,
              pngPath: `previews/${fileStem}.png`,
              limitations: preview.limitations,
            });
          }
          const uniqueIssues = new Map(previews.flatMap((preview) => [...preview.textLayoutIssues, ...preview.geometryIssues]
            .map((issue) => [JSON.stringify(issue), issue] as const)));
          previewIssueCounts.push({ variantId: policy.id, issueCount: uniqueIssues.size, issues: [...uniqueIssues.values()] });
        }
        const auditPath = path.join(variantDirectory, 'audit.json');
        const qualityPath = path.join(variantDirectory, 'quality.json');
        const kindsByVariant = Object.fromEntries(policies.map((item) => [item.id,
          qualifiedSlides.map((slide) => slide.variants.find((candidate) => candidate.variantId === item.id)?.compositionKind ?? 'unavailable'),
        ])) as Record<VariantPolicy['id'], string[]>;
        const presentationQuality = buildPresentationQualityReport({
          presentation: compiled,
          contentIR: input.contentIR,
          templateIR: template.templateIR,
          tracks: policies.map((item) => compiledByVariant.get(item.id)!).filter(Boolean),
          composition: { signaturesByVariant, kindsByVariant },
          ...(rendered.qualityEvidence ? { renderEvidence: rendered.qualityEvidence } : {}),
          previewEvidence: previews,
          safetyAudit: audit,
        });
        await writeFile(qualityPath, `${JSON.stringify(presentationQuality, null, 2)}\n`, 'utf8');
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
          presentationQuality,
          render: rendered,
          preview: previews.length > 0
            ? {
              status: previews.some((preview) => preview.status === 'failed') ? 'failed'
                : previews.some((preview) => preview.status === 'passed-with-warnings') ? 'passed-with-warnings' : 'passed',
              slideCount: previews.length,
              textLayoutIssueCount: previews.reduce((sum, preview) => sum + preview.textLayoutIssueCount, 0),
              artifacts: previews.map(({ slideIndex, svgPath, pngPath, textLayoutIssues, geometryIssues, status }) => ({ slideIndex, svg: svgPath, png: pngPath, status, textLayoutIssues, geometryIssues })),
              limitations: previews[0]!.limitations,
            }
            : { status: 'unknown', reason: 'No preview adapter was supplied.' },
          factualEquivalenceStatus,
        }, null, 2)}\n`, 'utf8');
        templateOutputs.push({
          templateIndex: templateIndex + 1,
          variantId: policy.id,
          pptxPath,
          auditPath,
          qualityPath,
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
          previewStatus: previews.length > 0 ? previews.some((preview) => preview.status === 'failed') ? 'failed'
            : previews.some((preview) => preview.status === 'passed-with-warnings') ? 'passed-with-warnings' : 'passed' : 'unknown',
          templatePreservationStatus: rendered.templatePreservationStatus,
          factualEquivalenceStatus,
          unresolvedVisualTypes: rendered.unresolvedVisualTypes,
        });
      }
      const compositionsByVariant = Object.fromEntries(policies.map((policy) => [policy.id,
        (renderedByVariant.get(policy.id)?.projectedCompositions ?? []).map((composition, slideIndex) => ({
          slideId: compiledByVariant.get(policy.id)!.slides[slideIndex]!.sourceDeckPlanSlideId,
          signature: composition.projectedCompositionSignature,
          archetype: composition.semanticArchetype,
        } satisfies DeckReviewComposition)),
      ])) as Record<VariantPolicy['id'], DeckReviewComposition[]>;
      const deckReview = reviewDeckLevel({
        deckPlan: input.deckPlan,
        contentIR: input.contentIR,
        compiledTracks: policies.map((policy) => compiledByVariant.get(policy.id)!).filter(Boolean),
        compositionsByVariant,
      });
      const deckReviewPath = path.join(stagingDirectory, 'deck-review.json');
      await writeFile(deckReviewPath, `${JSON.stringify(deckReview, null, 2)}\n`, 'utf8');
      for (const output of templateOutputs) {
        const auditRecord = JSON.parse(await readFile(output.auditPath, 'utf8')) as Record<string, unknown>;
        auditRecord.deckLevelReview = deckReview;
        await writeFile(output.auditPath, `${JSON.stringify(auditRecord, null, 2)}\n`, 'utf8');
      }
      qualification.deckReviewStatus = deckReview.status === 'pass' ? 'passed'
        : deckReview.status === 'warning' ? 'warning' : deckReview.status === 'error' ? 'failed' : 'unknown';
      qualification.deckReviewPath = deckReviewPath;
      const previewFailed = input.previewAdapter !== undefined && templateOutputs.some((output) => output.previewStatus === 'failed');
      if (previewFailed) throw new TypeError(`Template ${templateIndex + 1} Office Kit preview found an exact geometry/text blocker; inspect staged matrix artifacts before qualification`);
      await stat(templateDirectory).then(
        () => { throw new TypeError(`Template output already exists: ${templateDirectory}`); },
        (error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; },
      );
      await rename(stagingDirectory, templateDirectory);
      outputs.push(...templateOutputs.map((output) => ({
        ...output,
        pptxPath: output.pptxPath.replace(stagingDirectory, templateDirectory),
        auditPath: output.auditPath.replace(stagingDirectory, templateDirectory),
        qualityPath: output.qualityPath.replace(stagingDirectory, templateDirectory),
      })));
      qualification.renderStatus = 'passed';
      qualification.deckReviewPath = deckReviewPath.replace(stagingDirectory, templateDirectory);
      qualification.previewStatus = !input.previewAdapter ? 'not-requested'
        : templateOutputs.some((output) => output.previewStatus === 'passed-with-warnings') ? 'passed-with-warnings' : 'passed';
      qualification.previewIssueCounts = previewIssueCounts;
    } catch (error) {
      if (input.continueOnBlocked) {
        const diagnosticDirectory = path.join(outputRoot, `.template-${templateIndex + 1}-blocked-${randomUUID()}`);
        try {
          await rename(stagingDirectory, diagnosticDirectory);
          qualification.diagnosticArtifactPath = diagnosticDirectory;
        } catch {
            await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
      } else await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      qualification.status = 'blocked';
      const previewFailed = error instanceof Error && error.message.includes('Office Kit preview found an exact geometry/text blocker');
      qualification.renderStatus = previewFailed ? 'passed' : 'failed';
      qualification.previewStatus = previewFailed ? 'failed' : 'not-run';
      qualification.previewIssueCounts = previewIssueCounts;
      const previewSummary = previewIssueCounts.filter((item) => item.issueCount > 0).map((item) => `${item.variantId}=${item.issueCount}`).join(', ');
      qualification.renderFailure = [error instanceof Error ? error.message : 'Template render qualification failed.',
        ...(previewSummary ? [`preview text-layout issues by variant: ${previewSummary}`] : []),
        ...(qualification.diagnosticArtifactPath ? [`diagnostic artifacts: ${qualification.diagnosticArtifactPath}`] : [])].join('; ');
      if (!input.continueOnBlocked) throw error;
    }
  }
  const result: OfflineMatrixResult = {
    schemaVersion: 1,
    inferenceRequests: templateProfilerRequests,
    callCounts: {
      planningWorker: 0,
      planningSupervisor: 0,
      templateProfiler: templateProfilerRequests,
      generation: 0,
      total: templateProfilerRequests,
    },
    planId: input.deckPlan.id,
    planHash: input.deckPlan.hash,
    templateCount: input.templates.length,
    variantCount: policies.length,
    outputCount: outputs.length,
    templateQualifications,
    backend,
    timingsMs: { total: performance.now() - started, ...timings },
    outputs,
  };
  await writeFile(path.join(outputRoot, 'matrix.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}
