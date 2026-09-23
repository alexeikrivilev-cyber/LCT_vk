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
  Dockerfile. One image is used for both supported profiles. The official
  recipe reports tests on a fork build in the v0.27 range; this repository
  has not built or run the pinned image with these profiles.
- Transformers: 5.8.0 is pinned at image build for the Qwen3-VL processor
  classes required by the multimodal model. The image build has not yet
  verified this installation against the exact base image.
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
    docker build --platform linux/amd64 -t lct-qwen-inference:dev .

The first command checks the Docker build definition without building the
image or retrieving model weights. The second builds the serving image and
downloads the pinned base image and Transformers package, but never the Qwen
weights.

The build does not download model weights, require a GPU, or contact
Cloud.ru. The model is fetched from Hugging Face when the container starts.
Hugging Face, vLLM, Triton, config, and home caches use writable paths under
/tmp; do not assume they survive scale-to-zero.
The image has no Docker VOLUME, listens on 8080 by default, and runs as UID 1000.

After an image build, a local hardware smoke run can check the API:

    docker run --rm --gpus all -p 8080:8080 lct-qwen-inference:dev
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
   lct-qwen-inference:dev. A registry from another project must be public
   according to the Docker RUN image requirements.
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
