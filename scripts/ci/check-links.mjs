// Relative-link checker (Issue #6).
// Resolves in-document links against the repo so broken or escaping links are
// caught before release. Links to http(s), mailto: and anchors are ignored.
// Usage: node scripts/ci/check-links.mjs [root]   (root defaults to repo root).
import {spawnSync} from 'node:child_process';
import {readFileSync,statSync} from 'node:fs';
import {dirname,join,relative,resolve,resolve as pResolve} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';

// Inline [text](target) and <a href="...">, in order of appearance.
const INLINE=/\[[^\]]*\]\(([^)\s]+)/g;
const ANCHOR=/<a\b[^>]*?\b(?:src|href)\s*=\s*("|')(.*?)\1/gi;

// A code fence opens/closes a fenced block; the fence line itself is skipped.
function isFence(trimmed){ return /^(`{3,}|~{3,})/.test(trimmed); }
// Blank inline code spans so their contents are not read as links.
function stripCode(line){ return line.replace(/`+[^`]*`+/g, (s) => ' '.repeat(s.length)); }

export function extractLinks(markdown){
 const lines=String(markdown).split('\n'); const out=[];
 let fenced=false;
 for(let i=0;i<lines.length;i++){
  const line=lines[i];
  if(isFence(line.trim())){ fenced=!fenced; continue; }
  if(fenced) continue;
  const clean=stripCode(line); const hits=[]; let m;
  while((m=INLINE.exec(clean))){ hits.push({i:m.index, target:m[1]}); }
  while((m=ANCHOR.exec(clean))){ hits.push({i:m.index, target:m[2]}); }
  hits.sort((a,b)=>a.i-b.i);
  for(const h of hits) out.push({target:h.target, line:i+1});
 }
 return out;
}

function isSkippedTarget(target){
 return target.startsWith('http://')||target.startsWith('https://')||target.startsWith('mailto:')||target.startsWith('#');
}

// Resolve a markdown file's links. Returns [{path, line, target, reason}].
export function checkFile(root, path, text){
 const baseDir = path.startsWith('/') ? root : join(root, dirname(path));
 const out=[];
 for(const {target, line} of extractLinks(text)){
  if(isSkippedTarget(target)) continue;
  const clean = target.split(/[#?]/)[0];
  if(!clean) continue;
  let resolved = clean.startsWith('/') ? pResolve(join(root, clean)) : pResolve(baseDir, clean);
  resolved = pResolve(resolved);
  if(relative(root, resolved).startsWith('..')){ out.push({path, line, target, reason:'outside'}); continue; }
  let stat;
  try{ stat=statSync(resolved); }catch{ out.push({path, line, target, reason:'missing'}); continue; }
  if(stat.isDirectory()||stat.isFile()) continue;
  out.push({path, line, target, reason:'missing'});
 }
 return out;
}

// Tracked files as POSIX relative paths, or null if `git ls-files` fails.
function listFiles(root){
 const r=spawnSync('git',['-C',root,'ls-files','-z'],{encoding:'utf8',stdio:'pipe'});
 if(r.status!==0)return null;
 return r.stdout.split('\0').filter(Boolean);
}

export async function main(argv){
 const here=dirname(fileURLToPath(import.meta.url));
 const root=argv[0]?resolve(argv[0]):resolve(here,'..','..');
 const files=listFiles(root);
 if(files===null){ console.error('check-links: git ls-files failed in '+root); return 2; }
 let findings=[];
 for(const rel of files){
  if(!rel.toLowerCase().endsWith('.md')) continue;
  let text;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(join(root,rel)));}catch{continue;}
  findings.push(...checkFile(root, rel, text));
 }
 if(findings.length){
  for(const f of findings)console.log(f.path+':'+f.line+': '+f.target+' ('+f.reason+')');
  return 1;
 }
 return 0;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 main(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(e=>{console.error(e&&e.stack||e);process.exitCode=1;});
}