import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage']);

export interface PresentationFile {
  name: string;
  path: string;
  type: 'file';
  size: number;
  mtime: number;
  kind: string;
  mime: string;
}

export function assertSafeProjectId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error('invalid project id');
  return value;
}

export function presentationProjectDir(projectsRoot: string, projectId: string): string {
  return path.join(projectsRoot, assertSafeProjectId(projectId));
}

export async function ensurePresentationProjectDir(projectsRoot: string, projectId: string): Promise<string> {
  const dir = presentationProjectDir(projectsRoot, projectId);
  await mkdir(dir, { recursive: true });
  return dir;
}

function normalizeRelativeFile(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) {
    throw new Error('invalid project file path');
  }
  return parts.join('/');
}

export async function resolvePresentationFilePath(
  projectsRoot: string,
  projectId: string,
  name: string,
  options: { createParent?: boolean; requireExisting?: boolean } = {},
): Promise<{ projectDir: string; name: string; absolute: string }> {
  const projectDir = await ensurePresentationProjectDir(projectsRoot, projectId);
  const safeName = normalizeRelativeFile(name);
  const absolute = path.resolve(projectDir, safeName);
  const relative = path.relative(projectDir, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('project file escapes project root');

  if (options.createParent) await mkdir(path.dirname(absolute), { recursive: true });
  if (options.requireExisting) {
    const canonicalRoot = await realpath(projectDir).catch(() => projectDir);
    const canonicalFile = await realpath(absolute);
    const canonicalRelative = path.relative(canonicalRoot, canonicalFile);
    if (canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) {
      throw new Error('project file symlink escapes project root');
    }
  }
  return { projectDir, name: safeName, absolute };
}

export function mimeForPresentationFile(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
  } as Record<string, string>)[ext] ?? 'application/octet-stream';
}

function kindForPresentationFile(name: string): string {
  const mime = mimeForPresentationFile(name);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (/powerpoint|presentationml/.test(mime)) return 'presentation';
  if (mime.startsWith('text/') || mime.includes('json') || mime.includes('javascript')) return 'text';
  return 'file';
}

async function collectFiles(root: string, current: string, out: PresentationFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const absolute = path.join(current, entry.name);
    const rel = path.relative(root, absolute).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await collectFiles(root, absolute, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(absolute);
    out.push({
      name: rel,
      path: rel,
      type: 'file',
      size: info.size,
      mtime: info.mtimeMs,
      kind: kindForPresentationFile(rel),
      mime: mimeForPresentationFile(rel),
    });
  }
}

export async function listPresentationFiles(projectsRoot: string, projectId: string): Promise<PresentationFile[]> {
  const root = await ensurePresentationProjectDir(projectsRoot, projectId);
  const out: PresentationFile[] = [];
  await collectFiles(root, root, out);
  return out.sort((a, b) => b.mtime - a.mtime);
}

export async function writePresentationFile(
  projectsRoot: string,
  projectId: string,
  name: string,
  content: string | Buffer,
): Promise<PresentationFile> {
  const target = await resolvePresentationFilePath(projectsRoot, projectId, name, { createParent: true });
  await writeFile(target.absolute, content);
  const info = await stat(target.absolute);
  return {
    name: target.name,
    path: target.name,
    type: 'file',
    size: info.size,
    mtime: info.mtimeMs,
    kind: kindForPresentationFile(target.name),
    mime: mimeForPresentationFile(target.name),
  };
}

export async function deletePresentationFile(projectsRoot: string, projectId: string, name: string): Promise<void> {
  const target = await resolvePresentationFilePath(projectsRoot, projectId, name, { requireExisting: true });
  await rm(target.absolute, { force: true });
}

export async function readPresentationFile(projectsRoot: string, projectId: string, name: string): Promise<Buffer> {
  const target = await resolvePresentationFilePath(projectsRoot, projectId, name, { requireExisting: true });
  return readFile(target.absolute);
}

export async function removePresentationProjectDir(projectsRoot: string, projectId: string): Promise<void> {
  const dir = presentationProjectDir(projectsRoot, projectId);
  await rm(dir, { recursive: true, force: true });
}
