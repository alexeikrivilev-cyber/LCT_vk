#!/usr/bin/env node

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredFiles = [
  'README.md', 'ARCHITECTURE.md', 'MODELS.md', 'AUDIT.md', 'RELEASE_NOTES.md', 'RELEASE_READINESS.md', 'CONTRIBUTING.md',
  'SECURITY.md', 'CHANGELOG.md', 'LICENSE', '.env.example', 'INFERENCE.md', 'TESTING.md',
  'CONTEXT.md', 'LIVE_QUALIFICATION.md', 'services/inference/README.md',
  'docs/index.md', 'docs/READY_FOR_QWEN.md', 'docs/DEMO_RUNBOOK.md', 'docs/PITCH_OUTLINE.md', 'docs/RUNPOD_STARTUP_RUNBOOK.md',
  'docs/getting-started/quickstart.md', 'docs/getting-started/configuration.md',
  'docs/getting-started/local-development.md', 'docs/getting-started/troubleshooting.md',
  'docs/product/guide.md', 'docs/architecture/overview.md',
  'docs/deployment/overview.md', 'docs/deployment/inference-provider.md',
  'docs/deployment/runpod.md', 'docs/deployment/vk-inference.md',
  'docs/deployment/production-checklist.md', 'docs/quality/template-qualification.md',
  'docs/operations/runbook.md', 'docs/operations/observability.md',
  'docs/operations/failure-recovery.md', 'docs/compliance/CASE_REQUIREMENTS.md',
  'docs/compliance/BROWSER_SUPPORT.md', 'docs/compliance/licenses-and-models.md',
  'decisions/README.md', 'decisions/ADR-001-office-kit-renderer-spike.md',
  'decisions/ADR-002-provider-neutral-inference.md', 'decisions/ADR-003-deterministic-geometry-boundary.md',
  'decisions/ADR-004-template-as-component-library.md', 'decisions/ADR-005-prompt-aware-profile-cache.md',
  'decisions/ADR-006-shared-plan-variant-strategies.md', 'decisions/ADR-007-native-editable-output.md',
  'decisions/ADR-008-fake-offline-inference.md', 'decisions/ADR-009-versioned-runtime-prompts.md',
  'apps/daemon/prompts/worker-deck-plan.v2.md', 'apps/daemon/prompts/supervisor-plan-review.v1.md',
  'apps/daemon/prompts/template-profiler.v1.md',
  'skills/README.md',
  'apps/daemon/src/presentation/contracts/agent-workflows.v1.json',
  'apps/daemon/src/presentation/contracts/template-profiler.v1.json',
];
const ignoredDirectories = new Set(['.git', '.next', '.lct', 'node_modules', 'dist', 'coverage', 'out']);

async function markdownFiles(directory) {
  const found = [];
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) pending.push(target);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        found.push(target);
      }
    }
  }
  return found;
}

function stripFencedCode(markdown) {
  return markdown.replace(/^\s{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s{0,3}\1\s*$/gm, '');
}

function localTargets(markdown) {
  const text = stripFencedCode(markdown);
  const results = [];
  const linkPattern = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\s*\)/g;
  for (const match of text.matchAll(linkPattern)) {
    let target = (match[1] ?? '').replace(/^<|>$/g, '').trim();
    if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue;
    target = decodeURIComponent(target.split('#', 1)[0].split('?', 1)[0]);
    if (target) results.push(target);
  }
  return results;
}

const failures = [];
for (const file of requiredFiles) {
  try { await stat(path.join(root, file)); }
  catch { failures.push(`missing required file: ${file}`); }
}

for (const file of await markdownFiles(root)) {
  const source = await readFile(file, 'utf8');
  for (const target of localTargets(source)) {
    const resolved = path.resolve(path.dirname(file), target);
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      failures.push(`link escapes repository: ${path.relative(root, file)} -> ${target}`);
      continue;
    }
    try { await stat(resolved); }
    catch { failures.push(`broken link: ${path.relative(root, file)} -> ${target}`); }
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Documentation check passed: ${requiredFiles.length} required files; local Markdown links resolve.`);
}
