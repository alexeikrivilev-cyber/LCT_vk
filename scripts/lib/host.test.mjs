import assert from 'node:assert/strict';
import test from 'node:test';

import { parseConfiguredLoopbackHost } from './host.mjs';

test('web development host defaults to loopback and rejects network interfaces', () => {
  assert.equal(parseConfiguredLoopbackHost(undefined), '127.0.0.1');
  assert.equal(parseConfiguredLoopbackHost('localhost'), 'localhost');
  assert.equal(parseConfiguredLoopbackHost('127.0.0.2'), '127.0.0.2');
  assert.equal(parseConfiguredLoopbackHost('::1'), '::1');
  for (const value of ['0.0.0.0', '10.0.0.2', '192.168.1.20', 'example.test']) {
    assert.throws(() => parseConfiguredLoopbackHost(value), /must be localhost or a loopback IP address/);
  }
});
