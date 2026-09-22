import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export interface PresentationDesignSystemSummary {
  id: string;
  name: string;
  displayName: string;
  description: string;
  category?: string;
  source: 'built-in';
}

export interface PresentationSkillSummary {
  id: string;
  name: string;
  description: string;
  source: 'built-in';
  mode: 'deck' | 'presentation';
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export async function listPresentationDesignSystems(projectRoot: string): Promise<PresentationDesignSystemSummary[]> {
  const root = path.join(projectRoot, 'design-systems');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: PresentationDesignSystemSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const manifest = await readJson(path.join(root, entry.name, 'manifest.json'));
    if (!manifest) continue;
    const id = typeof manifest.id === 'string' && manifest.id ? manifest.id : entry.name;
    const name = typeof manifest.name === 'string' && manifest.name ? manifest.name : id;
    out.push({
      id,
      name,
      displayName: name,
      description: typeof manifest.description === 'string' ? manifest.description : '',
      ...(typeof manifest.category === 'string' ? { category: manifest.category } : {}),
      source: 'built-in',
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function frontmatterField(raw: string, key: string): string | null {
  const frontmatter = raw.startsWith('---') ? raw.slice(3, raw.indexOf('\n---', 3)) : '';
  if (!frontmatter) return null;
  const simple = frontmatter.match(new RegExp(`^${key}:\\s*["']?([^\\n"']+)["']?\\s*$`, 'm'));
  if (simple?.[1]) return simple[1].trim();
  const block = frontmatter.match(new RegExp(`^${key}:\\s*\\|\\s*\\n((?:[ \\t]+[^\\n]*\\n?)+)`, 'm'));
  if (!block?.[1]) return null;
  return block[1].split('\n').map((line) => line.trim()).filter(Boolean).join(' ').trim() || null;
}

export async function listPresentationSkills(projectRoot: string): Promise<PresentationSkillSummary[]> {
  const root = path.join(projectRoot, 'skills');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: PresentationSkillSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(root, entry.name, 'SKILL.md');
    try {
      if (!(await stat(skillPath)).isFile()) continue;
      const raw = await readFile(skillPath, 'utf8');
      const name = frontmatterField(raw, 'name') ?? entry.name;
      out.push({
        id: name,
        name,
        description: frontmatterField(raw, 'description') ?? '',
        source: 'built-in',
        mode: 'presentation',
      });
    } catch {
      // Invalid/missing skill packages are intentionally invisible.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function resolveDesignSystemFile(
  projectRoot: string,
  designSystemId: string,
  requested: string,
): Promise<string | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(designSystemId)) return null;
  const root = path.join(projectRoot, 'design-systems', designSystemId);
  const safe = requested.replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = safe.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) return null;
  const absolute = path.resolve(root, ...parts);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  try {
    if (!(await stat(absolute)).isFile()) return null;
    return absolute;
  } catch {
    return null;
  }
}

export async function resolveDesignSystemPreview(projectRoot: string, designSystemId: string): Promise<string | null> {
  const manifest = await readJson(path.join(projectRoot, 'design-systems', designSystemId, 'manifest.json'));
  const preview = manifest?.preview;
  if (preview && typeof preview === 'object' && !Array.isArray(preview)) {
    const pages = (preview as Record<string, unknown>).pages;
    if (Array.isArray(pages)) {
      for (const page of pages) {
        if (page && typeof page === 'object' && !Array.isArray(page)) {
          const candidate = (page as Record<string, unknown>).path;
          if (typeof candidate === 'string') {
            const resolved = await resolveDesignSystemFile(projectRoot, designSystemId, candidate);
            if (resolved) return resolved;
          }
        }
      }
    }
  }
  return resolveDesignSystemFile(projectRoot, designSystemId, 'components.html');
}
