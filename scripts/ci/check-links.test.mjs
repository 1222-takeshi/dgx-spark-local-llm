// Self-tests for scripts/ci/check-links.mjs.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync,execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

import {extractLinks,checkFile} from './check-links.mjs';

const script=fileURLToPath(new URL('./check-links.mjs',import.meta.url));
const TICK='`';
const FENCE=TICK+TICK+TICK;

const targets=(md)=>extractLinks(md).map((l)=>l.target);

test('extractLinks finds inline links and images',()=>{
 assert.deepEqual(extractLinks('[a](x.md)'),[{target:'x.md',line:1}]);
 assert.deepEqual(extractLinks('![img](pics/p.png)'),[{target:'pics/p.png',line:1}]);
});

test('extractLinks finds anchor tags',()=>{
 assert.deepEqual(targets('<a href="docs/y.md">y</a>'),['docs/y.md']);
});

test('extractLinks returns several links from one line in order',()=>{
 const found=extractLinks('see [a](a.md) and [b](b.md) or <a href="c.md">c</a>');
 assert.deepEqual(found.map((l)=>l.target),['a.md','b.md','c.md']);
 assert.ok(found.every((l)=>l.line===1));
});

test('extractLinks ignores inline code spans',()=>{
 const md='use '+TICK+'[x](nope.md)'+TICK+' here [r](real.md)';
 assert.deepEqual(targets(md),['real.md']);
});

test('extractLinks ignores fenced code blocks',()=>{
 const md=['[before](before.md)',FENCE+'md','[inside](inside.md)','<a href="inside2.md">',FENCE,'[after](after.md)'].join('\n');
 assert.deepEqual(targets(md),['before.md','after.md']);
});

test('extractLinks reports 1-based line numbers',()=>{
 const md=['# title','','text','[a](a.md)','','x [b](b.md)'].join('\n');
 assert.deepEqual(extractLinks(md),[{target:'a.md',line:4},{target:'b.md',line:6}]);
 const fenced=['one',FENCE,'[z](z.md)',FENCE,'[w](w.md)'].join('\n');
 assert.deepEqual(extractLinks(fenced),[{target:'w.md',line:5}]);
});

test('extractLinks returns nothing for plain text',()=>{
 assert.deepEqual(extractLinks('no links, just (parens) and [brackets]'),[]);
 assert.deepEqual(extractLinks(''),[]);
});

