import {id,root} from './target-protocol-v2.mjs';
function base58Width(text){const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';if(typeof text!=='string'||!text||text.length>90)return null;let n=0n;for(const c of text){const d=alphabet.indexOf(c);if(d<0)return null;n=n*58n+BigInt(d);}let bytes=0;while(n){bytes++;n>>=8n;}return bytes+(text.match(/^1*/)[0].length);}
export function validateEvidenceManifest(v){
 const allowed=['schema','kind','genesisHash','programId','policyHash','economicTaskId','unitId','contributionId','acceptanceId','goalId','roundId','claimId','readoutId','modelRoot','graphRoot','parameterProfileHash','evaluatorVersion','judgement','authorizationId','publicEvidence','privateCommitments'];
 if(v.schema!=='flybrain-evidence-manifest-v1'||Object.keys(v).some(k=>!allowed.includes(k)))throw new Error('EvidenceManifest schema/whitelist');
 if(!['discovery','coverage','verification','readout','community'].includes(v.kind))throw new Error('Evidence kind');
 for(const k of ['genesisHash','programId','evaluatorVersion'])if(typeof v[k]!=='string'||!v[k]||v[k].length>128)throw new Error('Evidence field '+k);
 for(const k of ['genesisHash','programId'])if(base58Width(v[k])!==32)throw new Error('Chain identity base58 width');
 for(const k of ['policyHash','economicTaskId','unitId','contributionId','authorizationId'])root(v[k]);
 if(v.kind==='discovery'&&v.unitId!=='0'.repeat(64))throw new Error('Discovery singleton unit');
 if(['discovery','coverage','readout'].includes(v.kind))for(const k of ['acceptanceId','goalId','readoutId','modelRoot','graphRoot','parameterProfileHash'])root(v[k]);
 if(v.kind==='discovery')for(const k of ['roundId','claimId'])root(v[k]);
 if(v.judgement!=='accepted'&&!(v.kind==='verification'&&v.judgement==='correct-rejection'))throw new Error('Evidence judgement');
 if(!Array.isArray(v.privateCommitments)||v.privateCommitments.length>16)throw new Error('Private commitment bound');for(const c of v.privateCommitments){if(c.schema!=='randomized-sha256-commitment-v1'||Object.keys(c).length!==2)throw new Error('Randomized private commitment required');root(c.root);}
 if(!Array.isArray(v.publicEvidence)||v.publicEvidence.length>32)throw new Error('Public evidence bound');for(const e of v.publicEvidence){if(Object.keys(e).length!==3||typeof e.kind!=='string'||typeof e.id!=='string')throw new Error('Public evidence whitelist');root(e.sha256);root(e.id);if(!['scientific-package','goal-result','authorization-statement','external-evaluation'].includes(e.kind))throw new Error('Public reference kind');}return v;
}
export async function evidenceManifestRoot(v){return id('economic-evidence-manifest-v1',validateEvidenceManifest(v));}
export function economicSlotKey(s){if(!['discovery','coverage','verification','readout','community'].includes(s.kind)||!s.genesisHash||!s.programId||!s.economicTaskId)throw new Error('EconomicSlotKey');root(s.unitId);if(s.kind==='discovery'&&s.unitId!=='0'.repeat(64))throw new Error('Discovery unit');return JSON.stringify(['Flybrain/EconomicSlotKey/v1',s.genesisHash,s.programId,s.economicTaskId,s.kind,s.unitId]);}
