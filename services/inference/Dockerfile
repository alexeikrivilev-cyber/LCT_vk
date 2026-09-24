FROM vllm/vllm-openai:qwen38@sha256:d392f621bb3e372ecc09f0b0cb88099afe9fa05d37a0450de45eeb8c12b6787e

LABEL org.opencontainers.image.title="LCT Qwen semantic inference"
LABEL org.opencontainers.image.description="One vLLM server for concurrent LCT Worker and Supervisor requests"

RUN uv pip install --system "transformers==5.8.0" "tiktoken==0.13.0" \
    && python3 -c 'import importlib.metadata as metadata; import tiktoken; from transformers.models.qwen2.tokenization_qwen2 import Qwen2Tokenizer; assert metadata.version("transformers") == "5.8.0"; assert metadata.version("tiktoken") == "0.13.0"; tokenizer = Qwen2Tokenizer(); assert tokenizer._tokenizer.get_vocab(); print("Qwen tokenizer dependency check passed")'

ENV PORT=8080 \
    LCT_INFERENCE_PROFILE=A100_BF16 \
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
