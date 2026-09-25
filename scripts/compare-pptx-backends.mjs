#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
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

export async function runPptxCompatibilityHarness(inputValue, outputValue) {
  const inputCandidate = path.resolve(inputValue);
  const inputPath = await realpath(inputCandidate);
  const inputStat = await stat(inputPath);
  if (!inputStat.isFile() || inputStat.size < 1 || inputStat.size > MAX_INPUT_BYTES || path.extname(inputPath).toLowerCase() !== '.pptx') {
    throw new TypeError('Input must be a regular PPTX file no larger than 64 MiB');
  }
  const outputCandidate = path.resolve(outputValue);
  const sourceDirectory = path.dirname(inputCandidate);
  const resolvedSourceDirectory = path.dirname(inputPath);
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
  assertSeparateOutputDirectory(outputCandidate, sourceDirectory, inputCandidate);
  await mkdir(outputCandidate, { recursive: true });
  const outputPath = await realpath(outputCandidate);
  assertSeparateOutputDirectory(outputPath, resolvedSourceDirectory, inputPath);
  const sourceBytes = await readFile(inputPath);
  const sourceSha256 = sha256(sourceBytes);
  const report = {
    schemaVersion: 1,
    source: { sha256: sourceSha256, byteLength: sourceBytes.byteLength, path: path.basename(inputPath), immutable: 'UNKNOWN' },
    capabilities: {},
    officeKitInventory: null,
    lctInventory: null,
    outputs: {},
    safeForOfficeKitBackend: 'no',
    reasons: [],
  };

  const inspector = await inspectPptx(inputPath);
  const templateIR = createTemplateIR(inspector, {
    filePath: path.basename(inputPath), originalName: path.basename(inputPath), sha256: sourceSha256,
    compiledAt: new Date().toISOString(), compilerVersion: 'lct-template-compiler/1',
  });
  report.lctInventory = {
    slideCount: inspector.inspection.slides.length,
    masterCount: inspector.inspection.masters.length,
    layoutCount: inspector.inspection.layouts.length,
    placeholderCount: inspector.inspection.layouts.reduce((sum, layout) => sum + layout.elements.filter((element) => element.placeholder !== null).length, 0),
    relationshipCount: inspector.inspection.layouts.reduce((sum, layout) => sum + layout.relationships.length, 0)
      + inspector.inspection.masters.reduce((sum, master) => sum + master.relationships.length, 0)
      + inspector.inspection.slides.reduce((sum, slide) => sum + slide.relationships.length, 0),
  };
  report.capabilities.inputSafety = { status: 'PASS', maxBytes: MAX_INPUT_BYTES };
  report.capabilities.lctInspection = { status: 'PASS', templateIRHash: templateIR.hash, warnings: templateIR.warnings.length };

  const office = await inspectOfficeKitPackage(sourceBytes);
  const sourcePackage = await packageInventory(sourceBytes);
  report.officeKitInventory = { ...office, packagePartCount: sourcePackage.parts.length, packageRelationships: sourcePackage.relationships };
  report.capabilities.officeKitLoad = { status: 'PASS', slideCount: office.slideCount, masterCount: office.masterParts.length, layoutCount: office.layoutNames.length };

  const noOp = await new OfficeKitPptxDocumentAdapter().roundTrip(sourceBytes);
  const noOpPath = path.join(outputPath, 'office-kit-noop-roundtrip.pptx');
  await writeFile(noOpPath, noOp.pptx, { flag: 'wx' });
  const noOpInventory = await packageInventory(noOp.pptx);
  const noOpPreservation = await packagePreservation(sourceBytes, noOp.pptx);
  report.outputs.noOp = {
    path: path.basename(noOpPath),
    validationStatus: noOp.validationIssues.some((issue) => issue.severity === 'error') ? 'FAIL' : 'PASS',
    validationIssues: noOp.validationIssues,
    packagePartCount: noOpInventory.parts.length,
    partNameChanges: sourcePackage.parts.length === noOpInventory.parts.length ? 'none' : 'present',
    preservation: noOpPreservation,
  };
  report.capabilities.noOpRoundTrip = { status: report.outputs.noOp.validationStatus === 'PASS' && noOpPreservation.status === 'PASS' ? 'PASS' : 'FAIL' };

  const scratch = path.join(outputPath, 'probe-content');
  await mkdir(scratch, { recursive: true });
  await writeFile(path.join(scratch, 'evidence.md'), 'A generated compatibility probe remains editable and traceable.\n', { flag: 'wx' });
  const contentIR = await compileContentIR(outputPath, 'probe-content', ['evidence.md']);
  const unit = contentIR.units.find((item) => item.text);
  const brief = { audience: 'Template compatibility review', purpose: 'Exercise the generated-slide backend boundary', expectedOutcome: 'Create one editable source-backed slide', preferences: ['Keep the test deterministic'], requestedSlideCount: 1 };
  const deckPlan = canonicalizeDeckPlan({
    workingTitle: 'Compatibility probe', narrativeSummary: 'One local slide checks backend mutation and reopen.',
    slides: [{ narrativeRole: 'content', purpose: 'Verify editable output', takeaway: 'A generated compatibility probe remains editable and traceable.', contentRefs: [unit.id], semanticVisualType: 'none', targetDensity: 'balanced' }],
  }, {
    id: 'compatibility_probe', version: 1, createdAt: new Date().toISOString(), inputFingerprint: contentIR.hash,
    briefHash: briefHash(brief), allowedContentIds: new Set(contentIR.units.map((item) => item.id)), requestedSlideCount: 1,
  });
  const compiled = compilePresentation(deckPlan, contentIR, templateIR, VARIANT_POLICIES[0]);
  const mutationPath = path.join(outputPath, 'office-kit-generated-probe.pptx');
  const rendered = await new OfficeKitPptxRenderer().render({ compiledPresentation: compiled, contentIR, templateIR, templatePath: inputPath, outputPath: mutationPath, contentRoot: outputPath });
  const outputBytes = await readFile(mutationPath);
  const reopenedInspection = await inspectPptx(mutationPath);
  const preview = await new OfficeKitPreviewAdapter().preview(outputBytes, 0);
  await writeFile(path.join(outputPath, 'generated-probe.svg'), preview.svg, { flag: 'wx' });
  await writeFile(path.join(outputPath, 'generated-probe.png'), preview.png, { flag: 'wx' });
  const outputPackage = await inspectOfficeKitPackage(outputBytes);
  const generatedCountMatches = outputPackage.slideCount === 1;
  report.outputs.generatedMutation = {
    path: path.basename(mutationPath), backend: rendered.backend, slideCount: rendered.slideCount,
    nativeObjectCounts: { text: rendered.nativeTextShapeCount, tables: rendered.nativeTableCount, charts: rendered.nativeChartCount, images: rendered.nativeImageCount, shapes: rendered.nativeShapeCount, connectors: rendered.nativeConnectorCount, notes: rendered.nativeNotesCount },
    reopenStatus: rendered.reopenStatus, validationStatus: outputPackage.validationIssues.some((issue) => issue.severity === 'error') ? 'FAIL' : 'PASS',
    templatePreservation: rendered.templatePreservationStatus, lctReopenSlideCount: reopenedInspection.inspection.slides.length,
    preview: { status: preview.status, textLayoutIssueCount: preview.textLayoutIssues.length, svg: 'generated-probe.svg', png: 'generated-probe.png', limitations: preview.limitations },
  };
  report.capabilities.generatedSlideProjection = { status: generatedCountMatches && reopenedInspection.inspection.slides.length === 1 ? 'PASS' : 'FAIL', sourceSlideCount: office.slideCount, generatedSlideCount: rendered.slideCount };
  report.capabilities.generatedMutation = { status: rendered.validationStatus === 'passed' && generatedCountMatches ? 'PASS' : 'FAIL' };
  report.capabilities.preview = { status: preview.status === 'passed' ? 'PASS' : 'WARN', limitations: preview.limitations };
  report.capabilities.templatePartPreservation = { status: rendered.templatePreservationStatus === 'passed' ? 'PASS' : rendered.templatePreservationStatus === 'failed' ? 'FAIL' : 'UNKNOWN' };

  const finalHash = sha256(await readFile(inputPath));
  report.source.immutable = finalHash === sourceSha256 ? 'PASS' : 'FAIL';
  report.capabilities.sourceByteIdentity = { status: finalHash === sourceSha256 ? 'PASS' : 'FAIL' };
  report.capabilities.nativeOfficeOpen = { status: 'UNKNOWN', reason: 'No Microsoft PowerPoint or LibreOffice open/save pass was run by this offline harness.' };
  report.reasons.push('Real held-out organizer/user PPTX qualification and an Office application open/save pass are still required for production adoption.');
  report.reasons.push('Preview output is approximate and does not verify PowerPoint typography or table-cell overflow.');
  report.safeForOfficeKitBackend = 'no';
  const reportPath = path.join(outputPath, 'backend-compatibility-report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  return { report, reportPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { reportPath, report } = await runPptxCompatibilityHarness(args.input, args.output);
    process.stdout.write(`${JSON.stringify({ reportPath, safeForOfficeKitBackend: report.safeForOfficeKitBackend, capabilities: report.capabilities }, null, 2)}\n`);
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage()}\n`);
    process.exitCode = 1;
  }
}
