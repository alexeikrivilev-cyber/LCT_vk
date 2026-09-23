#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8080}"
LCT_INFERENCE_PROFILE="${LCT_INFERENCE_PROFILE:-A100_BF16}"
SERVED_MODEL_NAME="${SERVED_MODEL_NAME:-Qwen/Qwen3.8-27B}"
MAX_NUM_SEQS="${MAX_NUM_SEQS:-2}"
MAX_NUM_BATCHED_TOKENS="${MAX_NUM_BATCHED_TOKENS:-4096}"
GPU_MEMORY_UTILIZATION="${GPU_MEMORY_UTILIZATION:-0.90}"
HOME="${HOME:-/tmp/lct-home}"
HF_HOME="${HF_HOME:-/tmp/lct-huggingface}"
VLLM_CACHE_ROOT="${VLLM_CACHE_ROOT:-/tmp/lct-vllm-cache}"
VLLM_CONFIG_ROOT="${VLLM_CONFIG_ROOT:-/tmp/lct-vllm-config}"
TRITON_CACHE_DIR="${TRITON_CACHE_DIR:-/tmp/lct-triton-cache}"

case "$LCT_INFERENCE_PROFILE" in
  A100_BF16)
    PROFILE_MODEL_ID="Qwen/Qwen3.8-27B"
    PROFILE_MODEL_REVISION="1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0"
    PROFILE_MODEL_DTYPE="bfloat16"
    PROFILE_MAX_MODEL_LEN=16384
    ;;
  H100_FP8)
    PROFILE_MODEL_ID="Qwen/Qwen3.8-27B-FP8"
    PROFILE_MODEL_REVISION="017b9c7af6b5689d5dd426a76e0bc077eb5ca20a"
    PROFILE_MODEL_DTYPE="auto"
    PROFILE_MAX_MODEL_LEN=32768
    ;;
  *)
    echo "LCT_INFERENCE_PROFILE must be A100_BF16 or H100_FP8" >&2
    exit 64
    ;;
esac

MODEL_ID="${MODEL_ID:-$PROFILE_MODEL_ID}"
MODEL_REVISION="${MODEL_REVISION:-$PROFILE_MODEL_REVISION}"
MODEL_DTYPE="${MODEL_DTYPE:-$PROFILE_MODEL_DTYPE}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-$PROFILE_MAX_MODEL_LEN}"

if [[ "$MODEL_DTYPE" != "$PROFILE_MODEL_DTYPE" ]]; then
  echo "MODEL_DTYPE must be $PROFILE_MODEL_DTYPE for profile $LCT_INFERENCE_PROFILE" >&2
  exit 64
fi
if [[ -z "$MODEL_ID" || -z "$SERVED_MODEL_NAME" ]]; then
  echo "MODEL_ID and SERVED_MODEL_NAME must not be empty" >&2
  exit 64
fi
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "PORT must be an integer from 1 to 65535" >&2
  exit 64
fi
if ! [[ "$MAX_MODEL_LEN" =~ ^[0-9]+$ ]] || (( MAX_MODEL_LEN < 1 )); then
  echo "MAX_MODEL_LEN must be a positive integer" >&2
  exit 64
fi
if ! [[ "$MAX_NUM_SEQS" =~ ^[0-9]+$ ]] || (( MAX_NUM_SEQS < 1 )); then
  echo "MAX_NUM_SEQS must be a positive integer" >&2
  exit 64
fi
if ! [[ "$MAX_NUM_BATCHED_TOKENS" =~ ^[0-9]+$ ]] || (( MAX_NUM_BATCHED_TOKENS < 1 )); then
  echo "MAX_NUM_BATCHED_TOKENS must be a positive integer" >&2
  exit 64
fi
if ! [[ "$GPU_MEMORY_UTILIZATION" =~ ^0\.[0-9]*[1-9][0-9]*$ ]]; then
  echo "GPU_MEMORY_UTILIZATION must be greater than 0 and less than 1" >&2
  exit 64
fi
if ! [[ "$MODEL_REVISION" =~ ^[A-Fa-f0-9]{40}$ ]]; then
  echo "MODEL_REVISION must be a full 40-character commit SHA" >&2
  exit 64
fi

mkdir -p "$HOME" "$HF_HOME" "$VLLM_CACHE_ROOT" "$VLLM_CONFIG_ROOT" "$TRITON_CACHE_DIR"
args=(
  serve "$MODEL_ID"
  --revision "$MODEL_REVISION"
  --dtype "$MODEL_DTYPE"
  --served-model-name "$SERVED_MODEL_NAME"
  --reasoning-parser qwen3
  --host 0.0.0.0
  --port "$PORT"
  --max-model-len "$MAX_MODEL_LEN"
  --max-num-seqs "$MAX_NUM_SEQS"
  --max-num-batched-tokens "$MAX_NUM_BATCHED_TOKENS"
  --gpu-memory-utilization "$GPU_MEMORY_UTILIZATION"
  --enable-prefix-caching
)
exec vllm "${args[@]}"
