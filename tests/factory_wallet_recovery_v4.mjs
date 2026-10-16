// Ephemeral test wallet, in-memory IndexedDB and simulated personal RPC only.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Keypair,Transaction,PublicKey} from '@solana/web3.js';
import {factoryWalletAdapter} from '../web/factory-wallet-adapter-v4.mjs';
import {instruction,meta} from '../tools/task_factory_v4_client.mjs';
const {deployment}=JSON.parse(await readFile('tests/vectors/factory-user-rpc-v4.json','utf8'));
const records=new Map();
globalThis.indexedDB={open(){const r={};setImmediate(()=>{r.result={close(){},transaction(){const t={objectStore(){const request=fn=>{const q={};setImmediate(()=>{q.result=fn();q.onsuccess();setImmediate(()=>t.oncomplete());});return q;};return {get:key=>request(()=>structuredClone(records.get(key))),put:(value,key)=>request(()=>records.set(key,structuredClone(value)))}}};return t;}};r.onsuccess();});return r;}};
const encode=bytes=>{const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let value=BigInt('0x'+Buffer.from(bytes).toString('hex')),out='';while(value){out=alphabet[Number(value%58n)]+out;value/=58n;}for(const byte of bytes){if(byte)break;out='1'+out;}return out;};
const key=Keypair.generate(),address=key.publicKey.toBase58(),statuses=new Map(),packets=[];let signatures=0,unknown=false,enabled=true;
const session={generation:0,account:{address,publicKey:key.publicKey.toBytes()},login:{wallet:address,expiresAt:Date.now()/1000+3600},guard(){},wallet:{features:{'solana:signTransaction':{async signTransaction({transaction}){signatures++;const tx=Transaction.from(Buffer.from(transaction));tx.partialSign(key);return [{signedTransaction:tx.serialize()}];}}}}};
const rpc={generation:0,assertReady(){if(!enabled)throw new Error('RPC_REQUIRED');},async request(options){
  this.assertReady();const request=JSON.parse(options.body);let result;
  switch(request.method){
    case 'getGenesisHash':result=deployment.genesisHash;break;
    case 'getLatestBlockhash':result={context:{slot:100},value:{blockhash:new PublicKey(new Uint8Array(32).fill(signatures+7)).toBase58(),lastValidBlockHeight:200}};break;
    case 'getFeeForMessage':result={context:{slot:100},value:5000};break;
    case 'getSignatureStatuses':result={context:{slot:100},value:request.params[0].map(s=>unknown?null:statuses.get(s)||null)};break;
    case 'getBlockHeight':result=201;break;
    case 'sendTransaction':{const tx=Transaction.from(Buffer.from(request.params[0],'base64'));assert(tx.verifySignatures());packets.push(tx);result=encode(tx.signature);statuses.set(result,{slot:100,confirmations:null,err:null,confirmationStatus:'finalized'});break;}
    default:throw new Error('Unexpected fixture RPC method: '+request.method);
  }
  return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
}};
const adapter=factoryWalletAdapter({deployment,session,rpc}),ix=instruction(deployment.programId,[meta(deployment.factory,true),meta(new PublicKey(new Uint8Array(32).fill(9)),true)],8),intent=attempt=>({intent:'task-recovery-v4:expire:2:'+attempt,replacementSafe:false});
await adapter.send([ix],intent(0));assert.equal(signatures,1);await adapter.send([ix],intent(0));assert.equal(signatures,1);assert.equal(packets.length,1);
await adapter.send([ix],intent(1));assert.equal(signatures,2);assert.equal(packets.length,2);assert.equal(records.size,2);
unknown=true;await assert.rejects(adapter.send([ix],intent(2)),e=>e.code==='CHAIN_STATUS_UNKNOWN');assert.equal(signatures,3);
await assert.rejects(adapter.send([ix],intent(2)),/Original recovery transaction is unconfirmed/);assert.equal(signatures,3);assert.equal(packets.length,3);
const liveLogin={...session.login};assert.equal(adapter.isSignedIn(),true);
for(const login of [{...liveLogin,expiresAt:Date.now()/1000-1},{...liveLogin,expiresAt:'invalid'},{...liveLogin,wallet:'different-wallet'},null]){
  session.login=login;assert.equal(adapter.isSignedIn(),false);
  assert.throws(()=>adapter.assertMiningAuthorization(),e=>e.code==='wallet-login-required');
  await assert.rejects(adapter.send([ix],intent(3)),e=>e.code==='wallet-login-required');
  assert.equal(signatures,3);assert.equal(packets.length,3);assert.equal(records.size,3);
}
session.login=liveLogin;assert.equal(adapter.isSignedIn(),true);
enabled=false;await assert.rejects(adapter.send([ix],intent(3)),/RPC_REQUIRED/);assert.equal(signatures,3);
console.log(JSON.stringify({passed:true,checks:['Finalized recovery receipts deduplicate identical attempts','A second contract attempt uses a separate persisted transaction scope','Ambiguous expired recovery is retained and never signed again blindly','Expired, invalid, mismatched and missing wallet login block signing and expose the same UI authorization state','Missing personal RPC blocks signing'],ephemeralFixtureWallet:true,realChainWrites:0}));
