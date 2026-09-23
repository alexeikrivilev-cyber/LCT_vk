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
  Dockerfile. The official recipe reports test runs on a fork build in the
  v0.27 range and says older releases are unverified; this repository has not
  built this exact image or verified it serving the selected model.
- Transformers: 5.8.0 is pinned at image build for the Qwen3-VL processor
  classes required by the official recipe. The image build has not yet
  verified that installation against this exact base image.
- Model repository: Qwen/Qwen3.8-27B-FP8, pinned to revision
  017b9c7af6b5689d5dd426a76e0bc077eb5ca20a.
- Public API model alias: Qwen/Qwen3.8-27B.
- Model license: Apache-2.0.
- Default profile: one GPU, 32,768-token model limit, at most two active
  sequences, prefix caching enabled. vLLM continuous batching schedules
  active requests together; it does not promise equal GPU time per role.

The official vLLM recipe declares H100 support and estimates 38 GB minimum
VRAM for this FP8 checkpoint. That is a compatibility declaration, not a
measurement on a Cloud.ru H100. Use a GPU with at least 80 GB for the first
controlled run. The exact Cloud.ru device, storage quota, model-load time,
and maximum startup duration still need a deployment check.

## Build

From this directory:

    docker build --platform linux/amd64 -t lct-qwen-inference:dev .

The build downloads the pinned vLLM base image and pinned Transformers
package. It does not download model weights, require a GPU, or contact
Cloud.ru. The model is fetched from Hugging Face when the container starts.
Hugging Face, vLLM, Triton, config,
and home caches use writable paths under /tmp; do not assume they survive scale-to-zero.
The image has no Docker VOLUME, listens on 8080 by default, and runs as UID 1000.

For a local hardware smoke run:

    docker run --rm --gpus all -p 8080:8080 lct-qwen-inference:dev
    curl http://localhost:8080/health
    curl http://localhost:8080/v1/models

This local model smoke requires a compatible NVIDIA GPU and enough disk for
the model download. A successful image build alone does not prove the model
loads or generates.

## Cloud.ru Docker RUN deployment

1. Create a container repository in the Cloud.ru Artifact Registry available
   to the target project. Authenticate Docker with the registry values and
   permissions supplied by that project, then tag and push
   lct-qwen-inference:dev. A registry from another project must be public
   according to the Docker RUN image requirements.
2. In AI Factory / ML Inference, create a Serverless inference service using
   Docker RUN and the pushed image. Choose Linux/amd64, port 8080, and an
   H100 80 GB GPU for the initial profile. Set minimum instances to 0 and
   maximum instances to 1 for the controlled experiment.
3. Select Concurrency scaling and set its target to 2 if the console offers
   that threshold. Cloud.ru documents Concurrency as an autoscaling metric;
   its public documentation does not establish that two overlapping requests
   are forwarded into one custom Docker RUN container. Maximum instances 1
   prevents another model instance from being created, but the overlap still
   has to be measured against the deployed URL.
4. Configure readiness as HTTP GET /health on port 8080 if the deployment
   form exposes probes. vLLM serves this endpoint after the model server is
   ready. Use the generated service URL with /v1 as the daemon base URL.
5. Keep platform authentication enabled for any non-public use. Cloud.ru's
   Docker RUN guide documents optional service-account authentication, but
   does not document a caller token format or secret injection for custom
   containers. The container does not configure an application API key, so
   verify that platform authentication protects the generated URL before
   exposing it. Never place a live key in the image, source, or command history.
6. Wait for readiness, then call /v1/models and the adapter smoke contract.
   Check Terminal/System logs for startup errors. The first request at
   minimum=0 can include container startup, model download, and model load.
   Cloud.ru describes scale-to-zero behavior but does not publish a Docker
   RUN request timeout or a numeric startup deadline. Do not treat a cold
   failure as an inference result.

Cloud.ru deployment facts were checked against the official [Docker RUN image
requirements](https://cloud.ru/docs/ml-inference/ug/topics/concepts__image-requirements),
[Docker RUN creation guide](https://cloud.ru/docs/ml-inference/ug/topics/guides__create-inference-docker),
[scaling guide](https://cloud.ru/docs/ml-inference/ug/topics/concepts__scaling),
[test call guide](https://cloud.ru/docs/ml-inference/ug/topics/guides__test-call-docker),
[GPU FAQ](https://cloud.ru/docs/ml-inference/ug/topics/faq__gpus),
and [Docker logs guide](https://cloud.ru/docs/ml-inference/ug/topics/guides__logs-docker).
Model and serving compatibility are based on the official [Qwen FP8 model
card](https://huggingface.co/Qwen/Qwen3.8-27B-FP8), the [vLLM Qwen recipe](https://github.com/vllm-project/recipes/blob/main/models/Qwen/Qwen3.8-27B.yaml),
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
    node services/inference/benchmark.mjs warm --repetitions 3

Warm mode makes Worker and Supervisor warm-up requests, then records
Worker-only, Supervisor-only, serial-pair, and overlapping-pair cases for
each repetition. It reports per-request latency, first streamed token time,
token usage when returned, and pair wall time. Case order rotates between
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
