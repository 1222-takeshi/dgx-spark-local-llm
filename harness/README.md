# ハーネス

- `basics/runner.mjs`（sparkDash の `server/collectors/qualitySuite.js` を `./server/collectors/` に置く必要がある。ルートの README 参照）: 基礎 150 問（qa / reason / arith / track / gsm8k / mmlu）。`node runner.mjs openai <model> <out.jsonl> 25 3`。環境変数 `BASE_URL`、`API_KEY`、`TIMEOUT_MS`。再開可能。**エラー行も完了として数える**ので、再実行前に jsonl からエラー行を除く。
- `code/`（サンドボックスは `code/sandbox/Dockerfile` から `lcb-judge:py312-np` をビルドし、`SANDBOX_HOST` を指定する）: LiveCodeBench（code_generation_lite）60 問の合否判定。詳細は `code/README.md`。サンドボックスはネットワークなしの Docker。
