# Code-generation benchmark (LiveCodeBench code_generation_lite, pass@1)

Fixed seeded subset of 60 AtCoder stdin/stdout problems (15 easy / 24 medium / 21 hard), seed 20261010.
Source: HF `livecodebench/code_generation_lite` revision 0fe84c39..., file `test6.jsonl` (newest). Details: `manifest.json`.
Excluded: LeetCode/functional problems, float-tolerance statements, multi-answer / case-insensitive-judge statements
(8 excluded by that rule, ids in manifest), private-test blobs > 8 MB. The medium pool (26) is too small after exclusions, so the
shortfall of 1 is topped up from hard.

## Run
    cd harness/code
    node code-runner.mjs <backend> <model> <outfile> [problems=60] [concurrency=3] [--think]
    node code-runner.mjs claude haiku out/haiku.jsonl 60 3
    SANDBOX_HOST=user@host BASE_URL=http://127.0.0.1:8888 API_KEY=x node code-runner.mjs openai qwen3.8-27b out/q27.jsonl 60 3 [--think]
- `problems=N` = first N of the seeded-shuffled subset (small N is only roughly stratified).
- Effective settings are recorded on every row: `backend`, `model`, `think`, `maxTokens`.
  openai: think "off" -> max_tokens 4096; `--think` -> "on", 16384 (enable_thinking flags as in runner.mjs; SYS sent as system message).
  claude/codex: `--think` not applicable (ignored), recorded `think:"default"`, `maxTokens:"n/a"`.
- claude: isolated as in runner.mjs (no tools, `--setting-sources ""`, own system prompt). Checked: "Say OK" costs 572 input tokens, 1 turn,
  so no CLAUDE.md/plugins are injected. `--bare` does not work with subscription auth (api_error).
- codex is AGENTIC (`codex exec`, read-only sandbox, but it can run code locally while answering); rows carry `agentic:true`. Its env is
  an allowlist (PATH, HOME, LANG, CODEX_HOME); API_KEY/BASE_URL are never passed. Treat codex numbers as not comparable to plain-answer backends.
- Resume key = (id, backend, model, think); rows with err/judge_error/killed are retried on the next run. Aggregation covers only matching
  rows and ids of the current subset. Final JSON counts pass/fail/timeout/runtime_error/no_code/killed/judge_error/err.
  If any err/judge_error/killed remain or rows < N: prints `INCOMPLETE` and exits with code 2 (rerun to retry).
- Startup fails fast if any problem lacks its private tests (`cache/private/*.b64`); a missing/empty private set is `judge_error`, never pass.
  Rows store `total` and `n_public` test counts; a warning is printed if only public tests ran.
- Prompt: statement + "reply with a single ```python block, reads stdin, writes stdout". Extracted: LAST block labeled python/py/python3
  (an unclosed trailing fence counts; fallback: last unlabeled block); none -> `no_code` (fail). Empty reply -> `err` (retried once), not no_code.
- `SANDBOX_PARALLEL` (default 2), `SANDBOX_HOST` (required: user@host of the machine running the Docker sandbox), `SANDBOX_PER_TEST` seconds (default 10).

## Sandbox
`sandbox.mjs` tars {judge.py, sol.py, problem.json (public tests + private base64 blob)} over ssh (ConnectTimeout 10, keepalive) to a
`mktemp -d` dir on the Spark and runs `docker run --rm --network none --read-only --memory 1g --memory-swap 1g --cpus 1 --pids-limit 128
--tmpfs /tmp:rw,noexec,nosuid,size=64m --user 65534:65534 --cap-drop ALL --security-opt no-new-privileges -v tmp:/work:ro lcb-judge:py312-np
python /work/judge.py`. A shell trap (EXIT HUP INT TERM) removes container and temp dir. Nothing from a model is executed on the Mac.
Private tests are base64+zlib+pickle: `prepare.py` never decodes them; `judge.py` unpickles inside the container.
Limits: 10 s per test, 120 s per problem (container hard kill at 170 s), stdout capped at 64 MB, no RLIMIT_AS (the cgroup limits memory, so
threading/large stacks work). judge() never throws; judge_error/killed are retried once. The image `lcb-judge:py312-np` is python:3.12-slim plus numpy 2.3.3 and scipy 1.16.2 (see `sandbox/Dockerfile`). A stdlib-only image made
solutions that import numpy fail with runtime_error and unfairly penalised the models that use it.
Verdicts: pass, wrong_answer, runtime_error, timeout, no_code, judge_error, killed. Compare rule: stdout and expected output are split on
whitespace and compared token by token, exact string equality (no float tolerance). Judging stops at the first failing test.

Single problem: `node sandbox.mjs <id> solution.py`. Self-test: `node selftest.mjs` (positive controls with reference solutions; negatives:
wrong, infinite loop, memory bomb, network blocked, rootfs write blocked, non-root, fork bomb, output bomb, unknown problem; leftovers check).
Rebuild subset (needs test6.jsonl from HF): `python3 -I prepare.py test6.jsonl <dataset_sha>` (`cache/` is gitignored).

## Known limits
- Contamination: all problems are from contests 2025-01-04 .. 2025-04-06 (the newest data in this dataset); recent models may have seen them.
- 60 problems => 95% CI about +-12 percentage points; small gaps between models are not significant.
- The candidate shares the container with the judge: it can read /work (tests) and can forge the result channel (known limitation, not fixed).
  Irrelevant for honest models; there is no network to exfiltrate.
- Hard-problem timing sensitivity is not calibrated: no correct hard reference solution was available; observed max per-test time of
  passing solutions was 0.02 s (trivial inputs only).
- Problems with several valid outputs were filtered by regex on the statement; residual cases cannot be excluded.
- Float-tolerance problems are excluded, so such problems are not measured.
