# LCT Qwen semantic inference

This service runs one vLLM model server for both LCT semantic roles. The
application caller must construct Worker and Supervisor requests independently;
the adapter forwards each supplied message list and labels its role, but does
not inspect or filter evidence across roles. The calls are stateless requests
with separate schemas and role metadata. The container does not include the
LCT daemon.

## Pinned runtime

- Engine image: the Qwen3.8-specific `vllm/vllm-openai:qwen38` image from the
  official vLLM recipe, pinned to its Linux/amd64 manifest digest in the
  Dockerfile. One image is used for both supported profiles. The pinned image
  was built locally as `lct-qwen-inference:snapshot-local-v4`; its installed
  vLLM package reports `0.1.dev19754+g3a0914114` from fork commit
  `3a0914114705fa38d4c3171d0746c1a6b6f10209`. The tokenizer checks passed,
  but neither serving profile has been started or qualified on a GPU here.
  The official recipe reports tests on a fork build in the v0.27 range.
- Transformers 5.8.0 and `tiktoken` 0.13.0 are pinned at image build. The
  build imports the selected Qwen tokenizer class and constructs its backend
  with a tiny in-memory vocabulary; it downloads no model files for this
  check. `Qwen/Qwen3.8-27B` declares `Qwen2Tokenizer` and ships BPE
  `tokenizer.json`, `vocab.json`, and `merges.txt` files. SentencePiece is not
  required for this tokenizer family and is not added as a dependency. The
  current pinned base image happens to contain both `tiktoken` and
  SentencePiece, but the Dockerfile did not declare either. This differs from
  the RunPod missing-dependency error, which cannot be reproduced with the
  locally pulled base digest. The explicit `tiktoken` pin and build check make
  the reported slow-to-fast fallback dependency reproducible; tokenizer-only
  smoke tests pass against both pinned checkpoints without downloading weights.
- The pinned base already supplies `huggingface_hub` 1.27.0. The Docker build
  verifies its version and `snapshot_download` API; no extra Hub package is
  installed. At startup the entrypoint resolves `MODEL_ID@MODEL_REVISION` with
  `snapshot_download` into `$HF_HOME/hub`, then passes that returned local
  snapshot directory as both vLLM's model and tokenizer path. The public API
  alias remains `Qwen/Qwen3.8-27B`. vLLM also receives the pinned revision for
  diagnostics, while all model and tokenizer files are read from the local
  snapshot.
