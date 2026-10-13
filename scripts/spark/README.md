# Spark 起動スクリプト

いずれも `vllm` のイメージ `eugr/spark-vllm-b12x`（digest 固定）で起動する。重みは `~/.cache/huggingface` に取得済みである前提。

| スクリプト | モデル | ポート | 備考 |
|---|---|---|---|
| `ornith-run.sh` | Ornith-1.5-35B-A3B NVFP4 | 8888 | b12x MoE + MTP。第三者リポジトリ（MiaAI-Lab/Ornith-1.5-35B-A3B-DGX-Spark）のパッチ 2 本を `~/work/` に置いてマウントする |
| `gemma-run.sh` | Gemma-4-26B-A4B NVFP4 | 8889 | 推測デコードなし。約 30 tok/s と遅い |
| `nemotron-run.sh` | Nemotron-3.5-Lightning 30B-A3B NVFP4 | 8891 | DSpark ドラフトモデルを別途取得 |

- 同時に起動するのは 1 モデルだけ。切り替えるときは先に `docker rm -f` で止める。
- `--host 127.0.0.1` で待ち受ける。外部公開しない。SSH トンネルでアクセスする。
- Qwen3.8-Flash-Next（NVFP4、重み合計 124GB）は標準構成では載らない。標準の起動を試して**ホストが停止した**。PLE テーブルを NVMe から mmap する第三者レシピ（blazux/qwen3.8-Flash-DGX）を、API を localhost のみに公開する形で検証中。
