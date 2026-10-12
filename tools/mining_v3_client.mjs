// Transaction adapter for the fixed mining V3 instruction extension.
import {PublicKey,TransactionInstruction,Ed25519Program,SystemProgram,SYSVAR_INSTRUCTIONS_PUBKEY} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {Writer,text,encodeIntent} from '../web/mining-v3-codec.mjs';
import {meta,addresses as oldAddresses} from './economy_v2_client.mjs';
export * from '../web/mining-v3-codec.mjs';
export {meta,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID};
const pk=x=>new PublicKey(x),bytes=x=>pk(x).toBytes();
export function addresses(program){const p=pk(program),pda=(...xs)=>PublicKey.findProgramAddressSync(xs.map(x=>Buffer.from(x)),p)[0];return {...oldAddresses(p),config:pda(text('mining-config-v3')),generation:miner=>pda(text('wallet-generation-v3'),bytes(miner)),grant:(miner,id)=>pda(text('grant-v3'),bytes(miner),id),miningStage:id=>pda(text('mining-stage-v3'),id),unit:task=>pda(text('slot-v2'),task,[0],new Uint8Array(32)),intent:(unit,miner,commitment)=>pda(text('intent-v3'),bytes(unit),bytes(miner),commitment),staging:(unit,intent)=>pda(text('staging-v3'),bytes(unit),bytes(intent)),result:unit=>pda(text('result-v3'),bytes(unit)),ata:(mint,miner)=>getAssociatedTokenAddressSync(pk(mint),pk(miner))};}
export function operationData(tag,v={}){
  const w=new Writer().u8(tag);
  if(tag===1)w.key(v.relayer).key(v.closeAuthority).key(v.rentRecipient).u64(v.retentionSeconds).u64(v.maxGrantLifetime).u64(v.maxDeposit);
  else if(tag===2)w.key(v.id).u64(v.budget).i64(v.deadline);
  else if(tag===3)w.key(v.economicTask).u64(v.amount);
  else if(tag===4||tag===5){if(tag===4)w.key(v.id);w.u64(v.generation).key(v.session).u64(v.deposit).u64(v.maxSpend).u64(v.maxResultRent).u64(v.maxResults).i64(v.expiresAt);}
  else if(tag===7)w.u64(v.amount);
  else if(tag===9)w.bytes(encodeIntent(v.intent)).u16(v.ed25519Index);
  else if(tag===10)w.key(v.expectedHash);
  else if(tag===11)w.u16(v.offset).u32(v.bytes.length).bytes(v.bytes);
  else if(tag===13||tag===16)w.u16(v.ed25519Index);
  else if(tag===14)w.u64(v.generation);
  else if(![0,6,8,12,15,17,18,19].includes(tag))throw new Error('Unknown mining operation');
  return w.result();
}
export function instruction(program,keys,tag,v={}){const b=operationData(tag,v);return new TransactionInstruction({programId:pk(program),keys,data:Buffer.from(new Writer().u8(10).u32(b.length).bytes(b).result())});}
export function signedInstruction(program,keys,tag,v,message,signer){return [Ed25519Program.createInstructionWithPrivateKey({privateKey:signer.secretKey,message}),instruction(program,keys,tag,{...v,ed25519Index:0})];}
export function signatureInstruction(publicKey,message,signature){return Ed25519Program.createInstructionWithPublicKey({publicKey:bytes(publicKey),message,signature});}
export const system=()=>meta(SystemProgram.programId);
export const instructionSysvar=()=>meta(SYSVAR_INSTRUCTIONS_PUBKEY);
export function settlementKeys(a,{stage,unit,intent,staging,grant,mint,miner,relayer}){return [meta(a.global),meta(a.config),meta(stage,true),meta(unit,true),meta(intent),meta(staging),meta(grant,true),meta(a.result(unit),true),meta(mint),meta(a.pool(0),true),meta(a.ata(mint,miner),true),meta(miner),meta(relayer,true,true),system(),meta(TOKEN_PROGRAM_ID),meta(ASSOCIATED_TOKEN_PROGRAM_ID)];}
