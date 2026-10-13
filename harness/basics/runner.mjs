// Usage: node runner.mjs <backend> <model> <outfile> [perCat=25] [concurrency=3]
//   backend: claude | codex | openai (OpenAI-compatible: env BASE_URL, API_KEY)
// Same items + same scorer (sparkDash qualitySuite.js) for every backend. Resumable.
import { spawn } from "node:child_process";
import { readFileSync, appendFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSuite, scoreItem, mulberry32, hashString } from "./server/collectors/qualitySuite.js";

const [backend, model, outFile, perCatArg = "25", concArg = "3"] = process.argv.slice(2);
const perCat = Number(perCatArg), conc = Number(concArg);
const CATS = ["qa", "reason", "arith", "track", "gsm8k", "mmlu"];

function sample() {
  const all = generateSuite({ categories: CATS });
  const out = [];
  for (const c of CATS) {
    const items = all.filter((i) => i.category === c);
    const rnd = mulberry32(hashString("sample-" + c));
    const idx = items.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    out.push(...idx.slice(0, perCat).sort((a, b) => a - b).map((i) => items[i]));
  }
  return out;
}

const SYS = "Answer the user's question directly. Follow the requested output format exactly.";
const cwd = mkdtempSync(join(tmpdir(), "bench-cwd-"));

function run(cmd, args, { input, env, timeoutMs }) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let so = "", se = "";
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (d) => (so += d)); p.stderr.on("data", (d) => (se += d));
    p.on("close", (code) => { clearTimeout(t); resolve({ code, so, se }); });
    p.stdin.end(input ?? "");
  });
}

async function ask(item) {
  const timeoutMs = Number(process.env.TIMEOUT_MS || 300000);
  if (backend === "claude") {
    const r = await run("claude", ["-p", "--model", model, "--tools", "", "--setting-sources", "", "--disable-slash-commands",
      "--no-session-persistence", "--strict-mcp-config", "--system-prompt", SYS, "--output-format", "json"], { input: item.prompt, timeoutMs });
    if (r.code !== 0) return { error: `claude exit ${r.code}: ${(r.se || r.so).slice(0, 300)}` };
    try { const j = JSON.parse(r.so); if (j.is_error) return { error: String(j.result).slice(0, 300) }; return { reply: String(j.result ?? ""), tokens: j.usage?.output_tokens }; }
    catch (e) { return { error: "bad json: " + r.so.slice(0, 200) }; }
  }
  if (backend === "codex") {
    const of = join(cwd, `o-${Math.random().toString(36).slice(2)}.txt`);
    const r = await run("codex", ["exec", "-m", model, "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "--ignore-rules", "-o", of, "-"],
      { input: `${SYS}\n\n${item.prompt}`, env: { CODEX_HOME: process.env.CODEX_HOME || join(process.env.HOME, ".codex-plus") }, timeoutMs });
    if (!existsSync(of)) return { error: `codex exit ${r.code}: ${(r.se || r.so).slice(-300)}` };
    return { reply: readFileSync(of, "utf8") };
  }
  if (backend === "openai") {
    const res = await fetch(`${process.env.BASE_URL}/v1/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.API_KEY}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: item.prompt }], max_tokens: item.maxTokens, temperature: 0, top_p: 1, seed: 1234, stream: true, stream_options: { include_usage: true },
        // same switches as sparkDash applyThinkingFlags(): without them Qwen spends max_tokens on thinking
        chat_template_kwargs: { enable_thinking: Boolean(item.thinking), thinking: Boolean(item.thinking), thinking_mode: item.thinking ? "enabled" : "disabled" } }),
      signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { error: `http ${res.status}` };
    // streamed: a non-streaming reply that takes >300s trips undici's headersTimeout ("fetch failed")
    let reply = "", tokens, buf = "";
    const dec = new TextDecoder();
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let k; while ((k = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, k).trim(); buf = buf.slice(k + 1);
        if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
        try { const j = JSON.parse(line.slice(5)); reply += j.choices?.[0]?.delta?.content ?? ""; if (j.usage) tokens = j.usage.completion_tokens; } catch {}
      }
    }
    return { reply, tokens };
  }
  return { error: "unknown backend" };
}

const items = sample();
const done = new Set(existsSync(outFile) ? readFileSync(outFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id) : []);
const todo = items.filter((i) => !done.has(i.id));
console.error(`backend=${backend} model=${model} sample=${items.length} todo=${todo.length}`);
let next = 0, n = 0;
async function worker() {
  while (next < todo.length) {
    const item = todo[next++];
    const t0 = Date.now();
    let r; try { r = await ask(item); } catch (e) { r = { error: String(e && e.name || e) + ": " + String(e && e.message || "").slice(0, 100) }; }
    const row = { id: item.id, category: item.category, ms: Date.now() - t0, model, backend };
    if (r.error) row.error = r.error;
    else { try { const s = scoreItem(item, r.reply); row.ok = !!(s?.ok ?? s?.pass ?? s); row.score = s; } catch (e) { row.error = "score: " + e.message; } row.excerpt = r.reply.slice(0, 160); row.tokens = r.tokens; }
    appendFileSync(outFile, JSON.stringify(row) + "\n");
    if (++n % 10 === 0) console.error(`${n}/${todo.length}`);
  }
}
await Promise.all(Array.from({ length: conc }, worker));
const rows = readFileSync(outFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const by = {};
for (const r of rows) { const b = (by[r.category] ??= { ok: 0, n: 0, err: 0 }); if (r.error) b.err++; else { b.n++; if (r.ok) b.ok++; } }
console.log(JSON.stringify(by));
