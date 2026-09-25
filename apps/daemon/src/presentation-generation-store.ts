import type Database from 'better-sqlite3';

type Db = Database.Database;
type Row = Record<string, unknown>;

export interface StoredPresentationGeneration<T = Record<string, unknown>> {
  projectId: string;
  generationId: string;
  idempotencyKey: string;
  inputFingerprint: string;
  revision: number;
  state: T;
}

function decode<T>(row: Row | undefined): StoredPresentationGeneration<T> | null {
  if (!row) return null;
  let state: unknown;
  try { state = JSON.parse(String(row.state_json)); }
  catch { throw new TypeError('Saved presentation generation state is invalid JSON'); }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('Saved presentation generation state has an invalid shape');
  }
  return {
    projectId: String(row.project_id),
    generationId: String(row.generation_id),
    idempotencyKey: String(row.idempotency_key),
    inputFingerprint: String(row.input_fingerprint),
    revision: Number(row.revision),
    state: state as T,
  };
}

export function getPresentationGeneration<T = Record<string, unknown>>(
  db: Db,
  projectId: string,
): StoredPresentationGeneration<T> | null {
  const row = db.prepare('SELECT * FROM presentation_generations WHERE project_id = ?').get(projectId) as Row | undefined;
  return decode<T>(row);
}

export function listRecoverablePresentationGenerations<T = Record<string, unknown>>(
  db: Db,
): StoredPresentationGeneration<T>[] {
  const rows = db.prepare(`
    SELECT * FROM presentation_generations
    WHERE json_extract(state_json, '$.status') IN ('preparing', 'generating')
    ORDER BY updated_at ASC
  `).all() as Row[];
  return rows.map((row) => decode<T>(row)!).filter(Boolean);
}

export type StartGenerationResult<T> =
  | { kind: 'created'; generation: StoredPresentationGeneration<T> }
  | { kind: 'existing'; generation: StoredPresentationGeneration<T> }
  | { kind: 'active-conflict'; generation: StoredPresentationGeneration<T> }
  | { kind: 'idempotency-conflict'; generation: StoredPresentationGeneration<T> };

/** Short SQLite transaction; render and preview work always happens outside it. */
export function startPresentationGeneration<T extends { generationId: string; revision: number; status: string }>(
  db: Db,
  input: {
    projectId: string;
    idempotencyKey: string;
    inputFingerprint: string;
    state: T;
  },
): StartGenerationResult<T> {
  const run = db.transaction((): StartGenerationResult<T> => {
    const currentRow = db.prepare('SELECT * FROM presentation_generations WHERE project_id = ?').get(input.projectId) as Row | undefined;
    const current = decode<T>(currentRow);
    if (current) {
      if (current.idempotencyKey === input.idempotencyKey) {
        return current.inputFingerprint === input.inputFingerprint
          ? { kind: 'existing', generation: current }
          : { kind: 'idempotency-conflict', generation: current };
      }
      const active = current.state.status === 'preparing' || current.state.status === 'generating';
      if (active) return { kind: 'active-conflict', generation: current };
      if (current.inputFingerprint === input.inputFingerprint) return { kind: 'existing', generation: current };
    }
    db.prepare(`
      INSERT INTO presentation_generations
        (project_id, generation_id, idempotency_key, input_fingerprint, revision, state_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        generation_id = excluded.generation_id,
        idempotency_key = excluded.idempotency_key,
        input_fingerprint = excluded.input_fingerprint,
        revision = excluded.revision,
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `).run(input.projectId, input.state.generationId, input.idempotencyKey, input.inputFingerprint,
      input.state.revision, JSON.stringify(input.state), Date.now());
    return { kind: 'created', generation: {
      projectId: input.projectId,
      generationId: input.state.generationId,
      idempotencyKey: input.idempotencyKey,
      inputFingerprint: input.inputFingerprint,
      revision: input.state.revision,
      state: input.state,
    } };
  }).immediate();
  return run;
}

/** Re-read and merge the latest snapshot under a short SQLite write lock. */
export function updatePresentationGeneration<T extends { generationId: string; revision: number }>(
  db: Db,
  projectId: string,
  generationId: string,
  update: (current: T) => T,
): StoredPresentationGeneration<T> | null {
  const run = db.transaction((): StoredPresentationGeneration<T> | null => {
    const row = db.prepare('SELECT * FROM presentation_generations WHERE project_id = ?').get(projectId) as Row | undefined;
    const stored = decode<T>(row);
    if (!stored || stored.generationId !== generationId) return null;
    const current = stored.state;
    const next = update(current);
    const revision = stored.revision + 1;
    next.revision = revision;
    db.prepare(`
      UPDATE presentation_generations SET revision = ?, state_json = ?, updated_at = ?
      WHERE project_id = ? AND generation_id = ? AND revision = ?
    `).run(revision, JSON.stringify(next), Date.now(), projectId, generationId, stored.revision);
    return { ...stored, revision, state: next };
  }).immediate();
  return run;
}
