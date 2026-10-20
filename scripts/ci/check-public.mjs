// Public-surface secret scan (Issue #6).
// Flags real host names, tailnet names, home/mount paths, e-mails, keys and
// tokens in tracked files so accidental leaks are caught before release.
// Usage: node scripts/ci/check-public.mjs [root]   (root defaults to repo root).
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';

const ALLOW_MARKER='public-check: allow ';

// One rule per documented leak. `secret` masks the excerpt, `except` skips
// benign matches (documented example addresses) that a plain RegExp
// cannot express without echoing a secret in its own condition.
export const RULES=[
 {id:'tailnet', secret:false, pattern:/(?:\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b)|tail[0-9a-f]{6}/i, description:'Tailscale host name or tailnet label'},
 {id:'tailscale-ip', secret:false, pattern:/\b100\.(?:6[4-9]|7[0-9]|8[0-9]|9[0-9]|1[01][0-9]|12[0-7])\.\d{1,3}\.\d{1,3}(?!\s*\/10\b)/, description:'CGNAT Tailscale address (excludes the 100.64.0.0/10 range text)'}
, {id:'home-path', secret:false, pattern:/(?:\/home|\/Users)\/(?!user\/)([a-z][a-z0-9]*)\//, description:'Absolute user home directory'},
 {id:'mnt-path', secret:false, pattern:/\/mnt\/[A-Za-z]+\//, description:'Absolute /mnt mount path'},
 {id:'email', secret:false, pattern:/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, description:'E-mail address', except:(s)=>s.endsWith('@users.noreply.github.com')||s.endsWith('@example.com')||s.endsWith('@example.org')||s==='noreply@anthropic.com'},
 {id:'private-key', secret:true, pattern:/-----BEGIN [A-Z ]*PRIVATE KEY-----/, description:'Private key block header'},
 {id:'token', secret:true, pattern:/(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/, description:'API key or token'},
];

function excerptFor(rule, match){
 if(rule.secret)return match.slice(0,6)+'…';
 return match.slice(0,60);
}

export function scanText(text, path){
 const lines=String(text).split('\n'); const out=[];
 for(let i=0;i<lines.length;i++){
  const line=lines[i]; const lineNo=i+1;
  for(const rule of RULES){
   if(line.includes(ALLOW_MARKER+rule.id))continue;
   rule.pattern.lastIndex=0;
   const m=rule.pattern.exec(line);
   if(!m)continue;
   if(rule.except && rule.except(m[0]))continue;
   out.push({path, line:lineNo, rule:rule.id, excerpt:excerptFor(rule,m[0])});
  }
 }
 return out;
}

const SKIP_EXT=new Set(['.png','.jpg','.jpeg','.gif','.pdf','.zip','.gz','.tar','.ico','.woff','.woff2']);
export function isScanned(path){
 if(path==='package-lock.json')return false;
 const dot=path.lastIndexOf('.');
 if(dot>=0 && SKIP_EXT.has(path.slice(dot).toLowerCase()))return false;
 return true;
}

// Tracked files as POSIX relative paths, or null if `git ls-files` fails.
export function listFiles(root){
 const r=spawnSync('git',['-C',root,'ls-files','-z'],{encoding:'utf8',stdio:'pipe'});
 if(r.status!==0)return null;
 return r.stdout.split('\0').filter(Boolean);
}

export async function main(argv){
 const here=dirname(fileURLToPath(import.meta.url));
 const root=argv[0]?resolve(argv[0]):resolve(here,'..','..');
 const files=listFiles(root);
 if(files===null){ console.error('check-public: git ls-files failed in '+root); return 2; }

 const scanned=files.filter(isScanned); let count=0; const findings=[];
 for(const rel of scanned){
  let text;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(join(root,rel)));}catch{continue;}
  count++; findings.push(...scanText(text, rel));
 }
 if(findings.length){
  for(const f of findings)console.log(f.path+':'+f.line+': '+f.rule+' '+f.excerpt);
  console.log(findings.length+' finding(s)');
  return 1;
 }
 console.log('ok ('+count+' files)');
 return 0;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 main(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(e=>{console.error(e&&e.stack||e);process.exitCode=1;});
}