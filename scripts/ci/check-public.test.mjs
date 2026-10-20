// Self-tests for scripts/ci/check-public.mjs.
// Sample leaks are assembled at runtime so this file itself stays clean.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync,execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

import {RULES,scanText,listFiles,isScanned} from './check-public.mjs';

const script=fileURLToPath(new URL('./check-public.mjs',import.meta.url));
const ALLOW=' // public-check: allow ';
const TS='.ts'+'.net';
const HOME='/ho'+'me/';
const MNT='/m'+'nt/';
const AT='@';
const tokens={
 sk:'sk-'+'x'.repeat(24),
 ghp:'ghp_'+'a'.repeat(30),
 pat:'github_pat_'+'b'.repeat(30),
 slack:'xoxb-'+'1234567890',
 aws:'AKIA'+'A'.repeat(16),
};

const rulesOf=(text)=>scanText(text,'f.txt').map((f)=>f.rule).sort();
const hit=(text,rule)=>rulesOf(text).includes(rule);

test('RULES lists every documented rule with a RegExp pattern',()=>{
 const ids=RULES.map((r)=>r.id).sort();
 assert.deepEqual(ids,['email','home-path','mnt-path','private-key','tailnet','tailscale-ip','token']);
 for(const r of RULES)assert.ok(r.pattern instanceof RegExp);
});

test('tailnet fires on ts.net hosts and tail labels',()=>{
 assert.ok(hit('ssh box1'+TS,'tailnet'));
 assert.ok(hit('a.b-c'+TS+' up','tailnet'));
 assert.ok(hit('net tail'+'abc123 x','tailnet'));
});

test('tailnet ignores near-misses',()=>{
 assert.equal(hit('see index.ts and example.net','tailnet'),false);
 assert.equal(hit('ts'+'.net alone','tailnet'),false);
 assert.equal(hit('tail'+'abc short','tailnet'),false);
 assert.equal(hit('tail'+'xyz123 not hex','tailnet'),false);
 assert.equal(hit('tail -f the log','tailnet'),false);
});

test('tailscale-ip fires only inside 100.64.0.0/10',()=>{
 const ip=(...p)=>'addr '+p.join('.');
 assert.ok(hit(ip(100,100,1,2),'tailscale-ip'));
 assert.ok(hit(ip(100,64,0,1),'tailscale-ip'));
 assert.ok(hit(ip(100,127,255,255),'tailscale-ip'));
 assert.equal(hit(ip(100,63,1,1),'tailscale-ip'),false);
 assert.equal(hit(ip(100,128,0,1),'tailscale-ip'),false);
 assert.equal(hit('the range '+[100,64,0,0].join('.')+'/10 is CGNAT','tailscale-ip'),false);
});

test('home-path fires on real user dirs, not placeholders',()=>{
 assert.ok(hit('cd '+HOME+'alice/work','home-path'));
 assert.ok(hit('cd /Us'+'ers/bob/work','home-path'));
 assert.equal(hit('cd '+HOME+'<user>/work','home-path'),false);
 assert.equal(hit('cd '+HOME+'user/work','home-path'),false);
 assert.equal(hit('cd ~/work','home-path'),false);
});

test('mnt-path fires on absolute mount paths',()=>{
 assert.ok(hit('ls '+MNT+'data/x','mnt-path'));
 assert.equal(hit('ls /m'+'nt','mnt-path'),false);
 assert.equal(hit('ls m'+'nt/data/x','mnt-path'),false);
});

test('email fires on addresses except the documented exceptions',()=>{
 assert.ok(hit('mail alice'+AT+'corp.io now','email'));
 assert.equal(hit('12345+bot'+AT+'users.noreply.github.com','email'),false);
 assert.equal(hit('a'+AT+'example.com','email'),false);
 assert.equal(hit('a'+AT+'example.org','email'),false);
 assert.equal(hit('noreply'+AT+'anthropic.com','email'),false);
 assert.equal(hit('use the '+AT+'scope/pkg package','email'),false);
});

test('private-key fires on PEM headers only',()=>{
 assert.ok(hit('-----BEGIN '+'RSA PRIVATE KEY-----','private-key'));
 assert.ok(hit('-----BEGIN '+'PRIVATE KEY-----','private-key'));
 assert.equal(hit('-----BEGIN '+'PUBLIC KEY-----','private-key'),false);
 assert.equal(hit('a private key is secret','private-key'),false);
});

test('token fires for each documented form',()=>{
 for(const [name,value] of Object.entries(tokens)){
  assert.ok(hit('key='+value,'token'),name);
 }
});

test('token ignores short or malformed values',()=>{
 assert.equal(hit('sk-'+'x','token'),false);
 assert.equal(hit('sk-'+'x'.repeat(10),'token'),false);
 assert.equal(hit('ghp_'+'a'.repeat(10),'token'),false);
 assert.equal(hit('AKIA'+'A'.repeat(10),'token'),false);
 assert.equal(hit('xoxb-'+'short','token'),false);
});

test('inline allow marker suppresses only the named rule',()=>{
 const leak='box1'+TS+' mail alice'+AT+'corp.io';
 assert.deepEqual(rulesOf(leak),['email','tailnet']);
 assert.deepEqual(rulesOf(leak+ALLOW+'tailnet'),['email']);
 assert.deepEqual(rulesOf(leak+ALLOW+'email'),['tailnet']);
 assert.deepEqual(rulesOf(leak+ALLOW+'home-path'),['email','tailnet']);
});

