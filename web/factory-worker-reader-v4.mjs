import {PublicKey} from '@solana/web3.js';
import {Buffer} from 'buffer';
import {readerForDeployment} from './task-factory-client-v4.mjs';
import {verifyPoolManifestV4,poolDeploymentV4,verifyPoolCatalogV4} from './factory-pool-v4.mjs';
export function capability(port){
  if(!port||typeof port.postMessage!=='function')throw Object.assign(new Error('RPC_REQUIRED'),{code:'RPC_REQUIRED'});
  let sequence=0,closed=false;const requests=new Map();
  const close=()=>{closed=true;for(const {reject,timer}of requests.values()){clearTimeout(timer);reject(new Error('Factory read capability closed'));}requests.clear();port.close();};
  port.onmessage=({data:m})=>{const pending=requests.get(m?.id);if(!pending)return;requests.delete(m.id);clearTimeout(pending.timer);if(m.error)pending.reject(new Error('Personal RPC could not verify the frozen task'));else pending.resolve(m.value);};port.start();
  const call=(method,fields={})=>new Promise((resolve,reject)=>{if(closed||requests.size>=2){reject(new Error('Factory read capability unavailable'));return;}const id=++sequence,timer=setTimeout(()=>{requests.delete(id);reject(new Error('Personal RPC task verification timed out'));},30000);requests.set(id,{resolve,reject,timer});port.postMessage({id,method,...fields});});
  const connection={getGenesisHash:()=>call('getGenesisHash'),getAccountInfo:async address=>{const raw=await call('getAccountInfo',{address:address.toBase58()});return raw?{owner:new PublicKey(raw.owner),data:Buffer.from(raw.data)}:null;}};
  return {connection,close,getPoolManifest:()=>call('getPoolManifest')};
}
export function factoryWorkerReaderV4(deployment,port){const c=capability(port),reader=readerForDeployment(deployment,c.connection);reader.dispose=c.close;return reader;}
export async function factoryWorkerPoolReaderV4(base,round,port){
  const c=capability(port);
  try{
    let deployment=base;
    if(round.pre.factoryAddress!==base.factory){
      const trust=base.taskPool?.trust;if(trust?.anchorFactory!==base.factory)throw new Error('Worker task pool is not configured');
      const document=await c.getPoolManifest(),verified=await verifyPoolManifestV4(document,trust),entry=verified.body.catalogs.find(x=>x.factory===round.pre.factoryAddress);if(!entry)throw new Error('Worker catalog is outside the signed pool');
      deployment=poolDeploymentV4(base,entry,trust);await verifyPoolCatalogV4(deployment,trust,c.connection);
    }
    const reader=readerForDeployment(deployment,c.connection);reader.dispose=c.close;return reader;
  }catch(error){c.close();throw error;}
}
