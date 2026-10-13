"""Runs INSIDE the network-less container (python:3.12-slim, non-root, read-only rootfs, cgroup memory limit).
/work (read-only mount): judge.py, sol.py, problem.json {"public": [...], "private_b64": str|null, "require_private": bool, "opts": {...}}
Prints exactly one JSON line. Compare rule: whitespace-split tokens, exact string equality.
A problem with require_private and no (or empty / undecodable) private tests is a judge_error, never a pass."""
import base64, json, os, pickle, resource, signal, subprocess, sys, threading, time, zlib

PER_TEST, TOTAL, OUT_CAP = 10.0, 120.0, 64 * 1024 * 1024
P = json.load(open("/work/problem.json"))
OPTS = P.get("opts", {})
PER_TEST = float(OPTS.get("per_test", PER_TEST))


def decode_private(blob):
    s = blob.strip()
    if s.startswith("["):  # plain json path, preferred
        return json.loads(s)
    raw = zlib.decompress(base64.b64decode(s.encode("utf-8")))
    # LCB format: pickle of a JSON string. Untrusted data -> only ever unpickled here, in the sandbox.
    return json.loads(pickle.loads(raw))


def limits():
    os.setsid()
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def pump_out(f, buf, cap, flag):
    n = 0
    while True:
        d = f.read1(65536)
        if not d:
            return
        n += len(d)
        if n > cap:
            flag.append(1)
            return
        buf.append(d)


def run_one(inp, timeout):
    """-> (rc|'timeout'|'output_limit', stdout, stderr_tail, seconds)"""
    t0 = time.time()
    p = subprocess.Popen([sys.executable, "/work/sol.py"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, cwd="/tmp", preexec_fn=limits)
    out, err, over = [], [], []
    ths = [threading.Thread(target=pump_out, args=(p.stdout, out, OUT_CAP, over), daemon=True),
           threading.Thread(target=pump_out, args=(p.stderr, err, 1 << 20, []), daemon=True)]

    def feed():
        try:
            p.stdin.write(inp.encode()); p.stdin.close()
        except Exception:
            pass
    ths.append(threading.Thread(target=feed, daemon=True))
    for t in ths:
        t.start()

    def kill():
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    verdict = None
    while p.poll() is None:
        if over:
            verdict = "output_limit"; kill(); break
        if time.time() - t0 > timeout:
            verdict = "timeout"; kill(); break
        time.sleep(0.005)
    p.wait()
    if verdict is None:
        kill()  # reap stray children left in the process group
        for t in ths[:2]:
            t.join(2)
    return verdict or p.returncode, b"".join(out).decode("utf-8", "replace"), b"".join(err)[-300:].decode("utf-8", "replace"), time.time() - t0


def main():
    t0 = time.time()
    pub = list(P["public"])
    priv = []
    try:
        if P.get("private_b64"):
            priv = decode_private(P["private_b64"])
    except Exception as e:
        return {"status": "judge_error", "passed": 0, "total": 0, "detail": "decode: %r" % e}
    if P.get("require_private") and not priv:
        return {"status": "judge_error", "passed": 0, "total": len(pub), "n_public": len(pub), "detail": "private tests missing/empty"}
    tests = pub + priv
    res = {"n_public": len(pub), "total": len(tests)}
    passed, slow = 0, 0.0
    for i, t in enumerate(tests):
        left = TOTAL - (time.time() - t0)
        if left <= 0:
            return {**res, "status": "timeout", "passed": passed, "fail_index": i, "detail": "problem budget", "max_test_s": round(slow, 2)}
        rc, out, err, dt = run_one(t["input"], min(PER_TEST, left))
        slow = max(slow, dt)
        if rc == "timeout":
            return {**res, "status": "timeout", "passed": passed, "fail_index": i, "max_test_s": round(slow, 2)}
        if rc == "output_limit":
            return {**res, "status": "runtime_error", "passed": passed, "fail_index": i, "detail": "output > 64MB", "max_test_s": round(slow, 2)}
        if rc != 0:
            return {**res, "status": "runtime_error", "passed": passed, "fail_index": i, "detail": "rc=%s %s" % (rc, err), "max_test_s": round(slow, 2)}
        if out.split() != t["output"].split():
            return {**res, "status": "wrong_answer", "passed": passed, "fail_index": i, "max_test_s": round(slow, 2)}
        passed += 1
    return {**res, "status": "pass", "passed": passed, "max_test_s": round(slow, 2)}


try:
    r = main()
except Exception as e:
    r = {"status": "judge_error", "passed": 0, "total": 0, "detail": repr(e)}
print(json.dumps(r))
