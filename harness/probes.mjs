// Usage: node harness/probes.mjs <smoke|speed|long> <base URL> <model> <output JSONL>
// Long mode requires the same local sparkDash qualitySuite.js as harness/basics/runner.mjs.
// SPEED_CONCURRENCIES defaults to 1,4,8; use 1,4 when the server admits four requests.
import {appendFileSync} from 'node:fs';
const [mode,base,model,out]=process.argv.slice(2);
async function ask(prompt,maxTokens=512,thinking=false){
 const started=performance.now(); let first=null,content='',reasoning='',usage,finish,done=false,buf='';
 const res=await fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:prompt}],max_tokens:maxTokens,temperature:0,top_p:1,seed:1234,stream:true,stream_options:{include_usage:true},chat_template_kwargs:{enable_thinking:thinking,thinking,thinking_mode:thinking?'enabled':'disabled'}}),signal:AbortSignal.timeout(900000)});
 if(!res.ok)throw Error(`HTTP ${res.status} ${(await res.text()).slice(0,300)}`);
 const dec=new TextDecoder();
 function feed(l){if(!l.startsWith('data:'))return;const d=l.slice(5).trim();if(!d)return;if(d==='[DONE]'){done=true;return;}const j=JSON.parse(d);const c=j.choices?.[0],dl=c?.delta??{};const text=dl.content??'',think=dl.reasoning_content??dl.reasoning??'';if((text||think)&&first===null)first=performance.now();content+=text;reasoning+=think;if(j.usage)usage=j.usage;if(c?.finish_reason)finish=c.finish_reason;}
 for await(const chunk of res.body){buf+=dec.decode(chunk,{stream:true});const lines=buf.split('\n');buf=lines.pop();for(const l of lines)feed(l.trim());}feed(buf.trim());
 const ended=performance.now();const seconds=(ended-started)/1000,ttft=first===null?null:(first-started)/1000;const tokens=usage?.completion_tokens;
 if(!done||!finish||!Number.isFinite(tokens)||tokens<=0||first===null)throw Error('Incomplete SSE completion: missing terminator, finish, usage or text');
 return {seconds,ttft,usage,finish,tps:tokens&&ttft!==null?tokens/(seconds-ttft):null,content,reasoning_chars:reasoning.length};
}
function save(x){appendFileSync(out,JSON.stringify({timestamp:new Date().toISOString(),model,mode,...x})+'\n');console.log(JSON.stringify({...x,content:undefined}));}
if(mode==='smoke'){
 for(const thinking of [false,true]){const r=await ask('What is 17 times 19? Reply with the integer only.',1024,thinking);save({thinking,...r});if(!r.content.includes('323'))process.exitCode=2;}
}else if(mode==='speed'){
 const prompt='Explain how a hash table works in detail, including collision handling, resizing, time complexity, and a complete Python example.';
 const levels=(process.env.SPEED_CONCURRENCIES??'1,4,8').split(',').map(Number);
 if(!levels.length||levels.some(n=>!Number.isInteger(n)||n<1||n>16))throw Error('Invalid SPEED_CONCURRENCIES');
 for(const n of levels)for(let rep=1;rep<=2;rep++){
  const t=performance.now();const rows=await Promise.all(Array.from({length:n},(_,i)=>ask(`${prompt}\nBenchmark request ${n}-${rep}-${i}.`,512,false)));const wall=(performance.now()-t)/1000;
  save({concurrency:n,rep,wall_s:wall,aggregate_end_to_end_tps:rows.reduce((s,r)=>s+(r.usage?.completion_tokens??0),0)/wall,rows:rows.map(({content,...r})=>r)});
 }
}else if(mode==='long'){
 const {longItem,buildLongPrompt,scoreItem}=await import('./basics/server/collectors/qualitySuite.js');
 for(const size of [32768,131072])for(const index of [1,2]){const item=longItem(size,index);const r=await ask(buildLongPrompt(item),item.maxTokens,false);save({id:item.id,size,score:scoreItem(item,r.content),...r});}
}else throw Error('mode must be smoke, speed or long');
