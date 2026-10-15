// Dependency-free V4 descriptor wire layout for browser Workers and durable metadata.
export const concat = parts => { const b=new Uint8Array(parts.reduce((n,a)=>n+a.length,0)); let k=0; for(const a of parts){b.set(a,k);k+=a.length;} return b; };
export const text = s => new TextEncoder().encode(s);
export const fromHex = h => { if(!/^[a-f0-9]{64}$/.test(h)) throw new Error('Expected SHA-256 hex'); return Uint8Array.from(h.match(/../g),x=>parseInt(x,16)); };
export const hex = b => Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
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
const fields=['scientificIdentity','goal','content','model','graph','parameters','calibration','inputDomain'];
export function encodeDescriptor(d,w=new Writer()){
  for(const k of fields)w.key(d[k]);
  return w.u64(d.rewardAtoms).u32(d.claimSeconds).u32(d.revealSeconds).u32(d.verifySeconds).u8(d.maxAttempts).vec(d.seeds,(w,s)=>w.u64(s));
}
export function decodeDescriptor(r){const d={};for(const k of fields)d[k]=r.key();for(const k of ['rewardAtoms'])d[k]=r.u64();for(const k of ['claimSeconds','revealSeconds','verifySeconds'])d[k]=r.u32();d.maxAttempts=r.u8();d.seeds=r.vec(r=>r.u64(),16);return d;}
export function validateDescriptor(d){
  for(const k of fields){const w=new Writer().key(d[k]).result();if(w.every(b=>b===0))throw new Error('Missing descriptor root: '+k);}
  encodeDescriptor(d);
  if(['claimSeconds','revealSeconds','verifySeconds','maxAttempts'].some(k=>!Number.isSafeInteger(d[k])))throw new Error('Integer descriptor windows/attempts required');
  if(BigInt(d.rewardAtoms)<=0n||d.claimSeconds<1||d.claimSeconds>=d.revealSeconds||d.revealSeconds>=d.verifySeconds||d.verifySeconds>86400||d.maxAttempts<1||d.maxAttempts>16||![2,4,8,16].includes(d.seeds.length)||new Set(d.seeds.map(String)).size!==d.seeds.length)throw new Error('Invalid frozen descriptor');return d;
}
