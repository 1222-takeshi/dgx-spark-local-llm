import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const target=fileURLToPath(new URL('./probes.mjs',import.meta.url));
const root=mkdtempSync(join(tmpdir(),'probes-test-'));
const output=join(root,'output.jsonl');
let requests=0;
let responseMode='complete';
const server=createServer(async(req,res)=>{
 requests++; let body='';for await(const chunk of req)body+=chunk;
 const data=JSON.parse(body),think=data.chat_template_kwargs.enable_thinking;
 assert.equal(data.stream,true);assert.equal(data.temperature,0);
 if(responseMode==='http_error'){res.writeHead(503);res.end('unavailable');return;}
 const events=[{choices:[{delta:think?{reasoning_content:'calculation'}:{}}]},
 {choices:[{delta:{content:'323'},finish_reason:'stop'}]},
 {choices:[],usage:{prompt_tokens:12,completion_tokens:3,total_tokens:15}}];
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 if(responseMode==='no_usage')events.pop();
 const stream=events.map(x=>'data: '+JSON.stringify(x)).join('\n')+(responseMode==='early_eof'?'':'\ndata: [DONE]');
 // Split inside JSON and omit the final newline to exercise buffered SSE parsing.
 res.write(stream.slice(0,35));setTimeout(()=>res.end(stream.slice(35)),5);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
async function run(mode,levels='1'){
 return new Promise(resolve=>{
  const child=spawn(process.execPath,[target,mode,base,'test-model',output],
   {env:{...process.env,SPEED_CONCURRENCIES:levels},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',x=>stderr+=x);
  child.on('close',code=>resolve({code,stderr}));
 });
}
try{
 rmSync(output,{force:true});assert.equal((await run('smoke')).code,0);
 let rows=readFileSync(output,'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(rows.length,2);assert.equal(rows[0].reasoning_chars,0);
 assert.equal(rows[1].reasoning_chars,11);assert.equal(rows[1].content,'323');
 assert.equal(rows[1].usage.completion_tokens,3);assert.equal(rows[1].finish,'stop');
 rmSync(output);assert.equal((await run('speed')).code,0);
 rows=readFileSync(output,'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(rows.length,2);
 for(const row of rows){assert.equal(row.concurrency,1);assert.ok(row.aggregate_end_to_end_tps>0);assert.equal(row.rows.length,1);assert.equal(row.rows[0].reasoning_chars,0);}
 rmSync(output);assert.equal((await run('speed','4')).code,0);
 rows=readFileSync(output,'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(rows.length,2);assert.ok(rows.every(r=>r.concurrency===4&&r.rows.length===4));
 const before=requests;
 assert.notEqual((await run('speed','0')).code,0);
 assert.notEqual((await run('invalid')).code,0);
 assert.equal(requests,before);
 for(const failure of ['early_eof','no_usage','http_error']){
  responseMode=failure;rmSync(output,{force:true});
  assert.notEqual((await run('smoke')).code,0,failure);
  assert.throws(()=>readFileSync(output),failure+' must not save a partial measurement');
 }
 console.log('PASS: smoke/thinking, split SSE/no trailing newline, usage/finish, concurrency1/4 repetitions, invalid inputs, HTTP errors and incomplete streams rejected');
}finally{
 await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});
}
