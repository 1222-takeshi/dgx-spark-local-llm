#!/usr/bin/env bash
set -euo pipefail
# one model at a time: loading two at once exhausted memory and hung the host
docker rm -f ornith-b12x-serve nemotron-serve >/dev/null 2>&1 || true
IMAGE="eugr/spark-vllm-b12x@sha256:d999354461ae004c754333fd50a69867816758c864687e41b9a224b748a2c104"
SNAP=$(ls -d $HOME/.cache/huggingface/hub/models--nvidia--Gemma-4-26B-A4B-NVFP4/snapshots/*/ | head -1); SNAP=${SNAP%/}
docker rm -f gemma4-serve >/dev/null 2>&1 || true
docker run -d --name gemma4-serve --gpus all --network host --ipc=host \
  -v $HOME/.cache/huggingface:/root/.cache/huggingface -v $HOME/.cache/vllm:/root/.cache/vllm \
  "$IMAGE" vllm serve "/root/.cache/huggingface/${SNAP#$HOME/.cache/huggingface/}" \
  --served-model-name gemma-4-26b-a4b-nvfp4 --host 127.0.0.1 --port 8889 --trust-remote-code \
  --enable-prefix-caching --max-num-seqs 8 --gpu-memory-utilization 0.60 --max-model-len 131072 \
  --tool-call-parser gemma4 --reasoning-parser gemma4 --enable-auto-tool-choice
