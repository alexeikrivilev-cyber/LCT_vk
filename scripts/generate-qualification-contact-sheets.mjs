#!/usr/bin/env node

import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { OfficeKitPreviewAdapter } from '../apps/daemon/src/presentation/adapters/office-kit-preview-adapter.js';

const require = createRequire(new URL('../apps/daemon/package.json', import.meta.url));
const PptxGenJS = require('pptxgenjs');
const VARIANTS = ['A', 'B', 'C'];

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function slug(value) {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/gu, '') || 'template';
}

function usage() {
  return 'Usage: node --import tsx scripts/generate-qualification-contact-sheets.mjs --matrix matrix.json --out contact-sheets-dir --labels "VK Tech,WorkSpace,Education,AIOS,ЛЦТ2026"';
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--matrix', '--out', '--labels'].includes(key)) throw new Error(`Unknown option: ${key}`);
    const value = argv[++index];
    if (!value) throw new Error(`${key} requires a value`);
    result[key.slice(2)] = value;
  }
  if (!result.matrix || !result.out || !result.labels) throw new Error(usage());
  result.labels = result.labels.split(',').map((label) => label.trim()).filter(Boolean);
  return result;
}

async function readVariantEvidence(output) {
  const auditPath = path.resolve(output.auditPath);
  const qualityPath = output.qualityPath ? path.resolve(output.qualityPath) : null;
  const audit = JSON.parse(await readFile(auditPath, 'utf8'));
  const quality = qualityPath ? JSON.parse(await readFile(qualityPath, 'utf8')) : null;
  const previewImages = new Map((audit.preview?.artifacts ?? []).filter((item) => record(item) && Number.isSafeInteger(item.slideIndex)
    && typeof item.png === 'string').map((item) => [item.slideIndex + 1, path.resolve(path.dirname(auditPath), item.png)]));
  return { quality, previewImages };
}

function categorySummary(quality) {
  if (!record(quality?.categories)) return null;
  return Object.fromEntries(Object.entries(quality.categories).map(([category, value]) => [category, {
    status: value.status,
    severity: value.severity,
    findingCount: value.findingCount,
    summary: value.summary,
  }]));
}

