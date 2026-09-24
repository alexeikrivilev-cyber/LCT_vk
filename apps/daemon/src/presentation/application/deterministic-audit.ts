import type { ContentIR } from '../domain/content-ir.js';
import type { TemplateIR } from '../domain/template-ir.js';
import type { CompiledPresentation, CompiledSlide } from './slide-compilation.js';

/** Internal, replaceable audit findings. Contextual claims remain outside this deterministic module. */
export interface DeterministicAuditFinding {
  id: string;
  ruleId: string;
  slideId: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  evidence: Record<string, string | number | boolean | null>;
  autofixAvailable: boolean;
  suggestedRepair: string | null;
}

export interface DeterministicAuditReport {
  schemaVersion: 1;
  ruleSetVersion: 'deterministic-audit.v1';
  presentationId: string;
  findings: DeterministicAuditFinding[];
  checks: Array<{ ruleId: string; status: 'checked' | 'unknown' | 'not_applicable'; reason: string }>;
}

function overlaps(a: CompiledSlide['placements'][keyof CompiledSlide['placements']], b: CompiledSlide['placements'][keyof CompiledSlide['placements']]): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function numericTokens(value: string): string[] {
  return value.match(/(?:[$€£]\s*)?-?\d[\d,]*(?:\.\d+)?(?:%|‰)?/gu) ?? [];
}

function normalizeNumber(value: string): string {
  return value.replaceAll(' ', '').replace(/,(?=\d{3}(?:\D|$))/g, '').toLowerCase();
}

function addFinding(
  findings: DeterministicAuditFinding[],
  input: Omit<DeterministicAuditFinding, 'id'>,
): void {
  findings.push({ ...input, id: `finding_${input.slideId}_${input.ruleId}_${findings.length + 1}` });
}

export function auditCompiledPresentation(
  presentation: CompiledPresentation,
  contentIR: ContentIR,
  templateIR: TemplateIR,
): DeterministicAuditReport {
  const findings: DeterministicAuditFinding[] = [];
  const unitIds = new Set(contentIR.units.map((unit) => unit.id));
  const sourceTextByUnit = new Map(contentIR.units.map((unit) => [unit.id, unit.text ?? unit.cellValue ?? unit.numericLexeme ?? '']));
  const seenContent = new Map<string, string>();

  for (const slide of presentation.slides) {
    const boxes = [slide.placements.title, slide.placements.body];
    for (const [index, box] of boxes.entries()) {
      const label = index === 0 ? 'title' : 'body';
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
    const supported = new Set(slide.provenanceRefs.flatMap((id) => numericTokens(sourceTextByUnit.get(id) ?? '').map(normalizeNumber)));
    for (const number of [...numericTokens(slide.title), ...slide.body.flatMap(numericTokens)]) {
      if (!supported.has(normalizeNumber(number))) {
        addFinding(findings, {
          slideId: slide.id,
          ruleId: 'fidelity.unsupported-number',
          severity: 'warning',
          message: 'A visible numeric value is not present in the referenced source text.',
          evidence: { numericToken: number },
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
    const table = slide.visualization.tableData;
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
    ruleSetVersion: 'deterministic-audit.v1',
    presentationId: presentation.id,
    findings,
    checks: [
      { ruleId: 'geometry.bounds', status: 'checked', reason: 'Uses measured compiled EMU placements and TemplateIR canvas dimensions.' },
      { ruleId: 'geometry.overlap', status: 'checked', reason: 'Checks the compiled title and body boxes.' },
      { ruleId: 'fidelity.numeric', status: 'checked', reason: 'Matches visible numeric tokens to source units explicitly referenced by the DeckPlan.' },
      { ruleId: 'fidelity.semantic', status: 'unknown', reason: 'Semantic entailment is not deterministically inferred.' },
      { ruleId: 'template.font-color-contrast', status: 'unknown', reason: 'The current compiler does not resolve inherited render styles or text contrast.' },
      { ruleId: 'density.table', status: 'checked', reason: 'Checks row and column counts when referenced CSV cells form a rectangular native table.' },
      { ruleId: 'density.chart-series', status: 'unknown', reason: 'The current compiled representation has no native chart series contract.' },
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
      placements: { title: candidate.titleBox, body: candidate.bodyBox },
      selectedCandidateIndex: nextIndex,
    };
  });
  const result = repaired ? { ...presentation, slides } : presentation;
  return { presentation: result, report: auditCompiledPresentation(result, contentIR, templateIR), repairCount: repaired ? 1 : 0 };
}
