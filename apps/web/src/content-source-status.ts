import { ru } from './i18n/ru';

export type ContentSourceStatus = 'parsed' | 'asset-only' | 'unsupported' | 'not-parsed';

export interface ContentSourceStatusInput {
  kind: 'text' | 'image' | 'unsupported';
  warnings?: readonly { code: string }[];
}

const extractionFailureCodes = new Set([
  'INVALID_UTF8_NOT_EXTRACTED',
  'INVALID_JSON_NOT_PARSED',
  'INVALID_TABLE_NOT_PARSED',
  'UNSUPPORTED_FORMAT_NOT_PARSED',
]);

/** Human-facing ingestion state derived from the persisted ContentIR source record. */
export function contentSourceStatus(source: ContentSourceStatusInput | null | undefined): ContentSourceStatus {
  if (!source) return 'not-parsed';
  if (source.kind === 'image') return 'asset-only';
  if (source.kind === 'unsupported' || source.warnings?.some((warning) => extractionFailureCodes.has(warning.code))) return 'unsupported';
  return 'parsed';
}

export function contentSourceStatusLabel(status: ContentSourceStatus): string {
  switch (status) {
    case 'parsed': return ru.contentSource.parsed;
    case 'asset-only': return ru.contentSource.assetOnly;
    case 'unsupported': return ru.contentSource.unsupported;
    case 'not-parsed': return ru.contentSource.notParsed;
  }
}
