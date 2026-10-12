// Pure Borsh codec. All money, seeds, slots and u64 identities are BigInt.
import { sha256 } from '@noble/hashes/sha256';
export const concat = parts => { const b=new Uint8Array(parts.reduce((n,a)=>n+a.length,0)); let k=0; for(const a of parts){b.set(a,k);k+=a.length;} return b; };
export const text = s => new TextEncoder().encode(s);
export const fromHex = h => { if(!/^[a-f0-9]{64}$/.test(h)) throw new Error('Expected SHA-256 hex'); return Uint8Array.from(h.match(/../g),x=>parseInt(x,16)); };
export const hex = b => Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
export const hash = (...parts) => sha256(concat(parts));
const key = v => v?.toBytes ? v.toBytes() : typeof v==='string'?fromHex(v):Uint8Array.from(v);
export class Writer {
  constructor(){this.parts=[];} bytes(v){this.parts.push(Uint8Array.from(v));return this;}
  key(v){const b=key(v);if(b.length!==32)throw new Error('Pubkey/hash width');return this.bytes(b);}
  num(v,n,signed=false){if(typeof v==='number'&&!Number.isSafeInteger(v))throw new Error('Use BigInt for inexact integers');const x=BigInt(v), min=signed?-(1n<<BigInt(8*n-1)):0n,max=signed?(1n<<BigInt(8*n-1))-1n:(1n<<BigInt(8*n))-1n;if(x<min||x>max)throw new Error('Integer range');const b=new Uint8Array(n);let y=x;for(let i=0;i<n;i++){b[i]=Number(y&255n);y>>=8n;}return this.bytes(b);}
  u8(v){return this.num(v,1);} u16(v){return this.num(v,2);} u32(v){return this.num(v,4);} u64(v){return this.num(v,8);} i64(v){return this.num(v,8,true);} i32(v){return this.num(v,4,true);}
  vec(v,fn){this.u32(v.length);for(const x of v)fn(this,x);return this;} result(){return concat(this.parts);}
}
export class Reader {
  constructor(b){this.b=b;this.p=0;} bytes(n){if(this.p+n>this.b.length)throw new Error('Truncated Borsh');const v=this.b.slice(this.p,this.p+n);this.p+=n;return v;}
  num(n,s=false){const b=this.bytes(n);let v=0n;for(let i=n-1;i>=0;i--)v=(v<<8n)|BigInt(b[i]);if(s && b[n-1]&128)v-=1n<<BigInt(n*8);return n<=4?Number(v):v;}
  u8(){return this.num(1);} u32(){return this.num(4);} u64(){return this.num(8);} i64(){return this.num(8,true);} key(){return this.bytes(32);}
  vec(fn,max=6144){const n=this.u32();if(n>max)throw new Error('Borsh vector bound');return Array.from({length:n},()=>fn(this));}
}
export function encodeCampaign(w,c){
  for(const n of ['campaign_id','source_root','registry_root','graph_root','model_root','experiment_root','public_seed'])w.key(c[n]);
  w.u32(c.model_neuron_count).u32(c.simulation_steps).u32(c.time_step_us);
  w.vec(c.targets,(o,t)=>o.u64(t.body_id).u32(t.model_index));
  w.vec(c.stimuli,(o,s)=>o.u32(s.start_step).u32(s.end_step).i64(s.current));w.u32(c.repeats);
}
export function encodeRules(r){
  const w=new Writer();encodeCampaign(w,r.catalog);
  for(const n of ['manifest_root','readout_root','genesis'])w.key(r[n]);for(const v of r.verifiers)w.key(v);
  for(const n of ['developer','community','mint'])w.key(r[n]);w.u8(r.roi_count);
  for(const n of ['readout_schema_id','verifier_policy_id','simulation_config_id','observe_start'])w.u32(r[n]);
  for(const n of ['submit_deadline','reveal_ttl','verify_ttl','archive_ttl'])w.i64(r[n]);
  for(const n of ['min_reveal_slots','advance','queue_fee','verify_fee','rejection_slash'])w.u64(r[n]);
  w.i64(r.archive_retention_seconds);for(const n of ['miner_pool_whole','validator_pool_whole','community_pool_whole'])w.u64(r[n]);return w.u8(r.network).result();
}
export function decodeRules(b){
  const v=new Reader(b),c={};for(const n of ['campaign_id','source_root','registry_root','graph_root','model_root','experiment_root','public_seed'])c[n]=v.key();
  for(const n of ['model_neuron_count','simulation_steps','time_step_us'])c[n]=v.u32();c.targets=v.vec(r=>({body_id:r.u64(),model_index:r.u32()}),16);c.stimuli=v.vec(r=>({start_step:r.u32(),end_step:r.u32(),current:r.i64()}),64);c.repeats=v.u32();
  const r={catalog:c};for(const n of ['manifest_root','readout_root','genesis'])r[n]=v.key();r.verifiers=Array.from({length:3},()=>v.key());for(const n of ['developer','community','mint'])r[n]=v.key();r.roi_count=v.u8();
  for(const n of ['readout_schema_id','verifier_policy_id','simulation_config_id','observe_start'])r[n]=v.u32();for(const n of ['submit_deadline','reveal_ttl','verify_ttl','archive_ttl'])r[n]=v.i64();for(const n of ['min_reveal_slots','advance','queue_fee','verify_fee','rejection_slash'])r[n]=v.u64();r.archive_retention_seconds=v.i64();for(const n of ['miner_pool_whole','validator_pool_whole','community_pool_whole'])r[n]=v.u64();r.network=v.u8();if(v.p!==b.length)throw new Error('Rules trailing bytes');return r;
}
export function taskBytes(t){return new Writer().u64(t.k).u64(t.bodyId).u32(t.targetIndex).u32(t.stimulusIndex).u32(t.repeatIndex).u32(t.stimulus.start_step).u32(t.stimulus.end_step).i64(t.stimulus.current).key(t.taskId).u64(t.seed).result();}
export function leaf(t){return hash(text('FlyPoW/task-leaf/v1\0'),new Writer().u64(t.k).key(t.taskId).u64(t.bodyId).u32(t.targetIndex).u32(t.stimulusIndex).u32(t.repeatIndex).u32(t.stimulus.start_step).u32(t.stimulus.end_step).i64(t.stimulus.current).u64(t.seed).result());}
export function merkle(tasks){
  if(!tasks.length)throw new Error('Empty task catalog');const levels=[tasks.map(leaf)];
  while(levels.at(-1).length>1){const a=levels.at(-1),b=[];for(let i=0;i<a.length;i+=2)b.push(hash(text('FlyPoW/task-node/v1\0'),a[i],a[i+1]||a[i]));levels.push(b);}
  return {root:hash(text('FlyPoW/task-root/v1\0'),new Writer().u64(tasks.length).result(),levels.at(-1)[0]),proof(k){if(k<0||k>=tasks.length)throw new Error('Proof index');let i=k;return levels.slice(0,-1).map(a=>{const v=a[i^1]||a[i];i=Math.floor(i/2);return v;});}};
}
export function commitHash(program,r,campaign,task,miner,beneficiary,result,salt){return hash(text('FlyPoW/commit/v1\0'),key(r.genesis),key(program),key(campaign),key(task),key(miner),key(beneficiary),key(result),key(salt));}
export function verifyMessage(program,campaign,submission,r,s,accept){
  const w=new Writer().bytes(text('FlyPoW/verify-archive/v1\0'));
  for(const k of [r.genesis,program,campaign,submission,s.hashes.taskId,s.identity.miner,s.identity.rewardBeneficiary,r.catalog.source_root,r.catalog.registry_root,r.catalog.graph_root,r.catalog.model_root,r.catalog.experiment_root,r.manifest_root,r.readout_root,s.hashes.resultRoot,s.hashes.previewRoot,s.hashes.archiveManifestHash,s.hashes.summaryHash])w.key(k);
  return w.u8(accept?1:0).u32(r.verifier_policy_id).i64(s.lifecycle.verifyDeadlineTs).i64(r.archive_retention_seconds).result();
}
export function encodeReveal(x){const w=new Writer().key(x.resultRoot).key(x.previewRoot).key(x.archiveRoot).key(x.salt);for(const v of x.global)w.u64(v);for(const v of x.roi)w.i64(v);for(const v of x.time)w.i32(v);for(const t of x.top)w.u64(t.bodyId).i32(t.delta).u32(t.firstStep);return w.u8(x.topCount).result();}
export function accountReader(raw,name){const d=hash(text('account:'+name)).slice(0,8);if(!raw || raw.length<8 || !d.every((b,i)=>raw[i]===b))throw new Error('Invalid '+name+' discriminator');return new Reader(raw.slice(8));}
export function decodeCampaign(raw){const v=accountReader(raw,'CampaignConfig');const o={authority:v.key(),state:v.u8(),sealed:v.u32(),initialized:v.u32(),tge:!!v.u8(),communityClaimed:v.u64()};o.rules=decodeRules(v.bytes(v.u32()));return o;}
export function isAccount(raw,name){const d=hash(text('account:'+name)).slice(0,8);return raw?.length>=8 && d.every((b,i)=>raw[i]===b);}
export function decodePage(raw){
  const v=accountReader(raw,'ResultPage');
  const p={campaign:v.key(),taskId:v.key(),k:v.u64(),nextSeq:v.u32(),complete:!!v.u8(),archived:!!v.u8(),winner:v.key(),resultRoot:v.key(),previewRoot:v.key(),archiveRoot:v.key(),summaryHash:v.key()};
  p.queue=Array.from({length:8},()=>({submission:v.key(),seq:v.u32(),status:v.u8(),revealDeadline:v.i64(),verifyDeadline:v.i64()}));
  if(v.p!==v.b.length)throw new Error('ResultPage trailing bytes');return p;
}
export function decodeEpoch(raw){
  const v=accountReader(raw,'NeuronEpoch');const e={campaign:v.key(),bodyId:v.u64(),targetIndex:v.u32(),firstK:v.u64(),taskCount:v.u32(),initialized:v.u32(),completed:v.u32(),archived:v.u32(),sealed:!!v.u8()};
  e.bits=v.bytes(v.u32());if(v.p!==v.b.length)throw new Error('NeuronEpoch trailing bytes');return e;
}
export function decodeEntitlement(raw){
  const v=accountReader(raw,'MinerEntitlement');
  const e={campaign:v.key(),submission:v.key(),miner:v.key(),payer:v.key(),taskId:v.key(),k:v.u64(),beneficiary:v.key(),refundRecipient:v.key(),bodyId:v.u64(),closed:!!v.u8(),accepted:!!v.u8(),refundPaid:!!v.u8(),principalReleased:!!v.u8(),principal:v.u64(),advance:v.u64(),minerWhole:v.u64()};
  e.validatorWhole=Array.from({length:3},()=>v.u64());e.minerClaimed=v.u64();e.validatorClaimed=Array.from({length:3},()=>v.u64());
  if(v.p!==v.b.length)throw new Error('Entitlement trailing bytes');return e;
}
export const wholeAllocation=(k,m,p)=>{k=BigInt(k);m=BigInt(m);p=BigInt(p);if(m<=0n||k<0n||k>=m||p<0n)throw new Error('Allocation index');return (k+1n)*p/m-k*p/m;};
