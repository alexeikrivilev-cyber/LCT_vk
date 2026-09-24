import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import type { ContentIR } from '../domain/content-ir.js';
import type { DeckPlan } from '../domain/deck-plan.js';
import type { TemplateIR } from '../domain/template-ir.js';
import { auditCompiledPresentation } from './deterministic-audit.js';
import { renderNativePptx } from './native-pptx-renderer.js';
import { compilePresentation, VARIANT_POLICIES, type VariantPolicy } from './slide-compilation.js';

export interface OfflineMatrixTemplate {
  pptxPath: string;
  templateIR: TemplateIR;
}

export interface OfflineMatrixResult {
  schemaVersion: 1;
  inferenceRequests: 0;
  planId: string;
  planHash: string;
  templateCount: number;
  variantCount: number;
  outputCount: number;
  timingsMs: { total: number; compile: number; audit: number; render: number };
  outputs: Array<{
    templateIndex: number;
    variantId: string;
    pptxPath: string;
    auditPath: string;
    findingCount: number;
    compiledPresentationId: string;
    artifactSha256: string;
  }>;
}

/** Offline-only fan-out: validates once, reuses the same plan for all template/variant renders. */
export async function runOfflinePresentationMatrix(input: {
  deckPlan: DeckPlan;
  contentIR: ContentIR;
  templates: readonly OfflineMatrixTemplate[];
  outputRoot: string;
  policies?: readonly VariantPolicy[];
}): Promise<OfflineMatrixResult> {
  if (input.templates.length !== 3) throw new TypeError('The current matrix runner expects exactly three PPTX templates');
  const policies = input.policies ?? VARIANT_POLICIES;
  if (policies.length !== 3 || new Set(policies.map((policy) => policy.id)).size !== 3) {
    throw new TypeError('The current matrix runner expects three distinct A/B/C variant policies');
  }
  const started = performance.now();
  const timings = { compile: 0, audit: 0, render: 0 };
  const outputs: OfflineMatrixResult['outputs'] = [];
  const outputRoot = path.resolve(input.outputRoot);
  await mkdir(outputRoot, { recursive: true });

  for (let templateIndex = 0; templateIndex < input.templates.length; templateIndex += 1) {
    const template = input.templates[templateIndex]!;
    const templateDirectory = path.join(outputRoot, `template-${templateIndex + 1}`);
    await mkdir(templateDirectory, { recursive: true });
    for (const policy of policies) {
      const variantDirectory = path.join(templateDirectory, `variant-${policy.id.toLowerCase()}`);
      await mkdir(variantDirectory, { recursive: true });
      const compileStarted = performance.now();
      const compiled = compilePresentation(input.deckPlan, input.contentIR, template.templateIR, policy);
      timings.compile += performance.now() - compileStarted;
      const auditStarted = performance.now();
      const audit = auditCompiledPresentation(compiled, input.contentIR, template.templateIR);
      timings.audit += performance.now() - auditStarted;
      const pptxPath = path.join(variantDirectory, 'presentation.pptx');
      const renderStarted = performance.now();
      const rendered = await renderNativePptx({
        compiledPresentation: compiled,
        contentIR: input.contentIR,
        templateIR: template.templateIR,
        templatePath: template.pptxPath,
        outputPath: pptxPath,
      });
      timings.render += performance.now() - renderStarted;
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
        renderer: 'native-text-ooxml.v1',
        audit,
        render: rendered,
      }, null, 2)}\n`, 'utf8');
      outputs.push({
        templateIndex: templateIndex + 1,
        variantId: policy.id,
        pptxPath,
        auditPath,
        findingCount: audit.findings.length,
        compiledPresentationId: compiled.id,
        artifactSha256: rendered.artifactSha256,
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
    timingsMs: { total: 0, ...timings },
    outputs,
  };
  result.timingsMs.total = performance.now() - started;
  await writeFile(path.join(outputRoot, 'matrix.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}
