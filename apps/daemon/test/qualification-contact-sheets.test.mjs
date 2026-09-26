import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { generateQualificationContactSheets } from '../../../scripts/generate-qualification-contact-sheets.mjs';

const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pWQAAAAASUVORK5CYII=', 'base64');

test('qualification contact sheets render only available local previews and mark blocked variants withheld', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lct-contact-sheet-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const matrixRoot = path.join(root, 'matrix');
  const outputRoot = path.join(root, 'sheets');
  const variants = [];
  for (const variantId of ['A', 'B', 'C']) {
    const variantRoot = path.join(matrixRoot, 'template-1', `variant-${variantId.toLowerCase()}`);
    await mkdir(path.join(variantRoot, 'previews'), { recursive: true });
    await writeFile(path.join(variantRoot, 'previews', 'slide-01.png'), onePixelPng);
    const qualityPath = path.join(variantRoot, 'quality.json');
    const auditPath = path.join(variantRoot, 'audit.json');
    await writeFile(qualityPath, JSON.stringify({ categories: {
      hierarchy: { status: 'pass', severity: 'info', findingCount: 0, summary: 'No issue found.' },
      contrast: { status: 'unknown', severity: 'info', findingCount: 0, summary: 'Background map unavailable.' },
    } }));
    await writeFile(auditPath, JSON.stringify({ preview: { artifacts: [{ slideIndex: 0, png: 'previews/slide-01.png' }] } }));
    if (variantId === 'A') variants.push({ templateIndex: 1, variantId, auditPath, qualityPath, pptxPath: path.join(variantRoot, 'presentation.pptx') });
  }
  const matrixPath = path.join(matrixRoot, 'matrix.json');
  await writeFile(matrixPath, JSON.stringify({
    templateQualifications: [
      { templateIndex: 1, status: 'blocked', slides: [{ plannedSlideIndex: 1, intent: 'title' }], renderFailure: 'Variants B and C were withheld.' },
      { templateIndex: 2, status: 'blocked', slides: [{ plannedSlideIndex: 1, intent: 'content' }], renderFailure: 'Template did not qualify.' },
    ],
    outputs: variants,
  }));

  const results = await generateQualificationContactSheets({
    matrixPath,
    outputRoot,
    templateLabels: ['Synthetic template', 'Held-out template'],
  });
  assert.equal(results.length, 2);
  const firstQuality = JSON.parse(await readFile(results[0].qualityReport, 'utf8'));
  assert.equal(firstQuality.cells.length, 3);
  assert.deepEqual(firstQuality.cells.map((cell) => cell.status), ['preview-available', 'withheld', 'withheld']);
  assert.equal(firstQuality.cells[0].qualityCategories.contrast.status, 'unknown');
  const secondQuality = JSON.parse(await readFile(results[1].qualityReport, 'utf8'));
  assert.ok(secondQuality.cells.every((cell) => cell.status === 'withheld'));
  const image = await readFile(results[0].contactSheet);
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});
