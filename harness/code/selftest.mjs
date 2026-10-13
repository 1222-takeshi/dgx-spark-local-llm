// Sandbox self-test. Positive controls (correct reference solutions must pass) + negatives (wrong / loop / memory bomb /
// network / rootfs write / fork bomb / output bomb / non-root), then checks nothing persists on the Spark.
// Usage: node selftest.mjs
import { execFileSync } from "node:child_process";
import { allProblems, judge, checkData } from "./sandbox.mjs";

const ps = allProblems(); checkData(ps.map((p) => p.id));
const REF = {
  abc399_a: "n=int(input());s=input();t=input()\nprint(sum(a!=b for a,b in zip(s,t)))\n",
  abc387_b: "x=int(input())\nprint(sum(i*j for i in range(1,10) for j in range(1,10) if i*j!=x))\n",
  abc400_a: "a=int(input())\nprint(400//a if 400%a==0 else -1)\n",
  abc400_a_np: "import numpy as np\nfrom scipy.special import comb\na=int(input())\nprint(int(np.int64(400)//a) if 400%a==0 else -1)\nassert comb(5,2)==10\n",
  abc400_b: "n,m=map(int,input().split())\nx=sum(n**i for i in range(m+1))\nprint(x if x<=10**9 else 'inf')\n",
};
const NEG = {
  wrong: ["print(0)\n", (r) => r.status === "wrong_answer"],
  loop: ["while True:\n    pass\n", (r) => r.status === "timeout"],
  mem_bomb: ["x = []\nwhile True:\n    x.append(bytearray(50 * 10**6))\n", (r) => r.status === "runtime_error" && /rc=-9/.test(r.detail ?? "")],
  network: ["import socket,sys\ntry:\n    socket.create_connection(('1.1.1.1', 80), timeout=3)\nexcept OSError as e:\n    sys.stderr.write('BLOCKED %r' % e)\n    sys.exit(3)\n", (r) => r.status === "runtime_error" && /BLOCKED/.test(r.detail ?? "")],
  rootfs_write: ["import sys\nfor p in ('/etc/x', '/work/x', '/usr/x'):\n    try:\n        open(p, 'w')\n        sys.exit(0)\n    except OSError:\n        pass\nsys.stderr.write('BLOCKED')\nsys.exit(3)\n", (r) => r.status === "runtime_error" && /BLOCKED/.test(r.detail ?? "")],
  non_root: ["import os,sys\nsys.stderr.write('uid=%d' % os.getuid())\nsys.exit(3 if os.getuid() else 0)\n", (r) => r.status === "runtime_error" && /uid=65534/.test(r.detail ?? "")],
  fork_bomb: ["import os,time\nwhile True:\n    try:\n        os.fork()\n    except OSError:\n        time.sleep(0.01)\n", (r) => ["timeout", "runtime_error"].includes(r.status)],
  output_bomb: ["import sys\nwhile True:\n    sys.stdout.write('x' * 1000000)\n", (r) => r.status === "runtime_error" && /output > 64MB/.test(r.detail ?? "")],
};
let bad = 0; const line = (ok, ...a) => { if (!ok) bad++; console.log(ok ? "OK  " : "FAIL", ...a); };
for (const [id, code] of Object.entries(REF)) {
  const r = await judge(id.replace(/_np$/, ""), code);
  line(r.status === "pass" && r.total > r.n_public, "positive", id, r.status, `${r.passed}/${r.total} (public ${r.n_public}) max_test_s=${r.max_test_s}`);
}
for (const d of ["easy", "medium", "hard"]) {
  const p = ps.find((x) => x.difficulty === d);
  for (const [k, [code, expect]] of Object.entries(NEG)) {
    const t0 = Date.now(); const r = await judge(p.id, code);
    line(expect(r), "negative", d, p.id, k, "->", r.status, (r.detail ?? "").slice(0, 60).replace(/\s+/g, " "), `(${Date.now() - t0}ms)`);
  }
}
// unknown problem / missing private tests must never pass
const r0 = await judge("no_such_problem", REF.abc400_a); line(r0.status === "judge_error", "negative unknown-problem ->", r0.status);
const left = execFileSync("ssh", ["-o", "BatchMode=yes", process.env.SANDBOX_HOST,
  "ls -d /tmp/lcbj.* 2>/dev/null; docker ps -a --filter name=lcbj --format '{{.Names}}'; echo END"]).toString();
line(left.trim() === "END", "no leftovers on Spark:", JSON.stringify(left));
console.log(bad ? `SELFTEST FAILED (${bad})` : "SELFTEST PASSED");
process.exit(bad ? 1 : 0);
