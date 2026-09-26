import { isIP } from 'node:net';

export const DEFAULT_DAEMON_BIND_HOST = '127.0.0.1';
export const DEFAULT_DAEMON_PORT = 7456;

export function normalizeDaemonBindHost(input: unknown): string {
  const host = String(input ?? '').trim();
  return host || DEFAULT_DAEMON_BIND_HOST;
}

export function parseDaemonPort(input: unknown, fallback = DEFAULT_DAEMON_PORT): number {
  if (input === undefined || input === null || String(input).trim() === '') return fallback;
  const raw = String(input).trim();
  if (!/^\d{1,5}$/.test(raw)) throw new TypeError('LCT_PORT must be an integer between 1 and 65535.');
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('LCT_PORT must be an integer between 1 and 65535.');
  }
  return port;
}

export function assertLoopbackDaemonBindHost(hostValue: unknown): string {
  const host = normalizeDaemonBindHost(hostValue);
  const ipv4Loopback = isIP(host) === 4 && Number(host.split('.')[0]) === 127;
  if (host.toLowerCase() !== 'localhost' && host !== '::1' && !ipv4Loopback) {
    throw new TypeError('The presentation daemon has no authentication and can bind only to localhost or a loopback IP address.');
  }
  return host;
}