async function renderContactSheet(label, qualification, outputs, outputDirectory) {
  const rows = qualification.slides?.length ?? 0;
  const sourceOutputs = new Map(outputs.filter((output) => output.templateIndex === qualification.templateIndex)
    .map((output) => [output.variantId, output]));
  const variants = new Map();
  for (const variant of VARIANTS) {
    const output = sourceOutputs.get(variant);
    if (output) {
      try {
        variants.set(variant, { output, ...(await readVariantEvidence(output)) });
      } catch (error) {
        variants.set(variant, { output, failure: error instanceof Error ? error.message : 'Artifact evidence is unreadable.' });
      }
    }
  }

  const sheetWidth = 13.333;
  const leftMargin = 0.28;
  const leftLabelWidth = 0.52;
  const columnGap = 0.12;
  const thumbWidth = (sheetWidth - leftMargin * 2 - leftLabelWidth - columnGap * 2) / 3;
  const thumbHeight = thumbWidth * 9 / 16;
  const headerHeight = 0.48;
  const rowGap = 0.12;
  const rowHeight = thumbHeight + rowGap;
  const sheetHeight = Math.max(1.4, headerHeight + Math.max(rows, 1) * rowHeight + 0.16);
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'LCT_QUALIFICATION_SHEET', width: sheetWidth, height: sheetHeight });
  pptx.layout = 'LCT_QUALIFICATION_SHEET';
  pptx.author = 'LCT offline qualification tooling';
  pptx.subject = 'Local generated previews; no inference is performed';
  pptx.title = `${label} qualification contact sheet`;
  pptx.theme = { headFontFace: 'Aptos', bodyFontFace: 'Aptos', lang: 'ru-RU' };
  const slide = pptx.addSlide();
  slide.background = { color: 'F4F6F8' };
  slide.addText(label, { x: leftMargin, y: 0.1, w: 4.7, h: 0.28, fontFace: 'Aptos Display', fontSize: 17, bold: true, color: '17324D', margin: 0 });
  slide.addText(`Planned slides: ${rows} · A / B / C`, { x: sheetWidth - 4.2, y: 0.14, w: 3.9, h: 0.22, fontFace: 'Aptos', fontSize: 10, color: '435466', align: 'right', margin: 0 });

  for (let variantIndex = 0; variantIndex < VARIANTS.length; variantIndex += 1) {
    const variant = VARIANTS[variantIndex];
    const x = leftMargin + leftLabelWidth + variantIndex * (thumbWidth + columnGap);
    slide.addText(variant, { x, y: 0.42, w: thumbWidth, h: 0.24, fontFace: 'Aptos Display', fontSize: 12, bold: true, color: '17324D', align: 'center', margin: 0 });
  }

  const cellEvidence = [];
  for (let row = 0; row < Math.max(rows, 1); row += 1) {
    const plannedSlide = qualification.slides?.[row];
    const y = headerHeight + row * rowHeight;
    slide.addText(String(row + 1).padStart(2, '0'), { x: leftMargin, y: y + thumbHeight / 2 - 0.1, w: leftLabelWidth - 0.05, h: 0.2, fontFace: 'Aptos', fontSize: 9, color: '435466', align: 'center', margin: 0 });
    for (let variantIndex = 0; variantIndex < VARIANTS.length; variantIndex += 1) {
      const variant = VARIANTS[variantIndex];
      const x = leftMargin + leftLabelWidth + variantIndex * (thumbWidth + columnGap);
      const evidence = variants.get(variant);
      const output = evidence?.output;
      const pngPath = evidence?.previewImages?.get(row + 1);
      const variantStatus = output ? (pngPath && !evidence.failure ? 'preview-available' : 'withheld') : 'withheld';
      const plannedVariant = plannedSlide?.variants?.find((item) => item.variantId === variant);
      const rejectedCandidate = plannedVariant?.candidateDiagnostics?.find((item) => item.rejectReason)
        ?? plannedVariant?.candidateDiagnostics?.find((item) => item.gate && item.gate !== 'passed');
      const withheldReason = evidence?.failure ?? rejectedCandidate?.rejectReason
        ?? (rejectedCandidate?.gate ? `${rejectedCandidate.gate}: ${rejectedCandidate.evidence?.[0] ?? 'no safe composition candidate passed'}` : null)
        ?? qualification.renderFailure ?? qualification.profileFailure ?? 'No generated preview was qualified.';
      if (pngPath && !evidence.failure) {
        slide.addImage({ path: pngPath, x, y, w: thumbWidth, h: thumbHeight });
      } else {
        slide.addShape('rect', { x, y, w: thumbWidth, h: thumbHeight, line: { color: 'B5C2CE', width: 0.8 }, fill: { color: 'E7ECF0' } });
        slide.addText(`WITHHELD\n${withheldReason.slice(0, 150)}`, {
          x: x + 0.12, y: y + thumbHeight * 0.31, w: thumbWidth - 0.24, h: thumbHeight * 0.38,
          fontFace: 'Aptos', fontSize: 10, color: '5B6570', align: 'center', valign: 'mid', breakLine: false, margin: 0.04,
        });
      }
      slide.addShape('rect', { x, y, w: thumbWidth, h: thumbHeight, line: { color: 'B5C2CE', width: 0.7 }, fill: { color: 'FFFFFF', transparency: 100 } });
      const summary = categorySummary(evidence?.quality);
      cellEvidence.push({
        slideIndex: row + 1,
        intent: plannedSlide?.intent ?? null,
        variantId: variant,
        status: variantStatus,
        previewPath: pngPath ?? null,
        artifactPath: output?.pptxPath ?? null,
        qualityCategories: summary,
        withheldReason: variantStatus === 'withheld'
          ? withheldReason : null,
      });
    }
  }

  const outputPngPath = path.join(outputDirectory, 'contact-sheet.png');
  const outputJsonPath = path.join(outputDirectory, 'quality.json');
  await mkdir(outputDirectory, { recursive: true });
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'lct-qualification-sheet-'));
  try {
    const tempPptx = path.join(tempDirectory, 'sheet.pptx');
    await pptx.writeFile({ fileName: tempPptx });
    const bytes = await readFile(tempPptx);
    const preview = await new OfficeKitPreviewAdapter().preview(bytes, 0, 1920);
    const temporaryPng = path.join(outputDirectory, '.contact-sheet.tmp.png');
    const temporaryJson = path.join(outputDirectory, '.quality.tmp.json');
    await Promise.all([
      writeFile(temporaryPng, preview.png),
      writeFile(temporaryJson, `${JSON.stringify({
        schemaVersion: 1,
        reportKind: 'qualification-contact-sheet-quality',
        template: { index: qualification.templateIndex, label, status: qualification.status, plannedSlides: rows },
        contactSheet: 'contact-sheet.png',
        previewLimitations: preview.limitations,
        cells: cellEvidence,
        variantReports: VARIANTS.flatMap((variantId) => {
          const item = variants.get(variantId);
          return item?.quality ? [{ variantId, quality: item.quality }] : [];
        }),
      }, null, 2)}\n`, 'utf8'),
    ]);
    await Promise.all([rename(temporaryPng, outputPngPath), rename(temporaryJson, outputJsonPath)]);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
  return { templateIndex: qualification.templateIndex, label, status: qualification.status, plannedSlides: rows, contactSheet: outputPngPath, qualityReport: outputJsonPath };
}

export async function generateQualificationContactSheets({ matrixPath, outputRoot, templateLabels }) {
  const matrix = JSON.parse(await readFile(matrixPath, 'utf8'));
  if (!record(matrix) || !Array.isArray(matrix.templateQualifications) || !Array.isArray(matrix.outputs)) {
    throw new TypeError('Matrix file must contain templateQualifications and outputs arrays');
  }
  if (!Array.isArray(templateLabels) || templateLabels.length !== matrix.templateQualifications.length
      || templateLabels.some((label) => typeof label !== 'string' || !label.trim())) {
    throw new TypeError(`Provide one non-empty display label for each of the ${matrix.templateQualifications.length} templates`);
  }
  const root = path.resolve(outputRoot);
  await mkdir(root, { recursive: true });
  const results = [];
  for (let index = 0; index < matrix.templateQualifications.length; index += 1) {
    const qualification = matrix.templateQualifications[index];
    if (!Number.isSafeInteger(qualification.templateIndex) || !Array.isArray(qualification.slides)) {
      throw new TypeError(`Template qualification ${index + 1} is missing a stable index or planned slide rows`);
    }
    results.push(await renderContactSheet(templateLabels[index].trim(), qualification, matrix.outputs, path.join(root, `${String(qualification.templateIndex).padStart(2, '0')}-${slug(templateLabels[index])}`)));
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const results = await generateQualificationContactSheets({ matrixPath: args.matrix, outputRoot: args.out, templateLabels: args.labels });
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Contact sheet generation failed'}\n`);
    process.exitCode = 64;
  }
}
