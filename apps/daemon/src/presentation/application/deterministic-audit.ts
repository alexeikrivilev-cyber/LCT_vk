import { createHash } from 'node:crypto';
import type { ContentIR } from '../domain/content-ir.js';
import type { TemplateIR } from '../domain/template-ir.js';
import type { CompiledPresentation, CompiledSlide, PlacementBox } from './slide-compilation.js';

/** Internal, replaceable audit findings. Contextual claims remain outside this deterministic module. */
export interface DeterministicAuditFinding {
  id: string;
  ruleId: string;
  slideId: string;
  elementIds: string[];
  severity: 'error' | 'warning' | 'info';
  message: string;
  evidence: Record<string, string | number | boolean | null>;
  autofixAvailable: boolean;
  suggestedRepair: string | null;
}

export interface DeterministicAuditReport {
  schemaVersion: 1;
  ruleSetVersion: typeof DETERMINISTIC_AUDIT_RULE_SET_VERSION;
  presentationId: string;
  findings: DeterministicAuditFinding[];
  checks: Array<{ ruleId: string; status: 'checked' | 'unknown' | 'not_applicable'; reason: string }>;
}

export const DETERMINISTIC_AUDIT_RULE_SET_VERSION = 'deterministic-audit.v1' as const;

function canonicalAuditJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalAuditJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalAuditJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Hash only audit evidence, excluding run-specific presentation identity and timestamps. */
export function canonicalDeterministicAuditSha256(report: DeterministicAuditReport): string {
  return createHash('sha256').update(canonicalAuditJson({
    schemaVersion: report.schemaVersion,
    ruleSetVersion: report.ruleSetVersion,
    findings: report.findings,
    checks: report.checks,
  })).digest('hex');
}

function overlaps(a: PlacementBox, b: PlacementBox): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function normalizeNumber(value: string): string {
  return value.replaceAll(' ', '').replace(/,(?=\d{3}(?:\D|$))/g, '').toLowerCase();
}

/** Keep dates, percentages and explicit currencies intact as one source fact. */
function numericFacts(value: string): string[] {
  const facts: string[] = [];
  let remaining = value;
  const take = (pattern: RegExp, map: (match: RegExpExecArray) => string) => {
    for (const match of remaining.matchAll(pattern)) facts.push(map(match as RegExpExecArray));
    remaining = remaining.replace(pattern, ' ');
  };
  take(/\b\d{4}-\d{2}-\d{2}\b/gu, (match) => `date:${match[0]}`);
  take(/(?:\b(?:USD|EUR|GBP|RUB|CAD|AUD|JPY|CNY)\s*-?\d[\d,]*(?:\.\d+)?|-?\d[\d,]*(?:\.\d+)?\s*\b(?:USD|EUR|GBP|RUB|CAD|AUD|JPY|CNY)\b)/giu,
    (match) => `currency:${match[0].replace(/\s+/g, '').replace(/(USD|EUR|GBP|RUB|CAD|AUD|JPY|CNY)/i, (code) => code.toUpperCase())}`);
  take(/[$€£₽¥]\s*-?\d[\d,]*(?:\.\d+)?/gu, (match) => `currency-symbol:${match[0].replaceAll(' ', '')}`);
  take(/-?\d[\d,]*(?:\.\d+)?(?:%|‰)/gu, (match) => `number-unit:${normalizeNumber(match[0])}`);
  facts.push(...(remaining.match(/-?\d[\d,]*(?:\.\d+)?/gu) ?? []).map((number) => `number:${normalizeNumber(number)}`));
  return facts;
}

function addFinding(
  findings: DeterministicAuditFinding[],
  input: Omit<DeterministicAuditFinding, 'id' | 'elementIds'> & { elementIds?: string[] },
): void {
  findings.push({ ...input, elementIds: input.elementIds ?? [], id: `finding_${input.slideId}_${input.ruleId}_${findings.length + 1}` });
}

