/** Internal, replaceable request/response boundary; the final product specification may revise it. */
export const CONTEXTUAL_AUDIT_GATES = [
  'title_takeaway',
  'content_supports_title',
  'one_sentence_summary',
  'facts_grounded',
  'visual_relevance',
  'prompt_garbage',
  'language_consistency',
  'adjacent_narrative',
] as const;

export type ContextualAuditGate = typeof CONTEXTUAL_AUDIT_GATES[number];
export type ContextualAuditResult = 'pass' | 'fail' | 'unknown';

export interface ContextualSlideAuditRequest {
  slideId: string;
  renderedSlide: { mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string };
  title: string;
  body: string[];
  provenanceEvidence: Array<{ contentRef: string; text: string }>;
  previousSlideSummary: string | null;
  nextSlideSummary: string | null;
}

export interface ContextualSlideAuditFinding {
  gate: ContextualAuditGate;
  result: ContextualAuditResult;
  rationale: string;
  evidenceRefs: string[];
}

export interface ContextualSlideAuditResponse {
  schemaVersion: 1;
  slideId: string;
  findings: ContextualSlideAuditFinding[];
}

/** Called as a bounded Supervisor capability; this does not introduce a third runtime agent. */
export interface ContextualSlideAuditPort {
  review(request: ContextualSlideAuditRequest, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ContextualSlideAuditResponse>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Reject malformed or partial contextual findings before they enter persisted audit state. */
export function validateContextualSlideAuditResponse(value: unknown, expectedSlideId: string): ContextualSlideAuditResponse {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'slideId', 'findings']) || value.schemaVersion !== 1
      || value.slideId !== expectedSlideId || !Array.isArray(value.findings) || value.findings.length !== CONTEXTUAL_AUDIT_GATES.length) {
    throw new TypeError('Contextual slide audit response has an invalid shape');
  }
  const seen = new Set<string>();
  const findings = value.findings.map((item) => {
    if (!isRecord(item) || !exactKeys(item, ['gate', 'result', 'rationale', 'evidenceRefs'])) {
      throw new TypeError('Contextual slide audit finding is invalid');
    }
    const gate = item.gate;
    if (typeof gate !== 'string' || !CONTEXTUAL_AUDIT_GATES.includes(gate as ContextualAuditGate)
        || !['pass', 'fail', 'unknown'].includes(String(item.result))
        || typeof item.rationale !== 'string' || item.rationale.trim().length === 0 || item.rationale.length > 500
        || !Array.isArray(item.evidenceRefs) || item.evidenceRefs.length > 8
        || item.evidenceRefs.some((ref) => typeof ref !== 'string' || ref.length === 0 || ref.length > 128)) {
      throw new TypeError('Contextual slide audit finding is invalid');
    }
    if (seen.has(gate)) throw new TypeError('Contextual slide audit gates must be unique');
    seen.add(gate);
    return {
      gate: gate as ContextualAuditGate,
      result: item.result as ContextualAuditResult,
      rationale: item.rationale,
      evidenceRefs: [...item.evidenceRefs] as string[],
    };
  });
  if (seen.size !== CONTEXTUAL_AUDIT_GATES.length) throw new TypeError('Contextual slide audit response omitted a required gate');
  return { schemaVersion: 1, slideId: expectedSlideId, findings };
}
