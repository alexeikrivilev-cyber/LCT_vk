/** Hide request failures once a matching persisted snapshot proves the operation succeeded. */
export function visibleRequestFailure<T>(
  failure: T | null | undefined,
  persistedStatus: string | null | undefined,
  successfulStatuses: readonly string[],
): T | null {
  if (persistedStatus && successfulStatuses.includes(persistedStatus)) return null;
  return failure ?? null;
}

/** Generation start failures can become stale after persistence completes; action failures cannot. */
export function visibleGenerationOperationError<T>(
  failure: T | null | undefined,
  origin: 'start' | 'action' | null,
  persistedStatus: string | null | undefined,
): T | null {
  if (origin === 'start') return visibleRequestFailure(failure, persistedStatus, ['completed']);
  return failure ?? null;
}

export type PersistedWorkspaceView = 'template' | 'outline' | 'progress' | 'editor' | 'audit';

export function persistedWorkspaceView(input: {
  operationStatus?: string | null;
  operationGenerationId?: string | null;
  operationFailureStage?: string | null;
  savedPlanReady: boolean;
  templateReady: boolean;
}): PersistedWorkspaceView | null {
  if (input.operationStatus === 'running') return 'progress';
  if (input.operationStatus === 'failed' && input.operationFailureStage === 'contextual_audit' && input.operationGenerationId) return 'audit';
  if (input.operationStatus === 'failed') return 'progress';
  if (input.operationStatus === 'ready' && input.operationGenerationId) return 'editor';
  if (input.savedPlanReady) return 'outline';
  if (input.templateReady) return 'template';
  return null;
}

/** Persisted workflow failures are shown only while the latest operation is actually failed. */
export function visiblePersistedFailure<T>(
  failure: T | null | undefined,
  persistedStatus: string | null | undefined,
): T | null {
  return persistedStatus === 'failed' ? failure ?? null : null;
}
