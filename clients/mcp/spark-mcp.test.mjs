// Tests for clients/mcp/spark-mcp.mjs (stdio MCP server exposing the local_llm tool).
// handleMessage and createServer use injected deps; the CLI runs against a local mock gate.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer as createHttpServer} from 'node:http';
import {spawn} from 'node:child_process';
import {PassThrough} from 'node:stream';
import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {handleMessage,createServer,SERVER_INFO,PROTOCOL_VERSIONS,TOOL} from './spark-mcp.mjs';

const script=fileURLToPath(new URL('./spark-mcp.mjs',import.meta.url));
const TOKEN='sk-test-mcp-4d1e8a'; // public-check: allow token
const MODEL='test-model-x';
const BASE='http://127.0.0.1:9';
const CHAT_URL=BASE+'/v1/chat/completions';

const reply=(content,finish='stop')=>JSON.stringify({choices:[{finish_reason:finish,message:{role:'assistant',content}}]});

// A mock fetch that records every call and answers via `handler(url, init)`.
function mockFetch(handler){
 const calls=[];
 const fn=async(url,init)=>{calls.push({url:String(url),init});return handler(String(url),init);};
 fn.calls=calls;
 return fn;
}
const ok=(body,status=200)=>new Response(body,{status});
function makeDeps(fetch,extra){
 return {fetch,getConfig:()=>({base_url:BASE,model:MODEL,token:TOKEN}),timeoutMs:2000,...extra};
}
const rpc=(method,params,id=1)=>({jsonrpc:'2.0',id,method,params});
const callTool=(args,deps,name='local_llm')=>handleMessage(rpc('tools/call',{name,arguments:args}),deps);
const textOf=r=>r.result.content[0].text;
const unusedFetch=()=>mockFetch(()=>{throw new Error('fetch must not be called');});

// ---- protocol basics ----

test('initialize echoes a known protocol version and reports capabilities',async()=>{
 for(const v of PROTOCOL_VERSIONS){
  const r=await handleMessage(rpc('initialize',{protocolVersion:v,capabilities:{},clientInfo:{name:'c',version:'1'}},7),makeDeps(unusedFetch()));
  assert.equal(r.jsonrpc,'2.0');
  assert.equal(r.id,7);
  assert.equal(r.result.protocolVersion,v);
  assert.deepEqual(r.result.capabilities,{tools:{listChanged:false}});
  assert.deepEqual(r.result.serverInfo,SERVER_INFO);
 }
 assert.equal(SERVER_INFO.name,'spark-local-llm');
});

test('initialize falls back to the first supported version for unknown or missing versions',async()=>{
 const d=makeDeps(unusedFetch());
 const a=await handleMessage(rpc('initialize',{protocolVersion:'1999-01-01'}),d);
 assert.equal(a.result.protocolVersion,PROTOCOL_VERSIONS[0]);
 const b=await handleMessage(rpc('initialize',{}),d);
 assert.equal(b.result.protocolVersion,PROTOCOL_VERSIONS[0]);
});

test('notifications return null',async()=>{
 const d=makeDeps(unusedFetch());
 for(const method of ['notifications/initialized','notifications/cancelled','notifications/anything/else']){
  assert.equal(await handleMessage({jsonrpc:'2.0',method},d),null,method);
 }
});

test('ping returns an empty result',async()=>{
 const r=await handleMessage(rpc('ping',undefined,3),makeDeps(unusedFetch()));
 assert.deepEqual(r,{jsonrpc:'2.0',id:3,result:{}});
});

test('tools/list returns exactly the local_llm tool',async()=>{
 const r=await handleMessage(rpc('tools/list',undefined,4),makeDeps(unusedFetch()));
 assert.equal(r.id,4);
 assert.equal(r.result.tools.length,1);
 const tool=r.result.tools[0];
 assert.equal(tool.name,'local_llm');
 assert.deepEqual(tool,TOOL);
 assert.deepEqual(tool.inputSchema.required,['prompt']);
 assert.equal(tool.inputSchema.type,'object');
 assert.ok(tool.inputSchema.properties.prompt);
});

