// Sandbox client. Untrusted code runs ONLY on the Spark in a network-less Docker container.
// Usage (CLI): node sandbox.mjs <problemId> <solution.py>
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SSH_HOST = process.env.SANDBOX_HOST || "<spark-user>@<spark-host>";
export const IMAGE = process.env.SANDBOX_IMAGE || "lcb-judge:py312-np"; // python:3.12-slim + numpy 2.3.3 + scipy 1.16.2 (see README)
const MAX_PARALLEL = Number(process.env.SANDBOX_PARALLEL || 2);
const PER_TEST = Number(process.env.SANDBOX_PER_TEST || 10);

// Remote script: temp dir -> untar -> docker run -> container + temp dir always removed (EXIT/HUP/INT/TERM).
// Memory is limited by the cgroup (docker --memory); no RLIMIT_AS so threading/large stacks work.
const REMOTE = `d=$(mktemp -d /tmp/lcbj.XXXXXX); n=lcbj-$$-$RANDOM; trap 'docker rm -f $n >/dev/null 2>&1; rm -rf $d' EXIT HUP INT TERM; tar x -C $d && chmod -R a+rX $d && ` +
  `timeout -s KILL 170 docker run --rm --name $n --network none --read-only --memory 1g --memory-swap 1g --cpus 1 --pids-limit 128 ` +
  `--tmpfs /tmp:rw,noexec,nosuid,size=64m --user 65534:65534 --cap-drop ALL --security-opt no-new-privileges ` +
  `-e PYTHONDONTWRITEBYTECODE=1 -v $d:/work:ro ${IMAGE} python /work/judge.py`;

let active = 0; const waiters = [];
async function acquire() { while (active >= MAX_PARALLEL) await new Promise((r) => waiters.push(r)); active++; }
function release() { active--; waiters.shift()?.(); }

let problems = null;
export function allProblems() {
  if (!problems) problems = new Map(readFileSync(join(HERE, "data/subset.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { const p = JSON.parse(l); return [p.id, p]; }));
  return [...problems.values()];
}
const privPath = (id) => join(HERE, "cache/private", id + ".b64");
// Fail fast: every problem needs its private test blob (otherwise a sweep could "pass" on public tests only).
export function checkData(ids) {
  const bad = ids.filter((id) => !existsSync(privPath(id)) || readFileSync(privPath(id), "utf8").trim().length < 20);
  if (bad.length) throw new Error(`private tests missing for: ${bad.join(", ")} (run prepare.py)`);
}

function once(id, code, p) {
  return new Promise((resolve) => {
    let dir;
    try {
      dir = mkdtempSync(join(tmpdir(), "lcb-stage-"));
      copyFileSync(join(HERE, "sandbox/judge.py"), join(dir, "judge.py"));
      writeFileSync(join(dir, "sol.py"), code);
      writeFileSync(join(dir, "problem.json"), JSON.stringify({ public: p.public_tests, private_b64: readFileSync(privPath(id), "utf8"), require_private: true, opts: { per_test: PER_TEST } }));
    } catch (e) { if (dir) rmSync(dir, { recursive: true, force: true }); return resolve({ status: "judge_error", passed: 0, total: 0, detail: "stage: " + e.message }); }
    let fin = false;
    const done = (r) => { clearTimeout(t); rmSync(dir, { recursive: true, force: true }); resolve(r); };
    const c = spawn("sh", ["-c", `tar cf - -C '${dir}' . | ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 ${SSH_HOST} "${REMOTE.replace(/(["\\$`])/g, "\\$1")}"`], { stdio: ["ignore", "pipe", "pipe"] });
    let so = "", se = "";
    const t = setTimeout(() => c.kill("SIGKILL"), 200000);
    c.stdout.on("data", (d) => (so += d)); c.stderr.on("data", (d) => (se += d));
    c.on("error", (e) => { if (!fin) { fin = true; done({ status: "judge_error", passed: 0, total: 0, detail: "spawn: " + e.message }); } });
    c.on("close", (code) => {
      if (fin) return; fin = true;
      try { done(JSON.parse(so.trim().split("\n").pop())); }
      catch { done({ status: code === 137 || /Killed/.test(se) ? "killed" : "judge_error", passed: 0, total: 0, detail: `exit ${code} ${(se || so).slice(-300)}` }); }
    });
  });
}

// Never throws. Infra failures (judge_error / killed) are retried once; a missing private blob is NEVER a pass.
export async function judge(id, code) {
  await acquire();
  try {
    allProblems();
    const p = problems.get(id);
    if (!p) return { status: "judge_error", passed: 0, total: 0, detail: "unknown problem " + id };
    if (!existsSync(privPath(id))) return { status: "judge_error", passed: 0, total: 0, detail: "private tests missing" };
    const safe = (e) => ({ status: "judge_error", passed: 0, total: 0, detail: String(e) });
    let r = await once(id, code, p).catch(safe);
    if (r.status === "judge_error" || r.status === "killed") { const first = r.status; r = await once(id, code, p).catch(safe); r.retried = first; }
    return r;
  } finally { release(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [id, file] = process.argv.slice(2);
  console.log(JSON.stringify(await judge(id, readFileSync(file, "utf8"))));
}
