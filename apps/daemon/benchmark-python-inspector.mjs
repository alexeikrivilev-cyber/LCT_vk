import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { makeSyntheticPptx } from './python-inspector-test-fixtures.mjs';
import { inspectPptx } from './dist/presentation/adapters/python-inspector.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'lct-inspector-benchmark-'));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const range = (values) => ({ min: Math.min(...values), median: median(values), max: Math.max(...values) });
const cases = [
  { name: 'transitional-small', strict: false, slideCount: 1, layoutCount: 2 },
  { name: 'strict-medium', strict: true, slideCount: 4, layoutCount: 3 },
  { name: 'transitional-large', strict: false, slideCount: 12, layoutCount: 4 },
];

try {
  const rows = [];
  for (const fixture of cases) {
    const input = path.join(root, `${fixture.name}.pptx`);
    const bytes = await makeSyntheticPptx(fixture);
    await writeFile(input, bytes);
    const coldStart = performance.now();
    const coldResult = await inspectPptx(input);
    const coldWallMs = performance.now() - coldStart;

    const wallMs = [];
    const inspectionMs = [];
    for (let run = 0; run < 7; run += 1) {
      const started = performance.now();
      const result = await inspectPptx(input);
      wallMs.push(performance.now() - started);
      inspectionMs.push(result.inspectionMs);
    }
    rows.push({
      fixture: fixture.name,
      inputBytes: bytes.length,
      slides: coldResult.inspection.slides.length,
      firstCall: { processWallMs: Number(coldWallMs.toFixed(2)), inspectionMs: Number(coldResult.inspectionMs.toFixed(2)) },
      repeated7: {
        processWallMs: Object.fromEntries(Object.entries(range(wallMs)).map(([key, value]) => [key, Number(value.toFixed(2))])),
        inspectionMs: Object.fromEntries(Object.entries(range(inspectionMs)).map(([key, value]) => [key, Number(value.toFixed(2))])),
      },
    });
  }
  process.stdout.write(`${JSON.stringify({ repeatsPerFixture: 7, rows }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}