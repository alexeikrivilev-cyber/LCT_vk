import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const entrypointUrl = new URL('./entrypoint.sh', import.meta.url);
const snapshotUrl = new URL('./model_snapshot.py', import.meta.url);
const preflightUrl = new URL('./tokenizer_preflight.py', import.meta.url);
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

test('one server exposes the configured port, serves the public alias, and uses local snapshot paths', async () => {
  const [script, dockerfile, readme] = await Promise.all([
    source(entrypointUrl), source(dockerfileUrl), source(readmeUrl),
  ]);
  assert.match(dockerfile, /EXPOSE 8080/);
  assert.match(dockerfile, /COPY[^\n]*entrypoint\.sh/);
  assert.doesNotMatch(dockerfile, /safetensors|huggingface-cli download|hf download/i);
  assert.equal((script.match(/exec vllm /g) || []).length, 1);
  assert.match(script, /serve "\$MODEL_LOCAL_PATH"/);
  assert.match(script, /--tokenizer "\$MODEL_LOCAL_PATH"/);
  assert.doesNotMatch(script, /serve "\$MODEL_ID"/);
  assert.doesNotMatch(script, /--tokenizer "\$MODEL_ID"/);
  assert.match(script, /--served-model-name "\$SERVED_MODEL_NAME"/);
  assert.match(script, /SERVED_MODEL_NAME="\$\{SERVED_MODEL_NAME:-Qwen\/Qwen3\.8-27B\}"/);
  assert.match(script, /--host 0\.0\.0\.0/);
  assert.match(script, /--port "\$PORT"/);
  assert.match(script, /--reasoning-parser qwen3/);
  assert.match(readme, /readiness[^\n]*\/health|readiness[\s\S]{0,160}\/health/i);
  assert.match(readme, /\/v1\/models/);
  assert.doesNotMatch(dockerfile, /^HEALTHCHECK\b/m);
});

test('Docker build checks the existing snapshot dependency without fetching model files', async () => {
  const [dockerfile, readme] = await Promise.all([source(dockerfileUrl), source(readmeUrl)]);

  assert.match(dockerfile, /transformers==5\.8\.0/);
  assert.match(dockerfile, /tiktoken==0\.13\.0/);
  assert.match(dockerfile, /metadata\.version\("huggingface-hub"\) == "1\.27\.0"/);
  assert.match(dockerfile, /from huggingface_hub import snapshot_download/);
  assert.match(dockerfile, /python3 -c '[^\n]*import tiktoken/);
  assert.match(dockerfile, /Qwen2Tokenizer\(\)/);
  assert.match(dockerfile, /metadata\.version\("tiktoken"\) == "0\.13\.0"/);
  assert.doesNotMatch(dockerfile, /sentencepiece|from_pretrained|hf download|safetensors/i);
  assert.match(dockerfile, /py_compile \/opt\/lct-inference\/model_snapshot\.py \/opt\/lct-inference\/tokenizer_preflight\.py/);
  assert.match(readme, /sentencepiece is not[\s\S]{0,30}required/i);
  assert.match(readme, /tiktoken[^\n]*pinned/i);
  assert.match(readme, /huggingface_hub[^\n]*1\.27\.0/i);
});

test('snapshot materialization pins the profile revision and preflight-only excludes weights', async () => {
  const snapshot = await source(snapshotUrl);
  const script = await source(entrypointUrl);

  assert.match(snapshot, /snapshot_download\(/);
  assert.match(snapshot, /repo_id=model_id/);
  assert.match(snapshot, /revision=revision/);
  assert.match(snapshot, /cache_dir=cache_dir/);
  assert.match(snapshot, /allow_patterns=allow_patterns/);
  assert.match(snapshot, /PREFLIGHT_FILES = \(/);
  assert.match(snapshot, /REQUIRED_PREFLIGHT_FILES = \("config\.json", "tokenizer_config\.json", "tokenizer\.json"\)/);
  assert.doesNotMatch(snapshot, /safetensors|\.bin|model-\*|layers-\*/i);
  assert.match(script, /MODEL_REVISION.*\$PROFILE_MODEL_REVISION/);
  assert.match(script, /env CUDA_VISIBLE_DEVICES= python3 \/opt\/lct-inference\/model_snapshot\.py "\$MODEL_ID" "\$MODEL_REVISION" "\$HF_HOME" "\$SNAPSHOT_MODE"/);
  assert.match(script, /--revision "\$MODEL_REVISION"/);
  assert.match(script, /--tokenizer-revision "\$MODEL_REVISION"/);
});

test('preflight-only downloads a tokenizer snapshot, validates it locally, and exits before vLLM', async () => {
  const script = await source(entrypointUrl);
  const snapshot = await source(snapshotUrl);
  const preflight = await source(preflightUrl);
  const preflightOnlyBranch = script.indexOf('if [[ "$PREFLIGHT_ONLY" == "1" ]]');
  const vllmExec = script.indexOf('exec vllm');

  assert.match(script, /SNAPSHOT_MODE="preflight"/);
  assert.match(script, /env CUDA_VISIBLE_DEVICES= python3 \/opt\/lct-inference\/tokenizer_preflight\.py "\$MODEL_LOCAL_PATH" "\$MODEL_ID" "\$MODEL_REVISION"/);
  assert.ok(preflightOnlyBranch >= 0 && preflightOnlyBranch < vllmExec);
  assert.doesNotMatch(script.slice(preflightOnlyBranch, vllmExec), /vllm/);
  assert.match(snapshot, /allow_patterns = list\(PREFLIGHT_FILES\) if mode == "preflight" else None/);
  assert.match(preflight, /AutoConfig\.from_pretrained\(model_path, local_files_only=True\)/);
  assert.match(preflight, /AutoTokenizer\.from_pretrained\(model_path, local_files_only=True\)/);
  assert.match(preflight, /tokenizer\.backend_class=/);
  assert.match(preflight, /config\.model_type=/);
});

test('tokenizer diagnostics redact credential values and do not dump the environment', async () => {
  const preflight = await source(preflightUrl);
  const snapshot = await source(snapshotUrl);

  assert.match(preflight, /SECRET_NAME_MARKERS/);
  assert.match(preflight, /redact_secret_values/);
  assert.doesNotMatch(preflight, /print\([^\n]*os\.environ/);
  assert.doesNotMatch(preflight, /printenv|env\s*\)/i);
  assert.match(snapshot, /SECRET_NAME_MARKERS/);
  assert.match(snapshot, /redact_secret_values/);
  assert.match(snapshot, /Hub exceptions can contain signed download URLs/);
  assert.match(snapshot, /download\.traceback=omitted/);
  assert.doesNotMatch(snapshot, /print\([^\n]*os\.environ|traceback\.format_exc/);
});
