#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.LCT_PORT) || 7456;
const webPort = Number(process.env.PORT) || 3000;
const daemonUrl = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  LCT_BIND_HOST: '127.0.0.1',
  LCT_PORT: String(port),
  PORT: String(webPort),
  LCT_NEXT_DIST_DIR: process.env.LCT_NEXT_DIST_DIR?.trim() || `.next/dev-${webPort}`,
};
const children = new Set();
let stopping = false;

function start(label, executable, args, cwd, childEnv = env) {
  const child = spawn(executable, args, { cwd, env: childEnv, stdio: 'inherit', windowsHide: true });
  children.add(child);
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`[lct] ${label} exited (${signal ?? code ?? 'unknown'})`);
      process.exitCode = code && code > 0 ? code : 1;
      void stop();
    }
  });
  return child;
}

async function waitForDaemon(child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('daemon exited before becoming healthy');
    try {
      const response = await fetch(`${daemonUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* daemon is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('daemon did not become healthy within 30 seconds');
}

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const timeout = new Promise((resolve) => setTimeout(resolve, 5000));
  await Promise.race([exited, timeout]);
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('exit', resolve);
      killer.once('error', resolve);
    });
  } else {
    child.kill('SIGKILL');
  }
}

async function stop() {
  if (stopping) return;
  stopping = true;
  await Promise.all([...children].map(terminate));
}

process.once('SIGINT', () => { void stop().finally(() => { process.exitCode ??= 0; }); });
process.once('SIGTERM', () => { void stop().finally(() => { process.exitCode ??= 0; }); });

try {
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  await access(tsc);
  const built = await new Promise((resolve) => {
    const child = spawn(process.execPath, [tsc, '-p', path.join(root, 'apps', 'daemon', 'tsconfig.json')], { cwd: root, env, stdio: 'inherit', windowsHide: true });
    child.once('exit', (code) => resolve(code ?? 1));
    child.once('error', () => resolve(1));
  });
  if (built !== 0) throw new Error('daemon TypeScript build failed');

  const daemon = start('daemon', process.execPath, [path.join(root, 'apps', 'daemon', 'dist', 'cli.js'), '--no-open'], root);
  await waitForDaemon(daemon);
  console.log(`[lct] daemon ready at ${daemonUrl}`);

  const nextCli = path.join(root, 'apps', 'web', 'node_modules', 'next', 'dist', 'bin', 'next');
  await access(nextCli);
  console.log(`[lct] web ready at http://127.0.0.1:${webPort}`);
  start('web', process.execPath, [nextCli, 'dev', '--turbopack', '-p', String(webPort)], path.join(root, 'apps', 'web'));
} catch (error) {
  console.error(`[lct] development startup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
  await stop();
}

if (!children.size) process.exitCode ??= 0;
