# patrol — 毎朝の PR・Issue 巡回（出力はローカルのみ）

毎朝、指定したリポジトリの開いている PR にはレビューを、Issue には方針案を、Spark のモデルに書かせて手元のファイルに保存する（GitHub には書き込まない）。

## 仕組み

- gh CLI で開いている PR・Issue を読むだけ。GitHub には書き込まない。
- モデルには道具を渡さない。差分をテキストとして渡し、判断だけがモデルの仕事。
- タイトル・本文・コメント・差分は信用できないデータとして渡す（中にある指示は無視させる）。PR はタイトル・本文・差分、Issue はタイトル・本文・コメント（最新 5 件）を渡す。
- モデルは考えてから答えるので、1 件に数分かかることがある（1 件あたり最長 20 分で打ち切る）。
- レビュー済みの PR（head SHA）と確認済みの Issue（更新時刻）を `state.json` に記録し、変わったものだけを見る。
- Spark で目的のモデルが動いていなければ何もせず終わる。

## 準備

- [../README.md](../README.md) の手順で Spark の接続設定が済んでいること。
- `gh` にログイン済みであること。

設定は `~/.config/spark-llm/patrol.json`（権限 600）に書く。

```sh
install -m 600 /dev/null ~/.config/spark-llm/patrol.json
cat > ~/.config/spark-llm/patrol.json <<'JSON'
{
  "repos": ["<owner>/<repo>", "<owner>/<repo2>"],
  "include_drafts": true,
  "max_prs_per_run": 10,
  "max_issues_per_run": 10,
  "max_diff_chars": 120000,
  "out_dir": "~/.local/state/spark-patrol"
}
JSON
```

| キー | 既定値 | 意味 |
|---|---|---|
| `repos` | ―（必須） | 対象リポジトリ。`<owner>/<repo>` 形式 |
| `include_drafts` | `true` | ドラフト PR を対象に含むか |
| `max_prs_per_run` | `10` | 1 回あたりの最大 PR 数（0〜50、0 で無効） |
| `max_issues_per_run` | `10` | 1 回あたりの最大 Issue 数（0〜50、0 で無効） |
| `max_diff_chars` | `120000` | モデルへ渡す差分の文字数上限 |
| `out_dir` | `~/.local/state/spark-patrol` | 出力先ディレクトリ（絶対パス） |

## 手動で動かす

```sh
node clients/patrol/patrol.mjs
node clients/patrol/patrol.mjs --max-prs 5 --max-issues 3
```

- 結果は 1 行のサマリを stdout に出す: `reviewed=<num> failed=<num> status=<ok|partial|skipped>`。
- モデルが動いていない時は `status=skipped reason=model unavailable` だけで終わる。

- 終了コード `0`: 正常（失敗なし、またはモデル不在でスキップ）。
- 終了コード `1`: 一部が失敗した、または予期しないエラー。
- 終了コード `2`: 使い方や設定の誤り（引数・設定ファイル）。

## 出力

出力先（既定 `~/.local/state/spark-patrol/`）の中身。日付ごとのディレクトリと、その上の `state.json` からなる。

```
spark-patrol/
├── state.json
└── <日付>/
    ├── index.md
    ├── prs/
    │   └── <owner>__<repo>#<番号>@<head7>.md
    └── issues/
        └── <owner>__<repo>#<番号>.md
```

- PR の index 1 行: `- [PR] <問題なし|要修正|要確認> <repo>#<番号> <タイトル> → prs/<ファイル>`
- Issue の index 1 行: `- [Issue] 規模 <S|M|L> / 任せやすさ <高|中|低> <repo>#<番号> <タイトル> → issues/<ファイル>`
- ディレクトリは権限 700、ファイルは 600。
- 同じ PR は新しいコミットが入るまで再レビューしない。
- `state.json` が壊れていたら止まる（exit 1）。
- 判定・規模・任せやすさは、モデルが書いた見出し行から読み取る。`**規模: L**` や `規模：S` のような書き方も読み、決められた値でなければ `不明` にする。
- 差分が大きくてレビューが答えの長さの上限に収まらなかった PR は、index に `長すぎて失敗` と書き、同じ head SHA のあいだは再挑戦しない（`state.json` の `too_long`）。

## 毎朝動かす（systemd ユーザータイマー）

`node` と `gh` は systemd のユーザーユニットから見える PATH にあること。見えないなら `ExecStart` を `command -v node` で調べた `node` の絶対パスにする。

`~/.config/systemd/user/spark-patrol.service`:

```ini
[Unit]
Description=Spark patrol (PR reviews and Issue plans)

[Service]
Type=oneshot
WorkingDirectory=%h/<このリポジトリのパス>
ExecStart=/usr/bin/env node clients/patrol/patrol.mjs
```

`~/.config/systemd/user/spark-patrol.timer`:

```ini
[Unit]
Description=Run the Spark patrol every morning

[Timer]
OnCalendar=*-*-* 07:30
Persistent=true

[Install]
WantedBy=timers.target
```

- `Persistent=true` なので、PC が止まっていた日は次の起動時に 1 回動く。

```sh
systemctl --user daemon-reload
systemctl --user enable --now spark-patrol.timer
systemctl --user list-timers spark-patrol.timer
journalctl --user -u spark-patrol.service
```

## 今後

- 質を確かめてから、PR・Issue へのコメント投稿に切り替える。
- 昼・夜に、持ち主がラベルを付けた Issue だけ改善 PR を下書きで出す。モデルは patch を作るだけで、push と PR 作成はスクリプト側。
