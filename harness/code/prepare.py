#!/usr/bin/env python3
"""Build the fixed LiveCodeBench subset. Runs on the Mac but NEVER unpickles anything:
private tests stay as opaque base64 blobs (decoded later inside the network-less sandbox).
Usage: python3 -I prepare.py <path/to/test6.jsonl> <dataset_sha>"""
import json, random, re, sys, hashlib, os
src, dsha = sys.argv[1], sys.argv[2]
SEED, QUOTA, MAXBLOB = 20261010, {"easy": 15, "medium": 25, "hard": 20}, 8_000_000
here = os.path.dirname(os.path.abspath(__file__))
rows = [json.loads(l) for l in open(src)]
tol = re.compile(r"(absolute|relative) (or relative )?error|error (of|is) at most|10\^\{?-\d", re.I)
# statements that accept several valid answers / case-insensitive judging cannot be scored by exact token match
multi = re.compile(r"print any|any of them|if there are multiple|multiple solutions|output any|any one of|if multiple|there are multiple|"
                   r"multiple (valid|possible|answers)|one of them|you may print|is accepted|be accepted|considered correct|judged correct|case-insensitive", re.I)
base = [r for r in rows if r["platform"] == "atcoder" and not r["starter_code"]
        and not tol.search(r["question_content"]) and len(r["private_test_cases"]) <= MAXBLOB
        and all(t["testtype"] == "stdin" for t in json.loads(r["public_test_cases"]))]
excluded_multi = [r["question_id"] for r in base if multi.search(r["question_content"])]
ok = [r for r in base if not multi.search(r["question_content"])]
rnd = random.Random(SEED)
sel = []
short = 0
for d, n in QUOTA.items():
    pool = sorted([r for r in ok if r["difficulty"] == d], key=lambda r: r["question_id"])
    if d == "hard": n += short  # medium pool exhausted -> top up with hard to keep 60 problems
    elif n > len(pool): short += n - len(pool)
    sel += rnd.sample(pool, min(n, len(pool)))
rnd.shuffle(sel)  # prefix of any length is roughly stratified
os.makedirs(f"{here}/data", exist_ok=True); os.makedirs(f"{here}/cache/private", exist_ok=True)
with open(f"{here}/data/subset.jsonl", "w") as f:
    for r in sel:
        f.write(json.dumps({"id": r["question_id"], "title": r["question_title"], "difficulty": r["difficulty"],
            "contest_date": r["contest_date"][:10], "contest_id": r["contest_id"], "statement": r["question_content"],
            "public_tests": json.loads(r["public_test_cases"])}, ensure_ascii=False) + "\n")
        open(f"{here}/cache/private/{r['question_id']}.b64", "w").write(r["private_test_cases"])
man = {"dataset": "livecodebench/code_generation_lite", "dataset_revision": dsha, "source_file": "test6.jsonl",
       "source_sha256": hashlib.sha256(open(src, "rb").read()).hexdigest(), "seed": SEED, "selection_target": QUOTA,
       "excluded_multi_answer": len(excluded_multi), "excluded_multi_answer_ids": excluded_multi,
       "filters": f"atcoder stdin only, no float-tolerance statements, no multi-answer/case-insensitive statements, private blob <= {MAXBLOB} bytes",
       "note": "test6 is the newest file in the HF repo (contest dates below); nothing after 2025-04 exists in this dataset",
       "counts": {d: sum(r["difficulty"] == d for r in sel) for d in QUOTA},
       "date_range": [min(r["contest_date"][:10] for r in sel), max(r["contest_date"][:10] for r in sel)],
       "problems": [{"id": r["question_id"], "difficulty": r["difficulty"], "date": r["contest_date"][:10]} for r in sel]}
json.dump(man, open(f"{here}/manifest.json", "w"), indent=1)
print(man["counts"], man["date_range"])
