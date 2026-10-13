// Usage: node rejudge.mjs <infile.jsonl> <outfile.jsonl>
// Re-runs ONLY the sandbox judge (no model calls) on stored `code` with the current SANDBOX_IMAGE. infile is never modified.
// Rows without code (no_code / err) are copied unchanged. Rows not in the current subset are dropped.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { allProblems, judge, checkData, IMAGE } from "./sandbox.mjs";
const [inFile, outFile] = process.argv.slice(2);
if (!inFile || !outFile || inFile === outFile) { console.error("usage: node rejudge.mjs <infile.jsonl> <outfile.jsonl> (different files)"); process.exit(1); }
if (existsSync(outFile)) { console.error("refusing to overwrite existing " + outFile); process.exit(1); }
const ids = new Set(allProblems().map((p) => p.id)); checkData([...ids]);
const rows = readFileSync(inFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => ids.has(r.id));
const BAD = new Set(["judge_error", "killed"]);
const out = await Promise.all(rows.map(async (r) => {
  if (typeof r.code !== "string") return r;
  const v = await judge(r.id, r.code);
  const n = { ...r, rejudged: true, image: IMAGE, old_status: r.status, old_ok: r.ok };
  delete n.error; delete n.detail; delete n.judge_retried;
  n.ok = v.status === "pass"; n.status = v.status; n.passed = v.passed; n.total = v.total; n.n_public = v.n_public; n.max_test_s = v.max_test_s;
  if (v.detail) n.detail = String(v.detail).slice(0, 200);
  if (v.retried) n.judge_retried = v.retried;
  if (BAD.has(v.status)) { delete n.ok; n.error = `${v.status}: ${n.detail ?? ""}`; }
  return n;
}));
writeFileSync(outFile, out.map((r) => JSON.stringify(r)).join("\n") + "\n");
const pass = (rs) => { const o = {}; for (const r of rs) { const d = (o[r.difficulty] ??= { pass: 0, n: 0 }); d.n++; if (r.ok) d.pass++; } return o; };
console.log(JSON.stringify({ old: pass(rows), new: pass(out), changed: out.filter((r, i) => r.rejudged && r.status !== rows[i].status).map((r) => `${r.id}:${r.old_status}->${r.status}`) }));
