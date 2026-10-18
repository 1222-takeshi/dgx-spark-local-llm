# Bolt評価とFlash Next FP4 QAD再評価（2026-10-18）

評価完了。[Issue #7](https://github.com/1222-takeshi/dgx-spark-local-llm/issues/7)。再現条件・revision・rawのSHA256は[manifest.json](manifest.json)。

## 目的と判断

rate limitで中断していたNemotron 3.5 Boltを既存と同じ条件で評価し、[MiaAI Labの投稿](https://x.com/MiaAI_lab/status/2111540267840901174)にある新しいFlash Next FP4 QAD構成も確認した。
旧NVFP4版の結果だけでは新しい構成を判断できなかったため、モデル・推論基盤・出力予算を記録する独立した評価とした。

- **Boltを常駐へ昇格させる根拠は得られなかった。** この出力予算ではコード・Tool Evalとも既存Ornith/27Bを上回らず、Tool Evalの模擬スリーパー攻撃で、外部データの誘導に従い宛先を追加する失敗もあった（TC-60）。
- **QAD版は思考なしコーディングの候補。** 同じ4K上限で38/60となり、旧Flash Nextの32/60から改善した。一方、16K思考では35/60、25件がコード出力前に打ち切られた。思考ありの既存27Bは39/60である。
- QADのtool callは動いたが、構造化出力制約は未対応。Tool Evalの86点には採点除外もあり、総合点だけで常駐に選ばない。評価後は**Ornithへ復旧済み**。

## 実測結果

| 項目 | Bolt | Flash Next FP4 QAD / TensorFold |
|---|---|---|
| 基礎150問 | 141/150（94.0%） | 142/150（94.7%） |
| コード思考なし4K | 23/60 | 38/60 |
| コード思考あり16K | 29/60 | 35/60 |
| 打切り（思考なし / あり） | 17 / 30件 | 17 / 25件 |
| Tool EvalのCLI報告値 | 88（122/138点、69件採点） | 86（117/136点、68件採点）※ |
| 長文脈の状態更新 | 3/4成功 | 4/4成功 |
| 速度・単一（end-to-end） | 68.1〜72.9 tok/s | 52.4〜52.7 tok/s |
| 速度・4件合計（同上） | 155.2〜161.1 tok/s | 125.6〜133.8 tok/s |
| 速度・8件合計（同上） | 223.4〜232.5 tok/s | 未測定（server parallel=4） |

基礎の内訳（各25問）は、BoltがQA19 / 推論24 / 算数25 / 追跡24 / GSM8K25 / MMLU24、QADが19 / 25 / 25 / 25 / 25 / 23。
基礎・コードとも通信・採点環境エラーは0。コードは各run 60行・60 IDで完了した。

コード思考なしの失敗内訳はBoltが誤答32・実行エラー4・時間切れ1、QADが誤答18・実行エラー4。
打切りはこの内訳と重なり、Boltは誤答13＋実行エラー4、QADは誤答15＋実行エラー2に含まれる。
思考ありはBoltが30件のコード未出力＋実行エラー1、QADが25件のコード未出力。コード未出力は全件が16K打切りだった。

既存の思考なし / 16K思考はOrnithが28/33、27Bが30/39、旧Flash Nextが32/34。
27Bの46/60は打切り問題だけ40Kで再実行した値なので、今回の16Kと直接比較しない。

※ Tool Evalは両モデルで69 IDを実行。QADのTC-64は`response_format`要求をHTTP 400で拒否し、v2.8.0が`server_error`として得点分母から除外した。
したがって86点は68件分の値であり、Boltの88点とは分母が異なる。rawの除外記録を保持し、独自の除外や補正はしていない。
QADのStructured OutputカテゴリもTC-64を除いた4/10点（5件）で、残るケースにも最終JSON形式の失敗があった。全てをAPI拒否のせいにはできない。
Tool Evalのpass / partial / failはBoltが58/6/5、QADが52/13/4（API拒否1件をfail表示に含む）。

## 条件とメモリ

- DGX Spark / GB10 1台、OSから約121 GiB。ロードする推論モデルは1つ。
- MemAvailableを2秒間隔で監視し、20 GiB未満なら評価用モデルを停止する設定。全14,432観測の最低は**34.57 GiB**で、閾値未満は0回。これはOS全体の空き容量であり、モデル単体の使用量ではない。
- 観測は08:42〜16:44 JST。Ornith復旧後のメモリはこの観測範囲に含めない。
- 基礎は同じseedの150問、suite v1 / scoring v2。既存27Bの150 IDと一致を確認。
- コードはLiveCodeBench由来の固定60問（easy15 / medium24 / hard21）。ネットワークを遮断したDocker内でprivate testも実行。
- コードの上限は思考なし4,096、思考あり16,384 tokens。temperature=0、top_p=1、request seed=1234。IDごとの最新行で集計し、環境エラーが残れば未完了とする。
- Boltは基礎3件＋コード3件を並行し、後に思考あり3件。QADは基礎2件＋コード2件、その完了後に思考あり4件。品質runの所要時間は速度比較に使わない。
- 速度・長文脈・Tool Evalは他の評価やソースビルドと重ねず、モデルごとに順次実行した。

QADはvisionなし、FP8 KV、MTPあり、context上限262,144、server parallel=4。
起動時floor=20 GiBを使う既定の約116 GiBのチェックを回避せず、実際の117 GiBで通過した。
KV poolのreserveは28 GiB。1並列で疎通確認後、4並列の短い512-token生成を2回通して本評価へ進んだ。
4並列起動時のsequence poolは13.50 GiBであり、4件それぞれに262K入力を保証する設定ではない。
reserveは全負荷での空き容量を保証するハード制限ではなく、別の監視と観測最低値で検証した。

速度は思考なし、同じhash table説明プロンプト、512出力tokens、各同時数で2回。
表は生成tokens合計を全応答完了までの実時間で割った値で、TTFT・転送時間を含む。単一streamのdecode推定値はBolt69.7〜74.9、QAD53.3〜53.8 tok/s。
クライアントはSSH転送越し。明示的なprefix cache消去は行っていない。tokenizerも異なるため、tok/sは同じ字数の作業時間ではない。

長文脈は同一の4入力で、各16事実のうち4事実を後段で更新する。従来ラベルは32K/128Kだが、実際の入力tokensは次のとおり。

| モデル | 短い2入力 / TTFT | 長い2入力 / TTFT |
|---|---|---|
| Bolt | 39,933〜40,002 / 22.7〜24.4秒 | 160,336〜160,671 / 107.2〜107.5秒 |
| QAD | 39,145〜39,299 / 約19.3秒 | 157,108〜157,133 / 約84.7〜84.8秒 |

Boltは長い入力の1件で旧値を1個回答（15/16）。QADは全件16/16で、usageのcached_tokensも全件0だった。
小さな状態更新テストであり、262K全窓や一般的な長文作業の成功率を示すものではない。

Tool Evalは既存と同じv2.8.0、temperature=0、思考あり、上限16,384、各リクエスト120秒・最大8turns。
Bolt初回は未登録の評価ポートが既定ポートへフォールバックし、疎通段階で失敗した。記録を残し、`base-url`を明示した再実行だけを成績に使った。

## 投稿と配布元の主張をどう扱ったか

[NVIDIAのモデルカード](https://huggingface.co/nvidia/Qwen3.8-Flash-Next-FP4-Local)の対象は`nvidia/Qwen3.8-Flash-Next-FP4-Local`。
NVFP4/MXFP8の低精度表現をBF16 teacherに合わせて追加学習した版で、配布元はGPQA DiamondをBF16 92.2% / FP4 91.5%、ToolEvalBenchを89.4% / 88.7%と報告している。
これは配布元の別ベンチマークであり、今回の実測や全用途でBF16と同等という保証ではない。

[固定したレシピ](https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark-TensorFold/tree/06df57f8a76c74fec908c87fdbc4dd702ff598f9)の既定は全512 routed expertsを保持するQAD版。
任意のINT4版はtop-5へのexpert削減も伴うため、量子化bit幅だけの差として比較しない。以前の手元のNVFP4/vLLM評価も、このINT4版とは別物である。
今回の旧版との差には推論エンジンの変更も含まれ、QAD単独の効果は分離できない。

作者の46〜55 tok/s（単一prose）、132.1 tok/s（5件合計）、約2,000 tok/sのprefillは作者の測定値。
400出力tokens、visionあり、FP8 KV、MTP、同一ホストのsparkDashという条件があり、今回の512 tokens・visionなし・4件合計の値と混ぜない。
指定のビルド済みイメージは取得できなかったため、固定ソースからビルドした。RUN単位で8 GiB / 4 CPU制限を渡し、軽いresourcecheckのRUNでcgroup上限も確認した。

## 再現・検証と限界

基礎・コードは既存の[harness](../../harness/code/README.md)を使用。速度・長文脈は[harness/probes.mjs](../../harness/probes.mjs)で再現できる。
`BASE_URL`と`MODEL`を対象へ設定し、長文脈には既存基礎ハーネスと同じ外部qualitySuite.jsを用意する。

```sh
SPEED_CONCURRENCIES=1,4 node harness/probes.mjs speed "$BASE_URL" "$MODEL" speed.jsonl
node harness/probes.mjs long "$BASE_URL" "$MODEL" long.jsonl
node --test harness/probes.test.mjs
```

- 採点sandboxの自己テストに合格: 参照解とNumPy、誤答、時間切れ、メモリ超過、ネットワーク遮断、rootfs書込み拒否、非root、fork/output制限、不明ID、残存コンテナなし。
- probesはSSE分割・終端・usage、思考切替、1/4並列、HTTPエラー・途中切断・不正入力を検証。不完全streamは測定値として保存しない。Boltの既存測定も全26速度応答のusage/finish、長文脈4件の完了を確認した。
- raw・baselineは上書きせず、小さなmanifestと集計のみ追跡。既存27B思考ありrawの62行/60 IDは最新行で集計した。旧Flash Next基礎は過去のrawと説明に不一致があるため比較に使っていない。
- 公開コンテスト由来の2025年の問題で学習データ混入は排除できず、hardの時間制限の校正にも既存の限界がある。60問の小標本や、飽和した基礎項目から一般的な能力順位を決めない。
- Ornithのhealth・認証gate越しのモデル一覧と生成、未認証401、resident timer・恒久memguardのactiveを確認。評価候補と一時監視を停止した。
