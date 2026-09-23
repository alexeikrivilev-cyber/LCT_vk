FROM vllm/vllm-openai:qwen38@sha256:d392f621bb3e372ecc09f0b0cb88099afe9fa05d37a0450de45eeb8c12b6787e

LABEL org.opencontainers.image.title="LCT Qwen semantic inference"
LABEL org.opencontainers.image.description="One vLLM server for concurrent LCT Worker and Supervisor requests"

RUN uv pip install --system "transformers==5.8.0"

ENV PORT=8080 \
    MODEL_ID=Qwen/Qwen3.8-27B-FP8 \
    MODEL_REVISION=017b9c7af6b5689d5dd426a76e0bc077eb5ca20a \
    SERVED_MODEL_NAME=Qwen/Qwen3.8-27B \
    MAX_MODEL_LEN=32768 \
    MAX_NUM_SEQS=2 \
    MAX_NUM_BATCHED_TOKENS=4096 \
    GPU_MEMORY_UTILIZATION=0.90 \
    HOME=/tmp/lct-home \
    XDG_CACHE_HOME=/tmp/lct-home/.cache \
    HF_HOME=/tmp/lct-huggingface \
    VLLM_CACHE_ROOT=/tmp/lct-vllm-cache \
    VLLM_CONFIG_ROOT=/tmp/lct-vllm-config \
    TRITON_CACHE_DIR=/tmp/lct-triton-cache

COPY --chown=0:0 --chmod=0555 entrypoint.sh /opt/lct-inference/entrypoint.sh

RUN if ! grep -qE '^[^:]+:[^:]*:1000:' /etc/passwd; then \
      printf '%s\n' 'lct:x:1000:1000:LCT inference runtime:/tmp/lct-home:/bin/bash' >> /etc/passwd; \
    fi \
    && if ! grep -qE '^[^:]+:[^:]*:1000:' /etc/group; then \
      printf '%s\n' 'lct:x:1000:' >> /etc/group; \
    fi

ENV USER=lct \
    LOGNAME=lct

EXPOSE 8080
USER 1000:1000
ENTRYPOINT ["/opt/lct-inference/entrypoint.sh"]
