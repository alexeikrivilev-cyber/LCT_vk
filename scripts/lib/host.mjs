import { isIP } from 'node:net';

export function parseConfiguredLoopbackHost(value, name = 'LCT_WEB_HOST', fallback = '127.0.0.1') {
  const host = String(value ?? '').trim() || fallback;
  const ipv4Loopback = isIP(host) === 4 && Number(host.split('.')[0]) === 127;
  if (host.toLowerCase() !== 'localhost' && host !== '::1' && !ipv4Loopback) {
    throw new TypeError(`${name} must be localhost or a loopback IP address.`);
  }
  return host;
}