test('invalid requests return -32600',async()=>{
 const d=makeDeps(unusedFetch());
 const cases=[
  [{jsonrpc:'1.0',id:5,method:'ping'},5],
  [{id:6,method:'ping'},6],
  [{jsonrpc:'2.0',id:8},8],
  [{jsonrpc:'2.0',id:9,method:42},9],
  [{jsonrpc:'2.0'},null],
  [{id:null},null],
  [null,null],
  ['ping',null],
  [42,null],
 ];
 for(const [msg,id] of cases){
  const r=await handleMessage(msg,d);
  assert.ok(r,'expected a response for '+JSON.stringify(msg));
  assert.equal(r.jsonrpc,'2.0');
  assert.equal(r.id,id,JSON.stringify(msg));
  assert.equal(r.error.code,-32600,JSON.stringify(msg));
  assert.equal(typeof r.error.message,'string');
  assert.equal('result' in r,false);
 }
});

test('unknown method returns -32601',async()=>{
 const r=await handleMessage(rpc('resources/list',{},11),makeDeps(unusedFetch()));
 assert.equal(r.id,11);
 assert.equal(r.error.code,-32601);
 assert.ok(r.error.message.includes('resources/list'));
});

test('unknown tool returns -32602',async()=>{
 const f=unusedFetch();
 const r=await callTool({prompt:'x'},makeDeps(f),'nope_tool');
 assert.equal(r.error.code,-32602);
 assert.ok(r.error.message.includes('nope_tool'));
 assert.equal(f.calls.length,0);
});

// ---- argument validation ----

const BAD_ARGS=[
 ['missing prompt',{}],
 ['no arguments object',undefined],
 ['empty prompt',{prompt:''}],
 ['non-string prompt',{prompt:123}],
 ['max_tokens 0',{prompt:'x',max_tokens:0}],
 ['max_tokens 1.5',{prompt:'x',max_tokens:1.5}],
 ['max_tokens 40000',{prompt:'x',max_tokens:40000}],
 ['max_tokens string',{prompt:'x',max_tokens:'10'}],
 ['unknown key',{prompt:'x',stream:true}],
 ['non-string system',{prompt:'x',system:5}],
 ['temperature 3',{prompt:'x',temperature:3}],
 ['temperature negative',{prompt:'x',temperature:-0.5}],
 ['non-number temperature',{prompt:'x',temperature:'hot'}],
];
for(const [label,args] of BAD_ARGS){
 test('invalid arguments give a tool error: '+label,async()=>{
  const f=unusedFetch();
  const r=await callTool(args,makeDeps(f));
  assert.equal(r.error,undefined,'must not be a JSON-RPC error');
  assert.equal(r.result.isError,true);
  assert.ok(textOf(r).startsWith('invalid arguments:'),textOf(r));
  assert.equal(f.calls.length,0,'must not reach the network');
 });
}

// ---- config errors ----

test('getConfig throwing gives a config error that does not call fetch',async()=>{
 const f=unusedFetch();
 const deps=makeDeps(f,{getConfig:()=>{throw new Error('missing /nowhere/env');}});
 const r=await callTool({prompt:'hi'},deps);
 assert.equal(r.result.isError,true);
 assert.equal(textOf(r),'config error: missing /nowhere/env');
 assert.equal(f.calls.length,0);
});

// ---- success path ----

test('success posts to the chat completions endpoint and returns the content',async()=>{
 const f=mockFetch(()=>ok(reply('hello from spark')));
 const r=await callTool({prompt:'Say hi',system:'Be brief.'},makeDeps(f));
 assert.equal(r.jsonrpc,'2.0');
 assert.equal(r.result.isError,false);
 assert.deepEqual(r.result.content,[{type:'text',text:'hello from spark'}]);
 assert.equal(f.calls.length,1);
 const {url,init}=f.calls[0];
 assert.equal(url,CHAT_URL);
 assert.equal(init.method,'POST');
 const headers=new Headers(init.headers);
 assert.equal(headers.get('authorization'),'Bearer '+TOKEN);
 assert.equal(headers.get('content-type'),'application/json');
 assert.ok(init.signal,'a timeout signal must be passed');
 const body=JSON.parse(init.body);
 assert.equal(body.model,MODEL);
 assert.deepEqual(body.messages,[{role:'system',content:'Be brief.'},{role:'user',content:'Say hi'}]);
 assert.equal(body.max_tokens,4096);
 assert.equal('temperature' in body,false);
});

