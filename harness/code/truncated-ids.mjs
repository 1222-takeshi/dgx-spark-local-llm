// Usage: node truncated-ids.mjs <results.jsonl> > ids.txt
// Prints ids whose LAST row is status no_code with truncated:true (cut by max_tokens), one per line.
import { readFileSync } from "node:fs";
const last = new Map();
for (const l of readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l); last.set(r.id, r); }
for (const r of last.values()) if (r.status === "no_code" && r.truncated === true) console.log(r.id);
