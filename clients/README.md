# Spark のローカル LLM を各クライアントから使う

Claude Code・Codex から、Spark の常駐モデルを作業者として呼ぶための設定とラッパー。
役割分担と使ってよい範囲は [local-llm-policy.md](../docs/local-llm-policy.md) に従う。

```
この PC ──Tailscale──> <spark-host>:18888（ornith-gate, nginx, API key）──> 127.0.0.1:8888（vLLM）
```

- vLLM は `/v1/chat/completions`・`/v1/responses`・`/v1/messages` を持つので、変換プロキシは置かない。
- ゲートは Tailscale（100.64.0.0/10）とループバックだけを通し、生成系の同時実行を 4 本に制限する（超えると 429）。

## 準備（PC ごとに 1 回）

1. 接続先を書く。repo には実ホスト名を書かない。

   ```sh
   install -d -m 700 ~/.config/spark-llm
   printf 'SPARK_LLM_BASE_URL=http://<spark-host>:18888\nSPARK_LLM_MODEL=ornith-1.5-35b-a3b-nvfp4\n' > ~/.config/spark-llm/env
   chmod 600 ~/.config/spark-llm/env
   ```

   作業者に読ませたくないディレクトリ（ベンチマークの非公開データなど）は `SPARK_LLM_DENY_READ=/path/a:/path/b` で追加する。

2. この PC 用の API key を発行する。key は PC ごとに分け、`~/.config/spark-llm/token`（権限 600）にだけ置く。
   画面・コマンド引数・repo・ログに出さない。発行は次の流れで、本人が端末で行う。
   - この PC で `openssl rand -hex 32` を生成して token ファイルへ書く。
   - SSH の標準入力で Spark の `~/.config/ornith-gate/keys.map` へ、コメント（PC 名と日時）と次の 3 行を追記する。
     ゲートは `"$http_authorization:$http_x_api_key"` の完全一致で照合するため、送り方ごとに 1 行ずつ要る。
     ```
     "Bearer <key>:" 1;          # OpenAI 形式・Codex
     ":<key>" 1;                 # x-api-key だけを送るクライアント
     "Bearer <key>:<key>" 1;     # Claude Code（apiKeyHelper は両方を送る）
     ```
   - `docker exec ornith-gate nginx -t` が通ったときだけ `nginx -s reload` する。通らなければ `keys.map` を戻す。
   - 失効はその PC のコメントと 3 行を消して reload する。
3. 確認する: `clients/bin/spark-claude -p 'Reply with exactly: OK' --max-turns 1` が `OK` を返す。

### ゲート側の設定で必要なこと

- 3 行目のキーは 136 文字あり、nginx の既定 `map_hash_bucket_size`（64）では `nginx -t` が `could not build map_hash` で失敗する。
  ゲートの `nginx.conf` の先頭に `map_hash_bucket_size 256;` を置く（2026-10-20 に追加済み）。
- `nginx.conf` と `keys.map` は単体ファイルの bind mount なので、`sed -i` などで置き換えるとコンテナから見えなくなる。中身を上書きして inode を保つ。

## Claude Code: `clients/bin/spark-claude`

```sh
clients/bin/spark-claude -p "<brief>" --output-format json \
  --permission-mode acceptEdits --allowedTools "Read,Edit,Bash(python3 -m unittest *)" \
  --max-turns 40 --no-session-persistence
```

- `claude --bare --settings <一時ファイル>` で起動する。ユーザーの settings・hooks・plugins・MCP・CLAUDE.md は読まない。親セッションの設定（`~/.claude`）は変えない。
- key は `apiKeyHelper`（`cat <token>`）で渡す。設定ファイルは実行中だけ権限 600 で作り、終了時に消す。
- 作業者は token・env のあるディレクトリと `~/.ssh`、`SPARK_LLM_DENY_READ` の各パスを Read / Edit できない（`permissions.deny`）。
- 予算はクライアント側で強制する: `timeout <秒>` と `--max-turns`。JSON 出力の `usage` と `num_turns` を記録する。
- `[claude-code:unrecognized_model]` の警告は無害（モデル名がクラウドの一覧にないだけ）。

## Codex: `clients/bin/spark-codex`

```sh
clients/bin/spark-codex -C <dir> -s workspace-write -o last.txt "<brief>"
```

- `codex exec --ignore-user-config` と `-c` の上書きで起動し、`~/.codex/config.toml` を読まず変えない。
- Codex 0.163 では `wire_api="chat"` が廃止されたため、`/v1/responses` を使う。
- vLLM が受け付けない hosted `web_search` と multi-agent 用ツールは無効にしている。
- key は環境変数（`env_key`）で渡し、コマンド引数には載せない。
- 実測で 1 件あたり約 140 秒、入力 tokens が Claude Code の数十倍だった。短い作業は `spark-claude` を優先する。

## Cursor: `clients/mcp/spark-mcp.mjs`

Cursor の custom model は Cursor のサーバーからリクエストを送るため、Tailscale 内のゲートには届かない。
ゲートをインターネットへ公開する方法はとらない。

代わりに、この PC で動く stdio の MCP サーバーがゲートを呼ぶ。
Cursor のエージェント（チャットのモデルはクラウドのまま）が、tool `local_llm` を通して Spark のモデルに下書き・要約・レビューなどを頼める。

`~/.cursor/mcp.json`（プロジェクト単位なら `.cursor/mcp.json`）に書く:

```json
{ "mcpServers": { "spark-local-llm": { "command": "node", "args": ["<repo>/clients/mcp/spark-mcp.mjs"] } } }
```

- 接続先と key は Claude Code・Codex と同じ `~/.config/spark-llm/{env,token}` を読む。
  - `mcp.json` に key や URL は書かない。
  - 設定の場所は `SPARK_LLM_CONFIG_DIR` で変えられる。
- tool の引数:
  - `prompt`（必須）
  - `system`
  - `max_tokens`（既定 4096、1〜32768）
  - `temperature`
- 返り値は本文のテキストだけ。
  - モデルは本文の前に推論を書くため、`max_tokens` が小さいと `truncated` になる。
- 1 回の呼び出しの上限時間は `SPARK_MCP_TIMEOUT_MS`（既定 600000 ms）。
- 失敗（設定・HTTP・通信・打ち切り）は tool のエラーとして返す。
  - 本文に key が含まれていれば伏せ字にする。
  - stdout には JSON-RPC だけを書く。
- 確認:

  ```sh
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node clients/mcp/spark-mcp.mjs
  ```

  Cursor では Settings → MCP で `spark-local-llm` が緑になることを見る。

## 実測（2026-10-20、ornith-1.5-35b-a3b-nvfp4）

| クライアント | 作業 | 結果 |
|---|---|---|
| spark-claude | 1 行のバグ修正＋テスト実行 | 7 秒、5 ターン、入力 8.5K / 出力 0.4K tokens |
| spark-codex | 同等の修正＋テスト実行 | 約 140 秒、入力 58 万（うちキャッシュ 29 万）/ 出力 0.8K tokens |
| spark-claude | read-only レビュー | 2〜5 分、BLOCKING・IMPORTANT を実際に検出 |
| spark-claude | 300〜400 行の実装＋テスト | 18〜37 分。モックのテストは通るが、実環境のバグは残った |
