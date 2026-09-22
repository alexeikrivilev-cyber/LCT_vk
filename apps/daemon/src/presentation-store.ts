import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

type Db = Database.Database;
type Row = Record<string, unknown>;

export interface PresentationProject {
  id: string;
  name: string;
  skillId: string | null;
  designSystemId: string | null;
  pendingPrompt: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface CreatePresentationProjectInput {
  id: string;
  name: string;
  skillId?: string | null;
  designSystemId?: string | null;
  pendingPrompt?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface PatchPresentationProjectInput {
  name?: string;
  skillId?: string | null;
  designSystemId?: string | null;
  pendingPrompt?: string | null;
  metadata?: Record<string, unknown> | null;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function projectFromRow(row: Row): PresentationProject {
  return {
    id: String(row.id),
    name: String(row.name ?? 'Untitled presentation'),
    skillId: typeof row.skill_id === 'string' ? row.skill_id : null,
    designSystemId: typeof row.design_system_id === 'string' ? row.design_system_id : null,
    pendingPrompt: typeof row.pending_prompt === 'string' ? row.pending_prompt : null,
    metadata: parseMetadata(row.metadata_json),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

export function openPresentationStore(dataDir: string): Db {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'app.sqlite'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      skill_id TEXT,
      design_system_id TEXT,
      pending_prompt TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const columns = db.prepare('PRAGMA table_info(projects)').all() as Row[];
  const names = new Set(columns.map((column) => String(column.name)));
  if (!names.has('skill_id')) db.exec('ALTER TABLE projects ADD COLUMN skill_id TEXT');
  if (!names.has('design_system_id')) db.exec('ALTER TABLE projects ADD COLUMN design_system_id TEXT');
  if (!names.has('pending_prompt')) db.exec('ALTER TABLE projects ADD COLUMN pending_prompt TEXT');
  if (!names.has('metadata_json')) db.exec('ALTER TABLE projects ADD COLUMN metadata_json TEXT');
  return db;
}

export function listPresentationProjects(db: Db): PresentationProject[] {
  return (db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as Row[]).map(projectFromRow);
}

export function getPresentationProject(db: Db, projectId: string): PresentationProject | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Row | undefined;
  return row ? projectFromRow(row) : null;
}

export function createPresentationProject(db: Db, input: CreatePresentationProjectInput): PresentationProject {
  const now = Date.now();
  db.prepare(`
    INSERT INTO projects (id, name, skill_id, design_system_id, pending_prompt, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.name,
    input.skillId ?? null,
    input.designSystemId ?? null,
    input.pendingPrompt ?? null,
    JSON.stringify(input.metadata ?? { projectKind: 'presentation' }),
    now,
    now,
  );
  return getPresentationProject(db, input.id)!;
}

export function patchPresentationProject(
  db: Db,
  projectId: string,
  patch: PatchPresentationProjectInput,
): PresentationProject | null {
  const current = getPresentationProject(db, projectId);
  if (!current) return null;
  const next = {
    name: typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim() : current.name,
    skillId: patch.skillId === undefined ? current.skillId : patch.skillId,
    designSystemId: patch.designSystemId === undefined ? current.designSystemId : patch.designSystemId,
    pendingPrompt: patch.pendingPrompt === undefined ? current.pendingPrompt : patch.pendingPrompt,
    metadata: patch.metadata === undefined ? current.metadata : (patch.metadata ?? {}),
  };
  db.prepare(`
    UPDATE projects
    SET name = ?, skill_id = ?, design_system_id = ?, pending_prompt = ?, metadata_json = ?, updated_at = ?
    WHERE id = ?
  `).run(
    next.name,
    next.skillId,
    next.designSystemId,
    next.pendingPrompt,
    JSON.stringify(next.metadata),
    Date.now(),
    projectId,
  );
  return getPresentationProject(db, projectId);
}

export function deletePresentationProject(db: Db, projectId: string): boolean {
  return db.prepare('DELETE FROM projects WHERE id = ?').run(projectId).changes > 0;
}