export function auditCompiledPresentation(
  presentation: CompiledPresentation,
  contentIR: ContentIR,
  templateIR: TemplateIR,
): DeterministicAuditReport {
  const findings: DeterministicAuditFinding[] = [];
  const unitIds = new Set(contentIR.units.map((unit) => unit.id));
  const sourceById = new Map(contentIR.sources.map((source) => [source.id, source]));
  const sourceTextByUnit = new Map(contentIR.units
    .filter((unit) => sourceById.get(unit.sourceId)?.kind !== 'brief-task')
    .map((unit) => [unit.id, unit.text ?? unit.cellValue ?? unit.numericLexeme ?? '']));
  const seenContent = new Map<string, string>();

  for (const slide of presentation.slides) {
    const hasRenderableVisual = slide.imageRefs.length > 0 || Boolean(slide.visualization.tableData || slide.visualization.chartData
      || slide.visualization.kpi || slide.visualization.processSteps.length >= 2);
    if (slide.intent !== 'title' && slide.title.trim() && slide.body.every((line) => !line.trim()) && !hasRenderableVisual) {
      addFinding(findings, {
        slideId: slide.id,
        ruleId: 'integrity.title-only-slide',
        severity: 'warning',
        message: 'Non-cover slide contains only a title and has no body or visual evidence.',
        evidence: { intent: slide.intent },
        autofixAvailable: false,
        suggestedRepair: null,
      });
    }
    const boxes: Array<[string, PlacementBox]> = [
      ['title', slide.placements.title],
      ['body', slide.placements.body],
      ...(hasRenderableVisual && slide.placements.visual ? [['visual', slide.placements.visual] as [string, PlacementBox]] : []),
    ];
    for (const [label, box] of boxes) {
      const right = box.x + box.width;
      const bottom = box.y + box.height;
      if (box.x < 0 || box.y < 0 || right > templateIR.slideSize.width || bottom > templateIR.slideSize.height) {
        addFinding(findings, {
          slideId: slide.id,
          ruleId: 'geometry.out-of-bounds',
          severity: 'error',
          message: `Compiled ${label} placement extends outside the template canvas.`,
          evidence: { x: box.x, y: box.y, width: box.width, height: box.height, canvasWidth: templateIR.slideSize.width, canvasHeight: templateIR.slideSize.height },
          autofixAvailable: true,
          suggestedRepair: 'Select the next ranked compatible layout.',
        });
      }
    }
    if (overlaps(slide.placements.title, slide.placements.body)) {
      addFinding(findings, {
        slideId: slide.id,
        ruleId: 'geometry.text-slots-overlap',
        severity: 'error',
        message: 'Compiled title and body placements overlap.',
        evidence: { titleBodyOverlap: true },
        autofixAvailable: true,
        suggestedRepair: 'Select the next ranked compatible layout.',
      });
    }
    if (hasRenderableVisual && slide.placements.visual && (overlaps(slide.placements.title, slide.placements.visual)
        || overlaps(slide.placements.body, slide.placements.visual))) {
      addFinding(findings, {
        slideId: slide.id,
        ruleId: 'geometry.visual-slot-overlap',
        severity: 'warning',
        message: 'Compiled visual placement overlaps a text placement.',
        evidence: { visualTextOverlap: true },
        autofixAvailable: true,
        suggestedRepair: 'Select the next ranked compatible layout.',
      });
    }
    if (!slide.title.trim() && slide.body.every((line) => !line.trim())) {
      addFinding(findings, {
        slideId: slide.id,
        ruleId: 'integrity.blank-slide',
        severity: 'error',
        message: 'Compiled slide has no visible text.',
        evidence: { titleCharacters: slide.title.length, bodyLines: slide.body.length },
        autofixAvailable: false,
        suggestedRepair: null,
      });
    }
    const badText = [slide.title, ...slide.body].find((text) => /\b(?:lorem ipsum|todo|xxx)\b|вставьте текст/i.test(text));
    if (badText) {
      addFinding(findings, {
        slideId: slide.id,
        ruleId: 'integrity.placeholder-text',
        severity: 'warning',
        message: 'Compiled slide contains common placeholder text.',
        evidence: { text: badText.slice(0, 160) },
        autofixAvailable: false,
        suggestedRepair: null,
      });
    }
    const broken = slide.provenanceRefs.filter((id) => !unitIds.has(id));
    if (broken.length) {
      addFinding(findings, {
        slideId: slide.id,
        ruleId: 'integrity.broken-provenance',
        severity: 'error',
        message: 'One or more compiled provenance references do not exist in ContentIR.',
        evidence: { brokenReferenceCount: broken.length },
        autofixAvailable: false,
        suggestedRepair: null,
      });
    }
    const supported = new Set(slide.provenanceRefs.flatMap((id) => numericFacts(sourceTextByUnit.get(id) ?? '')));
    for (const fact of [...numericFacts(slide.title), ...slide.body.flatMap(numericFacts), ...(slide.visualization.tableData ?? []).flatMap((row) => row.flatMap(numericFacts))]) {
      if (!supported.has(fact)) {
        addFinding(findings, {
          slideId: slide.id,
          ruleId: 'fidelity.unsupported-number',
          severity: 'warning',
          message: 'A visible numeric value, date, percentage, or explicit currency is not present in the referenced source text.',
          evidence: { numericToken: fact },
          autofixAvailable: false,
          suggestedRepair: null,
        });
      }
    }
    const bullets = slide.body.filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line));
    if (bullets.length > 6) {
      addFinding(findings, {
        slideId: slide.id,
        ruleId: 'density.excessive-bullets',
        severity: 'warning',
        message: 'Compiled slide contains more than six explicit bullet lines.',
        evidence: { bulletCount: bullets.length },
        autofixAvailable: false,
        suggestedRepair: null,
      });
    }
    for (const bullet of bullets) {
      const text = bullet.replace(/^\s*(?:[-*•]|\d+[.)])\s+/u, '').trim();
      const wordCount = text ? text.split(/\s+/u).length : 0;
      if (wordCount > 15) {
        addFinding(findings, {
          slideId: slide.id,
          ruleId: 'density.long-bullet-copy',
          severity: 'warning',
          message: 'A bullet exceeds fifteen words; visual overflow still requires rendered-slide review.',
          evidence: { wordCount },
          autofixAvailable: false,
          suggestedRepair: null,
        });
      }
    }
    const table = slide.visualization.tableData;
    const tableCellRefs = slide.visualization.tableCellRefs;
    if (table && (!tableCellRefs || tableCellRefs.length !== table.length
        || table.some((row, rowIndex) => row.length !== tableCellRefs[rowIndex]?.length))) {
      addFinding(findings, {
        slideId: slide.id,
        ruleId: 'fidelity.table-source-reference',
        severity: 'error',
        message: 'Native table cells do not have a complete source ContentIR reference grid.',
        evidence: { rowCount: table.length },
        autofixAvailable: false,
        suggestedRepair: null,
      });
    } else if (table && tableCellRefs) {
      let mismatches = 0;
      table.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
        const ref = tableCellRefs[rowIndex]?.[columnIndex];
        const unit = contentIR.units.find((candidate) => candidate.id === ref);
        if (!unit || unit.kind !== 'table-cell' || unit.cellValue !== cell) mismatches += 1;
      }));
      if (mismatches) {
        addFinding(findings, {
          slideId: slide.id,
          ruleId: 'fidelity.table-source-reference',
          severity: 'error',
          message: 'One or more native table cells differ from their cited ContentIR values.',
          evidence: { mismatchedCellCount: mismatches },
          autofixAvailable: false,
          suggestedRepair: null,
        });
      }
    }
    if (table && (table.length > 7 || Math.max(...table.map((row) => row.length)) > 5)) {
      addFinding(findings, {
        slideId: slide.id,
        ruleId: 'density.table-limits',
        severity: 'warning',
        message: 'Native table exceeds the current seven-row or five-column review threshold.',
        evidence: { rowCount: table.length, columnCount: Math.max(...table.map((row) => row.length)) },
        autofixAvailable: false,
        suggestedRepair: null,
      });
    }
    if (slide.visualization.type !== 'none' && slide.visualization.status === 'unresolved') {
      addFinding(findings, {
        slideId: slide.id,
        ruleId: 'visualization.unresolved',
        severity: 'warning',
        message: 'The DeckPlan requests a visual type for which the current source references do not form a renderable native object.',
        evidence: { visualType: slide.visualization.type },
        autofixAvailable: false,
        suggestedRepair: null,
      });
    }
    if (slide.visualization.chartData) {
      const chart = slide.visualization.chartData;
      const missingLabelCount = Number(!chart.title.trim()) + Number(!chart.categories.length)
        + Number(!chart.series.length) + chart.series.filter((series) => !series.name.trim()).length;
      if (missingLabelCount) {
        addFinding(findings, {
          slideId: slide.id,
          ruleId: 'integrity.chart-labels-legend',
          severity: 'error',
          message: 'Chart title, categories, and series names are required to identify its data and legend.',
          evidence: { missingLabelCount },
          autofixAvailable: false,
          suggestedRepair: null,
        });
      }
      if (!chart.unit?.trim()) {
        addFinding(findings, {
          slideId: slide.id,
          ruleId: 'integrity.chart-unit-unknown',
          severity: 'warning',
          message: 'Chart units are not declared; confirm that source values are dimensionless or add a source-backed unit.',
          evidence: { unitDeclared: false },
          autofixAvailable: false,
          suggestedRepair: null,
        });
      }
      const chartUnits = new Map(contentIR.units.map((unit) => [unit.id, unit]));
      const allRefs = [...chart.categorySourceRefs, ...chart.provenanceRefs, ...chart.series.flatMap((series) => [series.nameSourceRef, ...series.sourceRefs])];
      const missingRefs = [...new Set(allRefs.filter((id) => !chartUnits.has(id)))];
      const outsideSlideRefs = [...new Set(allRefs.filter((id) => !slide.provenanceRefs.includes(id)))];
      const chartSourceIds = new Set(allRefs.map((id) => chartUnits.get(id)?.sourceId).filter((id): id is string => typeof id === 'string'));
      const unprovenRefs = [...new Set([...chart.categorySourceRefs, ...chart.series.flatMap((series) => [series.nameSourceRef, ...series.sourceRefs])]
        .filter((id) => !chart.provenanceRefs.includes(id)))];
      if (missingRefs.length || outsideSlideRefs.length || chartSourceIds.size > 1 || unprovenRefs.length) {
        addFinding(findings, {
          slideId: slide.id,
          ruleId: 'fidelity.chart-source-reference',
          severity: 'error',
          message: 'Native chart references must exist in one source table, the slide provenance, and chart provenance.',
          evidence: { missingReferenceCount: missingRefs.length, outsideSlideReferenceCount: outsideSlideRefs.length, mixedSourceCount: chartSourceIds.size, missingChartProvenanceCount: unprovenRefs.length },
          autofixAvailable: false,
          suggestedRepair: null,
        });
      }
      const invalidLabels: Array<{ kind: 'category' | 'series'; index: number }> = [];
      chart.categories.forEach((category, index) => {
        const unit = chartUnits.get(chart.categorySourceRefs[index] ?? '');
        if (!unit || unit.kind !== 'table-cell' || unit.cellValue !== category) invalidLabels.push({ kind: 'category', index });
      });
      chart.series.forEach((series, index) => {
        const unit = chartUnits.get(series.nameSourceRef);
        if (!unit || unit.kind !== 'table-cell' || unit.cellValue !== series.name || series.sourceRefs.length !== series.values.length) {
          invalidLabels.push({ kind: 'series', index });
        }
      });
      if (invalidLabels.length || chart.categorySourceRefs.length !== chart.categories.length) {
        addFinding(findings, {
          slideId: slide.id,
          ruleId: 'fidelity.chart-label-provenance',
          severity: 'error',
          message: 'Native chart categories and series names must match their cited source table cells.',
          evidence: { invalidLabelCount: invalidLabels.length, categoryReferenceCount: chart.categorySourceRefs.length, categoryCount: chart.categories.length },
          autofixAvailable: false,
          suggestedRepair: null,
        });
      }
      const invalidValues: Array<{ series: number; value: number; index: number }> = [];
      chart.series.forEach((series, seriesIndex) => series.values.forEach((value, index) => {
        const unit = chartUnits.get(series.sourceRefs[index] ?? '');
        if (!unit || typeof unit.numericLexeme !== 'string' || !Number.isFinite(value) || Number(unit.numericLexeme) !== value) {
          invalidValues.push({ series: seriesIndex, value, index });
        }
      }));
      if (invalidValues.length) {
        addFinding(findings, {
          slideId: slide.id,
          ruleId: 'fidelity.chart-numeric-provenance',
          severity: 'error',
          message: 'Native chart values are not directly traceable to the cited numeric ContentIR cells.',
          evidence: { invalidValueCount: invalidValues.length },
          autofixAvailable: false,
          suggestedRepair: null,
        });
      }
      if (chart.series.length > 5) {
        addFinding(findings, {
          slideId: slide.id,
          ruleId: 'density.chart-series',
          severity: 'warning',
          message: 'Native chart exceeds five visible series.',
          evidence: { seriesCount: chart.series.length },
          autofixAvailable: false,
          suggestedRepair: null,
        });
      }
    }
    if (slide.visualization.kpi) {
      const kpi = slide.visualization.kpi;
      const valueRef = kpi.sourceRefs.at(-1);
      const valueUnit = contentIR.units.find((unit) => unit.id === valueRef);
      if (!valueUnit || typeof valueUnit.numericLexeme !== 'string' || valueUnit.cellValue !== kpi.value) {
        addFinding(findings, {
          slideId: slide.id,
          ruleId: 'fidelity.kpi-numeric-provenance',
          severity: 'error',
          message: 'KPI value is not directly traceable to a cited numeric ContentIR cell.',
          evidence: { valueRef: valueRef ?? null },
          autofixAvailable: false,
          suggestedRepair: null,
        });
      }
    }
    if (slide.visualization.processSteps.length) {
      const invalidRefs = slide.visualization.processSteps.filter((step) => !unitIds.has(step.sourceRef));
      if (invalidRefs.length) {
        addFinding(findings, {
          slideId: slide.id,
          ruleId: 'integrity.process-source-reference',
          severity: 'error',
          message: 'One or more process steps do not reference source ContentIR units.',
          evidence: { invalidReferenceCount: invalidRefs.length },
          autofixAvailable: false,
          suggestedRepair: null,
        });
      }
    }
    for (const image of slide.imageRefs) {
      const source = contentIR.sources.find((item) => item.id === image.sourceId);
      if (!source || source.kind !== 'image' || source.sha256 !== image.sha256 || source.mediaType !== image.mediaType) {
        addFinding(findings, {
          slideId: slide.id,
          ruleId: 'integrity.visual-asset-reference',
          severity: 'error',
          message: 'Visual asset reference does not match its ContentIR image source.',
          evidence: { mediaRef: image.contentUnitId },
          autofixAvailable: false,
          suggestedRepair: null,
        });
      }
    }
    const normalized = [slide.title, ...slide.body].join('\n').replace(/\s+/g, ' ').trim().toLowerCase();
    const duplicate = seenContent.get(normalized);
    if (normalized && duplicate) {
      addFinding(findings, {
        slideId: slide.id,
        ruleId: 'integrity.duplicate-slide-content',
        severity: 'warning',
        message: 'Compiled text duplicates another slide.',
        evidence: { duplicateOfSlideId: duplicate },
        autofixAvailable: false,
        suggestedRepair: null,
      });
    } else if (normalized) seenContent.set(normalized, slide.id);
  }

  const templateLayoutIds = new Set(templateIR.layouts.map((layout) => layout.id));
  for (const slide of presentation.slides) {
    if (!templateLayoutIds.has(slide.layoutId)) {
      addFinding(findings, {
        slideId: slide.id,
        ruleId: 'template.invalid-layout',
        severity: 'error',
        message: 'Compiled slide references a layout absent from TemplateIR.',
        evidence: { layoutId: slide.layoutId },
        autofixAvailable: false,
        suggestedRepair: null,
      });
    }
  }

  return {
    schemaVersion: 1,
    ruleSetVersion: DETERMINISTIC_AUDIT_RULE_SET_VERSION,
    presentationId: presentation.id,
    findings,
    checks: [
      { ruleId: 'geometry.bounds', status: 'checked', reason: 'Uses measured compiled EMU placements and TemplateIR canvas dimensions.' },
      { ruleId: 'geometry.overlap', status: 'checked', reason: 'Checks measured title/body intersection and visual overlap against text placements.' },
      { ruleId: 'fidelity.numeric', status: 'checked', reason: 'Matches visible numeric tokens to source units explicitly referenced by the DeckPlan.' },
      { ruleId: 'fidelity.semantic', status: 'unknown', reason: 'Semantic entailment is not deterministically inferred.' },
      { ruleId: 'template.font-color-contrast', status: 'unknown', reason: 'The current compiler does not resolve inherited render styles or text contrast.' },
      { ruleId: 'density.table', status: 'checked', reason: 'Checks row and column counts when referenced CSV cells form a rectangular native table.' },
      { ruleId: 'density.chart-series', status: 'checked', reason: 'Checks series count for source-backed chart grids that compile to a native chart.' },
      { ruleId: 'fidelity.chart-numeric-provenance', status: 'checked', reason: 'Chart values compile only from complete numeric source cells and every emitted value is rechecked against its cited ContentIR cell.' },
      { ruleId: 'integrity.visual-asset-reference', status: 'checked', reason: 'Visual media refs are separate from factual citations and must match an inventoried ContentIR image source.' },
      { ruleId: 'integrity.title-only-slide', status: 'checked', reason: 'Non-cover slides with a title but no body or compiled visual evidence are reported; intentional title covers are exempt.' },
      { ruleId: 'integrity.chart-labels-legend', status: 'checked', reason: 'Compiled charts require a title, categories, and named series; missing declared units are reported as warnings because dimensionless data can be valid.' },
      { ruleId: 'density.long-bullet-copy', status: 'checked', reason: 'Warns when an explicit bullet exceeds fifteen words; this is a copy-length heuristic, not a visual-overflow measurement.' },
      { ruleId: 'rendered-overflow', status: 'unknown', reason: 'Text layout and clipping require a presentation renderer.' },
    ],
  };
}