test('without system only the user message is sent; max_tokens and temperature pass through',async()=>{
 const f=mockFetch(()=>ok(reply('ok')));
 const r=await callTool({prompt:'p',max_tokens:32768,temperature:0},makeDeps(f));
 assert.equal(r.result.isError,false);
 const body=JSON.parse(f.calls[0].init.body);
 assert.deepEqual(body.messages,[{role:'user',content:'p'}]);
 assert.equal(body.max_tokens,32768);
 assert.equal(body.temperature,0);
});

test('temperature 0.7 and max_tokens 1 are accepted',async()=>{
 const f=mockFetch(()=>ok(reply('ok')));
 await callTool({prompt:'p',max_tokens:1,temperature:0.7},makeDeps(f));
 const body=JSON.parse(f.calls[0].init.body);
 assert.equal(body.max_tokens,1);
 assert.equal(body.temperature,0.7);
});

// ---- upstream failures ----

test('null content with finish_reason length reports truncation',async()=>{
 const f=mockFetch(()=>ok(reply(null,'length')));
 const r=await callTool({prompt:'p'},makeDeps(f));
 assert.equal(r.result.isError,true);
 assert.equal(textOf(r),'truncated: raise max_tokens (finish_reason=length)');
});

test('empty content with finish_reason length also reports truncation',async()=>{
 const r=await callTool({prompt:'p'},makeDeps(mockFetch(()=>ok(reply('','length')))));
 assert.equal(r.result.isError,true);
 assert.equal(textOf(r),'truncated: raise max_tokens (finish_reason=length)');
});

test('empty replies are errors',async()=>{
 const bodies=[reply('','stop'),reply(null,'stop'),JSON.stringify({choices:[]}),JSON.stringify({})];
 for(const b of bodies){
  const r=await callTool({prompt:'p'},makeDeps(mockFetch(()=>ok(b))));
  assert.equal(r.result.isError,true,b);
  assert.ok(textOf(r).includes('empty reply'),textOf(r));
 }
});

test('HTTP 500 is an error and the echoed token is redacted',async()=>{
 const f=mockFetch(()=>ok('upstream says: Bearer '+TOKEN+' rejected',500));
 const r=await callTool({prompt:'p'},makeDeps(f));
 assert.equal(r.result.isError,true);
 const text=textOf(r);
 assert.ok(text.startsWith('HTTP 500:'),text);
 assert.ok(!text.includes(TOKEN),'token leaked: '+text);
 assert.ok(text.includes('<redacted>'),text);
});

test('HTTP error bodies are cut to about 300 characters',async()=>{
 const r=await callTool({prompt:'p'},makeDeps(mockFetch(()=>ok('x'.repeat(5000),502))));
 assert.equal(r.result.isError,true);
 assert.ok(textOf(r).startsWith('HTTP 502:'));
 assert.ok(textOf(r).length<='HTTP 502: '.length+300,'length '+textOf(r).length);
});

test('a fetch rejection is reported with the token redacted',async()=>{
 const f=mockFetch(()=>{throw new Error('connect ECONNREFUSED with key '+TOKEN);});
 const r=await callTool({prompt:'p'},makeDeps(f));
 assert.equal(r.result.isError,true);
 const text=textOf(r);
 assert.ok(text.startsWith('request failed:'),text);
 assert.ok(!text.includes(TOKEN),'token leaked: '+text);
 assert.ok(text.includes('<redacted>'),text);
});

test('the timeout aborts a hanging request',async()=>{
 const f=mockFetch((url,init)=>new Promise((_,reject)=>{
  if(init.signal.aborted)return reject(init.signal.reason);
  init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});
 }));
 const started=Date.now();
 // AbortSignal.timeout timers are unref'd, so keep the event loop alive while waiting.
 const r=await withBound(callTool({prompt:'p'},makeDeps(f,{timeoutMs:50})),3000,'abort');
 assert.equal(r.result.isError,true);
 assert.ok(textOf(r).startsWith('request failed:'),textOf(r));
 assert.ok(Date.now()-started<2000,'timeout took too long');
});

test('valid requests without an id are notifications and get no response',async()=>{
 const f=unusedFetch();
 for(const method of ['initialize','ping','tools/list','tools/call']){
  assert.equal(await handleMessage({jsonrpc:'2.0',method,params:{}},makeDeps(f)),null,method);
 }
});