test('line numbers are 1-based and findings carry the path',()=>{
 const text=['fine','still fine','host box1'+TS,'fine'].join('\n');
 const found=scanText(text,'docs/a.md');
 assert.equal(found.length,1);
 assert.equal(found[0].line,3);
 assert.equal(found[0].path,'docs/a.md');
 assert.equal(found[0].rule,'tailnet');
 assert.equal(scanText('box1'+TS,'x')[0].line,1);
});

test('one finding per rule per line',()=>{
 const twice='a1'+TS+' b2'+TS;
 assert.equal(scanText(twice,'f').length,1);
 const mixed=twice+' alice'+AT+'corp.io';
 assert.deepEqual(rulesOf(mixed),['email','tailnet']);
 const twoLines=twice+'\n'+twice;
 assert.deepEqual(scanText(twoLines,'f').map((f)=>f.line),[1,2]);
});

test('excerpts are truncated to 60 characters',()=>{
 const longHost='a'.repeat(80)+TS;
 const [f]=scanText('x '+longHost,'f');
 assert.ok(f.excerpt.length<=61);
 assert.ok(f.excerpt.startsWith('a'.repeat(60)));
 assert.equal(scanText('box1'+TS,'f')[0].excerpt,'box1'+TS);
});

test('secret excerpts keep 6 characters then an ellipsis',()=>{
 const [t]=scanText('k '+tokens.sk,'f');
 assert.equal(t.excerpt,'sk-xxx…');
 assert.ok(!t.excerpt.includes('xxxx'));
 const [k]=scanText('-----BEGIN '+'RSA PRIVATE KEY-----','f');
 assert.equal(k.excerpt,'-----B…');
});

test('isScanned skips binaries and lockfiles',()=>{
 for(const p of ['a.png','b.jpg','c.jpeg','d.gif','e.pdf','f.zip','g.gz','h.tar','i.ico','j.woff','k.woff2','package-lock.json','dir/x.png']){
  assert.equal(isScanned(p),false,p);
 }
 for(const p of ['README.md','a.mjs','package.json','scripts/x.sh','dir/notes.txt']){
  assert.equal(isScanned(p),true,p);
 }
});

function makeDir(t){
 const dir=mkdtempSync(join(tmpdir(),'check-public-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 return dir;
}
function git(dir,...args){
 return execFileSync('git',['-C',dir,...args],{stdio:'pipe'});
}
function makeRepo(t,files){
 const dir=makeDir(t);
 git(dir,'init','-q');
 for(const [name,content] of Object.entries(files)){
  const full=join(dir,name);
  mkdirSync(dirname(full),{recursive:true});
  writeFileSync(full,content);
 }
 git(dir,'add','-A');
 git(dir,'-c','user.email=t@example.com','-c','user.name=t','-c','commit.gpgsign=false','commit','-q','-m','init'); // public-check: allow email
 return dir;
}
function runCli(root){
 const env={...process.env,GIT_CEILING_DIRECTORIES:dirname(root)};
 const r=spawnSync(process.execPath,[script,root],{encoding:'utf8',env,timeout:15000});
 return {code:r.status,out:r.stdout,err:r.stderr};
}

test('listFiles returns tracked files as POSIX relative paths',(t)=>{
 const dir=makeRepo(t,{'a.txt':'a','sub/b.txt':'b','sp ace/c d.md':'c'});
 writeFileSync(join(dir,'untracked.txt'),'u');
 assert.deepEqual([...listFiles(dir)].sort(),['a.txt','sp ace/c d.md','sub/b.txt']);
});

test('main exits 0 on a clean repo and prints ok',(t)=>{
 const dir=makeRepo(t,{'a.txt':'hello','b.md':'# hi'});
 const r=runCli(dir);
 assert.equal(r.code,0);
 assert.match(r.out,/ok \(\d+ files\)/);
});

test('main exits 1 and prints path:line: rule for a leak',(t)=>{
 const dir=makeRepo(t,{'ok.txt':'fine','docs/leak.txt':'fine\nhost box1'+TS+'\n'});
 const r=runCli(dir);
 assert.equal(r.code,1);
 assert.match(r.out,/docs\/leak\.txt:2: tailnet/);
 assert.match(r.out,/1 finding\(s\)/);
});

test('main honours inline allow markers',(t)=>{
 const dir=makeRepo(t,{'a.txt':'host box1'+TS+ALLOW+'tailnet\n'});
 assert.equal(runCli(dir).code,0);
});

test('main skips untracked files, binaries and non-UTF-8 files',(t)=>{
 const leak='host box1'+TS+'\n';
 const dir=makeRepo(t,{
  'pic.png':leak,
  'package-lock.json':leak,
  'latin.txt':Buffer.concat([Buffer.from([0xff,0xfe,0xc3,0x28,0x0a]),Buffer.from(leak)]),
 });
 writeFileSync(join(dir,'untracked.txt'),leak);
 assert.equal(runCli(dir).code,0);
});

test('main exits 2 outside a git repository',(t)=>{
 const dir=makeDir(t);
 writeFileSync(join(dir,'a.txt'),'hello');
 assert.equal(runCli(dir).code,2);
});

test('importing the module without a script path does not run main or crash',()=>{
 const url=new URL('./check-public.mjs',import.meta.url).href;
 const r=spawnSync(process.execPath,['--input-type=module','-e','await import('+JSON.stringify(url)+'); console.log("imported")'],{encoding:'utf8',timeout:20000});
 assert.equal(r.status,0,r.stderr);
 assert.equal(r.stdout.trim(),'imported');
});
