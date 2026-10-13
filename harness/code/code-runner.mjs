// Usage: node code-runner.mjs <backend> <model> <outfile> [problems=60] [concurrency=3] [--think] [--ids <file>] [--max-tokens N]
//   --ids: only the listed problem ids (jsonl rows with `id`, or one id per line); expected N = that set. --max-tokens: openai only, cap 65536.
//   backend: claude | codex | openai (OpenAI-compatible: env BASE_URL, API_KEY)
// LiveCodeBench code_generation_lite (fixed seeded subset, see manifest.json), pass@1, execution-based.
// Generated code is executed ONLY in the network-less Docker sandbox on the Spark (see sandbox.mjs). Resumable.
// Exit code 2 + "INCOMPLETE" if any problem still has an err / judge_error / killed row or rows < N.
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { readFileSync, appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allProblems, judge, checkData } from "./sandbox.mjs";

const rawArgs = process.argv.slice(2);
const args = []; let idsFile = null, maxTokOpt = null;
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--ids") idsFile = rawArgs[++i];
  else if (rawArgs[i] === "--max-tokens") maxTokOpt = Number(rawArgs[++i]);
  else args.push(rawArgs[i]);
}
const thinkFlag = args.includes("--think");
const [backend, model, outFile, nArg = "60", concArg = "3"] = args.filter((a) => a !== "--think");
const conc = Number(concArg);
if (!["claude", "codex", "openai"].includes(backend) || !model || !outFile) { console.error("usage: node code-runner.mjs <claude|codex|openai> <model> <outfile> [problems=60] [concurrency=3] [--think]"); process.exit(1); }
if (maxTokOpt != null && (backend !== "openai" || !Number.isInteger(maxTokOpt) || maxTokOpt < 1 || maxTokOpt > 65536)) { console.error("--max-tokens: openai backend only, integer 1..65536"); process.exit(1); }
if (idsFile && !existsSync(idsFile)) { console.error("--ids file not found: " + idsFile); process.exit(1); }
if (backend === "openai") {
  if (!process.env.BASE_URL || !process.env.API_KEY) { console.error("openai backend needs env BASE_URL and API_KEY"); process.exit(1); }
  try { new URL(process.env.BASE_URL); } catch { console.error("BASE_URL is not a valid URL"); process.exit(1); }
} else if (thinkFlag) console.error(`note: --think is not applicable to the ${backend} CLI backend; ignored (think="default")`);
// Effective settings, recorded on every row.
const think = backend === "openai" ? (thinkFlag ? "on" : "off") : "default";
const maxTokens = backend === "openai" ? (maxTokOpt ?? (thinkFlag ? 16384 : 4096)) : "n/a";
const agentic = backend === "codex"; // codex exec is an agent (sandbox read-only, but it may run code locally)

const SYS = "Answer the user's question directly. Follow the requested output format exactly.";
const cwd = mkdtempSync(join(tmpdir(), "bench-cwd-"));
process.on("exit", () => rmSync(cwd, { recursive: true, force: true }));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => process.exit(130));

function prompt(p) {
  return `${p.statement.trim()}\n\n---\nWrite a complete Python 3 program that solves the problem above. It must read from standard input and write to standard output. ` +
    `Reply with a single \`\`\`python code block containing the whole program; no explanation is needed.`;
}

