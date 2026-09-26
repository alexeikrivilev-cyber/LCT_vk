export interface WorkspaceDraft {
  updatedAt: number;
  selectedContentFiles: string[];
  briefAudience: string;
  briefPurpose: string;
  briefExpectedOutcome: string;
  briefContext?: string;
  briefPreferences: string;
  requestedSlideCount: string;
}

const MAX_DRAFT_BYTES = 64 * 1024;

export function workspaceDraftKey(projectId: string): string {
  return `lct:workspace-draft:v1:${projectId}`;
}

export function parseWorkspaceDraft(value: unknown): WorkspaceDraft | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const draft = value as Record<string, unknown>;
  if (!Number.isSafeInteger(draft.updatedAt) || Number(draft.updatedAt) < 0
      || !Array.isArray(draft.selectedContentFiles) || draft.selectedContentFiles.length > 12
      || !draft.selectedContentFiles.every((item) => typeof item === 'string' && item.length <= 1024)
      || !['briefAudience', 'briefPurpose', 'briefExpectedOutcome', 'briefPreferences', 'requestedSlideCount']
        .every((key) => typeof draft[key] === 'string' && (draft[key] as string).length <= 4000)
      || (draft.briefContext !== undefined && (typeof draft.briefContext !== 'string' || draft.briefContext.length > 16_000))) return null;
  return draft as unknown as WorkspaceDraft;
}

/** Drafts contain only brief fields and file names, never uploaded source text. */
export function readWorkspaceDraft(
  storage: Pick<Storage, 'getItem'>,
  projectId: string,
  serverUpdatedAt: string | null | undefined,
  availableContentPaths: ReadonlySet<string>,
): WorkspaceDraft | null {
  try {
    const raw = storage.getItem(workspaceDraftKey(projectId));
    if (!raw || raw.length > MAX_DRAFT_BYTES) return null;
    const draft = parseWorkspaceDraft(JSON.parse(raw) as unknown);
    if (!draft) return null;
    const serverTimestamp = serverUpdatedAt ? Date.parse(serverUpdatedAt) : Number.NaN;
    if (Number.isFinite(serverTimestamp) && serverTimestamp >= draft.updatedAt) return null;
    return { ...draft, selectedContentFiles: draft.selectedContentFiles.filter((item) => availableContentPaths.has(item)) };
  } catch {
    return null;
  }
}

export function writeWorkspaceDraft(storage: Pick<Storage, 'setItem'>, projectId: string, draft: Omit<WorkspaceDraft, 'updatedAt'>, now = Date.now()): boolean {
  const value: WorkspaceDraft = { ...draft, updatedAt: now };
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_DRAFT_BYTES || !parseWorkspaceDraft(value)) return false;
  try {
    storage.setItem(workspaceDraftKey(projectId), serialized);
    return true;
  } catch {
    return false;
  }
}

export function clearWorkspaceDraft(storage: Pick<Storage, 'removeItem'>, projectId: string): void {
  try { storage.removeItem(workspaceDraftKey(projectId)); }
  catch { /* Storage can be disabled by browser policy. */ }
}