test('config errors replace the home directory with ~',async()=>{
 const home=process.env.HOME||'/nonexistent-home';
 const deps=makeDeps(unusedFetch(),{getConfig:()=>{throw new Error('missing '+home+'/.config/spark-llm/env');}});
 const text=textOf(await callTool({prompt:'p'},deps));
 assert.equal(text,'config error: missing ~/.config/spark-llm/env');
 assert.ok(!text.includes(home));
});

// ---- createServer over in-memory streams ----

// Bounds an await; the timer is ref'd (keeps the loop alive) and cleared afterwards.
function withBound(p,ms,label){
 let timer;
 const limit=new Promise((_,rej)=>{timer=setTimeout(()=>rej(new Error('timed out: '+label)),ms);});
 return Promise.race([p,limit]).finally(()=>clearTimeout(timer));
}

test('createServer answers each request in order, reports parse errors, skips notifications',async()=>{
 const input=new PassThrough(); const output=new PassThrough();
 let out=''; output.on('data',c=>out+=c);
 // The first call is slow so that ordering has to be enforced by the server.
 const f=mockFetch(async()=>{await new Promise(r=>setTimeout(r,60));return ok(reply('slow reply'));});
 const done=createServer({input,output,deps:makeDeps(f)});
 input.write(JSON.stringify(rpc('initialize',{protocolVersion:PROTOCOL_VERSIONS[1]},1))+'\n');
 input.write('{this is not json\n');
 input.write('\n');
 input.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 input.write(JSON.stringify(rpc('tools/call',{name:'local_llm',arguments:{prompt:'p'}},2))+'\n');
 input.write(JSON.stringify(rpc('ping',undefined,3))+'\n');
 input.end(JSON.stringify(rpc('tools/list',undefined,4))+'\n');
 await withBound(done,5000,'createServer');
 await new Promise(r=>setImmediate(r));
 assert.ok(out.endsWith('\n'));
 const lines=out.split('\n').filter(l=>l.length);
 assert.equal(lines.length,5,out);
 const msgs=lines.map(l=>JSON.parse(l));
 assert.deepEqual(msgs.map(m=>m.id),[1,null,2,3,4]);
 assert.equal(msgs[0].result.protocolVersion,PROTOCOL_VERSIONS[1]);
 assert.equal(msgs[1].error.code,-32700);
 assert.equal(msgs[2].result.content[0].text,'slow reply');
 assert.deepEqual(msgs[3].result,{});
 assert.equal(msgs[4].result.tools.length,1);
 for(const l of lines)assert.ok(!l.includes('\n'));
});

test('createServer answers a final line that has no trailing newline',async()=>{
 const input=new PassThrough(); const output=new PassThrough();
 let out=''; output.on('data',c=>out+=c);
 const done=createServer({input,output,deps:makeDeps(unusedFetch())});
 input.end(JSON.stringify(rpc('ping',undefined,7)));
 await withBound(done,5000,'no trailing newline');
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(JSON.parse(out.trim()),{jsonrpc:'2.0',id:7,result:{}});
});

test('createServer resolves with no output for empty input',async()=>{
 const input=new PassThrough(); const output=new PassThrough();
 let out=''; output.on('data',c=>out+=c);
 const done=createServer({input,output,deps:makeDeps(unusedFetch())});
 input.end();
 await withBound(done,5000,'empty input');
 assert.equal(out,'');
});

// ---- CLI end to end ----

