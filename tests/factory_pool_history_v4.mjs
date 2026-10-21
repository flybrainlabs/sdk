import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import {canonical,hash} from '../web/target-protocol-v2.mjs';
import {verifyPoolManifestV4,poolManifestMessageV4,verifyPoolHistoryV4,poolHistoryMessageV4,selectPoolContextV4,FactoryPoolSwitchV4} from '../web/factory-pool-v4.mjs';
const authority=Keypair.generate(),key=()=>Keypair.generate().publicKey.toBase58(),envelope={graphRoot:'1'.repeat(64)},trust={schema:'flybrainlabs-factory-pool-trust-v4',poolId:'2'.repeat(64),authority:authority.publicKey.toBase58(),genesisHash:key(),programId:key(),mint:key(),policyHash:'3'.repeat(64),envelopeHash:await hash(canonical(envelope)),anchorFactory:key(),envelope};
const identity=Object.fromEntries(['poolId','authority','genesisHash','programId','mint','policyHash','envelopeHash','anchorFactory'].map(k=>[k,trust[k]]));
const catalogs=Array.from({length:132},(_,n)=>({factory:key(),factoryId:n.toString(16).padStart(64,'0'),catalogRoot:'4'.repeat(64),budgetAtoms:'100',taskCount:1,deadline:'10000'}));
const sign=(body,domain)=>({...body,signature:Buffer.from(ed25519.sign(domain(body),authority.secretKey.subarray(0,32))).toString('hex')});
let previous=null;
for(let n=0;n<catalogs.length;n++){
  const body={schema:'flybrainlabs-factory-pool-manifest-v4',...identity,revision:n+1,issuedAt:100+n,expiresAt:1000+n,catalogs:catalogs.slice(n,n+2)};
  previous=await verifyPoolManifestV4(sign(body,poolManifestMessageV4),trust,{now:240,previous});
}
assert(previous.body.catalogs.length<128);
const body={schema:'flybrainlabs-factory-pool-history-v4',...identity,issuedAt:100,expiresAt:1000,catalog:catalogs[0]},history=sign(body,poolHistoryMessageV4);
assert.equal((await verifyPoolHistoryV4(history,trust,{factory:catalogs[0].factory,now:240})).catalog.factory,catalogs[0].factory);
await assert.rejects(verifyPoolHistoryV4({...history,catalog:{...catalogs[0],budgetAtoms:'101'}},trust,{factory:catalogs[0].factory,now:240}),/POOL_HISTORY_SIGNATURE/);
await assert.rejects(verifyPoolHistoryV4(history,trust,{factory:catalogs[1].factory,now:240}),/POOL_HISTORY_CATALOG/);
await assert.rejects(verifyPoolManifestV4(history,trust,{now:240}),/POOL_MANIFEST_SCOPE/);
await assert.rejects(verifyPoolHistoryV4(history,trust,{factory:catalogs[0].factory,now:1001}),/POOL_HISTORY_SCOPE/);
const contexts=catalogs.slice(0,3).map((deployment,i)=>({deployment,client:{online:true,serverNow:100,round:{roundId:String(i),pre:{claimDeadline:1000+i}}}}));
assert.equal(selectPoolContextV4(contexts,contexts[0],{pendingRounds:new Set(['0'])}),contexts[1]);
contexts[1].historyOnly=true;assert.equal(selectPoolContextV4(contexts,contexts[0],{pendingRounds:new Set(['0'])}),contexts[2]);
const runner={active:[{context:contexts[0]}],generation:1,intent:true};let committed;
const sw=new FactoryPoolSwitchV4({runner,contextSafe:true,canSwitch:()=>runner.intent,prepare:async()=>{},commit:async c=>{await Promise.resolve();committed=c;}});
assert(await sw.switchTo(contexts[2]));assert.equal(committed,contexts[2]);assert.equal(runner.active[0].context,contexts[0]);
console.log(JSON.stringify({passed:true,rotations:132,oldSignaturesPreserved:true,historyDomainIsSeparate:true,scope:'Actual Ed25519 signatures and selection; chain reads and payouts are covered separately'}));
