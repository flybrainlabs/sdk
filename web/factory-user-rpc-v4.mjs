// Personal Helius transport. Credentials stay in the browser and are never
// attached to the project gateway, uploads, diagnostics or external links.
import {Connection} from '@solana/web3.js';
import {readerForDeployment} from './task-factory-client-v4.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const storage=name=>{try{return globalThis[name]||null;}catch{return null;}};
function pacedFetch(fetchImpl){
  let tail=Promise.resolve(),queued=0,nextAt=0,nextSendAt=0;
  return async(url,options,guard=()=>{})=>{
    if(queued>=16)throw fail('RPC_UNAVAILABLE');queued++;
    const operation=tail.catch(()=>{}).then(async()=>{
      const send=JSON.parse(options.body).method==='sendTransaction',wait=Math.max(0,nextAt-Date.now(),send?nextSendAt-Date.now():0);
      if(wait)await new Promise(ok=>setTimeout(ok,wait));nextAt=Date.now()+250;if(send)nextSendAt=Date.now()+1100;
      guard();return fetchImpl(url,options);
    }).finally(()=>{queued--;});tail=operation;return operation;
  };
}
export function heliusApiKey(value){
  const key=String(value??'').trim();
  if(!/^[A-Za-z0-9_-]{1,256}$/.test(key))throw fail('RPC_INVALID_KEY');
  return key;
}
export function heliusRpcUrl(value,deployment){
  const networks={devnet:['devnet','EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'],'mainnet-beta':['mainnet','5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp']};
  const network=networks[deployment?.cluster];
  if(!network||deployment.genesisHash!==network[1])throw fail('RPC_DEPLOYMENT_NETWORK');
  return 'https://'+network[0]+'.helius-rpc.com/?api-key='+encodeURIComponent(heliusApiKey(value));
}
function savedKey(saved,deployment){
  if(saved.apiKey)return heliusApiKey(saved.apiKey);
  // Migrate an existing URL preference without changing its storage scope.
  const url=new URL(saved.endpoint),key=heliusApiKey(url.searchParams.get('api-key'));
  if(url.href!==heliusRpcUrl(key,deployment))throw fail('RPC_INVALID_KEY');
  return key;
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
export async function probePersonalRpcV4(key,deployment,fetchImpl=globalThis.fetch){
  const endpoint=heliusRpcUrl(key,deployment),connection=new Connection(endpoint,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:(u,o)=>personalRpcFetchV4(u,o,fetchImpl)});
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
    Object.assign(this,{deployment,session,persistent,onChange});this.fetchImpl=pacedFetch(fetchImpl);this.key='flybrainlabs-personal-rpc-v4:'+deployment.genesisHash+':'+deployment.programId;this.value='';this.remember=false;this.status='required';this.busy=false;this.generation=0;
    for(const [source,remember]of [[persistent,true],[session,false]])try{const saved=JSON.parse(source?.getItem(this.key)||'null');if(saved?.schema==='flybrainlabs-personal-rpc-v4'&&(saved.apiKey||saved.endpoint)){this.value=savedKey(saved,deployment);this.remember=remember;break;}}catch{}
  }
  get endpoint(){return this.#endpoint;}
  get ready(){return !!this.#endpoint&&!this.busy;}
  assertReady(){if(!this.ready)throw fail('RPC_REQUIRED');}
  request(options){this.assertReady();const generation=this.generation;return personalRpcFetchV4(this.#endpoint,options,(url,o)=>this.fetchImpl(url,o,()=>{this.assertReady();if(generation!==this.generation)throw fail('RPC_CHANGED');}));}
  toJSON(){return {custom:!!this.#endpoint,remember:this.remember,status:this.status};}
  async initialize(){if(!this.value)return;try{await this.apply(this.value,{remember:this.remember});}catch{this.status='restore-unavailable';this.onChange();}}
  apply(value,{remember=false,persist=true}={}){
    if(this.operation)return this.operation;
    this.generation++;this.#endpoint=null;this.busy=true;this.status='checking';this.onChange();
    this.operation=(async()=>{
      const key=heliusApiKey(value),endpoint=await probePersonalRpcV4(key,this.deployment,this.fetchImpl);
      let saved=!persist;
      if(persist)try{const target=remember?this.persistent:this.session;if(!target)throw new Error('Storage unavailable');target.setItem(this.key,JSON.stringify({schema:'flybrainlabs-personal-rpc-v4',apiKey:key}));(remember?this.session:this.persistent)?.removeItem(this.key);saved=true;}catch{}
      this.#endpoint=endpoint;this.value=key;this.remember=remember&&saved;this.status=!saved?'memory-only':this.remember?'custom-remembered':'custom-session';return this.toJSON();
    })().catch(error=>{this.status=error.code||'RPC_UNAVAILABLE';throw error;}).finally(()=>{this.busy=false;this.operation=null;this.onChange();});
    return this.operation;
  }
  reset(){
    if(this.busy)throw fail('RPC_BUSY');
    let removed=true;for(const source of [this.session,this.persistent])try{source?.removeItem(this.key);}catch{removed=false;}
    this.generation++;this.#endpoint=null;this.value='';this.remember=false;this.status=removed?'required':'reset-storage-unavailable';this.onChange();
  }
}
