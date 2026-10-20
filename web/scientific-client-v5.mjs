import {PublicKey,TransactionInstruction,SystemProgram,SYSVAR_INSTRUCTIONS_PUBKEY,SYSVAR_SLOT_HASHES_PUBKEY} from '@solana/web3.js';
import {addresses as economicAddresses,meta} from '../tools/economy_v2_client.mjs';
import {operationData,text,hex,decodeRound,decodeClaim,validateScientificContent} from './scientific-round-v5.mjs';
import {capability} from './factory-worker-reader-v4.mjs';
export * from './scientific-round-v5.mjs';
export {meta};
export const pk=v=>new PublicKey(v);
export function addresses(program){const p=pk(program),pda=(...s)=>PublicKey.findProgramAddressSync(s.map(x=>Buffer.from(x)),p)[0];return {...economicAddresses(p),round:id=>pda(text('science-round-v5'),id),claim:(round,miner,commitment)=>pda(text('science-claim-v5'),pk(round).toBytes(),pk(miner).toBytes(),commitment),computation:id=>pda(text('science-compute-v5'),id)};}
export const instruction=(program,keys,tag,v={})=>new TransactionInstruction({programId:pk(program),keys,data:Buffer.from(operationData(tag,v))});
export const system=()=>meta(SystemProgram.programId),instructionSysvar=()=>meta(SYSVAR_INSTRUCTIONS_PUBKEY),slotHashes=()=>meta(SYSVAR_SLOT_HASHES_PUBKEY);
export class ScientificReaderV5 {
  constructor(connection,deployment){
    if(!connection||deployment.schema!=='flybrain-scientific-deployment-v5'||!deployment.enabled||!['localnet','devnet'].includes(deployment.cluster)||!deployment.genesisHash||!deployment.policyHash)throw new Error('Scientific deployment/RPC unavailable');
    this.connection=connection;this.deployment=deployment;this.program=pk(deployment.programId);this.a=addresses(this.program);
  }
  async account(address,decode){const a=await this.connection.getAccountInfo(pk(address),'finalized');if(!a?.owner.equals(this.program))throw new Error('Scientific account owner');return decode(a.data);}
  async round(address){
    if(await this.connection.getGenesisHash()!==this.deployment.genesisHash)throw new Error('Scientific chain genesis');
    const r=await this.account(address,decodeRound);
    if(!this.a.round(r.specification.id).equals(pk(address))||!pk(r.genesis).equals(pk(this.deployment.genesisHash))||!pk(r.mint).equals(pk(this.deployment.mint))||hex(r.policy)!==this.deployment.policyHash)throw new Error('Scientific frozen chain binding');return r;
  }
  async claim(address,round){const c=await this.account(address,decodeClaim);if(!pk(c.round).equals(pk(round))||!this.a.claim(round,c.miner,c.commitment).equals(pk(address)))throw new Error('Scientific claim binding');return c;}
  async content(round,store){const bytes=await store.get(hex(round.specification.content),1024*1024);const content=JSON.parse(new TextDecoder().decode(bytes));return validateScientificContent(content,round.specification);}
}
export async function verifyScientificWorkerRound(deployment,value,port){
  const c=capability(port);
  try{if(!deployment.rounds?.includes(value.roundAddress))throw new Error('Scientific round is not published');const reader=new ScientificReaderV5(c.connection,deployment),r=await reader.round(value.roundAddress),content=await validateScientificContent(value.content,r.specification);return {roundAddress:value.roundAddress,scienceRound:r,content,goal:content.goal};}finally{c.close();}
}
export class ScientificClientV5 {
  constructor({connection,deployment,send,contentStore,wallet}){Object.assign(this,{connection,deployment,send,contentStore,wallet});this.reader=new ScientificReaderV5(connection,deployment);}
  async commit(address,{commitment,beneficiary,role,assignment}){const claim=this.reader.a.claim(address,this.wallet.publicKey,commitment);await this.send([instruction(this.reader.program,[meta(address,true),meta(claim,true),meta(this.wallet.publicKey,true,true),system()],1,{commitment,beneficiary,role,assignment})],{intent:'scientific-commit-v5',replacementSafe:false});return claim;}
  async challenge(address){return this.send([instruction(this.reader.program,[meta(address,true),slotHashes()],2)],{intent:'scientific-challenge-v5',replacementSafe:true});}
  async reveal(address,claim,value){return this.send([instruction(this.reader.program,[meta(address),meta(claim,true),meta(this.wallet.publicKey,false,true)],3,value)],{intent:'scientific-reveal-v5',replacementSafe:false});}
  async resolve(address,claim){const c=await this.reader.claim(claim,address);return this.send([instruction(this.reader.program,[meta(address,true),meta(claim,true),meta(this.reader.a.computation(c.computation),true),meta(this.wallet.publicKey,true,true),system()],5)],{intent:'scientific-resolve-v5',replacementSafe:true});}
  async pay(address,claim,destination,tokenProgram){return this.send([instruction(this.reader.program,[meta(this.reader.a.global),meta(address,true),meta(claim,true),meta(this.reader.a.pool(0),true),meta(destination,true),meta(tokenProgram)],6)],{intent:'scientific-pay-v5',replacementSafe:true});}
}
