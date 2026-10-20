#!/usr/bin/env bash
set -euo pipefail
# one model at a time: loading two at once exhausted memory and hung the host
docker rm -f ornith-b12x-serve gemma4-serve >/dev/null 2>&1 || true
IMAGE="eugr/spark-vllm-b12x@sha256:d999354461ae004c754333fd50a69867816758c864687e41b9a224b748a2c104"
H=$HOME/.cache/huggingface/hub
# shellcheck disable=SC2012  # ls -d keeps the trailing slash on the snapshot path that ${SNAP#...} strips below
SNAP=$(ls -d "$H"/models--nvidia--NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4/snapshots/*/ | head -1); SNAP=${SNAP%/}
# shellcheck disable=SC2012  # ls -d keeps the trailing slash on the snapshot path that ${DSP#...} strips below
DSP=$(ls -d "$H"/models--nvidia--NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4-DSpark/snapshots/*/ | head -1); DSP=${DSP%/}
docker rm -f nemotron-serve >/dev/null 2>&1 || true
docker run -d --name nemotron-serve --gpus all --network host --ipc=host \
  -v "$HOME"/.cache/huggingface:/root/.cache/huggingface -v "$HOME"/.cache/vllm:/root/.cache/vllm \
  "$IMAGE" vllm serve "/root/.cache/huggingface/${SNAP#"$HOME"/.cache/huggingface/}" \
  --served-model-name nemotron-3.5-lightning-nvfp4 --host 127.0.0.1 --port 8891 --trust-remote-code \
  --moe-backend marlin --kv-cache-dtype fp8 --enable-prefix-caching --max-num-seqs 8 \
  --gpu-memory-utilization 0.60 --max-model-len 262144 \
  --speculative_config.num_speculative_tokens 3 --mamba-backend flashinfer --mamba-cache-mode align \
  --speculative_config.model "/root/.cache/huggingface/${DSP#"$HOME"/.cache/huggingface/}" \
  --reasoning-parser nemotron_v3 --tool-call-parser qwen3_coder --enable-auto-tool-choice
