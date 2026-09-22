import { lookup as dnsLookup } from 'node:dns';
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { Agent } from 'undici';

type DnsLookupFn = typeof dns.lookup;

function blockedIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function blockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0];
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('::ffff:127.') ||
    normalized.startsWith('::ffff:10.') ||
    normalized.startsWith('::ffff:192.168.')
  );
}

function blockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedIpv4(address);
  if (family === 6) return blockedIpv6(address);
  return true;
}

function blockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === 'metadata.google.internal';
}

async function validateExternalUrl(url: string, lookup: DnsLookupFn = dns.lookup): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid asset url: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('asset URL must use http or https');
  if (parsed.username || parsed.password) throw new Error('asset URL credentials are not allowed');
  if (blockedHostname(parsed.hostname)) throw new Error('asset URL host is not public');
  const literal = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal)) {
    if (blockedAddress(literal)) throw new Error('asset URL address is not public');
    return;
  }
  const answers = await lookup(parsed.hostname, { all: true, verbatim: true });
  if (!answers.length || answers.some((answer) => blockedAddress(answer.address))) {
    throw new Error('asset URL resolves to a non-public address');
  }
}

const dispatcher = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dnsLookup(hostname, options as never, (error, address, family) => {
        if (error) return callback(error, address as never, family as never);
        const addresses = Array.isArray(address) ? address : [{ address, family }];
        for (const entry of addresses) {
          const value = typeof entry === 'string' ? entry : entry.address;
          if (blockedAddress(String(value))) {
            return callback(new Error(`asset host resolved to non-public address: ${value}`), address as never, family as never);
          }
        }
        callback(null, address as never, family as never);
      });
    },
  },
});

/** Presentation-media-only external fetch guard. */
export async function assertAndFetchExternalAsset(
  url: string,
  init: RequestInit = {},
  lookup?: DnsLookupFn,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  await validateExternalUrl(url, lookup);
  const requestInit: RequestInit = { ...init, redirect: 'error' };
  (requestInit as RequestInit & { dispatcher?: unknown }).dispatcher = dispatcher;
  return fetchImpl(url, requestInit);
}
