import {PublicKey} from '@solana/web3.js';
import {Buffer} from 'buffer';
import {readerForDeployment} from './task-factory-client-v4.mjs';
export function factoryWorkerReaderV4(deployment,port){
  if(!port||typeof port.postMessage!=='function')throw Object.assign(new Error('RPC_REQUIRED'),{code:'RPC_REQUIRED'});
  let sequence=0,closed=false;const requests=new Map();
  const close=()=>{closed=true;for(const {reject,timer}of requests.values()){clearTimeout(timer);reject(new Error('Factory read capability closed'));}requests.clear();port.close();};
  port.onmessage=({data:m})=>{const pending=requests.get(m?.id);if(!pending)return;requests.delete(m.id);clearTimeout(pending.timer);if(m.error)pending.reject(new Error('Personal RPC could not verify the frozen task'));else pending.resolve(m.value);};port.start();
  const call=(method,fields={})=>new Promise((resolve,reject)=>{if(closed||requests.size>=2){reject(new Error('Factory read capability unavailable'));return;}const id=++sequence,timer=setTimeout(()=>{requests.delete(id);reject(new Error('Personal RPC task verification timed out'));},30000);requests.set(id,{resolve,reject,timer});port.postMessage({id,method,...fields});});
  const connection={getGenesisHash:()=>call('getGenesisHash'),getAccountInfo:async address=>{const raw=await call('getAccountInfo',{address:address.toBase58()});return raw?{owner:new PublicKey(raw.owner),data:Buffer.from(raw.data)}:null;}};
  const reader=readerForDeployment(deployment,connection);reader.dispose=close;return reader;
}
