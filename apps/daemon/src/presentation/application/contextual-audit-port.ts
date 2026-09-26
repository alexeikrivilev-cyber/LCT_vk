/** Internal replaceable boundary for one text-only review of the selected deck. */
export const CONTEXTUAL_AUDIT_RULES = [
  'titleTakeaway',
  'titleContentAlignment',
  'factGrounding',
  'visualSemanticFit',
  'languageConsistency',
  'narrativeContinuity',
  'redundancy',
  'garbage',
  'oneSentenceSummary',
] as const;

export type ContextualAuditRule = typeof CONTEXTUAL_AUDIT_RULES[number];
export type ContextualAuditSeverity = 'info' | 'warning' | 'error';

export const CONTEXTUAL_AUDIT_MESSAGE_CODES = {
  titleTakeaway: ['TITLE_TAKEAWAY_CLEAR', 'TITLE_TAKEAWAY_REVIEW'],
  titleContentAlignment: ['TITLE_CONTENT_ALIGNED', 'TITLE_CONTENT_MISMATCH'],
  factGrounding: ['FACTS_GROUNDED', 'FACTS_UNGROUNDED'],
  visualSemanticFit: ['VISUAL_SEMANTIC_FIT', 'VISUAL_SEMANTIC_MISMATCH'],
  languageConsistency: ['LANGUAGE_CONSISTENT', 'LANGUAGE_MIXED'],
  narrativeContinuity: ['NARRATIVE_CONTINUOUS', 'NARRATIVE_BREAK'],
  redundancy: ['NO_REDUNDANCY', 'CONTENT_REPEATED'],
  garbage: ['NO_PROMPT_GARBAGE', 'PROMPT_GARBAGE'],
  oneSentenceSummary: ['SUMMARY_CLEAR', 'SUMMARY_UNCLEAR'],
} as const satisfies Record<ContextualAuditRule, readonly [string, string]>;

export const CONTEXTUAL_AUDIT_ACTION_CODES = [
  'REVIEW_TITLE',
  'CHECK_SOURCE',
  'REVIEW_VISUAL',
  'CHECK_LANGUAGE',
  'REVIEW_NARRATIVE',
  'REVIEW_DUPLICATE',
  'REMOVE_INSTRUCTIONS',
  'SIMPLIFY_SLIDE',
] as const;

export type ContextualAuditActionCode = typeof CONTEXTUAL_AUDIT_ACTION_CODES[number];

export interface ContextualDeckAuditFinding {
  ruleId: ContextualAuditRule;
  slideId: string | null;
  severity: ContextualAuditSeverity;
  messageCode: typeof CONTEXTUAL_AUDIT_MESSAGE_CODES[ContextualAuditRule][number];
  evidenceRefs: string[];
  repairable: boolean;
  suggestedActionCode: ContextualAuditActionCode | null;
}

export interface ContextualDeckAuditResponse {
  schemaVersion: 1;
  findings: ContextualDeckAuditFinding[];
}

export interface ContextualDeckAuditValidationContext {
  slideContentRefs: ReadonlyMap<string, ReadonlySet<string>>;
  knownEvidenceRefs: ReadonlySet<string>;
}

const JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    findings: {
      type: 'array', minItems: CONTEXTUAL_AUDIT_RULES.length, maxItems: CONTEXTUAL_AUDIT_RULES.length,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          ruleId: { type: 'string', enum: [...CONTEXTUAL_AUDIT_RULES] },
          slideId: { type: ['string', 'null'], maxLength: 128 },
          severity: { type: 'string', enum: ['info', 'warning', 'error'] },
          messageCode: { type: 'string', enum: Object.values(CONTEXTUAL_AUDIT_MESSAGE_CODES).flat() },
          evidenceRefs: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 128 } },
          repairable: { type: 'boolean' },
          suggestedActionCode: { type: ['string', 'null'], enum: [...CONTEXTUAL_AUDIT_ACTION_CODES, null] },
        },
        required: ['ruleId', 'slideId', 'severity', 'messageCode', 'evidenceRefs', 'repairable', 'suggestedActionCode'],
      },
    },
  },
  required: ['schemaVersion', 'findings'],
} as const;

