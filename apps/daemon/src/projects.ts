// Presentation-core project helpers used by the media dispatcher.
// Generic artifact manifests, imported-folder workspaces, archives and runtime
// reconciliation live outside this reduced boundary.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export function isSafeId(id: unknown): id is string {
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) return false;
  if (/^\.+$/.test(id)) return false;
  return /^[A-Za-z0-9._-]+$/.test(id);
}

export function projectDir(projectsRoot: string, projectId: string): string {
  if (!isSafeId(projectId)) throw new Error('invalid project id');
  return path.join(projectsRoot, projectId);
}

export async function ensureProject(projectsRoot: string, projectId: string): Promise<string> {
  const dir = projectDir(projectsRoot, projectId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function sanitizeName(raw: unknown): string {
  const cleaned = String(raw ?? '')
    .replace(/[\\/]/g, '_')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .replace(/^\.+/, '_')
    .trim();
  return cleaned || `file-${Date.now()}`;
}

const EXT_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.ts': 'text/typescript; charset=utf-8',
  '.tsx': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};

export function mimeFor(name: string): string {
  return EXT_MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

export function kindFor(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.svg') return 'sketch';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'].includes(ext)) return 'image';
  if (['.mp4', '.mov', '.webm'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.m4a'].includes(ext)) return 'audio';
  if (['.md', '.txt'].includes(ext)) return 'text';
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.css'].includes(ext)) return 'code';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.pptx') return 'presentation';
  return 'binary';
}