/** At most one deterministic layout switch is attempted, then the deck is audited once more. */
export function repairCompiledPresentationOnce(
  presentation: CompiledPresentation,
  contentIR: ContentIR,
  templateIR: TemplateIR,
): { presentation: CompiledPresentation; report: DeterministicAuditReport; repairCount: 0 | 1 } {
  const first = auditCompiledPresentation(presentation, contentIR, templateIR);
  const repairableSlideIds = new Set(first.findings.filter((finding) => finding.autofixAvailable).map((finding) => finding.slideId));
  if (repairableSlideIds.size === 0) return { presentation, report: first, repairCount: 0 };
  let repaired = false;
  const slides = presentation.slides.map((slide) => {
    if (repaired || !repairableSlideIds.has(slide.id) || slide.layoutCandidates.length < 2) return slide;
    const nextIndex = Math.min(slide.selectedCandidateIndex + 1, slide.layoutCandidates.length - 1);
    if (nextIndex === slide.selectedCandidateIndex) return slide;
    const candidate = slide.layoutCandidates[nextIndex]!;
    repaired = true;
    return {
      ...slide,
      layoutId: candidate.layoutId,
      layoutSourcePart: candidate.sourcePart,
      placements: { title: candidate.titleBox, body: candidate.bodyBox, visual: candidate.visualBox },
      selectedCandidateIndex: nextIndex,
    };
  });
  const result = repaired ? { ...presentation, slides } : presentation;
  return { presentation: result, report: auditCompiledPresentation(result, contentIR, templateIR), repairCount: repaired ? 1 : 0 };
}
