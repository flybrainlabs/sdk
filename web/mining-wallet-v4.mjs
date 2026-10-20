// A user-owned mining wallet. Only an authenticated ciphertext is persisted.
import {generateMnemonic,validateMnemonic,mnemonicToSeedSync} from '@scure/bip39';
import {wordlist} from '@scure/bip39/wordlists/english';
import {hmac} from '@noble/hashes/hmac';
import {sha512} from '@noble/hashes/sha512';
import {ed25519} from '@noble/curves/ed25519';
import {Keypair,PublicKey,Transaction} from '@solana/web3.js';
import {Buffer} from 'buffer';

export const MINING_WALLET_PATH="m/44'/501'/0'/0'";
const schema='flybrainlabs-mining-wallet-v1',iterations=310000;
const fail=code=>Object.assign(new Error(code),{code});
const bytes=s=>new TextEncoder().encode(s),b64=b=>Buffer.from(b).toString('base64');
const normalize=s=>String(s).normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
export function newMiningMnemonic(){return generateMnemonic(wordlist,128);}
export function checkedMiningMnemonic(value){const s=normalize(value);if(![12,24].includes(s.split(' ').length)||!validateMnemonic(s,wordlist))throw fail('MINING_WALLET_PHRASE');return s;}

export function miningKeypair(value){
  // SLIP-0010 hardened Ed25519 derivation; the password encrypts storage only.
  const seed=mnemonicToSeedSync(checkedMiningMnemonic(value));let node;
  try{
    node=hmac(sha512,bytes('ed25519 seed'),seed);
    for(const index of [44,501,0,0]){
      const input=new Uint8Array(37);input.set(node.subarray(0,32),1);new DataView(input.buffer).setUint32(33,index+0x80000000,false);
      const next=hmac(sha512,node.subarray(32),input);node.fill(0);input.fill(0);node=next;
    }
    return Keypair.fromSeed(node.subarray(0,32));
  }finally{seed.fill(0);node?.fill(0);}
}

export function miningWalletStore(){
  async function access(mode,fn){
    const db=await new Promise((ok,no)=>{const r=indexedDB.open(schema,1);r.onupgradeneeded=()=>{r.result.createObjectStore('vaults');r.result.createObjectStore('settings');};r.onsuccess=()=>ok(r.result);r.onerror=()=>no(fail('MINING_WALLET_STORAGE'));});
    try{return await new Promise((ok,no)=>{const tx=db.transaction(['vaults','settings'],mode);let result;fn(tx,v=>result=v);tx.oncomplete=()=>ok(result);tx.onerror=()=>no(fail('MINING_WALLET_STORAGE'));tx.onabort=()=>no(fail('MINING_WALLET_STORAGE'));});}finally{db.close();}
  }
  return {
    async load(){return access('readonly',(tx,done)=>{const r=tx.objectStore('settings').get('active');r.onsuccess=()=>{if(!r.result){done(null);return;}const v=tx.objectStore('vaults').get(r.result);v.onsuccess=()=>done(v.result||null);};});},
    async save(record){return access('readwrite',tx=>{tx.objectStore('vaults').put(record,record.address);tx.objectStore('settings').put(record.address,'active');});}
  };
}

