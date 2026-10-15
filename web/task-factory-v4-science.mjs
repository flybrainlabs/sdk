// The complete science is approved before activation. Public fixed seeds allow
// precomputation; this version makes no claim to unpredictable randomness.
import {canonical,id,hash,validateGoal,validateInput,goalResultRoot,candidateId,trialId,root,trialTask} from './target-protocol-v2.mjs';
import {hex,validateDescriptor,fromHex,encodeDescriptor,text,concat} from './task-factory-v4-layout.mjs';
export const scientificDescriptorHash=async d=>fromHex(await hash(concat([text('Flybrain/task-descriptor/v4\0'),encodeDescriptor(d).result()])));
const rootHex=v=>typeof v==='string'?root(v):hex(v);
export async function scientificIdentity(goal){
  // Matches the existing V3 goal identity rule: descriptive/calibration labels
  // are not new science. The original frozen function is kept separate.
  const keys=['graphRoot','modelRoot','parameterProfileHash','inputDomainHash','stimulusSetRoot','responseSetRoot','offTargetSetRoot','windows','evaluatorVersion','maxStimulusCost','steps','timeStepUs'];
  return id('science-task-v1',Object.fromEntries(keys.map(k=>[k,goal[k]])));
}
export async function validateSpecification(spec,d){
  validateDescriptor(d);await validateGoal(spec.goal);
  if(spec.schema!=='flybrainlabs-scientific-task-v4'||Object.keys(spec).sort().join(',')!=='goal,schema,seeds'||!Array.isArray(spec.seeds)||spec.seeds.some(s=>! /^[a-f0-9]{16}$/.test(s))||spec.seeds.length!==d.seeds.length)throw new Error('Invalid frozen scientific task');
  if(await hash(canonical(spec))!==rootHex(d.content)||await id('goal-id',spec.goal)!==rootHex(d.goal)||await scientificIdentity(spec.goal)!==rootHex(d.scientificIdentity))throw new Error('Task content/scientific identity mismatch');
  for(const [field,key]of [['model','modelRoot'],['graph','graphRoot'],['parameters','parameterProfileHash'],['calibration','calibrationHash'],['inputDomain','inputDomainHash']])if(rootHex(d[field])!==spec.goal[key])throw new Error('Task '+field+' mismatch');
  if(spec.seeds.some((s,i)=>BigInt('0x'+s)!==BigInt(d.seeds[i])))throw new Error('Frozen seed mismatch');return spec;
}
export async function makeRound({program,genesis,factoryAddress,taskAddress,factory,task,spec}){
  await validateSpecification(spec,task.descriptor);
  const roundId=await id('contract-task-v4',{program,genesis,factory:factoryAddress,task:taskAddress,index:task.index,attempt:task.attempt,descriptorHash:hex(await scientificDescriptorHash(task.descriptor))});
  return {schema:'flybrainlabs-contract-round-v4',roundId,goal:spec.goal,seeds:spec.seeds,
    pre:{protocolVersion:4,networkId:genesis,programId:program,factoryAddress,taskAddress,taskIndex:task.index,attempt:task.attempt,
      goalId:hex(task.descriptor.goal),roundSequence:task.index+1,descriptorHash:hex(await scientificDescriptorHash(task.descriptor)),requiredBackgrounds:spec.seeds.length,
      openedAt:Number(task.openedAt),claimDeadline:Number(task.claimDeadline),revealDeadline:Number(task.revealDeadline),verificationDeadline:Number(task.verifyDeadline)},
    specification:spec,descriptor:Object.fromEntries(Object.entries(task.descriptor).map(([k,v])=>[k,v instanceof Uint8Array?hex(v):typeof v==='bigint'?String(v):k==='seeds'?v.map(String):v]))};
}
export async function factoryTrialTask(round,input,j){return {...await trialTask(round,input,j),protocolVersion:4};}
export async function validateFactoryManifest(m,r){
  await validateSpecification(r.specification,r.descriptor);
  if(m.schema!=='flybrainlabs-candidate-manifest-v4'||m.roundId!==r.roundId||m.goalId!==r.pre.goalId||m.candidateId!==await candidateId(r.roundId,m.input)||m.goalResultRoot!==await goalResultRoot(m.trials)||m.trials.length!==r.pre.requiredBackgrounds)throw new Error('Factory candidate identity/count');
  validateInput(r.goal,m.input);let total=0;
  for(let j=0;j<m.trials.length;j++){
    const t=m.trials[j];root(t.resultRoot);
    if(t.repeatIndex!==j||t.seedHex!==r.seeds[j]||t.trialId!==await trialId(r.roundId,r.goal,m.input,j,t.seedHex)||t.bytes<480||t.bytes>r.goal.maxTrialBytes||!t.metrics.passed)throw new Error('Factory trial identity/order/qualification');total+=t.bytes;
  }
  if(total>r.goal.maxCandidateBytes)throw new Error('Factory archive budget');return m;
}
export async function descriptorFor(spec,rules){
  if(!rules||Object.keys(rules).sort().join(',')!=='claimSeconds,maxAttempts,revealSeconds,rewardAtoms,verifySeconds')throw new Error('Exact frozen task rules required');
  await validateGoal(spec.goal);const g=spec.goal;
  const d={scientificIdentity:fromHex(await scientificIdentity(g)),goal:fromHex(await id('goal-id',g)),content:fromHex(await hash(canonical(spec))),model:fromHex(g.modelRoot),graph:fromHex(g.graphRoot),parameters:fromHex(g.parameterProfileHash),calibration:fromHex(g.calibrationHash),inputDomain:fromHex(g.inputDomainHash),...rules,seeds:spec.seeds.map(s=>BigInt('0x'+s))};
  await validateSpecification(spec,d);return d;
}
