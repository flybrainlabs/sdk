// Public transaction adapter. No instruction requires a configured relayer.
import {PublicKey,TransactionInstruction,SystemProgram,SYSVAR_INSTRUCTIONS_PUBKEY,Ed25519Program} from '@solana/web3.js';
import {addresses as economicAddresses,meta} from './economy_v2_client.mjs';
import {TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {Writer,text,operationData,decodeFactory,decodeTask,decodeSubmission} from '../web/task-factory-v4-codec.mjs';
export * from '../web/task-factory-v4-codec.mjs';
export {meta,TOKEN_PROGRAM_ID};
const pk=v=>new PublicKey(v),b=v=>pk(v).toBytes();
export function addresses(program){
  const p=pk(program),pda=(...seeds)=>PublicKey.findProgramAddressSync(seeds.map(s=>Buffer.from(s)),p)[0];
  return {...economicAddresses(p),factory:id=>pda(text('task-factory-v4'),id),
    task:(factory,index)=>pda(text('task-v4'),b(factory),new Writer().u32(index).result()),
    science:identity=>pda(text('task-science-v4'),identity),
    submission:(task,attempt,miner,commitment)=>pda(text('submission-v4'),b(task),new Writer().u32(attempt).result(),b(miner),commitment)};
}
export const instruction=(program,keys,tag,value={})=>new TransactionInstruction({programId:pk(program),keys,data:Buffer.from(operationData(tag,value))});
export const system=()=>meta(SystemProgram.programId);
export const instructionSysvar=()=>meta(SYSVAR_INSTRUCTIONS_PUBKEY);
export const signatureInstruction=(publicKey,message,signature)=>Ed25519Program.createInstructionWithPublicKey({publicKey:b(publicKey),message,signature});
export class FactoryReader {
  constructor(connection,program,{genesis,factoryAddress,id,catalogRoot,policy}){
    this.connection=connection;this.program=pk(program);this.a=addresses(this.program);this.expected={genesis,factoryAddress:pk(factoryAddress),id,catalogRoot,policy};
    if(!this.a.factory(id).equals(this.expected.factoryAddress))throw new Error('Factory PDA mismatch');
  }
  async account(address,decoder){const raw=await this.connection.getAccountInfo(pk(address),'finalized');if(!raw?.owner.equals(this.program))throw new Error('Factory account missing or wrong owner');return decoder(raw.data);}
  async factory(){
    if(await this.connection.getGenesisHash()!==this.expected.genesis)throw new Error('Wrong chain genesis');
    const f=await this.account(this.expected.factoryAddress,decodeFactory);
    const same=(a,b)=>Buffer.from(a).equals(Buffer.from(b));
    if(!same(f.id,this.expected.id)||!same(f.genesis,b(this.expected.genesis))||!same(f.catalogRoot,this.expected.catalogRoot)||!same(f.policy,this.expected.policy))throw new Error('Frozen factory identity mismatch');return f;
  }
  async task(index){const t=await this.account(this.a.task(this.expected.factoryAddress,index),decodeTask);if(t.index!==index||!pk(t.factory).equals(this.expected.factoryAddress))throw new Error('Task binding mismatch');return t;}
  async submission(address,taskAddress){const s=await this.account(address,decodeSubmission);if(!pk(s.task).equals(pk(taskAddress))||!this.a.submission(s.task,s.attempt,s.miner,s.commitment).equals(pk(address)))throw new Error('Submission PDA mismatch');return s;}
}