async function startGate(t,statusAndBody){
 const seen=[];
 const server=createHttpServer(async(req,res)=>{
  let body=''; for await(const c of req)body+=c;
  seen.push({method:req.method,url:req.url,auth:req.headers['authorization'],body:body?JSON.parse(body):null});
  const [status,payload]=statusAndBody;
  res.writeHead(status,{'content-type':'application/json'}); res.end(payload);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{server.closeAllConnections&&server.closeAllConnections();server.close(r);}));
 return {base:'http://127.0.0.1:'+server.address().port,seen};
}
function makeConfigDir(t,base){
 const dir=mkdtempSync(join(tmpdir(),'spark-mcp-cfg-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 writeFileSync(join(dir,'env'),'SPARK_LLM_BASE_URL='+base+'\nSPARK_LLM_MODEL='+MODEL+'\n');
 writeFileSync(join(dir,'token'),TOKEN+'\n');
 chmodSync(join(dir,'token'),0o600);
 return dir;
}
async function runCli(t,configDir,messages){
 const child=spawn(process.execPath,[script],{env:{...process.env,SPARK_LLM_CONFIG_DIR:configDir,SPARK_MCP_TIMEOUT_MS:'5000'},stdio:['pipe','pipe','pipe']});
 t.after(()=>{child.kill('SIGKILL');});
 let out='';let err='';
 child.stdout.on('data',d=>out+=d);
 child.stderr.on('data',d=>err+=d);
 const closed=new Promise(resolve=>child.on('close',code=>resolve(code)));
 child.stdin.end(messages.map(m=>JSON.stringify(m)+'\n').join(''));
 const code=await withBound(closed,8000,'cli exit');
 return {code,out,err};
}

test('CLI serves initialize, tools/list and tools/call over stdio',async(t)=>{
 const gate=await startGate(t,[200,reply('cli answer')]);
 const dir=makeConfigDir(t,gate.base);
 const {code,out,err}=await runCli(t,dir,[
  rpc('initialize',{protocolVersion:PROTOCOL_VERSIONS[0],capabilities:{},clientInfo:{name:'t',version:'0'}},1),
  {jsonrpc:'2.0',method:'notifications/initialized'},
  rpc('tools/list',undefined,2),
  rpc('tools/call',{name:'local_llm',arguments:{prompt:'ping?',system:'sys'}},3),
 ]);
 assert.equal(code,0,err);
 const lines=out.split('\n').filter(l=>l.length);
 const msgs=lines.map(l=>{try{return JSON.parse(l);}catch{assert.fail('non-JSON on stdout: '+l);}});
 assert.deepEqual(msgs.map(m=>m.id),[1,2,3]);
 assert.equal(msgs[0].result.serverInfo.name,'spark-local-llm');
 assert.equal(msgs[1].result.tools[0].name,'local_llm');
 assert.equal(msgs[2].result.isError,false);
 assert.equal(msgs[2].result.content[0].text,'cli answer');
 assert.equal(gate.seen.length,1);
 assert.equal(gate.seen[0].url,'/v1/chat/completions');
 assert.equal(gate.seen[0].auth,'Bearer '+TOKEN);
 assert.equal(gate.seen[0].body.model,MODEL);
 assert.deepEqual(gate.seen[0].body.messages,[{role:'system',content:'sys'},{role:'user',content:'ping?'}]);
 assert.ok(!out.includes(TOKEN),'token on stdout');
 assert.ok(!err.includes(TOKEN),'token on stderr');
});

test('CLI redacts a token echoed by the gate and keeps stdout pure JSON',async(t)=>{
 const gate=await startGate(t,[500,'oops '+TOKEN]);
 const dir=makeConfigDir(t,gate.base);
 const {code,out,err}=await runCli(t,dir,[rpc('tools/call',{name:'local_llm',arguments:{prompt:'p'}},1)]);
 assert.equal(code,0,err);
 const msgs=out.split('\n').filter(l=>l.length).map(l=>JSON.parse(l));
 assert.equal(msgs.length,1);
 assert.equal(msgs[0].result.isError,true);
 assert.ok(msgs[0].result.content[0].text.startsWith('HTTP 500:'));
 assert.ok(!out.includes(TOKEN)&&!err.includes(TOKEN));
});

test('CLI with a missing config reports a config error instead of crashing',async(t)=>{
 const dir=mkdtempSync(join(tmpdir(),'spark-mcp-empty-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const {code,out,err}=await runCli(t,dir,[rpc('tools/call',{name:'local_llm',arguments:{prompt:'p'}},1)]);
 assert.equal(code,0,err);
 const msgs=out.split('\n').filter(l=>l.length).map(l=>JSON.parse(l));
 assert.equal(msgs.length,1);
 assert.equal(msgs[0].result.isError,true);
 assert.ok(msgs[0].result.content[0].text.startsWith('config error:'));
 assert.ok(!out.includes(TOKEN)&&!err.includes(TOKEN));
});