// Last python block (labels python/py/python3). An unclosed trailing fence counts. Falls back to the last unlabeled block.
function extractCode(reply) {
  const lines = reply.split(/\r?\n/);
  const blocks = []; let cur = null;
  for (const l of lines) {
    const m = /^\s*```\s*([A-Za-z0-9_+-]*)\s*$/.exec(l);
    if (m) { if (cur) { blocks.push(cur); cur = null; } else cur = { label: m[1].toLowerCase(), body: [] }; }
    else if (cur) cur.body.push(l);
  }
  if (cur) blocks.push(cur); // unclosed fence: trailing block
  const txt = (b) => b.body.join("\n") + "\n";
  const py = blocks.filter((b) => ["python", "py", "python3"].includes(b.label));
  if (py.length) return txt(py[py.length - 1]);
  const un = blocks.filter((b) => b.label === "");
  return un.length ? txt(un[un.length - 1]) : null;
}

function run(cmd, args, { input, env, timeoutMs }) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let so = "", se = "";
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (d) => (so += d)); p.stderr.on("data", (d) => (se += d));
    p.on("error", (e) => { clearTimeout(t); resolve({ code: -1, so, se: String(e) }); });
    p.on("close", (code) => { clearTimeout(t); resolve({ code, so, se }); });
    p.stdin.on("error", () => {});
    p.stdin.end(input ?? "");
  });
}
const cliEnv = () => { const e = { ...process.env }; delete e.API_KEY; delete e.BASE_URL; return e; };

async function askOnce(item) {
  const timeoutMs = thinkFlag && backend === "openai" ? 900000 : 300000;
  const text = prompt(item);
  if (backend === "claude") {
    const r = await run("claude", ["-p", "--model", model, "--tools", "", "--setting-sources", "", "--disable-slash-commands",
      "--no-session-persistence", "--strict-mcp-config", "--system-prompt", SYS, "--output-format", "json"], { input: text, env: cliEnv(), timeoutMs });
    if (r.code !== 0) return { error: `claude exit ${r.code}: ${(r.se || r.so).slice(0, 300)}` };
    try { const j = JSON.parse(r.so); if (j.is_error) return { error: String(j.result).slice(0, 300) }; return { reply: String(j.result ?? ""), tokens: j.usage?.output_tokens }; }
    catch (e) { return { error: "bad json: " + r.so.slice(0, 200) }; }
  }
  if (backend === "codex") {
    // allowlist env only: never leak API_KEY / BASE_URL or other secrets to the agent
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG || "en_US.UTF-8", CODEX_HOME: process.env.CODEX_HOME || join(process.env.HOME, ".codex") };
    const of = join(cwd, `o-${Math.random().toString(36).slice(2)}.txt`);
    const r = await run("codex", ["exec", "-m", model, "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "--ignore-rules", "-o", of, "-"],
      { input: `${SYS}\n\n${text}`, env, timeoutMs });
    if (!existsSync(of)) return { error: `codex exit ${r.code}: ${(r.se || r.so).slice(-300)}` };
    return { reply: readFileSync(of, "utf8") };
  }
  return streamChat([{ role: "system", content: SYS }, { role: "user", content: text }]);
}
// Streaming chat completion (SSE): headers/chunks arrive immediately, so long thinking runs are not killed by undici's
// 300 s headersTimeout. Only delta.content is kept; reasoning deltas are counted. Abort: no data for 300 s or 20 min total.
function streamChat(messages) {
  return new Promise((resolve) => {
    const u = new URL(`${process.env.BASE_URL.replace(/\/$/, "")}/v1/chat/completions`);
    const body = JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0, top_p: 1, seed: 1234, stream: true, stream_options: { include_usage: true },
      // same switches as sparkDash applyThinkingFlags(); --think turns them on
      chat_template_kwargs: { enable_thinking: thinkFlag, thinking: thinkFlag, thinking_mode: thinkFlag ? "enabled" : "disabled" } });
    let reply = "", tokens, finish, reasoning = 0, buf = "", settled = false, idle, req;
    const end = (r) => { if (settled) return; settled = true; clearTimeout(idle); clearTimeout(cap); req?.destroy(); resolve(r); };
    const bump = () => { clearTimeout(idle); idle = setTimeout(() => end({ error: "stream idle 300s" }), 300000); };
    const cap = setTimeout(() => end({ error: "overall timeout 20min" }), 1200000);
    const feed = (line) => {
      if (!line.startsWith("data:")) return;
      const d = line.slice(5).trim();
      if (!d || d === "[DONE]") return;
      let j; try { j = JSON.parse(d); } catch { return; }
      if (j.usage?.completion_tokens != null) tokens = j.usage.completion_tokens;
      const c = j.choices?.[0]; if (!c) return;
      if (c.finish_reason) finish = c.finish_reason;
      const dl = c.delta ?? {};
      if (typeof dl.content === "string") reply += dl.content;
      if (dl.reasoning_content || dl.reasoning || dl.thinking) reasoning++;
    };
    const mod = u.protocol === "https:" ? https : http;
    req = mod.request(u, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.API_KEY}`, "Content-Length": Buffer.byteLength(body) } }, (res) => {
      if (res.statusCode !== 200) { let e = ""; res.on("data", (d) => (e += d)); res.on("end", () => end({ error: `http ${res.statusCode} ${e.slice(0, 120)}` })); return; }
      res.setEncoding("utf8"); bump();
      res.on("data", (d) => { bump(); buf += d; const ls = buf.split("\n"); buf = ls.pop(); ls.forEach(feed); });
      res.on("end", () => { feed(buf); end({ reply, tokens, finish, truncated: finish === "length", reasoning_chunks: reasoning }); });
      res.on("error", (e) => end({ error: "stream: " + e.message }));
    });
    req.on("error", (e) => end({ error: "request: " + e.message }));
    bump(); req.end(body);
  });
}
// one retry on transport errors and empty responses (empty is an error, not "no_code")
async function ask(item) {
  let r;
  for (let a = 0; a < 2; a++) {
    r = await askOnce(item).catch((e) => ({ error: String(e).slice(0, 300) }));
    if (!r.error && !String(r.reply ?? "").trim() && !r.truncated) r = { error: "empty response" + (r.finish ? ` (finish=${r.finish})` : "") };
    if (!r.error) break;
  }
  return r;
}

