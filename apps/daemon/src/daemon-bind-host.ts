import { isIP } from 'node:net';

export const DEFAULT_DAEMON_BIND_HOST = '127.0.0.1';

export function normalizeDaemonBindHost(input: unknown): string {
  const host = String(input ?? '').trim();
  return host || DEFAULT_DAEMON_BIND_HOST;
}

export function assertLoopbackDaemonBindHost(hostValue: unknown): string {
  const host = normalizeDaemonBindHost(hostValue);
  const ipv4Loopback = isIP(host) === 4 && Number(host.split('.')[0]) === 127;
  if (host.toLowerCase() !== 'localhost' && host !== '::1' && !ipv4Loopback) {
    throw new TypeError('The presentation daemon has no authentication and can bind only to localhost or a loopback IP address.');
  }
  return host;
}
