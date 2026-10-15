// New V4 layouts and signature domains; V3 codecs and stored records are unchanged.
import {hash} from './campaign-codec.mjs';
import {Writer,Reader,text,hex,fromHex,encodeDescriptor,decodeDescriptor} from './task-factory-v4-layout.mjs';
export * from './task-factory-v4-layout.mjs';
export {hash};
export const ZERO=new Uint8Array(32),NONE=0xffffffff;
export const STATE={DRAFT:0,RUNNING:1,EXHAUSTED:2,CLOSED:3,SCHEDULED:0,ACTIVE:1,SOLVED:2,FAILED:3,COMMITTED:1,REVEALED:2,VALID:3,INVALID:4,TIMED_OUT:5};
const evidenceFields=['candidate','result','manifest','archive'];
export const descriptorHash=d=>hash(text('Flybrain/task-descriptor/v4\0'),encodeDescriptor(d).result());
export const catalogStep=(previous,index,d)=>hash(text('Flybrain/task-catalog/v4\0'),new Writer().key(previous).u32(index).bytes(encodeDescriptor(d).result()).result());
export const catalogRoot=descriptors=>descriptors.reduce((h,d,i)=>catalogStep(h,i,d),ZERO);
export function encodeEvidence(e,w=new Writer()){for(const k of evidenceFields)w.key(e[k]);return w;}
export function commitment(program,f,task,attempt,miner,beneficiary,evidence,salt){
  const w=new Writer();for(const k of [program,f.genesis,f.policy,task])w.key(k);
  w.u32(attempt).key(miner).key(beneficiary);encodeEvidence(evidence,w).key(salt);
  return hash(text('Flybrain/task-commitment/v4\0'),w.result());
}
export function voteMessage(program,f,t,address,s,valid,report,completeTrials){
  const w=new Writer();for(const k of [program,f.genesis,f.policy,t.factory])w.key(k);
  w.u32(t.index).key(descriptorHash(t.descriptor)).key(address).key(s.task).u32(s.attempt).u64(s.sequence)
    .key(s.miner).key(s.beneficiary).key(s.commitment).u64(s.commitSlot);
  encodeEvidence(s.evidence,w).u8(valid?1:0).key(report).u8(completeTrials);
  return hash(text('Flybrain/task-replay/v4\0'),w.result());
}
function account(raw,tag,size,decode){
  if(raw?.length!==size||!text(tag).every((b,i)=>raw[i]===b))throw new Error('Invalid '+tag+' account');
  const r=new Reader(raw.slice(8)),v=decode(r);if(r.b.slice(r.p).some(b=>b!==0))throw new Error('Noncanonical V4 padding');return v;
}
export function decodeFactory(raw){return account(raw,'FBTFV004',768,r=>{
  const f={};for(const k of ['id','authority','genesis','policy','mint'])f[k]=r.key();f.verifiers=Array.from({length:3},()=>r.key());for(const k of ['catalogRoot','uploadedRoot'])f[k]=r.key();for(const k of ['count','uploaded'])f[k]=r.u32();for(const k of ['rewardSum','budget','remaining','reserved','acceptedUnpaid','paid','refunded'])f[k]=r.u64();f.nextIndex=r.u32();f.activeIndex=r.u32();f.deadline=r.i64();f.state=r.u8();const p=r.u8();if(p>1)throw new Error('Invalid bool');f.paused=!!p;
  if(f.remaining+f.reserved+f.acceptedUnpaid+f.paid+f.refunded!==f.budget||f.count<1||f.count>4096||f.uploaded>f.count)throw new Error('Invalid finite factory accounting');return f;
});}
export function decodeTask(raw){return account(raw,'FBTTV004',2048,r=>{
  const t={factory:r.key(),index:r.u32(),descriptor:decodeDescriptor(r),state:r.u8(),attempt:r.u32()};
  for(const k of ['openedAt','claimDeadline','revealDeadline','verifyDeadline'])t[k]=r.i64();t.nextSequence=r.u64();t.queue=r.vec(r=>({submission:r.key(),sequence:r.u64(),state:r.u8()}),8);t.winner=r.key();t.beneficiary=r.key();const p=r.u8();if(p>1)throw new Error('Invalid bool');t.paid=!!p;return t;
});}
export function decodeSubmission(raw){return account(raw,'FBTSV004',768,r=>{
  const s={task:r.key(),attempt:r.u32(),sequence:r.u64(),miner:r.key(),beneficiary:r.key(),commitment:r.key(),commitSlot:r.u64(),evidence:{}};for(const k of evidenceFields)s.evidence[k]=r.key();s.state=r.u8();s.validVotes=r.u8();s.invalidVotes=r.u8();s.reports=Array.from({length:3},()=>r.key());return s;
});}
export function operationData(tag,v={}){
  const w=new Writer().u8(tag);
  if(tag===0)w.key(v.id).key(v.catalogRoot).u32(v.count).u64(v.budget).i64(v.deadline);
  else if(tag===1)encodeDescriptor(v.descriptor,w);
  else if(tag===4)w.key(v.commitment).key(v.beneficiary);
  else if(tag===5)encodeEvidence(v.evidence,w).key(v.salt);
  else if(tag===6)w.u8(v.valid?1:0).key(v.report).u8(v.completeTrials).u16(v.ed25519Index);
  else if(tag===10)w.u8(v.paused?1:0);
  else if(![2,3,7,8,9,11].includes(tag))throw new Error('Unknown task factory operation');
  const b=w.result();return new Writer().u8(11).u32(b.length).bytes(b).result();
}
// The descriptor bounds are identical to the SBF rules. Storage/verification
// capacity is finite; there is no successful-task minimum interval.
