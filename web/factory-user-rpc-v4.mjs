// Personal Helius transport. Credentials stay in the browser and are never
// attached to the project gateway, uploads, diagnostics or external links.
import {Connection} from '@solana/web3.js';
import {readerForDeployment} from './task-factory-client-v4.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const storage=name=>{try{return globalThis[name]||null;}catch{return null;}};
function pacedFetch(fetchImpl){
  let tail=Promise.resolve(),queued=0,nextAt=0,nextSendAt=0;
  return async(url,options)=>{
    if(queued>=16)throw fail('RPC_UNAVAILABLE');queued++;
    const operation=tail.catch(()=>{}).then(async()=>{
      const send=JSON.parse(options.body).method==='sendTransaction',wait=Math.max(0,nextAt-Date.now(),send?nextSendAt-Date.now():0);
      if(wait)await new Promise(ok=>setTimeout(ok,wait));nextAt=Date.now()+250;if(send)nextSendAt=Date.now()+1100;
      return fetchImpl(url,options);
    }).finally(()=>{queued--;});tail=operation;return operation;
  };
}
export function heliusRpcUrl(value){
  let u;try{u=new URL(String(value).trim());}catch{throw fail('RPC_INVALID_URL');}
  if(u.protocol!=='https:'||!['devnet.helius-rpc.com','mainnet.helius-rpc.com'].includes(u.hostname)||u.port||u.username||u.password||u.hash||!u.searchParams.get('api-key')?.trim()||u.href.length>2048)throw fail('RPC_INVALID_URL');
  return u.href;
}
export async function personalRpcFetchV4(url,options={},fetchImpl=globalThis.fetch){
  const headers=new Headers(options.headers);
  for(const name of ['authorization','x-mining-csrf','cookie','solana-client'])headers.delete(name);
  try{
    const response=await fetchImpl(url,{...options,headers,credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw fail(response.status===429?'RPC_RATE_LIMITED':[401,403].includes(response.status)?'RPC_AUTH_FAILED':'RPC_UNAVAILABLE');
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>200000)throw fail('RPC_RESPONSE_LIMIT');chunks.push(value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}
    const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
    const value=JSON.parse(new TextDecoder().decode(bytes));
    // A provider error can echo its request URL. Do not forward that message.
    if(value.error)value.error={code:Number.isInteger(value.error.code)?value.error.code:-32000,message:'Personal RPC request failed'};
    return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
  }catch(error){throw fail(['RPC_RATE_LIMITED','RPC_AUTH_FAILED','RPC_RESPONSE_LIMIT'].includes(error.code)?error.code:'RPC_UNAVAILABLE');}
}
export async function probePersonalRpcV4(url,deployment,fetchImpl=globalThis.fetch){
  const endpoint=heliusRpcUrl(url),connection=new Connection(endpoint,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:(u,o)=>personalRpcFetchV4(u,o,fetchImpl)});
  try{await readerForDeployment(deployment,connection).factory();}
  catch(error){
    if(error.message==='Wrong chain genesis')throw fail('RPC_WRONG_NETWORK');
    if(['Factory account missing or wrong owner','Frozen factory identity mismatch'].includes(error.message))throw fail('RPC_FACTORY_MISMATCH');
    throw fail(['RPC_RATE_LIMITED','RPC_AUTH_FAILED'].find(code=>String(error.message).includes(code))||'RPC_UNAVAILABLE');
  }
  return endpoint;
}
export class FactoryUserRpcV4 {
  #endpoint=null;
  constructor({deployment,fetch:fetchImpl=globalThis.fetch,session=storage('sessionStorage'),persistent=storage('localStorage'),onChange=()=>{}}){
    Object.assign(this,{deployment,session,persistent,onChange});this.fetchImpl=pacedFetch(fetchImpl);this.key='flybrainlabs-personal-rpc-v4:'+deployment.genesisHash+':'+deployment.programId;this.value='';this.remember=false;this.status='default';this.busy=false;
    for(const [source,remember]of [[persistent,true],[session,false]])try{const saved=JSON.parse(source?.getItem(this.key)||'null');if(saved?.schema==='flybrainlabs-personal-rpc-v4'&&saved.endpoint){this.value=heliusRpcUrl(saved.endpoint);this.remember=remember;break;}}catch{}
  }
  get endpoint(){return this.#endpoint;}
  request(options){if(!this.#endpoint)throw fail('RPC_UNAVAILABLE');return personalRpcFetchV4(this.#endpoint,options,this.fetchImpl);}
  toJSON(){return {custom:!!this.#endpoint,remember:this.remember,status:this.status};}
  async initialize(){if(!this.value)return;try{await this.apply(this.value,{remember:this.remember,persist:false});}catch{this.status='restore-unavailable';this.onChange();}}
  apply(value,{remember=false,persist=true}={}){
    if(this.operation)return this.operation;
    this.busy=true;this.status='checking';this.onChange();
    this.operation=(async()=>{
      const endpoint=await probePersonalRpcV4(value,this.deployment,this.fetchImpl);
      let saved=!persist;
      if(persist)try{const target=remember?this.persistent:this.session;if(!target)throw new Error('Storage unavailable');target.setItem(this.key,JSON.stringify({schema:'flybrainlabs-personal-rpc-v4',endpoint}));(remember?this.session:this.persistent)?.removeItem(this.key);saved=true;}catch{}
      this.#endpoint=endpoint;this.value=endpoint;this.remember=remember&&saved;this.status=!saved?'memory-only':this.remember?'custom-remembered':'custom-session';return this.toJSON();
    })().catch(error=>{this.status=error.code||'RPC_UNAVAILABLE';throw error;}).finally(()=>{this.busy=false;this.operation=null;this.onChange();});
    return this.operation;
  }
  reset(){
    if(this.busy)throw fail('RPC_BUSY');
    let removed=true;for(const source of [this.session,this.persistent])try{source?.removeItem(this.key);}catch{removed=false;}
    this.#endpoint=null;this.value='';this.remember=false;this.status=removed?'default':'reset-storage-unavailable';this.onChange();
  }
}