function makeDir(t){
 const dir=mkdtempSync(join(tmpdir(),'check-links-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 return dir;
}
function put(dir,files){
 for(const [name,content] of Object.entries(files)){
  const full=join(dir,name);
  mkdirSync(dirname(full),{recursive:true});
  writeFileSync(full,content);
 }
}
// Layout: <tmp>/repo/{README.md,docs/a.md,docs/b.md,docs/sub/}, plus <tmp>/outside.md beside the repo.
function makeTree(t){
 const base=makeDir(t);
 const root=join(base,'repo');
 put(root,{'README.md':'# r','docs/a.md':'# a','docs/b.md':'# b','docs/sub/keep.txt':'k'});
 writeFileSync(join(base,'outside.md'),'# out');
 return root;
}

test('checkFile accepts existing files and directories',(t)=>{
 const root=makeTree(t);
 const md='[b](b.md) [sub](sub) [sub2](sub/) [up](../README.md)';
 assert.deepEqual(checkFile(root,'docs/a.md',md),[]);
});

test('checkFile strips anchors and queries',(t)=>{
 const root=makeTree(t);
 assert.deepEqual(checkFile(root,'docs/a.md','[x](b.md#section) [y](b.md?raw=1) [z](b.md?x=1#s)'),[]);
 const bad=checkFile(root,'docs/a.md','[x](nope.md#section)');
 assert.equal(bad.length,1);
 assert.equal(bad[0].reason,'missing');
});

test('checkFile skips external and anchor-only links',(t)=>{
 const root=makeTree(t);
 const md=['[a](http://example.com/x)','[b](https://example.com/y)','[c](mailto:someone)','[d](#top)'].join('\n');
 assert.deepEqual(checkFile(root,'docs/a.md',md),[]);
});

test('checkFile reports missing targets with path and line',(t)=>{
 const root=makeTree(t);
 const md='fine\n\nsee [gone](gone.md)';
 const found=checkFile(root,'docs/a.md',md);
 assert.equal(found.length,1);
 assert.equal(found[0].path,'docs/a.md');
 assert.equal(found[0].line,3);
 assert.equal(found[0].reason,'missing');
 assert.ok(found[0].target.includes('gone.md'));
});

test('checkFile reports targets that escape the root as outside',(t)=>{
 const root=makeTree(t);
 const deep=checkFile(root,'docs/a.md','[o](../../outside.md)');
 assert.equal(deep.length,1);
 assert.equal(deep[0].reason,'outside');
 const shallow=checkFile(root,'README.md','[o](../outside.md)');
 assert.equal(shallow.length,1);
 assert.equal(shallow[0].reason,'outside');
 assert.equal(checkFile(root,'docs/a.md','[o](../../nothing-here)').length,1);
});

test('checkFile resolves a leading slash against the root',(t)=>{
 const root=makeTree(t);
 assert.deepEqual(checkFile(root,'docs/sub/x.md','[b](/docs/b.md) [r](/README.md)'),[]);
 const bad=checkFile(root,'docs/sub/x.md','[m](/docs/missing.md)');
 assert.equal(bad.length,1);
 assert.equal(bad[0].reason,'missing');
});

test('checkFile ignores links inside code',(t)=>{
 const root=makeTree(t);
 const md=['x '+TICK+'[a](nope.md)'+TICK,FENCE,'[b](nope2.md)',FENCE].join('\n');
 assert.deepEqual(checkFile(root,'docs/a.md',md),[]);
});

function makeRepo(t,files){
 const dir=makeDir(t);
 const git=(...args)=>execFileSync('git',['-C',dir,...args],{stdio:'pipe'});
 git('init','-q');
 put(dir,files);
 git('add','-A');
 git('-c','user.email=t@example.com','-c','user.name=t','-c','commit.gpgsign=false','commit','-q','-m','init'); // public-check: allow email
 return dir;
}
function runCli(root){
 const env={...process.env,GIT_CEILING_DIRECTORIES:dirname(root)};
 const r=spawnSync(process.execPath,[script,root],{encoding:'utf8',env,timeout:15000});
 return {code:r.status,out:r.stdout};
}

test('main exits 0 when every link resolves',(t)=>{
 const dir=makeRepo(t,{'README.md':'[d](docs/a.md) [e](https://example.com)','docs/a.md':'[home](../README.md#top)'});
 assert.equal(runCli(dir).code,0);
});

test('main exits 1 and prints path:line: target (reason)',(t)=>{
 const dir=makeRepo(t,{'README.md':'# r\n[bad](nope.md)\n','docs/a.md':'[ok](../README.md)'});
 const r=runCli(dir);
 assert.equal(r.code,1);
 assert.match(r.out,/README\.md:2: nope\.md \(missing\)/);
});

test('main checks only tracked markdown files',(t)=>{
 const dir=makeRepo(t,{'README.md':'# r','notes.txt':'[bad](nope.md)'});
 writeFileSync(join(dir,'untracked.md'),'[bad](nope.md)');
 assert.equal(runCli(dir).code,0);
});

test('importing the module without a script path does not run main or crash',()=>{
 const url=new URL('./check-links.mjs',import.meta.url).href;
 const r=spawnSync(process.execPath,['--input-type=module','-e','await import('+JSON.stringify(url)+'); console.log("imported")'],{encoding:'utf8',timeout:20000});
 assert.equal(r.status,0,r.stderr);
 assert.equal(r.stdout.trim(),'imported');
});
