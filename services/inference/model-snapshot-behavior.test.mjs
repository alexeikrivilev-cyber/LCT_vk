import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const unitTest = fileURLToPath(new URL('./model_snapshot_unit.py', import.meta.url));

function pythonCandidate(executable, prefix = []) {
  const probe = spawnSync(executable, [...prefix, '-c', 'import encodings, json, pathlib, unittest, sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 1)'], {
    encoding: 'utf8', timeout: 3000, windowsHide: true,
  });
  return probe.status === 0 ? { executable, prefix } : null;
}

function findPython() {
  if (process.env.LCT_PYTHON) {
    const configured = pythonCandidate(process.env.LCT_PYTHON);
    if (configured) return configured;
  }
  if (process.platform === 'win32') {
    const launcher = pythonCandidate('py', ['-3.12']);
    if (launcher) return launcher;
    const installed = spawnSync('py', ['-0p'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    const executables = (installed.stdout ?? '').split(/\r?\n/)
      .map((line) => line.match(/([A-Za-z]:\\.*?python\.exe)\s*$/i)?.[1])
      .filter(Boolean);
    for (const executable of executables) {
      const candidate = pythonCandidate(executable);
      if (candidate) return candidate;
    }
  }
  for (const executable of process.platform === 'win32' ? ['python3', 'python'] : ['python3']) {
    const found = pythonCandidate(executable);
    if (found) return found;
  }
  return null;
}

test('pinned snapshot reuse, repair decision, offline failure, and secret redaction use mocked Hub calls only', (t) => {
  const python = findPython();
  if (!python) {
    t.skip('Python is unavailable; run this dependency-free inference behavior test with Python 3.12');
    return;
  }
  const result = spawnSync(python.executable, [...python.prefix, unitTest], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    env: process.env,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Ran 7 tests/);
  assert.match(result.stderr, /OK/);
});
