// V5 wire domains. No legacy bytes, account layouts or storage keys are changed.
import {Writer,Reader,text,hex,fromHex} from './task-factory-v4-layout.mjs';
import {hash} from './campaign-codec.mjs';
import {canonical,validateGoal,validateInput,hash as hashBytes} from './target-protocol-v2.mjs';
export {Writer,Reader,text,hex,fromHex,hash};
export const ZERO=new Uint8Array(32),STATES={COMMITTED:0,REVEALED:1,ACCEPTED:2,REJECTED:3,DUPLICATE:4,PAID:5};
const roots=['id','content','computationContext','analysis'],slots=['rewardAtoms','commitStart','commitEnd','challengeSlot','revealEnd','verifyEnd'];
const digest=(name,w)=>hash(text(`Flybrain/${name}/v5\0`),w.result());
export function encodeSpecification(s,w=new Writer()){
  for(const k of roots)w.key(s[k]);if(s.auditInputs.length!==4)throw new Error('Four frozen audit inputs required');
  s.auditInputs.forEach(k=>w.key(k));for(const k of slots)w.u64(s[k]);return w.u8(s.backgrounds);
}
export function decodeSpecification(r){const s={};for(const k of roots)s[k]=r.key();s.auditInputs=Array.from({length:4},()=>r.key());for(const k of slots)s[k]=r.u64();s.backgrounds=r.u8();return s;}
function account(bytes,tag,size,fn){if(bytes.length!==size||!text(tag).every((x,i)=>bytes[i]===x))throw new Error('Scientific account type/size');const r=new Reader(bytes.slice(8)),v=fn(r);if(r.b.slice(r.p).some(x=>x!==0))throw new Error('Scientific account padding');return v;}
export function decodeRound(bytes){return account(bytes,'FBSRV005',4096,r=>{
  const v={specification:decodeSpecification(r)};for(const k of ['genesis','policy','mint'])v[k]=r.key();v.verifiers=Array.from({length:3},()=>r.key());v.challenge=r.key();v.sourceSlot=r.u64();v.queues=Array.from({length:3},()=>r.vec(r=>r.key(),12));v.cursors=Array.from({length:3},()=>r.u8());v.winners=Array.from({length:10},()=>r.key());
  for(const k of ['remaining','acceptedUnpaid','paid','refunded'])v[k]=r.u64();const closed=r.u8();if(closed>1)throw new Error('Scientific bool');v.closed=!!closed;
  if(v.remaining+v.acceptedUnpaid+v.paid+v.refunded!==10n*v.specification.rewardAtoms||v.cursors.some((n,i)=>n>v.queues[i].length))throw new Error('Scientific round accounting');return v;
});}
export function decodeClaim(bytes){return account(bytes,'FBSCV005',768,r=>{
  const c={};for(const k of ['round','miner','beneficiary','commitment'])c[k]=r.key();c.role=r.u8();c.assignment=r.u8();for(const k of ['input','manifest','result','computation'])c[k]=r.key();for(const k of ['state','completeVotes','positiveVotes','invalidVotes'])c[k]=r.u8();c.reports=Array.from({length:3},()=>r.key());
  if(c.role>2||!(c.role===0?c.assignment===255:c.assignment<2)||c.state>5||(c.completeVotes|c.positiveVotes|c.invalidVotes)>7||(c.positiveVotes&~c.completeVotes)!==0||(c.completeVotes&c.invalidVotes)!==0)throw new Error('Scientific claim bounds');return c;
});}
export function operationData(tag,v={}){
  const w=new Writer().u8(tag);
  if(tag===0)encodeSpecification(v.specification,w);
  else if(tag===1)w.key(v.commitment).key(v.beneficiary).u8(v.role).u8(v.assignment);
  else if(tag===3)for(const k of ['input','salt','manifest','result'])w.key(v[k]);
  else if(tag===4)w.u8(v.complete?1:0).u8(v.passed?1:0).key(v.report).u16(v.ed25519Index);
  else if(![2,5,6,7].includes(tag))throw new Error('Unknown scientific operation');
  const b=w.result();return new Writer().u8(12).u32(b.length).bytes(b).result();
}
export function inputCommitment(program,r,c,input,salt){return digest('scientific-input-commitment',new Writer().key(program).key(r.genesis).key(r.policy).key(c.round).key(c.miner).key(c.beneficiary).u8(c.role).u8(c.assignment).key(input).key(salt));}
export function computationIdentity(r,role,assignment,input){return digest('scientific-computation',new Writer().key(r.specification.computationContext).key(r.challenge).u8(role).u8(assignment).u8(r.specification.backgrounds).key(input));}
export function backgroundSeeds(r,role,assignment){return Array.from({length:r.specification.backgrounds},(_,i)=>{
  const b=digest('scientific-background',new Writer().key(r.challenge).u8(role).u8(assignment).u8(i));return new DataView(b.buffer,b.byteOffset,8).getBigUint64(0,true).toString(16).padStart(16,'0');
});}
export function voteMessage(program,r,key,c,complete,passed,report){const w=new Writer();for(const k of [program,r.genesis,r.policy,c.round,key,c.commitment,c.input,c.computation,r.specification.analysis,r.specification.content,c.manifest,c.result,c.beneficiary])w.key(k);return digest('scientific-verdict',w.u8(complete?1:0).u8(passed?1:0).key(report));}
export const inputIdentity=input=>hash(text('Flybrain/scientific-input/v5\0'),canonical(input));
export const contentRoot=value=>hash(canonical(value));
export const uploadMessage=({genesis,program,round,claim,root,bytes})=>canonical({schema:'flybrain-scientific-upload-v5',genesis,program,round,claim,root,bytes});
export function computationContext(goal){return hash(text('Flybrain/scientific-context/v5\0'),canonical({model:goal.modelRoot,graph:goal.graphRoot,metadata:goal.modelDataRoot,parameters:goal.parameterProfileHash,initialState:'reset-zero-buffers-v1',transition:'integer-lif-one-delay-v1',randomness:'splitmix64-neuron-step-v1',steps:goal.steps,timeStepUs:goal.timeStepUs}));}
export async function validateScientificContent(content,spec){
  if(content.schema!=='flybrain-scientific-question-v5'||content.verificationMethod!=='exact-events-v1'||content.offTargetCoverage!=='all-outside-response-set'||content.auditInputs?.length!==4||content.auditPlans?.length!==4||content.independentOperators!==false||!Array.isArray(content.searchSeeds)||content.searchSeeds.length!==2||content.searchSeeds.some(s=>!/^[a-f0-9]{16}$/.test(s))||new Set(content.searchSeeds).size!==2||hex(contentRoot(content))!==hex(spec.content))throw new Error('Frozen scientific content');
  await validateGoal(content.goal);
  if(hex(computationContext(content.goal))!==hex(spec.computationContext)||hex(contentRoot({goal:content.goal,coverage:content.offTargetCoverage,evaluator:'complete-selective-v5'}))!==hex(spec.analysis))throw new Error('Computation/analysis context');
  content.auditInputs.forEach((input,i)=>{validateInput(content.goal,input);const plan=content.auditPlans[i];if(hex(inputIdentity(input))!==hex(spec.auditInputs[i])||plan.kind!==(i<2?'new-background-reproduction':'registered-input-stress')||typeof plan.hypothesis!=='string'||!plan.hypothesis.length||!/^[a-f0-9]{64}$/.test(plan.referenceEvidence))throw new Error('Frozen audit assignment/provenance');});
  return content;
}
export async function scientificTrialTask(r,address,content,input,role,assignment,index,{training=false}={}){
  await validateScientificContent(content,r.specification);validateInput(content.goal,input);
  if((!training&&!r.challenge.some(x=>x!==0))||index<0||index>=(training?2:r.specification.backgrounds))throw new Error('Challenge/background missing');
  const seeds=training?content.searchSeeds:backgroundSeeds(r,role,assignment),computation=training?hex(contentRoot({context:hex(r.specification.computationContext),input,seeds,scope:'unrewarded-training-v5'})):hex(computationIdentity(r,role,assignment,inputIdentity(input))),trialId=await hashBytes(canonical({computation,index,seed:seeds[index]}));
  return {protocolVersion:5,training,roundId:address,goalId:hex(r.specification.analysis),candidateId:computation,trialId,taskId:trialId,bodyId:input.stimulatedBodyId,targetIndex:validateInput(content.goal,input),repeatIndex:index,k:0,seed:BigInt('0x'+seeds[index]),seedHex:seeds[index],role,assignment,input,stimulus:{start_step:input.startStep,end_step:input.endStep,current:input.current}};
}
