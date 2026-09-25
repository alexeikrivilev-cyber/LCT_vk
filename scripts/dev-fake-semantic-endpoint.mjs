#!/usr/bin/env node

import { startFakeSemanticEndpoint } from './lib/fake-openai-compatible-endpoint.mjs';

const port = Number(process.env.LCT_FAKE_SEMANTIC_PORT) || 8787;
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
