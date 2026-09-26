#!/usr/bin/env node

import { startFakeSemanticEndpoint } from './lib/fake-openai-compatible-endpoint.mjs';
import { parseConfiguredPort } from './lib/port.mjs';

let port;
try {
  port = parseConfiguredPort(process.env.LCT_FAKE_SEMANTIC_PORT, 'LCT_FAKE_SEMANTIC_PORT', 8787);
} catch (error) {
  console.error(`[lct] invalid fake endpoint configuration: ${error instanceof Error ? error.message : 'invalid port'}`);
  process.exit(2);
}
const endpoint = await startFakeSemanticEndpoint({ port });
console.log(`[lct] offline semantic endpoint listening at ${endpoint.url}`);
console.log('[lct] configure daemon: LCT_SEMANTIC_BASE_URL=http://127.0.0.1:8787/v1 LCT_SEMANTIC_MODEL=Qwen/Qwen3.8-27B');

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void endpoint.close();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