async function passwordKey(password,salt){
  if(typeof password!=='string'||password.length<12||password.length>1024)throw fail('MINING_WALLET_PASSWORD_LENGTH');
  const material=bytes(password);
  try{const key=await crypto.subtle.importKey('raw',material,'PBKDF2',false,['deriveKey']);return await crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations},key,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);}finally{material.fill(0);}
}
function recordBytes(record){
  if(record?.schema!==schema||record.path!==MINING_WALLET_PATH||record.iterations!==iterations||typeof record.ciphertext!=='string'||record.ciphertext.length>4096)throw fail('MINING_WALLET_STORAGE');
  try{new PublicKey(record.address);const salt=Uint8Array.from(Buffer.from(record.salt,'base64')),iv=Uint8Array.from(Buffer.from(record.iv,'base64')),ciphertext=Uint8Array.from(Buffer.from(record.ciphertext,'base64'));if(salt.length!==16||iv.length!==12||ciphertext.length<32)throw new Error();return {salt,iv,ciphertext,aad:bytes(schema+'|'+record.address+'|'+record.path)};}catch{throw fail('MINING_WALLET_STORAGE');}
}
export class MiningWalletV4 extends EventTarget {
  #keypair=null;#record=null;#provider=null;
  constructor({deployment,store=miningWalletStore(),origin=globalThis.location?.origin||'https://flybrain.work'}){super();if(!['devnet','localnet'].includes(deployment.cluster))throw fail('MINING_WALLET_NETWORK');Object.assign(this,{deployment,store,origin,generation:0,policy:null});}
  get address(){return this.#record?.address||null;}
  get unlocked(){return !!this.#keypair;}
  get exists(){return !!this.#record;}
  toJSON(){return {exists:this.exists,address:this.address,unlocked:this.unlocked,path:MINING_WALLET_PATH};}
  changed(){this.dispatchEvent(new Event('change'));}
  async initialize(){const record=await this.store.load();if(record)recordBytes(record);this.#record=record;this.changed();return this;}
  assertUnlocked(){if(!this.#keypair)throw fail('MINING_WALLET_LOCKED');}
  async save(value,password,{confirmed=false,indices=[],answers=[],restored=false}={}){
    const phrase=checkedMiningMnemonic(value),words=phrase.split(' ');
    if(!confirmed||!restored&&(indices.length!==3||new Set(indices).size!==3||indices.some((n,i)=>!Number.isInteger(n)||n<0||n>=words.length||normalize(answers[i]||'')!==words[n])))throw fail('MINING_WALLET_BACKUP');
    const pair=miningKeypair(phrase),address=pair.publicKey.toBase58(),salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
    const record={schema,address,path:MINING_WALLET_PATH,iterations,salt:b64(salt),iv:b64(iv)},aad=bytes(schema+'|'+address+'|'+MINING_WALLET_PATH),plain=bytes(phrase);
    try{const key=await passwordKey(password,salt);record.ciphertext=b64(new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},key,plain)));await this.store.save(record);this.lock();this.#record=record;this.#keypair=pair;this.#provider=null;this.changed();return address;}catch(error){pair.secretKey.fill(0);throw error;}finally{plain.fill(0);}
  }
  async unlock(password){
    const generation=this.generation,record=this.#record;if(!record)throw fail('MINING_WALLET_STORAGE');const {salt,iv,ciphertext,aad}=recordBytes(record);let plain,pair;
    try{const key=await passwordKey(password,salt);plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad},key,ciphertext));pair=miningKeypair(new TextDecoder().decode(plain));if(pair.publicKey.toBase58()!==record.address)throw fail('MINING_WALLET_STORAGE');if(generation!==this.generation)throw fail('MINING_WALLET_LOCKED');this.#keypair=pair;this.#provider=null;this.changed();return this.address;}catch(error){pair?.secretKey.fill(0);throw fail(error.code==='MINING_WALLET_PASSWORD_LENGTH'?error.code:'MINING_WALLET_UNLOCK');}finally{plain?.fill(0);}
  }
  lock(){this.generation++;this.policy?.revoke();this.#keypair?.secretKey.fill(0);this.#keypair=null;this.#provider=null;this.changed();}
  provider(){
    this.assertUnlocked();if(this.#provider)return this.#provider;
    const account={address:this.address,publicKey:this.#keypair.publicKey.toBytes(),chains:['solana:'+this.deployment.cluster],features:['solana:signMessage','solana:signTransaction']};
    const providerGeneration=this.generation,guard=()=>{this.assertUnlocked();if(providerGeneration!==this.generation||this.address!==account.address)throw fail('MINING_WALLET_CHANGED');};
    this.#provider={version:'1.0.0',name:'flybrainwork Mining Wallet',icon:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',chains:account.chains,accounts:[account],features:{
      'standard:connect':{version:'1.0.0',connect:async()=>{guard();return {accounts:[account]};}},
      'standard:events':{version:'1.0.0',on:()=>()=>{}},
      'solana:signMessage':{version:'1.0.0',signMessage:async({account:requested,message})=>{
        guard();if(requested.address!==account.address)throw fail('MINING_WALLET_CHANGED');
        if(new TextDecoder().decode(message).startsWith('{')){if(!this.policy?.checkUploadMessage)throw fail('MINING_WALLET_CHALLENGE');await this.policy.checkUploadMessage(message);guard();}else this.checkChallenge(message);
        return [{signedMessage:message,signature:ed25519.sign(message,this.#keypair.secretKey.subarray(0,32))}];
      }},
      'solana:signTransaction':{version:'1.0.0',signTransaction:async({account:requested,chain,transaction})=>{
        guard();if(requested.address!==account.address||chain!=='solana:'+this.deployment.cluster)throw fail('MINING_WALLET_NETWORK');const generation=this.generation;
        const tx=Transaction.from(Buffer.from(transaction));await this.policy?.check(tx);guard();if(!this.policy||generation!==this.generation)throw fail('MINING_WALLET_APPROVAL');
        tx.partialSign(this.#keypair);await this.policy.reserve(tx);guard();if(generation!==this.generation)throw fail('MINING_WALLET_LOCKED');return [{signedTransaction:tx.serialize()}];
      }},
      'flybrainlabs:miningWallet':{version:'1.0.0',assertAuthorized:()=>{guard();this.policy?.assertAuthorized();if(!this.policy)throw fail('MINING_WALLET_APPROVAL');},reserveTransaction:async raw=>{guard();if(!this.policy)throw fail('MINING_WALLET_APPROVAL');return this.policy.reserve(Transaction.from(Buffer.from(raw)));}}
    }};return this.#provider;
  }
  checkChallenge(message){
    const lines=new TextDecoder().decode(message).split('\n'),field=(i,name)=>lines[i]?.startsWith(name+': ')?lines[i].slice(name.length+2):null,now=Date.now();
    if(lines.length!==15||lines[0]!==new URL(this.origin).host+' wants you to sign in with your Solana account:'||lines[1]!==this.address||lines[2]!==''||lines[3]!==`Sign in to flybrainlabs on Solana ${this.deployment.cluster==='devnet'?'Devnet':'localnet'}. This does not authorize transfers.`||lines[4]!==''||field(5,'URI')!==this.origin+'/'||field(6,'Version')!=='1'||field(7,'Chain ID')!=='solana:'+this.deployment.cluster||!/^[a-f0-9]{40}$/.test(field(8,'Nonce')||'')||field(11,'Request ID')!==field(8,'Nonce')||lines[12]!=='Resources:'||lines[13]!=='- urn:solana:genesis:'+this.deployment.genesisHash||lines[14]!=='- urn:flybrainlabs:program:'+this.deployment.programId)throw fail('MINING_WALLET_CHALLENGE');
    const issued=Date.parse(field(9,'Issued At')),expires=Date.parse(field(10,'Expiration Time'));if(!Number.isFinite(issued)||!Number.isFinite(expires)||issued>now+30000||issued<now-330000||expires<=now||expires>now+330000)throw fail('MINING_WALLET_CHALLENGE');
  }
}
