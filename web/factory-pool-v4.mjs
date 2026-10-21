// An HTTP discovery response is a hint until its authority signature and every
// advertised factory have been checked against finalized personal-RPC reads.
import {ed25519} from '@noble/curves/ed25519';
import {PublicKey} from '@solana/web3.js';
import {canonical,hash} from './target-protocol-v2.mjs';
import {fromHex,hex,STATE} from './task-factory-v4-codec.mjs';
import {readerForDeployment} from './task-factory-client-v4.mjs';
const fail=code=>Object.assign(new Error(code),{code});
const equal=(a,b)=>new PublicKey(a).equals(new PublicKey(b));
const identity=['poolId','authority','genesisHash','programId','mint','policyHash','envelopeHash','anchorFactory'];
export const poolManifestMessageV4=body=>new Uint8Array([...new TextEncoder().encode('Flybrain/factory-pool/v4\0'),...canonical(body)]);
export const poolHistoryMessageV4=body=>new Uint8Array([...new TextEncoder().encode('Flybrain/factory-pool-history/v4\0'),...canonical(body)]);
export async function verifyPoolHistoryV4(document,trust,{factory,now=Math.floor(Date.now()/1000)}={}){
  if(trust?.schema!=='flybrainlabs-factory-pool-trust-v4'||await hash(canonical(trust.envelope))!==trust.envelopeHash)throw fail('POOL_TRUST_REQUIRED');
  const {signature,...body}=document||{};
  if(body.schema!=='flybrainlabs-factory-pool-history-v4'||identity.some(k=>body[k]!==trust[k])||Object.keys(body).sort().join(',')!==[...identity,'schema','issuedAt','expiresAt','catalog'].sort().join(',')||!Number.isSafeInteger(body.issuedAt)||!Number.isSafeInteger(body.expiresAt)||body.issuedAt>now+30||body.expiresAt<=now||body.expiresAt-body.issuedAt>86400||body.expiresAt<=body.issuedAt||typeof signature!=='string'||!/^[a-f0-9]{128}$/.test(signature))throw fail('POOL_HISTORY_SCOPE');
  if(!ed25519.verify(Uint8Array.from(signature.match(/../g),x=>parseInt(x,16)),poolHistoryMessageV4(body),new PublicKey(trust.authority).toBytes()))throw fail('POOL_HISTORY_SIGNATURE');
  const c=body.catalog;
  if(!c||c.factory!==factory||Object.keys(c).sort().join(',')!=='budgetAtoms,catalogRoot,deadline,factory,factoryId,taskCount'||!Number.isInteger(c.taskCount)||c.taskCount<1||c.taskCount>4096||!/^[1-9][0-9]{0,19}$/.test(c.budgetAtoms)||BigInt(c.budgetAtoms)>0xffffffffffffffffn||!/^\d{1,19}$/.test(c.deadline))throw fail('POOL_HISTORY_CATALOG');
  new PublicKey(c.factory);fromHex(c.factoryId);fromHex(c.catalogRoot);return {body,catalog:c,hash:await hash(canonical(document))};
}
export async function verifyPoolManifestV4(document,trust,{now=Math.floor(Date.now()/1000),previous=null,history=false}={}){
  if(trust?.schema!=='flybrainlabs-factory-pool-trust-v4'||await hash(canonical(trust.envelope))!==trust.envelopeHash)throw fail('POOL_TRUST_REQUIRED');
  const {signature,...body}=document||{};
  if(body.schema!=='flybrainlabs-factory-pool-manifest-v4'||identity.some(k=>body[k]!==trust[k])||!Number.isSafeInteger(body.revision)||body.revision<1||!Number.isSafeInteger(body.issuedAt)||!Number.isSafeInteger(body.expiresAt)||body.expiresAt<=body.issuedAt||body.expiresAt-body.issuedAt>86400||body.issuedAt>now+30||!history&&body.expiresAt<=now||!Array.isArray(body.catalogs)||body.catalogs.length<1||body.catalogs.length>128||typeof signature!=='string'||!/^[a-f0-9]{128}$/.test(signature))throw fail('POOL_MANIFEST_SCOPE');
  if(Object.keys(body).sort().join(',')!==[...identity,'schema','revision','issuedAt','expiresAt','catalogs'].sort().join(','))throw fail('POOL_MANIFEST_FIELDS');
  if(!ed25519.verify(Uint8Array.from(signature.match(/../g),x=>parseInt(x,16)),poolManifestMessageV4(body),new PublicKey(trust.authority).toBytes()))throw fail('POOL_MANIFEST_SIGNATURE');
  const digest=await hash(canonical(document));
  if(previous&&(body.revision<previous.revision||body.revision===previous.revision&&digest!==previous.hash))throw fail('POOL_MANIFEST_ROLLBACK');
  const seen=new Set();
  for(const c of body.catalogs){
    if(Object.keys(c).sort().join(',')!=='budgetAtoms,catalogRoot,deadline,factory,factoryId,taskCount'||seen.has(c.factory)||!Number.isInteger(c.taskCount)||c.taskCount<1||c.taskCount>4096||!/^[1-9][0-9]{0,19}$/.test(c.budgetAtoms)||BigInt(c.budgetAtoms)>0xffffffffffffffffn||!/^\d{1,19}$/.test(c.deadline))throw fail('POOL_CATALOG_BOUNDS');
    new PublicKey(c.factory);fromHex(c.factoryId);fromHex(c.catalogRoot);seen.add(c.factory);
  }
  return {body,hash:digest,revision:body.revision};
}
export function poolDeploymentV4(base,catalog,trust){
  if(['genesisHash','programId','mint','policyHash'].some(k=>base[k]!==trust[k]))throw fail('POOL_DEPLOYMENT_SCOPE');
  return {...base,...catalog,taskPool:base.taskPool,poolFactory:catalog.factory};
}
export async function verifyPoolCatalogV4(deployment,trust,connection){
  if(['genesisHash','programId','mint','policyHash'].some(k=>deployment[k]!==trust[k]))throw fail('POOL_CATALOG_IDENTITY');
  const reader=readerForDeployment(deployment,connection),f=await reader.factory();
  if(!equal(f.authority,trust.authority)||!equal(f.mint,trust.mint)||hex(f.policy)!==trust.policyHash||f.uploaded!==f.count||f.count!==deployment.taskCount||String(f.budget)!==deployment.budgetAtoms||String(f.deadline)!==deployment.deadline||f.state===STATE.DRAFT)throw fail('POOL_CATALOG_IDENTITY');return {reader,factory:f};
}
export function verifyPoolGoalV4(goal,trust){
  const e=trust.envelope;
  for(const k of ['graphRoot','modelRoot','parameterProfileHash','inputDomainHash','evaluatorVersion','steps','timeStepUs'])if(goal[k]!==e[k])throw fail('POOL_SCIENCE_ENVELOPE');
  if(!Number.isSafeInteger(e.maxCandidateBytes)||goal.maxCandidateBytes>e.maxCandidateBytes||goal.maxStimulusCost>e.maxStimulusCost)throw fail('POOL_SCIENCE_ENVELOPE');
}
export function selectPoolContextV4(contexts,current,{minimumSeconds=1,exhaustedRounds=new Set(),pendingRounds=new Set()}={}){
  const available=c=>!c.historyOnly&&c.client.online&&c.client.round&&Number.isFinite(c.client.serverNow)&&!exhaustedRounds.has(c.client.round.roundId)&&!pendingRounds.has(c.client.round.roundId)&&c.client.serverNow+minimumSeconds<c.client.round.pre.claimDeadline;
  if(current&&available(current))return current;
  return [...contexts].filter(available).sort((a,b)=>a.client.round.pre.claimDeadline-b.client.round.pre.claimDeadline||a.deployment.factory.localeCompare(b.deployment.factory))[0]||null;
}

// The caller commits reader, signer policy, store, submission handler and Worker
// capability together. All preparation happens before this synchronous commit.
export class FactoryPoolSwitchV4 {
  constructor({runner,prepare,commit,canSwitch=()=>true,contextSafe=false}){Object.assign(this,{runner,prepare,commit,canSwitch,contextSafe});this.pending=null;}
  switchTo(context){
    if(this.pending)return this.pending;
    const generation=this.runner.generation;
    this.pending=(async()=>{
      if(!this.contextSafe&&this.runner.active.length||!this.canSwitch())return false;
      await this.prepare(context);
      if(!this.contextSafe&&this.runner.active.length||generation!==this.runner.generation||!this.canSwitch())return false;
      await this.commit(context);return true;
    })().finally(()=>this.pending=null);return this.pending;
  }
}
