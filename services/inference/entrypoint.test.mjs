import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const entrypointUrl = new URL('./entrypoint.sh', import.meta.url);
const dockerfileUrl = new URL('./Dockerfile', import.meta.url);
const readmeUrl = new URL('./README.md', import.meta.url);

async function source(url) {
  return readFile(url, 'utf8');
}

test('A100_BF16 profile pins the BF16 checkpoint and conservative first-run limits', async () => {
  const script = await source(entrypointUrl);
  const a100 = script.slice(script.indexOf('  A100_BF16)'), script.indexOf('  H100_FP8)'));

  assert.match(script, /LCT_INFERENCE_PROFILE="\$\{LCT_INFERENCE_PROFILE:-A100_BF16\}"/);
  assert.match(a100, /PROFILE_MODEL_ID="Qwen\/Qwen3\.8-27B"/);
  assert.match(a100, /PROFILE_MODEL_REVISION="1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0"/);
  assert.match(a100, /PROFILE_MODEL_DTYPE="bfloat16"/);
  assert.match(a100, /PROFILE_MAX_MODEL_LEN=16384/);
  assert.match(script, /MAX_NUM_SEQS="\$\{MAX_NUM_SEQS:-2\}"/);
  assert.match(script, /GPU_MEMORY_UTILIZATION="\$\{GPU_MEMORY_UTILIZATION:-0\.90\}"/);
});

test('H100_FP8 profile retains the pinned FP8 checkpoint with native checkpoint dtype selection', async () => {
  const script = await source(entrypointUrl);
  const h100 = script.slice(script.indexOf('  H100_FP8)'), script.indexOf('  *)'));

  assert.match(h100, /PROFILE_MODEL_ID="Qwen\/Qwen3\.8-27B-FP8"/);
  assert.match(h100, /PROFILE_MODEL_REVISION="017b9c7af6b5689d5dd426a76e0bc077eb5ca20a"/);
  assert.match(h100, /PROFILE_MODEL_DTYPE="auto"/);
  assert.match(h100, /PROFILE_MAX_MODEL_LEN=32768/);
});

test('entrypoint fails closed on unknown profiles and incompatible dtypes', async () => {
  const script = await source(entrypointUrl);
  assert.match(script, /LCT_INFERENCE_PROFILE must be A100_BF16 or H100_FP8/);
  assert.match(script, /MODEL_DTYPE must be \$PROFILE_MODEL_DTYPE for profile/);
  assert.match(script, /MODEL_REVISION.*\{40\}/);
});

test('one server exposes the configured port, binds externally, selects Qwen reasoning, and keeps model files external', async () => {
  const [script, dockerfile, readme] = await Promise.all([
    source(entrypointUrl), source(dockerfileUrl), source(readmeUrl),
  ]);
  assert.match(dockerfile, /EXPOSE 8080/);
  assert.match(dockerfile, /COPY[^\n]*entrypoint\.sh/);
  assert.doesNotMatch(dockerfile, /safetensors|huggingface-cli download|hf download/i);
  assert.equal((script.match(/exec vllm /g) || []).length, 1);
  assert.match(script, /--host 0\.0\.0\.0/);
  assert.match(script, /--port "\$PORT"/);
  assert.match(script, /--served-model-name "\$SERVED_MODEL_NAME"/);
  assert.match(script, /--reasoning-parser qwen3/);
  assert.match(readme, /readiness[^\n]*\/health|readiness[\s\S]{0,160}\/health/i);
  assert.match(readme, /\/v1\/models/);
  assert.doesNotMatch(dockerfile, /^HEALTHCHECK\b/m);
});

test('Docker build pins and checks the Qwen tokenizer fallback without fetching model files', async () => {
  const [dockerfile, readme] = await Promise.all([source(dockerfileUrl), source(readmeUrl)]);

  assert.match(dockerfile, /transformers==5\.8\.0/);
  assert.match(dockerfile, /tiktoken==0\.13\.0/);
  assert.match(dockerfile, /python3 -c '[^\n]*import tiktoken/);
  assert.match(dockerfile, /Qwen2Tokenizer\(\)/);
  assert.match(dockerfile, /metadata\.version\("tiktoken"\) == "0\.13\.0"/);
  assert.doesNotMatch(dockerfile, /sentencepiece|from_pretrained|snapshot_download|hf download|safetensors/i);
  assert.match(readme, /sentencepiece is not[\s\S]{0,30}required/i);
  assert.match(readme, /tiktoken[^\n]*pinned/i);
});
