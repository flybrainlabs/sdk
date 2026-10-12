// Canonical mining V3 codecs. These layouts never reinterpret V1/V2 accounts.
import {Writer,Reader,text,hash,hex} from './campaign-codec.mjs';
export {Writer,Reader,hex,text,hash};
export const RESULT_SIZE=1024;
export const BINDINGS=['genesis','program','policy','stage','economicTask','unit','round','candidate','claim','contribution','model','graph','parameters','goalResult','manifest','archive','miner','beneficiary','originalGrantId','originalSession','permanentUnit','originalGrant','settlerPolicy','replayEvidence','winnerProof'];
const INTENT_KEYS=['genesis','program','policy','unitAccount','economicTask','unit','round','candidate','commitment','goalResult','manifest','scientificIdentity','miner','beneficiary','grant'];
const BOOL=r=>{const b=r.u8();if(b>1)throw new Error('Noncanonical bool');return b===1;};
const U16=r=>r.num(2);
const end=r=>{if(r.b.slice(r.p).some(x=>x!==0))throw new Error('Nonzero reserved account bytes');};
function account(data,tag,size){if(data.length!==size)throw new Error('Wrong '+tag+' size');const r=new Reader(data);if(new TextDecoder().decode(r.bytes(8))!==tag)throw new Error('Wrong account discriminator');return r;}
export function encodeIntent(i,w=new Writer()){
  for(const k of INTENT_KEYS)w.key(i[k]);
  return w.u64(i.grantGeneration).key(i.session).u64(i.rewardAtoms).u64(i.maxResultRent).result();
}
export function decodeIntentValue(r){const i={};for(const k of INTENT_KEYS)i[k]=r.key();i.grantGeneration=r.u64();i.session=r.key();i.rewardAtoms=r.u64();i.maxResultRent=r.u64();return i;}
export const intentMessage=i=>hash(text('flybrainlabs/mining-v3/intent\0'),encodeIntent(i));
export function encodeResult(r){
  if(r.roots.length!==25||r.metrics.length!==16)throw new Error('Wrong result dimensions');
  const w=new Writer().bytes(text('FBMRV003')).u16(3).u16(0).u32(RESULT_SIZE);
  for(const k of r.roots)w.key(k);
  for(const k of ['originalGeneration','roundSequence','claimSequence','rewardAtoms','rentLamports','acceptedAt','settledSlot'])w.u64(r[k]);
  w.i64(r.settledAt).u16(r.requiredTrials).u16(r.completeTrials).u32(r.steps).u32(r.neurons).u32(r.metricsVersion);
  for(const n of r.metrics)w.i64(n);
  const b=w.result();decodeResult(b);return b;
}
export function decodeResult(data){
  const r=account(data,'FBMRV003',1024);
  if(U16(r)!==3||U16(r)!==0||r.u32()!==1024)throw new Error('Wrong result version/reserved/size');
  const v={roots:Array.from({length:25},()=>r.key())};
  for(const k of ['originalGeneration','roundSequence','claimSequence','rewardAtoms','rentLamports','acceptedAt','settledSlot'])v[k]=r.u64();
  v.settledAt=r.i64();v.requiredTrials=U16(r);v.completeTrials=U16(r);v.steps=r.u32();v.neurons=r.u32();v.metricsVersion=r.u32();v.metrics=Array.from({length:16},()=>r.i64());
  if(v.roots.some((x,i)=>i!==5&&x.every(b=>b===0))||v.originalGeneration===0n||v.roundSequence===0n||v.claimSequence===0n||v.rewardAtoms===0n||v.requiredTrials<2||v.requiredTrials>16||v.completeTrials!==v.requiredTrials||v.steps!==256||v.neurons===0||v.neurons>1_000_000||v.metricsVersion!==1||v.metrics.slice(13).some(n=>n!==0n))throw new Error('Invalid result bindings/counters');
  v.bindings=Object.fromEntries(BINDINGS.map((k,i)=>[k,v.roots[i]]));return v;
}
export function decodeConfig(data){const r=account(data,'FBMCV003',512),v={relayer:r.key(),closeAuthority:r.key(),rentRecipient:r.key(),retentionSeconds:r.u64(),maxGrantLifetime:r.u64(),maxDeposit:r.u64()};end(r);return v;}
export function decodeGeneration(data){const r=account(data,'FBMWV003',128),v={miner:r.key(),generation:r.u64()};end(r);return v;}
export function decodeGrant(data){
  const r=account(data,'FBMGV003',512),v={};for(const k of ['id','miner','beneficiary','session','policy'])v[k]=r.key();
  for(const k of ['generation','deposited','spent','withdrawn','successes','maxSpend','maxResultRent','maxResults'])v[k]=r.u64();v.expiresAt=r.i64();v.revoked=BOOL(r);v.managementRent=r.u64();end(r);
  if(hex(v.miner)!==hex(v.beneficiary)||v.generation===0n||v.spent>v.maxSpend||v.successes>v.maxResults||v.spent+v.withdrawn>v.deposited)throw new Error('Invalid grant principal/limits');v.available=v.deposited-v.spent-v.withdrawn;return v;
}
export function decodeMiningStage(data){
  const r=account(data,'FBMSV003',256),v={id:r.key(),policy:r.key()};for(const k of ['budget','remaining','pendingUnits','pendingAtoms','acceptedUnpaid','paid'])v[k]=r.u64();v.deadline=r.i64();v.closed=BOOL(r);end(r);
  if(v.remaining+v.pendingAtoms+v.acceptedUnpaid+v.paid>v.budget)throw new Error('Stage conservation');return v;
}
export function decodeUnit(data){
  const r=account(data,'FBMUV003',1536),v={economicTask:r.key(),unit:r.key(),stage:r.key(),amount:r.u64(),accepted:BOOL(r),paid:BOOL(r),released:BOOL(r)};
  for(const k of ['intent','staging','beneficiary','originalGrant','fundingGrant'])v[k]=r.key();v.fundingGeneration=r.u64();v.preparedHash=r.key();v.resultHash=r.key();v.actualRent=r.u64();v.acceptedAt=r.u64();v.paidSlot=r.u64();v.paidAt=r.i64();v.closed=BOOL(r);v.closedAt=r.i64();v.closeVotes=r.u8();end(r);
  if(v.unit.some(x=>x!==0)||(v.paid&&!v.accepted)||(v.closed&&!v.paid)||v.closeVotes>7)throw new Error('Invalid permanent unit state');return v;
}
export function decodeFinancialIntent(data){const r=account(data,'FBMIV003',1024),v={value:decodeIntentValue(r),hash:r.key(),originalGrant:r.key()};end(r);if(hex(intentMessage(v.value))!==hex(v.hash))throw new Error('Intent hash');return v;}
export function decodeStaging(data){const r=account(data,'FBMBV003',1280),v={unit:r.key(),intent:r.key(),expectedHash:r.key(),written:U16(r),sealed:BOOL(r),votes:r.u8()},n=r.u32();if(n!==1024||v.written>n||v.votes>7)throw new Error('Staging dimensions');v.bytes=r.bytes(n);end(r);if(v.sealed&&(v.written!==1024||hex(hash(v.bytes))!==hex(v.expectedHash)))throw new Error('Staging commitment');return v;}
export const winnerMessage=(program,g,unit,intentHash,preparedHash)=>hash(text('flybrainlabs/mining-v3/winner\0'),new Writer().key(program).key(g.network).key(g.policy).key(unit).key(intentHash).key(preparedHash).result());
export const settlerPolicy=(program,g)=>hash(text('flybrainlabs/mining-v3/settler-policy\0'),new Writer().key(program).key(g.network).key(g.policy).bytes(g.settlers.flatMap(k=>Array.from(k))).u8(2).result());
export const closureMessage=(program,g,unit,u)=>hash(text('flybrainlabs/mining-v3/finalized-archive-close\0'),new Writer().key(program).key(g.network).key(g.policy).key(unit).key(u.resultHash).key(u.preparedHash).u64(u.paidSlot).i64(u.paidAt).result());
export const jsonValue=x=>JSON.parse(JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v instanceof Uint8Array?hex(v):v?.type==='Buffer'&&Array.isArray(v.data)?hex(v.data):v));
