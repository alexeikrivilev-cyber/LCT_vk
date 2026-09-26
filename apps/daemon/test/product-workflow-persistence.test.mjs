import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'tsx/esm/api';

register();
const { renameWithTransientRetry } = await import('../src/presentation/application/product-workflow-service.ts');

test('workflow state replacement retries bounded transient Windows file locks', async () => {
  let attempts = 0;
  const delays = [];
  await renameWithTransientRetry('state.tmp', 'state.json', async () => {
    attempts += 1;
    if (attempts < 4) throw Object.assign(new Error('file is temporarily locked'), { code: 'EPERM' });
  }, async (ms) => { delays.push(ms); });

  assert.equal(attempts, 4);
  assert.deepEqual(delays, [20, 40, 80]);
});

test('workflow state replacement does not retry permanent failures', async () => {
  let attempts = 0;
  await assert.rejects(renameWithTransientRetry('state.tmp', 'state.json', async () => {
    attempts += 1;
    throw Object.assign(new Error('source does not exist'), { code: 'ENOENT' });
  }, async () => {}), { code: 'ENOENT' });
  assert.equal(attempts, 1);
});
