import path from 'node:path';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isPathInside(candidatePath, parentPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Fail closed on non-loopback fetches and expose only a request count, never URLs. */
export function installLoopbackFetchGuard(target = globalThis) {
  const originalFetch = target.fetch;
  if (typeof originalFetch !== 'function') throw new TypeError('fetch is unavailable for the offline guard');
  let blockedRequestCount = 0;
  target.fetch = async (input, init) => {
    let url;
    try { url = new URL(input instanceof Request ? input.url : String(input)); }
    catch { blockedRequestCount += 1; throw new Error('Offline qualification rejected a non-absolute fetch URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
      blockedRequestCount += 1;
      throw new Error('Offline qualification blocked a non-loopback network request.');
    }
    return originalFetch.call(target, input, init);
  };
  return {
    get blockedRequestCount() { return blockedRequestCount; },
    restore() { target.fetch = originalFetch; },
  };
}
