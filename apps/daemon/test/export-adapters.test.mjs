import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'tsx/esm/api';

register();
const { SemanticHtmlExportAdapter } = await import('../src/presentation/adapters/semantic-html-export-adapter.ts');

test('semantic HTML export keeps slide structure and escapes untrusted title/body/table text', async () => {
  const adapter = new SemanticHtmlExportAdapter();
  const compiledPresentation = {
    slides: [{
      sourceDeckPlanSlideId: 'slide-1',
      title: '<script>alert(1)</script>',
      body: ['</style><script>steal()</script>'],
      imageRefs: [],
      visualization: {
        type: 'table', status: 'referenced', sourceRefs: [], tableData: [['Header'], ['<img src=x onerror=alert(1)>']],
        tableCellRefs: [[], []], chartData: null, processSteps: [], kpi: null,
      },
      placements: {
        title: { x: 0, y: 0, width: 500, height: 100, unit: 'EMU' },
        body: { x: 0, y: 100, width: 500, height: 200, unit: 'EMU' },
        visual: { x: 0, y: 300, width: 500, height: 200, unit: 'EMU' },
      },
    }],
  };
  const bytes = await adapter.export({
    compiledPresentation,
    contentIR: { units: [] },
    templateIR: { slideSize: { width: 1000, height: 600 }, layouts: [], masters: [] },
    contentRoot: process.cwd(),
  });
  const html = bytes.toString('utf8');
  assert.match(html, /<main>[\s\S]*<section class="slide"[\s\S]*<h1 class="slide-title"/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script>|<img src=x/);
});

test('semantic HTML derives dark slide background and readable theme foreground from the selected template layout', async () => {
  const adapter = new SemanticHtmlExportAdapter();
  const compiledPresentation = {
    slides: [{
      sourceDeckPlanSlideId: 'slide-dark', layoutId: 'layout-dark', title: 'Dark slide', body: ['Readable copy'], imageRefs: [],
      visualization: { type: 'none', status: 'none', sourceRefs: [], tableData: null, tableCellRefs: null, chartData: null, processSteps: [], kpi: null },
      placements: {
        title: { x: 0, y: 0, width: 500, height: 100, unit: 'EMU' },
        body: { x: 0, y: 100, width: 500, height: 200, unit: 'EMU' }, visual: null,
      },
    }],
  };
  const html = (await adapter.export({
    compiledPresentation,
    contentIR: { units: [] },
    templateIR: {
      slideSize: { width: 1000, height: 600 },
      layouts: [{ id: 'layout-dark', masterId: null, background: { kind: 'explicit', fill: { colors: [{ type: 'schemeClr', attributes: { val: 'dk1' }, position: null }] } } }],
      masters: [],
    },
    designSystem: {
      colors: { theme: [{ name: 'dk1', value: '101010' }, { name: 'lt1', value: 'FAFAFA' }, { name: 'accent1', value: '35A2FF' }] },
      typography: { theme: { major: 'Aptos Display', minor: 'Aptos' }, observedSizesPt: [] },
    },
    contentRoot: process.cwd(),
  })).toString('utf8');
  assert.match(html, /--slide-background:#101010;--slide-foreground:#fafafa/);
});