export function contextualDeckAuditSchema(): Readonly<Record<string, unknown>> {
  return JSON_SCHEMA;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** Strictly validate model output and bind citations to the slide they claim to support. */
export function validateContextualDeckAuditResponse(
  value: unknown,
  context: ContextualDeckAuditValidationContext,
): ContextualDeckAuditResponse {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'findings']) || value.schemaVersion !== 1
      || !Array.isArray(value.findings) || value.findings.length !== CONTEXTUAL_AUDIT_RULES.length) {
    throw new TypeError('Contextual deck audit response has an invalid shape');
  }
  const seen = new Set<string>();
  const findings = value.findings.map((item) => {
    if (!isRecord(item) || !exactKeys(item, ['ruleId', 'slideId', 'severity', 'messageCode', 'evidenceRefs', 'repairable', 'suggestedActionCode'])) {
      throw new TypeError('Contextual deck audit finding has an invalid shape');
    }
    const ruleId = item.ruleId;
    if (typeof ruleId !== 'string' || !CONTEXTUAL_AUDIT_RULES.includes(ruleId as ContextualAuditRule) || seen.has(ruleId)) {
      throw new TypeError('Contextual deck audit rule IDs must be known and unique');
    }
    seen.add(ruleId);
    const rule = ruleId as ContextualAuditRule;
    const slideId = item.slideId;
    if (slideId !== null && (typeof slideId !== 'string' || !context.slideContentRefs.has(slideId))) {
      throw new TypeError('Contextual deck audit refers to an unknown slide');
    }
    if (!['info', 'warning', 'error'].includes(String(item.severity))) throw new TypeError('Contextual deck audit severity is invalid');
    const codes = CONTEXTUAL_AUDIT_MESSAGE_CODES[rule];
    if (typeof item.messageCode !== 'string' || !(codes as readonly string[]).includes(item.messageCode)) {
      throw new TypeError('Contextual deck audit message code does not match its rule');
    }
    if (typeof item.repairable !== 'boolean') throw new TypeError('Contextual deck audit repairability is invalid');
    const action = item.suggestedActionCode;
    if (action !== null && (typeof action !== 'string' || !CONTEXTUAL_AUDIT_ACTION_CODES.includes(action as ContextualAuditActionCode))) {
      throw new TypeError('Contextual deck audit action code is invalid');
    }
    if (item.severity === 'info' && (item.messageCode !== codes[0] || item.repairable || action !== null)) {
      throw new TypeError('Passing contextual checks cannot suggest a repair');
    }
    if (item.severity !== 'info' && (item.messageCode !== codes[1] || action === null)) {
      throw new TypeError('Contextual findings require a matching message and bounded action code');
    }
    if (!Array.isArray(item.evidenceRefs) || item.evidenceRefs.length > 8
        || item.evidenceRefs.some((ref) => typeof ref !== 'string' || !context.knownEvidenceRefs.has(ref))
        || new Set(item.evidenceRefs).size !== item.evidenceRefs.length) {
      throw new TypeError('Contextual deck audit cites unknown or duplicate evidence');
    }
    const allowedRefs = slideId === null ? context.knownEvidenceRefs : context.slideContentRefs.get(slideId)!;
    if (item.evidenceRefs.some((ref) => !allowedRefs.has(ref))) {
      throw new TypeError('Contextual deck audit evidence does not belong to its slide');
    }
    return {
      ruleId: rule,
      slideId: slideId as string | null,
      severity: item.severity as ContextualAuditSeverity,
      messageCode: item.messageCode as ContextualDeckAuditFinding['messageCode'],
      evidenceRefs: [...item.evidenceRefs] as string[],
      repairable: item.repairable,
      suggestedActionCode: action as ContextualAuditActionCode | null,
    };
  });
  if (seen.size !== CONTEXTUAL_AUDIT_RULES.length) throw new TypeError('Contextual deck audit omitted a required rule');
  return { schemaVersion: 1, findings };
}