let items;
if (idsFile) {
  const want = new Set(readFileSync(idsFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => (l.startsWith("{") ? JSON.parse(l).id : l)));
  items = allProblems().filter((p) => want.has(p.id));
  const missing = [...want].filter((id) => !items.some((p) => p.id === id));
  if (missing.length || !items.length) { console.error(`FATAL: --ids: ${missing.length ? "not in subset: " + missing.join(", ") : "no ids"}`); process.exit(1); }
} else items = allProblems().slice(0, Number(nArg));
try { checkData(items.map((i) => i.id)); } catch (e) { console.error("FATAL: " + e.message); process.exit(1); }
const ids = new Set(items.map((i) => i.id));
if (backend === "openai") { // fail fast if the endpoint is unreachable (any HTTP status counts as reachable)
  const ok = await new Promise((res) => { const u = new URL(process.env.BASE_URL); const rq = (u.protocol === "https:" ? https : http).request(u, { method: "GET", timeout: 8000 }, (r) => { r.resume(); res(true); }); rq.on("timeout", () => { rq.destroy(); res(false); }); rq.on("error", () => res(false)); rq.end(); });
  if (!ok) { console.error("FATAL: BASE_URL unreachable: " + process.env.BASE_URL); process.exit(1); }
}
const mine = (r) => r.backend === backend && r.model === model && r.think === think && r.maxTokens === maxTokens && ids.has(r.id);
const readRows = () => (existsSync(outFile) ? readFileSync(outFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const BAD = new Set(["judge_error", "killed"]);
const finalRow = (r) => !r.error && !BAD.has(r.status);
const done = new Set(readRows().filter(mine).filter(finalRow).map((r) => r.id)); // err / judge_error / killed rows are retried
const todo = items.filter((i) => !done.has(i.id));
console.error(`backend=${backend} model=${model} think=${think} max_tokens=${maxTokens} agentic=${agentic} problems=${items.length} todo=${todo.length}`);
let next = 0, n = 0;
async function worker() {
  while (next < todo.length) {
    const item = todo[next++];
    const t0 = Date.now();
    const r = await ask(item);
    const row = { id: item.id, difficulty: item.difficulty, contest_date: item.contest_date, ms: Date.now() - t0, model, backend, think, maxTokens, ...(agentic ? { agentic: true } : {}) };
    if (r.error) { row.error = r.error; row.status = "err"; }
    else {
      row.tokens = r.tokens; if (r.finish) row.finish = r.finish;
      if (r.truncated) row.truncated = true; // cut by max_tokens: no_code here means "ran out of tokens", not "gave no code"
      if (r.reasoning_chunks != null) row.reasoning_chunks = r.reasoning_chunks;
      const code = extractCode(r.reply);
      if (code == null) { row.ok = false; row.status = "no_code"; row.excerpt = r.reply.slice(0, 160); }
      else {
        const v = await judge(item.id, code);
        row.ok = v.status === "pass"; row.status = v.status; row.passed = v.passed; row.total = v.total; row.n_public = v.n_public; row.max_test_s = v.max_test_s;
        if (v.detail) row.detail = String(v.detail).slice(0, 200);
        if (v.retried) row.judge_retried = v.retried;
        row.code = code;
        if (v.total != null && v.n_public != null && v.total === v.n_public) console.error(`WARN ${item.id}: only public tests ran (total=${v.total})`);
        if (BAD.has(v.status)) { delete row.ok; row.error = `${v.status}: ${row.detail ?? ""}`; }
      }
    }
    appendFileSync(outFile, JSON.stringify(row) + "\n");
    if (++n % 10 === 0) console.error(`${n}/${todo.length}`);
  }
}
await Promise.all(Array.from({ length: conc }, worker));

// Aggregate: only rows of THIS (backend, model, think) and ids of the current subset; latest row per id.
const last = new Map(readRows().filter(mine).map((r) => [r.id, r]));
const cat = (r) => (r.status === "wrong_answer" ? "fail" : r.status ?? "err");
const KEYS = ["pass", "fail", "timeout", "runtime_error", "no_code", "killed", "judge_error", "err"];
const by = {}; const tot = Object.fromEntries(KEYS.map((k) => [k, 0]));
for (const r of last.values()) { const k = KEYS.includes(cat(r)) ? cat(r) : "err"; (by[r.difficulty] ??= Object.fromEntries(KEYS.map((x) => [x, 0])))[k]++; tot[k]++; }
const rows = last.size, bad = tot.err + tot.judge_error + tot.killed;
const incomplete = bad > 0 || rows < items.length;
const scored = rows - bad;
console.log(JSON.stringify({ backend, model, think, maxTokens, rows, expected: items.length, scored, pass_rate_scored: scored ? +(tot.pass / scored).toFixed(4) : null, total: tot, by_difficulty: by }));
if (incomplete) { console.log(`INCOMPLETE: rows=${rows}/${items.length} err=${tot.err} judge_error=${tot.judge_error} killed=${tot.killed} -- rerun to retry`); process.exit(2); }
