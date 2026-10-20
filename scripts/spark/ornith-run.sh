#!/usr/bin/env bash
# Custom launch (no HF token needed; weights already cached). Keeps the two upstream patches.
set -euo pipefail
# one model at a time: loading two at once exhausted memory and hung the host
docker rm -f gemma4-serve nemotron-serve >/dev/null 2>&1 || true
IMAGE="eugr/spark-vllm-b12x@sha256:d999354461ae004c754333fd50a69867816758c864687e41b9a224b748a2c104"
# shellcheck disable=SC2012  # ls -d keeps the trailing slash on the snapshot path that ${SNAP#...} strips below
SNAP=$(ls -d "$HOME"/.cache/huggingface/hub/models--ornith-ai--Ornith-1.5-35B-A3B-NVFP4/snapshots/*/ | head -1); SNAP=${SNAP%/}
docker rm -f ornith-b12x-serve >/dev/null 2>&1 || true
docker run -d --name ornith-b12x-serve --gpus all --network host --ipc=host \
  -v "$HOME"/.cache/huggingface:/root/.cache/huggingface -v "$HOME"/.cache/vllm:/root/.cache/vllm \
  -v "$HOME"/work/Ornith-1.5-35B-A3B-DGX-Spark/patches/kernel.py:/usr/local/lib/python3.12/dist-packages/b12x/moe/_shared/kernels/w4a16/kernel.py:ro \
  -v "$HOME"/work/Ornith-1.5-35B-A3B-DGX-Spark/patches/route_pack.py:/usr/local/lib/python3.12/dist-packages/b12x/moe/_shared/kernels/w4a16/route_pack.py:ro \
  "$IMAGE" vllm serve "/root/.cache/huggingface/${SNAP#"$HOME"/.cache/huggingface/}" \
  --served-model-name ornith-1.5-35b-a3b-nvfp4 --host 127.0.0.1 --port 8888 --trust-remote-code \
  --enable-prefix-caching --spec-method mtp --spec-tokens 1 --max-num-seqs 8 --moe-backend b12x \
  --gpu-memory-utilization 0.60 --max-model-len 262144 \
  --enable-auto-tool-choice --tool-call-parser qwen3_xml --reasoning-parser qwen3
