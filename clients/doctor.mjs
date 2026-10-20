// Connectivity check for the Spark model gate (Issue #10).
// Usage: node clients/doctor.mjs   reads env + token from the config dir.
import {readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';

const MODEL_DEFAULT='ornith-1.5-35b-a3b-nvfp4';
// The tool-call request must leave head-room for reasoning before the tool call;
// 64 truncates ~1/5 of runs. 512 is enough for the 63–104 completion tokens seen.
const TOOL_CALL_MAX_TOKENS=512;
const KNOWN=new Set(['SPARK_LLM_BASE_URL','SPARK_LLM_MODEL']);
export function parseEnv(text){
 const out={};
 for(const raw of String(text).split('\n')){
  const line=raw.trim();
  if(!line||line.startsWith('#'))continue;
  const i=line.indexOf('=');
  if(i<0)continue;
  const key=line.slice(0,i).trim();
  if(!KNOWN.has(key))continue;
  out[key]=line.slice(i+1).trim();
 }
 return out;
}

// Validate a base URL by hand (no regex) so a bad value never leaks a secret.
function isHostChar(ch){
 return (ch>='a'&&ch<='z')||(ch>='A'&&ch<='Z')||(ch>='0'&&ch<='9')||ch==='.'||ch==='-';
}
function validBase(s){
 if(typeof s!=='string')return false;
 if(!s.startsWith('http://')&&!s.startsWith('https://'))return false;
 const rest=s.slice(s.indexOf('://')+3);
 if(!rest||rest.indexOf('/')>=0)return false;
 const ci=rest.indexOf(':');
 const host=ci>=0?rest.slice(0,ci):rest;
 const port=ci>=0?rest.slice(ci+1):'';
 if(!host.length)return false;
 for(const ch of host) if(!isHostChar(ch))return false;
 if(port.length){ for(const ch of port) if(ch<'0'||ch>'9')return false; }
 return true;
}
export function loadConfig(dir){
 const envPath=join(dir,'env'); const tokenPath=join(dir,'token');
 let envText;
 try{envText=readFileSync(envPath,'utf8');}catch{throw new Error('missing '+envPath);}
 const env=parseEnv(envText);
 const base=env.SPARK_LLM_BASE_URL;
 if(!base)throw new Error('SPARK_LLM_BASE_URL missing in '+envPath);
 if(!validBase(base))throw new Error('invalid SPARK_LLM_BASE_URL: '+base);
 let mode; let token='';
 try{mode=statSync(tokenPath).mode&0o777; token=readFileSync(tokenPath,'utf8').replace(/\s+$/,'');}
 catch{throw new Error(tokenPath+' is missing or not mode 600');}
 if(mode!==0o600)throw new Error(tokenPath+' must be mode 600 (got '+mode.toString(8)+')');
 if(!token.length)throw new Error(tokenPath+' is empty');
 return {base_url:base, model:env.SPARK_LLM_MODEL||MODEL_DEFAULT, token};
}

// Redact every token occurrence so secrets never reach logs or details.
export function redact(text, token){
 if(token==null||text==null)return text==null?'':String(text);
 return String(text).split(token).join('<redacted>');
}

// One HTTP request. The token is sent only as a header, never on the URL.
async function call(fetch,url,opts,timeoutMs){
 try{
  const headers={...opts.headers,Accept:'application/json'}; let body;
  if(opts.body!=null){headers['Content-Type']='application/json';body=JSON.stringify(opts.body);}
  const res=await fetch(url,{method:opts.method||'GET',headers,body,signal:AbortSignal.timeout(timeoutMs)});
  return {ok:true,status:res.status,text:await res.text()};
 }catch(err){
  const timed=err&&err.name==='TimeoutError';
  return {ok:false,error:timed?"timeout":"network error: "+String(err&&err.cause&&err.cause.code||err&&err.message)};
 }
}
function parse(t){try{return JSON.parse(t)}catch{return {}}}

// Run all seven checks in order. A network failure yields a FAIL line but the
// remaining checks still run.
export async function runChecks(config,{fetch,timeoutMs=120000}){
 const {base_url,model,token}=config;
 const D=s=>redact(s,token).slice(0,200);
 const B={'Authorization':'Bearer '+token};
 const R=[]; const push=(name,ok,detail)=>R.push({name,ok,detail});
 let r,j;

 r=await call(fetch,base_url+'/health',{},timeoutMs);
 push('health',r.ok&&r.status===200, r.ok?(r.status===200?'200':'HTTP '+r.status+' '+D(r.text)):D(r.error));

 r=await call(fetch,base_url+'/v1/models',{},timeoutMs);
 push('auth-required',r.ok&&r.status===401, r.ok?(r.status===401?'401':'HTTP '+r.status+' '+D(r.text)):D(r.error));

 r=await call(fetch,base_url+'/v1/models',{headers:B},timeoutMs);
 if(r.ok&&r.status===200){j=parse(r.text);const id=(j.data||[]).some(d=>d&&typeof d.id==='string'&&d.id.includes(model));push('models',id,id?model:'model not in data[].id');}
 else push('models',false, r.ok?'HTTP '+r.status+' '+D(r.text):D(r.error));

 r=await call(fetch,base_url+'/v1/chat/completions',{method:'POST',headers:B,body:{model,messages:[{role:'user',content:'Say one word.'}],max_tokens:64}},timeoutMs);
 if(r.ok&&r.status===200){j=parse(r.text);const m=(j.choices&&j.choices[0]&&j.choices[0].message)||null;push('chat',!!m, m?'choices[0].message':'missing choices[0].message '+D(r.text));}
 else push('chat',false, r.ok?'HTTP '+r.status+' '+D(r.text):D(r.error));

 r=await call(fetch,base_url+'/v1/responses',{method:'POST',headers:B,body:{model,input:'Say one word.',max_output_tokens:256}},timeoutMs);
 if(r.ok&&r.status===200){j=parse(r.text);const s=j.status;push('responses',s==='completed',s==='completed'?'status=completed':'status='+s+' '+D(r.text));}
 else push('responses',false, r.ok?'HTTP '+r.status+' '+D(r.text):D(r.error));

 r=await call(fetch,base_url+'/v1/messages',{method:'POST',headers:{'x-api-key':token,'anthropic-version':'2023-06-01'},body:{model,messages:[{role:'user',content:'Say one word.'}],max_tokens:64}},timeoutMs);
 if(r.ok&&r.status===200){j=parse(r.text);const t=j.type;push('messages',t==='message',t==='message'?'type=message':'type='+t+' '+D(r.text));}
 else push('messages',false, r.ok?'HTTP '+r.status+' '+D(r.text):D(r.error));

 r=await call(fetch,base_url+'/v1/chat/completions',{method:'POST',headers:B,body:{model,messages:[{role:'user',content:'What is the weather in Tokyo? Use the tool.'}],max_tokens:TOOL_CALL_MAX_TOKENS,tools:[{type:'function',function:{name:'get_weather',description:'Current weather for a city.',parameters:{type:'object',properties:{city:{type:'string'},format:{type:'string'}},required:['city']}}}],tool_choice:'auto'}},timeoutMs);
 if(r.ok&&r.status===200){
  j=parse(r.text);
  const tc=((j.choices&&j.choices[0]&&j.choices[0].message&&j.choices[0].message.tool_calls)||[])[0]||{};
  const fn=tc.function||null; const name0=fn&&fn.name;
  if(name0!=='get_weather'){
   if(j.choices&&j.choices[0]&&j.choices[0].finish_reason==='length')push('tool-call',false,'truncated before tool call (finish_reason=length)');
   else push('tool-call',false,'unexpected function='+JSON.stringify(name0)+' '+D(r.text));
  }
  else{try{JSON.parse(fn.arguments);push('tool-call',true,'get_weather');}catch{push('tool-call',false,'arguments not JSON: '+D(r.text));}}
 }
 else push('tool-call',false, r.ok?'HTTP '+r.status+' '+D(r.text):D(r.error));

 return R;
}

function configDir(){return process.env.SPARK_LLM_CONFIG_DIR||join(homedir(),'.config','spark-llm');}

async function main(){
 let config;
 try{config=loadConfig(configDir());}catch(err){console.error('doctor: '+err.message);process.exitCode=2;return;}
 const timeoutMs=Math.max(1,Number(process.env.SPARK_DOCTOR_TIMEOUT_MS)||120000);
 const results=await runChecks(config,{fetch,timeoutMs});
 let failed=0;
 for(const r of results){ if(r.ok)console.log('ok   '+r.name+'  '+r.detail); else{failed++;console.log('FAIL '+r.name+'  '+r.detail);} }
 console.log((results.length-failed)+'/'+results.length+' ok');
 process.exitCode=failed?1:0;
}

if(import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e&&e.stack||e);process.exitCode=1;});
