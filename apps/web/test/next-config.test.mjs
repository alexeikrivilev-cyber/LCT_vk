import assert from 'node:assert/strict';
import test from 'node:test';
import nextConfig from '../next.config.ts';

test('Next proxy buffering limit covers the daemon two-file upload contract', () => {
  const configured = nextConfig.experimental?.proxyClientMaxBodySize;
  const bytes = typeof configured === 'number'
    ? configured
    : typeof configured === 'string' && /^\d+(?:\.\d+)?mb$/i.test(configured)
      ? Number.parseFloat(configured) * 1024 * 1024
      : 0;
  assert.ok(bytes >= 130 * 1024 * 1024, 'proxy body limit must fit two 64 MiB files plus multipart framing');
});