- Default profile `A100_BF16`: `Qwen/Qwen3.8-27B`, revision
  `1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0`, dtype `bfloat16`,
  `max-model-len=16384`, `max-num-seqs=2`, and
  `gpu-memory-utilization=0.90`. The revision exists and is Apache-2.0:
  [pinned BF16 checkpoint](https://huggingface.co/Qwen/Qwen3.8-27B/tree/1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0).
- Alternate profile `H100_FP8`: `Qwen/Qwen3.8-27B-FP8`, revision
  `017b9c7af6b5689d5dd426a76e0bc077eb5ca20a`, dtype `auto`,
  `max-model-len=32768`, `max-num-seqs=2`, and
  `gpu-memory-utilization=0.90`. The revision exists and is Apache-2.0:
  [pinned FP8 checkpoint](https://huggingface.co/Qwen/Qwen3.8-27B-FP8/tree/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a).
- Public API model alias: Qwen/Qwen3.8-27B.
- The `H100_FP8` profile uses `--dtype auto` so vLLM follows the checkpoint's
  native FP8 quantization metadata.
- The entrypoint enables `--reasoning-parser qwen3`. The parser separates
  reasoning from final content; the daemon consumes only `message.content`
  and validates it against the requested strict JSON Schema. Fake-response
  tests verify this boundary. The parser/structured-output interaction still
  needs a real model smoke test.
- Both profiles serve one model process under the stable API alias. vLLM
  continuous batching schedules concurrent requests; it does not promise
  equal GPU time per role.

The official vLLM recipe estimates 67 GB minimum VRAM for the BF16 checkpoint
and 38 GB for the FP8 checkpoint. It declares H100 for the FP8 variant but
does not list A100 as a verified Qwen3.8-27B device. A100 BF16 is the first
qualification target because the checkpoint is native BF16 and the card has
80 GB; successful loading, headroom, and performance remain unverified until
a GPU test. The recipe estimates do not account for Cloud.ru's allocation
boundary or actual runtime buffers.

## Build

From this directory:

    docker buildx build --check --platform linux/amd64 .
    docker build --platform linux/amd64 -t lct-qwen-inference:snapshot-local-v4 .

The first command checks the Docker build definition without building the
image or retrieving model weights. The second builds the serving image,
downloads the pinned base image and Python packages, and checks the tokenizer
and snapshot dependencies, but never downloads Qwen files.

`model_snapshot.py` uses the immutable profile revision as the source of truth.
Normal startup calls `snapshot_download(repo_id=MODEL_ID,
revision=MODEL_REVISION, cache_dir=$HF_HOME/hub)` without file filters, so it
materializes the full checkpoint before vLLM starts. The returned path is the
Hub cache's local snapshot for that commit; the base model and tokenizer share
the same directory and downloaded blobs are not duplicated. Startup logs both
`MODEL_ID@MODEL_REVISION` and the resolved local path.

`LCT_INFERENCE_PREFLIGHT_ONLY=1` calls the same API and cache with an explicit
allowlist of config, tokenizer, and template files. It excludes weight shards,
then checks `AutoConfig` and `AutoTokenizer` from that local snapshot with
`local_files_only=True`. The preflight logs Python/package locations, import
specs, config and tokenizer classes, and tokenizer backend; it hides CUDA from
the short-lived Python process and never loads model weights. It does not
print environment variables and redacts credential-like values from its own
traceback output. vLLM is skipped in this mode.

For a full startup, the same local-only config/tokenizer check runs after all
files have been materialized. vLLM receives the local snapshot path as both
the positional model and `--tokenizer`, and retains `--served-model-name
Qwen/Qwen3.8-27B` for the public API. The pinned revision flags are also passed
to preserve the requested revision in engine configuration. In the pinned
vLLM source, `resolve_revision` returns immediately when `Path(repo_id).exists()`;
the materialized local directory therefore bypasses Hub revision resolution
inside EngineCore while retaining the pinned SHA.

In the pinned vLLM source, tokenizer creation follows
`cached_tokenizer_from_config` → `cached_get_tokenizer` → `get_tokenizer` →
`CachedHfTokenizer.from_pretrained` → Transformers `AutoTokenizer`. The pinned
CLI registers `--tokenizer` and `--tokenizer-revision`; `ModelConfig` normally
inherits tokenizer revision from model revision, but the RunPod log showed
both as `main`. A local direct `AutoTokenizer` load succeeds for both the
pinned revision and `main`, so the revision mismatch was a confirmed
determinism defect but did not by itself explain the RunPod exception. The
runtime now materializes the pinned commit and tests the tokenizer from that
local path; the local CPU-only preflight has passed for both profile revisions.
RunPod must still confirm that its cache path and runtime interpreter behave
the same.

The `model_type` warning originates in vLLM `get_config`: it retries
`HFConfigParser.parse`, which calls Transformers `AutoConfig`. Transformers
raises that warning text when the parsed config dictionary lacks `model_type`;
vLLM's retry comment identifies a transient config-cache refresh as one
possible condition. The pinned checkpoint config contains
`model_type=qwen3_5`, and the observed run later resolved its architecture.
The first parse input is unavailable, so the warning's trigger remains
unconfirmed; no workaround was added.

Run a deterministic CPU-only snapshot and tokenizer preflight without fetching
weight shards or starting vLLM:

    docker run --rm -e LCT_INFERENCE_PREFLIGHT_ONLY=1 lct-qwen-inference:snapshot-local-v4

It exits 0 only when the pinned config and tokenizer load from the local commit
snapshot. The container retains its normal UID 1000 and image entrypoint; no
GPU is attached.

The build does not download model files, require a GPU, or contact Cloud.ru.
The complete pinned model snapshot is fetched from Hugging Face when the
container starts. Hugging Face, vLLM, Triton, config, and home caches use
writable paths under `/tmp`; do not assume they survive scale-to-zero.
The image has no Docker VOLUME, listens on 8080 by default, and runs as UID 1000.

After an image build, a local hardware smoke run can check the API:

    docker run --rm --gpus all -p 8080:8080 lct-qwen-inference:snapshot-local-v4
    curl http://localhost:8080/health
    curl http://localhost:8080/v1/models

This model smoke requires a compatible NVIDIA GPU and enough disk for the
model download. A successful image build alone does not prove the model
loads, the A100 profile works, or structured output remains valid under
reasoning.

## Cloud.ru Docker RUN deployment

1. Create a container repository in the Cloud.ru Artifact Registry available
   to the target project. Authenticate Docker with the registry values and
   permissions supplied by that project, then tag and push
   `lct-qwen-inference:snapshot-local-v4`. For the current repository, tag
   and push it as `lct-inference.cr.cloud.ru/lct-qwen-inference:snapshot-local-v4`.
   A registry from another project must
   be public according to the Docker RUN image requirements.
2. In AI Factory / ML Inference, create a Serverless inference service using
   Docker RUN and the pushed image. Choose Linux/amd64, port 8080, and A100
   NVLINK 80 GB. Set `LCT_INFERENCE_PROFILE=A100_BF16`, minimum instances to
   0, and maximum instances to 1. Do not enable «Не выключать модель». This
   is the first qualification profile; it is not a claim that the 300-second
   gate has been met.
3. Select Concurrency scaling and set its target to 2 if the console offers
   that threshold. Cloud.ru documents Concurrency as an autoscaling metric;
   its public documentation does not establish that two overlapping requests
   are forwarded into one custom Docker RUN container. Maximum instances 1
   prevents another model instance from being created, but the overlap still
   has to be measured against the deployed URL.
4. If the deployment form exposes probes, configure HTTP GET `/health` on
   port 8080 as a readiness check, with a startup grace period long enough for
   model download and load. Do not use model-load readiness failures as a
   liveness restart trigger. vLLM's `/health` checks the engine; after it is
   healthy, GET `/v1/models` and confirm it lists `Qwen/Qwen3.8-27B`. The
   image adds no Docker `HEALTHCHECK`. Use the generated service URL with
   `/v1` as the daemon base URL.
5. Keep platform authentication enabled for any non-public use. Cloud.ru's
   Docker RUN guide documents optional service-account authentication, but
   does not document a caller token format or secret injection for custom
   containers. The container does not configure an application API key, so
   verify that platform authentication protects the generated URL before
   exposing it. Never place a live key in the image, source, or command history.
6. Wait for readiness, then call the strict-schema adapter smoke contract.
   Check Terminal/System logs for startup errors. The first request at
   minimum=0 can include container startup, model download, and model load.
   Cloud.ru describes scale-to-zero behavior but does not publish a Docker
   RUN request timeout or a numeric startup deadline. Do not treat a cold
   failure as an inference result.

If the A100 profile cannot load the pinned BF16 model or measured performance
requires a faster device, use the same image on an H100 NVLINK GPU with
`LCT_INFERENCE_PROFILE=H100_FP8`. Worker and Supervisor remain requests to
one model server; do not run two model processes or replicas on one GPU.

Cloud.ru deployment facts were checked against the official [Docker RUN image
requirements](https://cloud.ru/docs/ml-inference/ug/topics/concepts__image-requirements),
[Docker RUN creation guide](https://cloud.ru/docs/ml-inference/ug/topics/guides__create-inference-docker),
[scaling guide](https://cloud.ru/docs/ml-inference/ug/topics/concepts__scaling),
[test call guide](https://cloud.ru/docs/ml-inference/ug/topics/guides__test-call-docker),
[GPU FAQ](https://cloud.ru/docs/ml-inference/ug/topics/faq__gpus),
and [Docker logs guide](https://cloud.ru/docs/ml-inference/ug/topics/guides__logs-docker).
Model and serving compatibility are based on the official [Qwen FP8 model
card](https://huggingface.co/Qwen/Qwen3.8-27B-FP8), [Qwen BF16 model card](https://huggingface.co/Qwen/Qwen3.8-27B),
the [vLLM Qwen recipe](https://github.com/vllm-project/recipes/blob/main/models/Qwen/Qwen3.8-27B.yaml),
the [Qwen reasoning parser](https://docs.vllm.ai/en/latest/features/reasoning_outputs/),
and the [vLLM structured output guide](https://docs.vllm.ai/en/stable/examples/features/structured_outputs/).

## Daemon configuration

Configure the application endpoint independently from the hosting provider:

    LCT_SEMANTIC_BASE_URL=https://<generated-service-host>/v1
    LCT_SEMANTIC_MODEL=Qwen/Qwen3.8-27B
    LCT_SEMANTIC_API_KEY=<optional-bearer-key>

When Cloud.ru platform authentication is enabled, configure the caller's
credential according to the authentication method available for that service.
The generic adapter can send a bearer API key and requires HTTPS except for
loopback development endpoints; the Cloud.ru caller credential format for a
custom Docker RUN endpoint still needs verification. Do not commit credentials.
The adapter sends OpenAI-compatible chat completions
requests, role and operation headers, and strict JSON-schema output requests;
it validates every response again in application code.

## Benchmark

From the repository root, with a ready deployment:

    $env:LCT_SEMANTIC_BASE_URL = 'https://<generated-service-host>/v1'
    $env:LCT_SEMANTIC_API_KEY = '<optional-bearer-key>'
    $env:LCT_INFERENCE_PROFILE = 'A100_BF16'
    $env:MODEL_ID = 'Qwen/Qwen3.8-27B'
    $env:MODEL_REVISION = '1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0'
    $env:MODEL_DTYPE = 'bfloat16'
    $env:LCT_BENCHMARK_GPU = 'A100 NVLINK 80GB'
    node services/inference/benchmark.mjs warm --repetitions 3

Warm mode makes Worker and Supervisor warm-up requests, then records
Worker-only, Supervisor-only, serial-pair, and overlapping-pair cases for
each repetition. The report includes the requested profile/checkpoint labels,
per-request and pair wall time, first generated-token and first final-content
token times, and token usage when returned. TTFT includes reasoning tokens
when the server emits them separately; content TTFT starts at the first JSON
content token. Set the matching `MODEL_ID`, `MODEL_REVISION`, and
`MODEL_DTYPE` values for H100 reports. These are caller-supplied labels, not
server attestation. Case order rotates between
repetitions to reduce simple order effects; the summary reports medians rather
than a P95 estimate from this small sample.

To measure one scale-from-zero first request, first verify minimum=0 and let
the deployment reach zero instances, then run:

    node services/inference/benchmark.mjs cold

Cold mode sends exactly one Worker request and no warm-up. Its latency is
end-to-end time through first response, so it combines platform startup,
model download/load, queueing, and generation; it cannot isolate those
components. Re-run cold mode only after independently restoring the service
to zero. Do not compare cold results with warm results.

The harness does not expose GPU utilization, VRAM, server-side queue time, or
prefix-cache hit metrics because this OpenAI-compatible API response does not
provide those measurements. This small synthetic benchmark is a smoke and
diagnostic comparison, not a production throughput or SLO estimate. A local fake-server overlap test proves that the
adapter can issue two concurrent HTTP requests; only the remote benchmark can
measure Cloud.ru routing and actual model-serving overlap.

## Cache and cancellation semantics

The HTTP contract is stateless: each call carries its own full messages.
There is no explicit Worker/Supervisor KV namespace or persistent session in
this adapter. vLLM automatic prefix caching may reuse exact matching prompt
prefix computation internally, but does not restore conversation history or
create role-isolated cache namespaces. Keep role instructions stable and
before mutable evidence if a caller wants prefix reuse. Caller cancellation
aborts the HTTP fetch; GPU work cancellation at the remote server is not
guaranteed by this portable contract.
