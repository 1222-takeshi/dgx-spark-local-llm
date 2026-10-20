// Self-tests for clients/doctor.mjs (Issue #10).
// A mock server mimics the Spark model gate; runChecks and the CLI are exercised.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {parseEnv,loadConfig,runChecks,redact} from './doctor.mjs';

const doctor=fileURLToPath(new URL('./doctor.mjs',import.meta.url));
const TOKEN='sk-doctor-test-9f3a2b7c';
const MODEL='ornith-1.5-35b-a3b-nvfp4';

async function startMock(opts){
 const seen=[]; let toolMaxTokens=0;
 const server=createServer(async(req,res)=>{
  const u=new URL(req.url,'http://'+req.headers.host);
  const p=u.pathname;
  let body='';
  if(req.method==='POST'){for await(const c of req)body+=c;}
  const auth=req.headers['authorization'];
  const key=req.headers['x-api-key'];
  const ver=req.headers['anthropic-version'];
  seen.push({path:p,auth,key,ver,url:req.url});
  if(p==='/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'ok'}));return;}
  if(p==='/v1/models'){
   if(opts.modelsAlways401){res.writeHead(401);res.end(JSON.stringify({error:'no'}));return;}
   if(!auth||!auth.startsWith('Bearer ')){res.writeHead(401);res.end(JSON.stringify({error:'auth required'}));return;}
   if(opts.modelInModelsList===false){res.writeHead(200);res.end(JSON.stringify({data:[{id:'some-other-model'}]}));return;}
   res.writeHead(200);res.end(JSON.stringify({data:[{id:MODEL},{id:'another-model'}]}));return;
  }
  if(p==='/v1/chat/completions'){
   if(!auth||!auth.startsWith('Bearer ')){res.writeHead(401);res.end(JSON.stringify({}));return;}
   const data=JSON.parse(body||'{}');
   if(data.tools){
    toolMaxTokens=data.max_tokens;
    if(opts.toolTruncated){res.writeHead(200);res.end(JSON.stringify({choices:[{finish_reason:'length',message:{role:'assistant',content:null}}]}));return;}
    const args=opts.toolArguments!==undefined?opts.toolArguments:JSON.stringify({city:'Tokyo'});
    const toolCall={index:0,id:'call_1',type:'function',function:{name:'get_weather',arguments:args}};
    const resp={choices:[{message:{role:'assistant',tool_calls:[toolCall]}}]};
    res.writeHead(200);res.end(JSON.stringify(resp));return;
   }
   res.writeHead(200);res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'hi'}}]}));return;
  }
  if(p==='/v1/responses'){
   if(!auth||!auth.startsWith('Bearer ')){res.writeHead(401);res.end(JSON.stringify({}));return;}
   if(opts.responsesEchoKey){res.writeHead(500);res.end(JSON.stringify({error:'boom',echoed:auth}));return;}
   res.writeHead(200);res.end(JSON.stringify({status:opts.responsesStatus||'completed'}));return;
  }
  if(p==='/v1/messages'){
   if(!key||ver!=='2023-06-01'){res.writeHead(401);res.end(JSON.stringify({}));return;}
   if(opts.messagesEchoKey){res.writeHead(500);res.end(JSON.stringify({error:'boom',echoed:key}));return;}
   res.writeHead(200);res.end(JSON.stringify({type:'message',role:'assistant'}));return;
  }
  res.writeHead(404);res.end(JSON.stringify({error:'unknown path '+p}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 return {base,server,seen,close:()=>new Promise(r=>{server.closeAllConnections&&server.closeAllConnections();server.close(r);}),get toolMaxTokens(){return toolMaxTokens;}};
}

function cfgDir(envText,token){
 const dir=mkdtempSync(join(tmpdir(),'doctor-cfg-'));
 writeFileSync(join(dir,'env'),envText||'');
 const tp=join(dir,'token');
 writeFileSync(tp,token==null?'':token);
 chmodSync(tp,0o600);
 return dir;
}

async function runCli(cfgDirPath){
 return new Promise(resolve=>{
  const child=spawn(process.execPath,[doctor],{env:{...process.env,SPARK_LLM_CONFIG_DIR:cfgDirPath},stdio:['ignore','pipe','pipe']});
  let out='';let err='';
  child.stdout.on('data',d=>out+=d);
  child.stderr.on('data',d=>err+=d);
  child.on('close',code=>resolve({code,out,err}));
 });
}
function find(results,name){return results.find(r=>r.name===name);}
const NAMES=['health','auth-required','models','chat','responses','messages','tool-call'];

test('parseEnv ignores blanks, comments and unknown keys',(t)=>{
 const e=parseEnv('# c\n\nSPARK_LLM_BASE_URL=http://h:18888\nSPARK_LLM_MODEL=m\nUNKNOWN=x\na=b=c\n');
 assert.equal(e.SPARK_LLM_BASE_URL,'http://h:18888');
 assert.equal(e.SPARK_LLM_MODEL,'m');
 assert.equal('UNKNOWN' in e,false);
 assert.equal('a' in e,false);
});

test('redact replaces every token occurrence',(t)=>{
 assert.equal(redact(TOKEN+' '+TOKEN,TOKEN),'<redacted> <redacted>');
 assert.equal(redact('safe',TOKEN),'safe');
 assert.equal(redact(null,TOKEN),'');
 assert.equal(redact('x',null),'x');
});

test('loadConfig loads a valid config',async(t)=>{
 const m=await startMock({}); t.after(()=>m.close());
 const d=cfgDir('SPARK_LLM_BASE_URL='+m.base+'\nSPARK_LLM_MODEL='+MODEL+'\n',TOKEN); t.after(()=>rmSync(d,{recursive:true,force:true}));
 const cfg=loadConfig(d);
 assert.equal(cfg.base_url,m.base);
 assert.equal(cfg.model,MODEL);
 assert.equal(cfg.token,TOKEN);
 
});

test('loadConfig throws when env file is missing',(t)=>{
 const d=mkdtempSync(join(tmpdir(),'doctor-cfg-'));
 assert.throws(()=>loadConfig(d),/missing/);
});

test('loadConfig throws when SPARK_LLM_BASE_URL is absent',(t)=>{
 const d=cfgDir('SPARK_LLM_MODEL=x\n',TOKEN); t.after(()=>rmSync(d,{recursive:true,force:true}));
 assert.throws(()=>loadConfig(d),/SPARK_LLM_BASE_URL/);
});

test('loadConfig throws on base URL with a path',(t)=>{
 const d=cfgDir('SPARK_LLM_BASE_URL=http://host:18888/path\n',TOKEN); t.after(()=>rmSync(d,{recursive:true,force:true}));
 assert.throws(()=>loadConfig(d),/invalid/);
});

test('loadConfig throws on bad scheme',(t)=>{
 const d=cfgDir('SPARK_LLM_BASE_URL=ftp://host\n',TOKEN); t.after(()=>rmSync(d,{recursive:true,force:true}));
 assert.throws(()=>loadConfig(d),/invalid/);
});

test('loadConfig throws on empty token',(t)=>{
 const d=cfgDir('SPARK_LLM_BASE_URL=http://h:1\n',''); t.after(()=>rmSync(d,{recursive:true,force:true}));
 assert.throws(()=>loadConfig(d),/empty/);
});

test('loadConfig throws on wrong token mode',(t)=>{
 const d=cfgDir('SPARK_LLM_BASE_URL=http://h:1\n',TOKEN); t.after(()=>rmSync(d,{recursive:true,force:true}));
 chmodSync(join(d,'token'),0o644);
 assert.throws(()=>loadConfig(d),/mode 600/);
});

test('loadConfig throws on missing token file',(t)=>{
 const d=mkdtempSync(join(tmpdir(),'doctor-cfg-'));
 writeFileSync(join(d,'env'),'SPARK_LLM_BASE_URL=http://h:1\n');
 assert.throws(()=>loadConfig(d),/mode 600|missing/);
});

test('all seven checks pass against the mock server',async(t)=>{
 const m=await startMock({}); t.after(()=>m.close());
 const d=cfgDir('SPARK_LLM_BASE_URL='+m.base+'\nSPARK_LLM_MODEL='+MODEL+'\n',TOKEN); t.after(()=>rmSync(d,{recursive:true,force:true}));
 const results=await runChecks(loadConfig(d),{fetch:globalThis.fetch,timeoutMs:5000});
 assert.equal(results.length,7);
 assert.equal(results.every(r=>r.ok),true);
 const msgs=m.seen.filter(s=>s.path==='/v1/messages');
 assert.equal(msgs.length,1);
 assert.equal(msgs[0].key,TOKEN);
 assert.equal(msgs[0].ver,'2023-06-01');
 for(const s of m.seen.filter(s=>s.path==='/v1/chat/completions'||s.path==='/v1/responses')){
  assert.ok(s.auth&&s.auth.startsWith('Bearer '),'missing Bearer on '+s.path);
 }
 assert.equal(m.seen.filter(s=>s.path==='/v1/models'&&!s.auth).length,1);
 
});

test('model missing from /v1/models fails only models',async(t)=>{
 const m=await startMock({modelInModelsList:false}); t.after(()=>m.close());
 const d=cfgDir('SPARK_LLM_BASE_URL='+m.base+'\n',TOKEN); t.after(()=>rmSync(d,{recursive:true,force:true}));
 const results=await runChecks(loadConfig(d),{fetch:globalThis.fetch,timeoutMs:5000});
 assert.equal(find(results,'models').ok,false);
 for(const r of results) if(r.name!=='models')assert.equal(r.ok,true);
 
});

test('responses status incomplete fails responses only',async(t)=>{
 const m=await startMock({responsesStatus:'incomplete'}); t.after(()=>m.close());
 const d=cfgDir('SPARK_LLM_BASE_URL='+m.base+'\n',TOKEN); t.after(()=>rmSync(d,{recursive:true,force:true}));
 const results=await runChecks(loadConfig(d),{fetch:globalThis.fetch,timeoutMs:5000});
 assert.equal(find(results,'responses').ok,false);
 for(const r of results) if(r.name!=='responses')assert.equal(r.ok,true);
 
});

test('tool-call with non-JSON arguments fails tool-call only',async(t)=>{
 const m=await startMock({toolArguments:'{not json'}); t.after(()=>m.close());
 const d=cfgDir('SPARK_LLM_BASE_URL='+m.base+'\n',TOKEN); t.after(()=>rmSync(d,{recursive:true,force:true}));
 const results=await runChecks(loadConfig(d),{fetch:globalThis.fetch,timeoutMs:5000});
 assert.equal(find(results,'tool-call').ok,false);
 for(const r of results) if(r.name!=='tool-call')assert.equal(r.ok,true);

});

test('truncated before tool call fails tool-call only',async(t)=>{
 const m=await startMock({toolTruncated:true}); t.after(()=>m.close());
 const d=cfgDir('SPARK_LLM_BASE_URL='+m.base+'\n',TOKEN); t.after(()=>rmSync(d,{recursive:true,force:true}));
 const results=await runChecks(loadConfig(d),{fetch:globalThis.fetch,timeoutMs:5000});
 assert.equal(find(results,'tool-call').ok,false);
 assert.ok(find(results,'tool-call').detail.includes('finish_reason=length'),'detail: '+find(results,'tool-call').detail);
 for(const r of results) if(r.name!=='tool-call')assert.equal(r.ok,true);
});

test('tool-call request sends at least 512 max_tokens',async(t)=>{
 const m=await startMock({}); t.after(()=>m.close());
 const d=cfgDir('SPARK_LLM_BASE_URL='+m.base+'\n',TOKEN); t.after(()=>rmSync(d,{recursive:true,force:true}));
 await runChecks(loadConfig(d),{fetch:globalThis.fetch,timeoutMs:5000});
 assert.ok(m.toolMaxTokens>=512,'tool max_tokens='+m.toolMaxTokens);
});

test('server 401 for the correct key fails models only',async(t)=>{
 const m=await startMock({modelsAlways401:true}); t.after(()=>m.close());
 const d=cfgDir('SPARK_LLM_BASE_URL='+m.base+'\n',TOKEN); t.after(()=>rmSync(d,{recursive:true,force:true}));
 const results=await runChecks(loadConfig(d),{fetch:globalThis.fetch,timeoutMs:5000});
 assert.equal(find(results,'models').ok,false);
 for(const r of results) if(r.name!=='models')assert.equal(r.ok,true);
 
});

test('a network error still runs the remaining checks',async(t)=>{
 const d=cfgDir('SPARK_LLM_BASE_URL=http://127.0.0.1:1\n',TOKEN); t.after(()=>rmSync(d,{recursive:true,force:true}));
 const results=await runChecks(loadConfig(d),{fetch:globalThis.fetch,timeoutMs:2000});
 assert.equal(results.length,7);
 assert.equal(find(results,'health').ok,false);
 assert.equal(find(results,'tool-call').ok,false);
});

test('echoed key is redacted from details and never appears on a URL',async(t)=>{
 const m=await startMock({responsesEchoKey:true}); t.after(()=>m.close());
 const d=cfgDir('SPARK_LLM_BASE_URL='+m.base+'\n',TOKEN); t.after(()=>rmSync(d,{recursive:true,force:true}));
 const results=await runChecks(loadConfig(d),{fetch:globalThis.fetch,timeoutMs:5000});
 for(const r of results) assert.ok(!r.detail.includes(TOKEN),'detail leaked: '+r.detail);
 const cli=await runCli(d);
 assert.equal(cli.code,1);
 assert.ok(!cli.out.includes(TOKEN),'stdout leaked');
 assert.ok(!cli.err.includes(TOKEN),'stderr leaked');
 for(const s of m.seen) assert.ok(!s.url.includes(TOKEN),'url leaked');
 
});

test('config error exits 2 before any network call',async(t)=>{
 const m=await startMock({}); t.after(()=>m.close());
 const d=cfgDir('SPARK_LLM_MODEL=x\n',TOKEN); t.after(()=>rmSync(d,{recursive:true,force:true}));
 const cli=await runCli(d);
 assert.equal(cli.code,2);
 assert.equal(m.seen.length,0);
 
});

test('wrong token mode CLI exits 2 and never prints the token',async(t)=>{
 const d=cfgDir('SPARK_LLM_BASE_URL=http://h:1\n',TOKEN); t.after(()=>rmSync(d,{recursive:true,force:true}));
 chmodSync(join(d,'token'),0o644);
 const cli=await runCli(d);
 assert.equal(cli.code,2);
 assert.ok(!cli.out.includes(TOKEN));
 assert.ok(!cli.err.includes(TOKEN));
});

test('CLI prints 7/7 ok and exits 0',async(t)=>{
 const m=await startMock({}); t.after(()=>m.close());
 const d=cfgDir('SPARK_LLM_BASE_URL='+m.base+'\nSPARK_LLM_MODEL='+MODEL+'\n',TOKEN); t.after(()=>rmSync(d,{recursive:true,force:true}));
 const cli=await runCli(d);
 assert.equal(cli.code,0);
 assert.ok(cli.out.includes('7/7 ok'));
 for(const n of NAMES) assert.ok(cli.out.includes(n),'missing '+n);
 
});
