import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import type { StartServerOptions } from './server.js';

export type StartedDaemonRuntime = {
  server: Server;
  url: string;
  shutdown?: () => Promise<void>;
  stop(): Promise<void>;
};

type DaemonRuntimeOptions = Omit<StartServerOptions, 'returnServer'> & {
  openBrowser?: boolean;
  logListening?: boolean;
};

export const DEFAULT_DAEMON_BIND_HOST = '127.0.0.1';

function openUrl(url: string): void {
  const command = process.platform === 'darwin'
    ? { bin: 'open', args: [url] }
    : process.platform === 'win32'
      ? { bin: 'cmd', args: ['/c', 'start', '', url] }
      : { bin: 'xdg-open', args: [url] };
  try {
    const child = spawn(command.bin, command.args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // Browser opening is a convenience only; the daemon remains usable.
  }
}

export function normalizeDaemonBindHost(input: unknown): string {
  const host = String(input ?? '').trim();
  return host || DEFAULT_DAEMON_BIND_HOST;
}

export function parseDaemonCliStartupArgs(argv: string[]):
  | { ok: true; config: { host: string; port: number; open: boolean } }
  | { ok: false; kind: 'help' | 'error'; message?: string } {
  let host = normalizeDaemonBindHost(process.env.OD_BIND_HOST);
  let port = Number(process.env.OD_PORT) || 7456;
  let open = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-open') open = false;
    else if (arg === '-h' || arg === '--help') return { ok: false, kind: 'help' };
    else if (arg === '--host') {
      const value = argv[++index];
      if (!value) return { ok: false, kind: 'error', message: '--host requires an address' };
      host = normalizeDaemonBindHost(value);
    } else if (arg === '-p' || arg === '--port') {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value <= 0 || value > 65535) {
        return { ok: false, kind: 'error', message: 'invalid port' };
      }
      port = value;
    } else if (arg === 'daemon') {
      continue;
    } else {
      return { ok: false, kind: 'error', message: `unknown option or command: ${arg}` };
    }
  }
  return { ok: true, config: { host, port, open } };
}

export async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    const hardStop = setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, 5000);
    hardStop.unref?.();
    server.close(() => {
      clearTimeout(hardStop);
      resolve();
    });
    setTimeout(() => server.closeIdleConnections?.(), 500).unref?.();
  });
}

export async function startDaemonRuntime(options: DaemonRuntimeOptions = {}): Promise<StartedDaemonRuntime> {
  const { openBrowser = false, logListening = false, ...serverOptions } = options;
  const { startServer } = await import('./server.js');
  const started = await startServer({ ...serverOptions, returnServer: true });
  if (typeof started === 'string') throw new Error('presentation server did not return a server handle');
  const stop = async () => {
    await Promise.allSettled([closeHttpServer(started.server), started.shutdown?.() ?? Promise.resolve()]);
  };
  if (logListening) console.log(`[lct] presentation core listening on ${started.url}`);
  if (openBrowser) openUrl(started.url);
  return { ...started, stop };
}

export async function runDaemonCliStartup(argv: string[]): Promise<void> {
  const parsed = parseDaemonCliStartupArgs(argv);
  if (!parsed.ok) {
    if (parsed.kind === 'help') {
      console.log('Usage: od [daemon] [--host HOST] [--port PORT] [--no-open]');
      return;
    }
    console.error(parsed.message ?? 'invalid arguments');
    process.exitCode = 2;
    return;
  }
  const runtime = await startDaemonRuntime({
    host: parsed.config.host,
    port: parsed.config.port,
    openBrowser: parsed.config.open,
    logListening: true,
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void runtime.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
