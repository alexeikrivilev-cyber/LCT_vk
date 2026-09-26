import assert from 'node:assert/strict';
import test from 'node:test';

import { parseConfiguredPort } from './port.mjs';

test('configured ports use defaults only when unset and reject invalid values', () => {
  assert.equal(parseConfiguredPort(undefined, 'PORT', 3000), 3000);
  assert.equal(parseConfiguredPort('', 'PORT', 3000), 3000);
  assert.equal(parseConfiguredPort('8787', 'PORT', 3000), 8787);
  for (const value of ['0', '-1', '1.5', 'abc', '65536', '123456']) {
    assert.throws(() => parseConfiguredPort(value, 'PORT', 3000), /PORT must be an integer/);
  }
});
