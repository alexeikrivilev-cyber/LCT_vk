#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8080}"
MODEL_ID="${MODEL_ID:-Qwen/Qwen3.8-27B-FP8}"
MODEL_REVISION="${MODEL_REVISION:-017b9c7af6b5689d5dd426a76e0bc077eb5ca20a}"
SERVED_MODEL_NAME="${SERVED_MODEL_NAME:-Qwen/Qwen3.8-27B}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-32768}"
MAX_NUM_SEQS="${MAX_NUM_SEQS:-2}"
MAX_NUM_BATCHED_TOKENS="${MAX_NUM_BATCHED_TOKENS:-4096}"
GPU_MEMORY_UTILIZATION="${GPU_MEMORY_UTILIZATION:-0.90}"
HOME="${HOME:-/tmp/lct-home}"
HF_HOME="${HF_HOME:-/tmp/lct-huggingface}"
VLLM_CACHE_ROOT="${VLLM_CACHE_ROOT:-/tmp/lct-vllm-cache}"
VLLM_CONFIG_ROOT="${VLLM_CONFIG_ROOT:-/tmp/lct-vllm-config}"
TRITON_CACHE_DIR="${TRITON_CACHE_DIR:-/tmp/lct-triton-cache}"

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
if ! [[ "$GPU_MEMORY_UTILIZATION" =~ ^0\.[0-9]+$ ]]; then
  echo "GPU_MEMORY_UTILIZATION must be a decimal between 0 and 1" >&2
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
  --served-model-name "$SERVED_MODEL_NAME"
  --host 0.0.0.0
  --port "$PORT"
  --max-model-len "$MAX_MODEL_LEN"
  --max-num-seqs "$MAX_NUM_SEQS"
  --max-num-batched-tokens "$MAX_NUM_BATCHED_TOKENS"
  --gpu-memory-utilization "$GPU_MEMORY_UTILIZATION"
  --enable-prefix-caching
)
exec vllm "${args[@]}"
