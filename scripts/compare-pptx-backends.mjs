#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { inspectPptx } from '../apps/daemon/src/presentation/adapters/python-inspector.js';
import { OfficeKitPptxDocumentAdapter } from '../apps/daemon/src/presentation/adapters/office-kit-pptx-document-adapter.js';
import { inspectOfficeKitPackage } from '../apps/daemon/src/presentation/adapters/office-kit-package-inspector.js';
import { OfficeKitPptxRenderer } from '../apps/daemon/src/presentation/adapters/office-kit-pptx-renderer.js';
import { OfficeKitPreviewAdapter } from '../apps/daemon/src/presentation/adapters/office-kit-preview-adapter.js';
import { compileContentIR } from '../apps/daemon/src/presentation/application/content-compiler.js';
import { createTemplateIR } from '../apps/daemon/src/presentation/application/template-mapper.js';
import { compilePresentation, VARIANT_POLICIES } from '../apps/daemon/src/presentation/application/slide-compilation.js';
import { briefHash } from '../apps/daemon/src/presentation/domain/brief.js';
import { canonicalizeDeckPlan } from '../apps/daemon/src/presentation/domain/deck-plan.js';

const require = createRequire(new URL('../apps/daemon/package.json', import.meta.url));
const JSZip = require('jszip');
const MAX_INPUT_BYTES = 64 * 1024 * 1024;

function usage() {
  return 'Usage: node --import tsx scripts/compare-pptx-backends.mjs <template.pptx> --out <separate-output-directory>';
}

