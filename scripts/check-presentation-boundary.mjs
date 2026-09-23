import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

const forbiddenRoots = [
  'packages',
  'tools',
  'e2e',
  'deploy',
  'mocks',
  'design-templates',
  'apps/web/public',
  'apps/daemon/scripts',
  'apps/daemon/src/integrations',
];

for (const relative of forbiddenRoots) {
  if (existsSync(path.join(root, relative))) failures.push(`removed generic surface returned: ${relative}`);
}

const forbiddenFiles = ['DISTILLATION.md'];
for (const relative of forbiddenFiles) {
  if (existsSync(path.join(root, relative))) failures.push(`obsolete repository document returned: ${relative}`);
}

const requiredRootDocs = [
  'AGENTS.md',
  'README.md',
  'CONTEXT.md',
  'ARCHITECTURE.md',
  'MODELS.md',
  'INFERENCE.md',
  'AUDIT.md',
  'TESTING.md',
];

for (const relative of requiredRootDocs) {
  if (!existsSync(path.join(root, relative))) failures.push(`required source-of-truth document missing: ${relative}`);
}

const agentsPath = path.join(root, 'AGENTS.md');
if (existsSync(agentsPath)) {
  const agents = await readFile(agentsPath, 'utf8');
  const lineCount = agents.split(/\r?\n/).length;
  const byteCount = Buffer.byteLength(agents);
  if (lineCount > 120) failures.push(`AGENTS.md must stay concise (<=120 lines); got ${lineCount}`);
  if (byteCount > 12 * 1024) failures.push(`AGENTS.md must stay concise (<=12 KiB); got ${byteCount} bytes`);
}

const workspace = await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
const workspaceMembers = [...workspace.matchAll(/^\s*-\s+([^\n#]+)$/gm)]
  .map((match) => match[1].trim())
  .filter((entry) => entry.startsWith('apps/'));
const expectedWorkspace = ['apps/daemon', 'apps/web'];
if (JSON.stringify(workspaceMembers) !== JSON.stringify(expectedWorkspace)) {
  failures.push(`workspace must contain only ${expectedWorkspace.join(', ')}; got ${workspaceMembers.join(', ')}`);
}

const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const forbiddenSourcePatterns = [
  { label: 'workspace package import', re: /(?:from\s+|import\s*\()\s*['"]@lct\// },
  { label: 'legacy OD_ runtime env', re: /\bOD_[A-Z0-9_]+\b/ },
];

async function scanDirectory(relative) {
  const absolute = path.join(root, relative);
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const childRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      await scanDirectory(childRelative);
      continue;
    }
    if (!entry.isFile() || !sourceExtensions.has(path.extname(entry.name))) continue;
    const text = await readFile(path.join(root, childRelative), 'utf8');
    for (const pattern of forbiddenSourcePatterns) {
      if (pattern.re.test(text)) failures.push(`${pattern.label}: ${childRelative}`);
    }
  }
}

await scanDirectory('apps');

if (failures.length) {
  console.error('presentation boundary check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('presentation boundary check passed');
}
