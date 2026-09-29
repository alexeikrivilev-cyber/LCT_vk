const USABLE_PROFILE_STATES = new Set(['ready', 'degraded-ready']);
const RECOVERABLE_REQUEST_STATES = new Set(['processing', 'ready', 'degraded-ready']);

export function isUsableTemplateProfileState(status: string | null | undefined): boolean {
  return typeof status === 'string' && USABLE_PROFILE_STATES.has(status);
}

export function isPersistedTemplatePreparationState(
  compileStatus: string | null | undefined,
  semanticStatus: string | null | undefined,
  persistedFilePath: string | null | undefined,
  requestedFilePath: string,
): boolean {
  return compileStatus === 'ready'
    && persistedFilePath === requestedFilePath
    && typeof semanticStatus === 'string'
    && RECOVERABLE_REQUEST_STATES.has(semanticStatus);
}
