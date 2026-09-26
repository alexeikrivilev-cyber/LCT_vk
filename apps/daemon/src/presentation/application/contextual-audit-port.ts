import { createHash } from 'node:crypto';
import { CONTEXTUAL_AUDITOR_CONTRACT_SHA256, CONTEXTUAL_AUDITOR_WORKFLOW } from './workflow-versions.js';

/** Internal replaceable boundary for one text-only review of the selected deck. */
export const CONTEXTUAL_AUDIT_RULE_SET_VERSION = 'contextual-deck-audit.v2' as const;
export const CONTEXTUAL_AUDIT_SCHEMA_VERSION = 2 as const;
export const CONTEXTUAL_AUDIT_SCHEMA_NAME = 'contextual_deck_audit_v2' as const;

export const CONTEXTUAL_AUDIT_RULES = [
  'titleTakeaway',
  'titleContentAlignment',
  'oneSentenceSummary',
  'factGrounding',
  'visualSemanticFit',
  'garbage',
  'spelling',
  'languageConsistency',
  'tableLegendUsefulness',
  'narrativeContinuity',
  'redundancy',
] as const;

export type ContextualAuditRule = typeof CONTEXTUAL_AUDIT_RULES[number];
export type ContextualAuditSeverity = 'info' | 'warning' | 'error';

export const CONTEXTUAL_AUDIT_MESSAGE_CODES = {
  titleTakeaway: ['TITLE_TAKEAWAY_CLEAR', 'TITLE_TAKEAWAY_REVIEW'],
  titleContentAlignment: ['TITLE_CONTENT_ALIGNED', 'TITLE_CONTENT_MISMATCH'],
  oneSentenceSummary: ['SUMMARY_CLEAR', 'SUMMARY_UNCLEAR'],
  factGrounding: ['FACTS_GROUNDED', 'FACTS_UNGROUNDED'],
  visualSemanticFit: ['VISUAL_SEMANTIC_FIT', 'VISUAL_SEMANTIC_MISMATCH'],
  garbage: ['NO_PROMPT_GARBAGE', 'PROMPT_GARBAGE'],
  spelling: ['SPELLING_CLEAR', 'SPELLING_REVIEW'],
  languageConsistency: ['LANGUAGE_CONSISTENT', 'LANGUAGE_MIXED'],
  tableLegendUsefulness: ['TABLE_LEGEND_USEFUL', 'TABLE_LEGEND_REVIEW'],
  narrativeContinuity: ['NARRATIVE_CONTINUOUS', 'NARRATIVE_BREAK'],
  redundancy: ['NO_REDUNDANCY', 'CONTENT_REPEATED'],
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
  'CHECK_SPELLING',
  'REVIEW_TABLE',
] as const;

export type ContextualAuditActionCode = typeof CONTEXTUAL_AUDIT_ACTION_CODES[number];

export const CONTEXTUAL_AUDIT_REVIEW_ACTIONS = {
  titleTakeaway: 'REVIEW_TITLE',
  titleContentAlignment: 'REVIEW_TITLE',
  oneSentenceSummary: 'SIMPLIFY_SLIDE',
  factGrounding: 'CHECK_SOURCE',
  visualSemanticFit: 'REVIEW_VISUAL',
  garbage: 'REMOVE_INSTRUCTIONS',
  spelling: 'CHECK_SPELLING',
  languageConsistency: 'CHECK_LANGUAGE',
  tableLegendUsefulness: 'REVIEW_TABLE',
  narrativeContinuity: 'REVIEW_NARRATIVE',
  redundancy: 'REVIEW_DUPLICATE',
} as const satisfies Record<ContextualAuditRule, ContextualAuditActionCode>;

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
  schemaVersion: typeof CONTEXTUAL_AUDIT_SCHEMA_VERSION;
  findings: ContextualDeckAuditFinding[];
}

export interface ContextualDeckAuditValidationContext {
  slideContentRefs: ReadonlyMap<string, ReadonlySet<string>>;
  knownEvidenceRefs: ReadonlySet<string>;
}

const JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: CONTEXTUAL_AUDIT_SCHEMA_VERSION },
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Version identity includes agent/skill/prompt hash plus exact schema and rule IDs. */
export function buildContextualAuditVersionFingerprint(overrides: {
  ruleSetVersion?: string;
  schema?: unknown;
  auditor?: Record<string, unknown>;
  auditorContractSha256?: string;
} = {}): string {
  return createHash('sha256').update(canonicalJson({
    ruleSetVersion: overrides.ruleSetVersion ?? CONTEXTUAL_AUDIT_RULE_SET_VERSION,
    schemaName: CONTEXTUAL_AUDIT_SCHEMA_NAME,
    schemaVersion: CONTEXTUAL_AUDIT_SCHEMA_VERSION,
    schema: overrides.schema ?? JSON_SCHEMA,
    rules: CONTEXTUAL_AUDIT_RULES,
    messageCodes: CONTEXTUAL_AUDIT_MESSAGE_CODES,
    actionCodes: CONTEXTUAL_AUDIT_ACTION_CODES,
    reviewActions: CONTEXTUAL_AUDIT_REVIEW_ACTIONS,
    auditor: overrides.auditor ?? CONTEXTUAL_AUDITOR_WORKFLOW,
    auditorContractSha256: overrides.auditorContractSha256 ?? CONTEXTUAL_AUDITOR_CONTRACT_SHA256,
  })).digest('hex');
}

export const CONTEXTUAL_AUDIT_VERSION_FINGERPRINT = buildContextualAuditVersionFingerprint();

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
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'findings']) || value.schemaVersion !== CONTEXTUAL_AUDIT_SCHEMA_VERSION
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
    if (item.severity !== 'info' && (item.messageCode !== codes[1] || item.repairable
        || action !== CONTEXTUAL_AUDIT_REVIEW_ACTIONS[rule])) {
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
  return { schemaVersion: CONTEXTUAL_AUDIT_SCHEMA_VERSION, findings };
}