function parseArgs(argv) {
  if (argv.length !== 3 || argv[1] !== '--out' || !argv[0] || !argv[2]) throw new Error(usage());
  return { input: argv[0], output: argv[2] };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function packageInventory(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const parts = Object.entries(zip.files).filter(([, entry]) => !entry.dir).map(([name]) => name).sort();
  const relationships = [];
  for (const name of parts.filter((part) => part.endsWith('.rels'))) {
    const xml = await zip.file(name).async('string');
    relationships.push({ part: name, count: (xml.match(/<Relationship\b/g) ?? []).length });
  }
  return { parts, relationships };
}

async function packagePreservation(source, output) {
  const sourceZip = await JSZip.loadAsync(source);
  const outputZip = await JSZip.loadAsync(output);
  const missingParts = [];
  const changedOpaqueParts = [];
  const ignored = new Set(['[Content_Types].xml', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels', 'docProps/app.xml', 'docProps/core.xml']);
  for (const [name, entry] of Object.entries(sourceZip.files)) {
    if (entry.dir || ignored.has(name) || name.startsWith('ppt/slides/') || name.startsWith('ppt/notesSlides/') || name.startsWith('ppt/notesMasters/')) continue;
    const outputEntry = outputZip.file(name);
    if (!outputEntry) { missingParts.push(name); continue; }
    const [before, after] = await Promise.all([entry.async('uint8array'), outputEntry.async('uint8array')]);
    if (sha256(before) !== sha256(after)) changedOpaqueParts.push(name);
  }
  return { status: missingParts.length || changedOpaqueParts.length ? 'FAIL' : 'PASS', missingParts, changedOpaqueParts };
}

async function canonicalizeFuturePath(candidate) {
  let current = candidate;
  const missingTail = [];
  while (true) {
    try {
      const existing = await realpath(current);
      return path.join(existing, ...missingTail);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missingTail.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function writeReportAtomically(reportPath, contents) {
  const temporaryPath = path.join(path.dirname(reportPath), `.${path.basename(reportPath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, contents, { flag: 'wx' });
    await rename(temporaryPath, reportPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function runPptxCompatibilityHarness(inputValue, outputValue) {
  const inputCandidate = path.resolve(inputValue);
  const outputCandidate = path.resolve(outputValue);
  function assertSeparateOutputDirectory(candidate, sourceRoot, sourceFile) {
    const outputRelativeToSource = path.relative(sourceRoot, candidate);
    const sourceRelativeToOutput = path.relative(candidate, sourceFile);
    const outputInsideSourceDirectory = outputRelativeToSource === ''
      || (!outputRelativeToSource.startsWith(`..${path.sep}`) && !path.isAbsolute(outputRelativeToSource));
    const outputContainsSource = sourceRelativeToOutput === ''
      || (!sourceRelativeToOutput.startsWith(`..${path.sep}`) && !path.isAbsolute(sourceRelativeToOutput));
    if (outputInsideSourceDirectory || outputContainsSource) {
      throw new TypeError('Choose a separate output directory outside the source template folder; the source template is read-only');
    }
  }
  const inputPathHint = await realpath(inputCandidate).catch(() => null);
  const sourceRootHint = inputPathHint
    ? path.dirname(inputPathHint)
    : await realpath(path.dirname(inputCandidate)).catch(() => path.dirname(inputCandidate));
  const outputPathHint = await canonicalizeFuturePath(outputCandidate);
  assertSeparateOutputDirectory(outputPathHint, sourceRootHint, inputPathHint ?? inputCandidate);
  await mkdir(outputCandidate, { recursive: true });
  const outputPath = await realpath(outputCandidate);
  assertSeparateOutputDirectory(outputPath, sourceRootHint, inputPathHint ?? inputCandidate);
  let inputPath = null;
  let sourceBytes = null;
  let sourceSha256 = null;
  let templateIR = null;
  let inspector = null;
  let office = null;
  let noOp = null;
  let compiled = null;
  let contentIR = null;
  let mutationPath = null;
  let outputBytes = null;
  const runDirectory = path.join(outputPath, `compatibility-run-${Date.now()}-${randomUUID().slice(0, 8)}`);
  await mkdir(runDirectory, { recursive: true });
  const report = {
    schemaVersion: 1,
    source: { sha256: null, byteLength: null, path: path.basename(inputCandidate), immutable: 'UNKNOWN' },
    capabilities: Object.fromEntries(['inputSafety', 'lctInspection', 'officeKitLoad', 'noOpRoundTrip', 'templatePartPreservation', 'sourceByteIdentity', 'generationCompatibility', 'generatedMutation', 'preview', 'nativeOfficeOpen']
      .map((name) => [name, { status: 'UNKNOWN', reason: { code: 'NOT_RUN', message: 'A required earlier stage did not produce its input.' } }])),
    officeKitInventory: null,
    lctInventory: null,
    outputs: {},
    safeForOfficeKitBackend: 'no',
    reasons: [],
  };

  const failure = (error) => {
    const rawMessage = error instanceof Error ? error.message : String(error);
    let message = rawMessage;
    for (const candidate of [inputCandidate, inputPath, outputPath].filter(Boolean)) message = message.split(candidate).join('[local path]');
    message = message.replace(/[A-Za-z]:\\[^\s"'<>]+/g, '[local path]').slice(0, 600);
    return { code: typeof error?.code === 'string' ? error.code : error?.name ?? 'STAGE_FAILED', message };
  };
  const runStage = async (name, action) => {
    try {
      const result = await action();
      report.capabilities[name] = result?.capability ?? { status: 'PASS' };
      return result?.value ?? result;
    } catch (error) {
      report.capabilities[name] = { status: 'FAIL', reason: failure(error) };
      if (error?.candidates) {
        report.capabilities[name].candidateEvidence = error.candidates;
        if (name === 'generationCompatibility' && report.lctInventory) {
          report.lctInventory.inferredSlotEvidence = error.candidates.map((candidate) => ({
            sourcePart: candidate.sourcePart, title: candidate.slots.title, body: candidate.slots.body, visual: candidate.slots.visual,
          }));
        }
      }
      return null;
    }
  };
  const runArtifact = async (name, bytes) => {
    const target = path.join(runDirectory, name);
    await writeFile(target, bytes, { flag: 'wx' });
    return target;
  };

  await runStage('inputSafety', async () => {
    inputPath = await realpath(inputCandidate);
    assertSeparateOutputDirectory(outputPath, path.dirname(inputPath), inputPath);
    const inputStat = await stat(inputPath);
    if (!inputStat.isFile() || inputStat.size < 1 || inputStat.size > MAX_INPUT_BYTES || path.extname(inputPath).toLowerCase() !== '.pptx') {
      const error = new TypeError('Input must be a regular PPTX file no larger than 64 MiB');
      error.code = 'UNSAFE_PPTX_INPUT';
      throw error;
    }
    sourceBytes = await readFile(inputPath);
    sourceSha256 = sha256(sourceBytes);
    report.source = { sha256: sourceSha256, byteLength: sourceBytes.byteLength, path: path.basename(inputPath), immutable: 'UNKNOWN' };
    return { capability: { status: 'PASS', maxBytes: MAX_INPUT_BYTES } };
  });

  if (sourceBytes) {
    await runStage('lctInspection', async () => {
      inspector = await inspectPptx(inputPath);
      templateIR = createTemplateIR(inspector, {
        filePath: path.basename(inputPath), originalName: path.basename(inputPath), sha256: sourceSha256,
        compiledAt: new Date().toISOString(), compilerVersion: 'lct-template-compiler/1',
      });
      const slideUsage = new Map();
      for (const slide of templateIR.slides) if (slide.layoutId) slideUsage.set(slide.layoutId, (slideUsage.get(slide.layoutId) ?? 0) + 1);
      const kinds = (elements) => Object.fromEntries([...new Set(elements.map((element) => element.kind))].sort()
        .map((kind) => [kind, elements.filter((element) => element.kind === kind).length]));
      report.lctInventory = {
        slideCount: inspector.inspection.slides.length,
        masterCount: inspector.inspection.masters.length,
        layoutCount: inspector.inspection.layouts.length,
        placeholderCount: templateIR.layouts.reduce((sum, layout) => sum + layout.elements.filter((element) => element.placeholder !== null).length, 0),
        relationshipCount: [...templateIR.layouts, ...templateIR.masters, ...templateIR.slides].reduce((sum, part) => sum + part.relationships.length, 0),
        layouts: templateIR.layouts.map((layout) => ({
          sourcePart: layout.sourcePart, declaredName: layout.declaredName, declaredType: layout.declaredType,
          elementCount: layout.elements.length, elementKinds: kinds(layout.elements),
          placeholders: layout.elements.filter((element) => element.placeholder !== null).map((element) => ({ type: element.placeholder?.type, role: element.placeholder?.role, hasGeometry: Boolean(element.geometry.resolved ?? element.geometry.direct) })),
          slideUsage: slideUsage.get(layout.id) ?? 0,
        })),
        masters: templateIR.masters.map((master) => ({ sourcePart: master.sourcePart, declaredName: master.declaredName, elementCount: master.elements.length, elementKinds: kinds(master.elements), placeholderCount: master.elements.filter((element) => element.placeholder !== null).length })),
        slideElementKinds: templateIR.slides.map((slide) => ({ index: slide.index, sourcePart: slide.sourcePart, elementCount: slide.elements.length, elementKinds: kinds(slide.elements) })),
        visualObjectRegions: templateIR.slides.flatMap((slide) => slide.elements.flatMap((element) => {
          const kind = element.kind.toLowerCase();
          const geometry = element.geometry.resolved ?? element.geometry.direct;
          if (!geometry || !['image', 'picture', 'chart', 'table', 'graphicframe'].includes(kind)) return [];
          return [{ slideIndex: slide.index, elementId: element.id, kind, geometry }];
        })),
        unsupportedKindCounts: Object.fromEntries([...new Set(templateIR.unsupported.map((item) => item.kind))].sort()
          .map((kind) => [kind, templateIR.unsupported.filter((item) => item.kind === kind).length])),
        inferredSlotEvidence: [],
      };
      return { capability: { status: 'PASS', templateIRHash: templateIR.hash, warnings: templateIR.warnings.length } };
    });

    await runStage('officeKitLoad', async () => {
      office = await inspectOfficeKitPackage(sourceBytes);
      const sourcePackage = await packageInventory(sourceBytes);
      report.officeKitInventory = { ...office, packagePartCount: sourcePackage.parts.length, packageRelationships: sourcePackage.relationships };
      return { capability: { status: 'PASS', slideCount: office.slideCount, masterCount: office.masterParts.length, layoutCount: office.layoutNames.length } };
    });

    await runStage('noOpRoundTrip', async () => {
      noOp = await new OfficeKitPptxDocumentAdapter().roundTrip(sourceBytes);
      const noOpPath = await runArtifact('office-kit-noop-roundtrip.pptx', noOp.pptx);
      const noOpInventory = await packageInventory(noOp.pptx);
      const validationStatus = noOp.validationIssues.some((issue) => issue.severity === 'error') ? 'FAIL' : 'PASS';
      report.outputs.noOp = { path: path.relative(outputPath, noOpPath), validationStatus, validationIssues: noOp.validationIssues, packagePartCount: noOpInventory.parts.length };
      return { capability: { status: validationStatus }, value: noOp };
    });

    if (noOp) await runStage('templatePartPreservation', async () => {
      const preservation = await packagePreservation(sourceBytes, noOp.pptx);
      report.outputs.noOp.preservation = preservation;
      return { capability: { status: preservation.status, missingParts: preservation.missingParts, changedOpaqueParts: preservation.changedOpaqueParts } };
    });

    if (templateIR) await runStage('generationCompatibility', async () => {
      const probeDirectory = path.join(runDirectory, 'probe-content');
      await mkdir(probeDirectory, { recursive: true });
      await writeFile(path.join(probeDirectory, 'evidence.md'), 'A generated compatibility probe remains editable and traceable.\n', { flag: 'wx' });
      contentIR = await compileContentIR(runDirectory, 'probe-content', ['evidence.md']);
      const unit = contentIR.units.find((item) => item.text);
      const brief = { audience: 'Template compatibility review', purpose: 'Exercise the generated-slide backend boundary', expectedOutcome: 'Create one editable source-backed slide', preferences: ['Keep the test deterministic'], requestedSlideCount: 1 };
      const deckPlan = canonicalizeDeckPlan({
        workingTitle: 'Compatibility probe', narrativeSummary: 'One local slide checks backend mutation and reopen.',
        slides: [{ narrativeRole: 'content', purpose: 'Verify editable output', takeaway: 'A generated compatibility probe remains editable and traceable.', contentRefs: [unit.id], semanticVisualType: 'none', targetDensity: 'balanced' }],
      }, {
        id: 'compatibility_probe', version: 1, createdAt: new Date().toISOString(), inputFingerprint: contentIR.hash,
        briefHash: briefHash(brief), allowedContentIds: new Set(contentIR.units.map((item) => item.id)), requestedSlideCount: 1,
      });
      compiled = compilePresentation(deckPlan, contentIR, templateIR, VARIANT_POLICIES[0]);
      const chosen = compiled.slides[0];
      const summarizeSlot = (slot) => {
        if (!slot) return null;
        const fontSizes = slot.sourceEvidence.flatMap((item) => item.fontSizesPt ?? []).sort((left, right) => left - right);
        return {
          role: slot.role, geometry: slot.geometry, provenance: slot.provenance, confidence: slot.confidence,
          sampleCount: slot.sampleCount,
          marginRatios: {
            left: Number((slot.geometry.x / templateIR.slideSize.width).toFixed(4)),
            top: Number((slot.geometry.y / templateIR.slideSize.height).toFixed(4)),
            right: Number(((templateIR.slideSize.width - slot.geometry.x - slot.geometry.width) / templateIR.slideSize.width).toFixed(4)),
            bottom: Number(((templateIR.slideSize.height - slot.geometry.y - slot.geometry.height) / templateIR.slideSize.height).toFixed(4)),
          },
          fontSizeRangePt: fontSizes.length ? [fontSizes[0], fontSizes.at(-1)] : null,
          sourceEvidence: slot.sourceEvidence, reasons: slot.reasons,
        };
      };
      if (report.lctInventory) report.lctInventory.inferredSlotEvidence = chosen.layoutCandidates.map((candidate) => ({
        sourcePart: candidate.sourcePart, title: summarizeSlot(candidate.slotEvidence.title), body: summarizeSlot(candidate.slotEvidence.body), visual: summarizeSlot(candidate.slotEvidence.visual),
      }));
      return { capability: { status: 'PASS', selectedLayout: chosen.layoutSourcePart, slotEvidence: chosen.layoutCandidates.map((candidate) => ({ sourcePart: candidate.sourcePart, title: summarizeSlot(candidate.slotEvidence.title), body: summarizeSlot(candidate.slotEvidence.body), visual: summarizeSlot(candidate.slotEvidence.visual) })) } };
    });

    await runStage('generatedMutation', async () => {
      if (!compiled || !contentIR || !templateIR) {
        return { capability: {
          status: 'UNKNOWN',
          reason: { code: report.capabilities.generationCompatibility.reason?.code ?? 'GENERATION_COMPATIBILITY_FAILED', message: 'Mutation was not attempted because the compatibility probe did not compile.' },
        } };
      }
      mutationPath = path.join(runDirectory, 'office-kit-generated-probe.pptx');
      const rendered = await new OfficeKitPptxRenderer().render({ compiledPresentation: compiled, contentIR, templateIR, templatePath: inputPath, outputPath: mutationPath, contentRoot: runDirectory });
      outputBytes = await readFile(mutationPath);
      const reopenedInspection = await inspectPptx(mutationPath);
      const outputPackage = await inspectOfficeKitPackage(outputBytes);
      const generatedCountMatches = outputPackage.slideCount === 1 && reopenedInspection.inspection.slides.length === 1;
      report.outputs.generatedMutation = {
        path: path.relative(outputPath, mutationPath), backend: rendered.backend, slideCount: rendered.slideCount,
        nativeObjectCounts: { text: rendered.nativeTextShapeCount, tables: rendered.nativeTableCount, charts: rendered.nativeChartCount, images: rendered.nativeImageCount, shapes: rendered.nativeShapeCount, connectors: rendered.nativeConnectorCount, notes: rendered.nativeNotesCount },
        reopenStatus: rendered.reopenStatus, validationStatus: outputPackage.validationIssues.some((issue) => issue.severity === 'error') ? 'FAIL' : 'PASS',
        templatePreservation: rendered.templatePreservationStatus, lctReopenSlideCount: reopenedInspection.inspection.slides.length,
      };
      report.capabilities.generatedSlideProjection = { status: generatedCountMatches ? 'PASS' : 'FAIL', sourceSlideCount: office?.slideCount ?? null, generatedSlideCount: rendered.slideCount };
      return { capability: { status: rendered.validationStatus === 'passed' && generatedCountMatches ? 'PASS' : 'FAIL', templatePreservation: rendered.templatePreservationStatus } };
    });

    if (outputBytes) await runStage('preview', async () => {
      const preview = await new OfficeKitPreviewAdapter().preview(outputBytes, 0);
      const svgPath = await runArtifact('generated-probe.svg', preview.svg);
      const pngPath = await runArtifact('generated-probe.png', preview.png);
      if (report.outputs.generatedMutation) report.outputs.generatedMutation.preview = {
        status: preview.status, textLayoutIssueCount: preview.textLayoutIssues.length,
        svg: path.relative(outputPath, svgPath), png: path.relative(outputPath, pngPath), limitations: preview.limitations,
      };
      return { capability: { status: preview.status === 'passed' ? 'PASS' : 'WARN', limitations: preview.limitations } };
    });

    if (report.outputs.generatedMutation?.templatePreservation) {
      const status = report.outputs.generatedMutation.templatePreservation;
      report.capabilities.templatePartPreservation = { status: status === 'passed' ? 'PASS' : status === 'failed' ? 'FAIL' : 'UNKNOWN', source: 'generated mutation' };
    }
  }

  report.capabilities.nativeOfficeOpen = { status: 'UNKNOWN', reason: { code: 'NOT_RUN', message: 'No Microsoft PowerPoint or LibreOffice open/save pass was run by this offline harness.' } };
  report.reasons.push('A successful Office application open/save pass is still required before production adoption.');
  report.reasons.push('Preview output is approximate and does not verify PowerPoint typography or table-cell overflow.');
  report.safeForOfficeKitBackend = 'no';
  const reportPath = path.join(outputPath, 'backend-compatibility-report.json');
  if (sourceBytes && inputPath && sourceSha256) await runStage('sourceByteIdentity', async () => {
    const finalHash = sha256(await readFile(inputPath));
    const identical = finalHash === sourceSha256;
    report.source.immutable = identical ? 'PASS' : 'FAIL';
    return { capability: { status: identical ? 'PASS' : 'FAIL', sha256: finalHash } };
  });
  await writeReportAtomically(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (sourceBytes && inputPath && sourceSha256) {
    const finalHash = sha256(await readFile(inputPath));
    if (finalHash !== report.capabilities.sourceByteIdentity.sha256) {
      const identical = finalHash === sourceSha256;
      report.source.immutable = identical ? 'PASS' : 'FAIL';
      report.capabilities.sourceByteIdentity = { status: identical ? 'PASS' : 'FAIL', sha256: finalHash };
      await writeReportAtomically(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    }
  }
  return { report, reportPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { reportPath, report } = await runPptxCompatibilityHarness(args.input, args.output);
    const capabilities = Object.fromEntries(Object.entries(report.capabilities).map(([name, result]) => [name, {
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
    }]));
    process.stdout.write(`${JSON.stringify({ reportPath, safeForOfficeKitBackend: report.safeForOfficeKitBackend, capabilities }, null, 2)}\n`);
    process.exitCode = report.capabilities.inputSafety.status === 'PASS'
      && report.capabilities.generationCompatibility.status === 'PASS'
      && report.capabilities.generatedMutation.status === 'PASS' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage()}\n`);
    process.exitCode = 1;
  }
}
