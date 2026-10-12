import { PublicKey, Connection, Keypair, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Ed25519Program } from '@solana/web3.js';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { addresses,instruction,meta,TOKEN } from '../web/solana-client.mjs';
import { Writer,encodeRules,taskBytes,decodeCampaign,decodePage,commitHash,encodeReveal,verifyMessage,accountReader,hex } from '../web/campaign-codec.mjs';
import { taskForIndex } from '../web/catalog-task.mjs';
import { decodeSubmissionV1 } from '../web/receipt-v1.mjs';
export * from '../web/campaign-codec.mjs';
export * from '../web/solana-client.mjs';
export const connection=new Connection(process.env.FLYPOW_RPC||'http://127.0.0.1:8899','confirmed');
export const loadKey=async p=>Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(p,'utf8'))));
export const loadProgram=async()=> (await loadKey('target/deploy/flypow_campaign_program-keypair.json')).publicKey;
export async function send(program,keys,tag,body=new Uint8Array(),signers=[],extra=[]){
  const payer=await loadKey(process.env.FLYPOW_PAYER||'deploy/localnet/payer.json');
  const tx=new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:1_000_000}),...extra,instruction(program,keys,tag,body));
  const id=await sendAndConfirmTransaction(connection,tx,[payer,...signers.filter(s=>!s.publicKey.equals(payer.publicKey))],{commitment:'confirmed'});
  const receipt=await connection.getTransaction(id,{commitment:'confirmed',maxSupportedTransactionVersion:0});
  return {id,computeUnits:receipt?.meta?.computeUnitsConsumed,fee:receipt?.meta?.fee};
}
export async function setup(r,proofs,out){
  const program=await loadProgram(),payer=await loadKey(process.env.FLYPOW_PAYER||'deploy/localnet/payer.json'),a=addresses(program,r.catalog.campaign_id);r.mint=a.mint.toBytes();
  const bytes=encodeRules(r);
  await send(program,[meta(a.campaign,true),meta(payer.publicKey,true,true),meta(a.ops,true),meta(SystemProgram.programId)],0,new Writer().key(r.catalog.campaign_id).u32(bytes.length).result());
  for(let i=0;i<bytes.length;i+=700)await send(program,[meta(a.campaign,true),meta(payer.publicKey,false,true)],1,new Writer().u32(i).vec(Array.from(bytes.slice(i,i+700)),(w,x)=>w.u8(x)).result());
  await sendAndConfirmTransaction(connection,new Transaction().add(SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:a.ops,lamports:100_000_000})),[payer]);
  for(let i=0;i<r.catalog.targets.length;i++){
    const t=r.catalog.targets[i];await send(program,[meta(a.campaign,true),meta(a.epoch(t.body_id),true),meta(a.settlement(t.body_id),true),meta(a.ops,true),meta(payer.publicKey,false,true),meta(SystemProgram.programId)],2,new Writer().u32(i).result());
  }
  const count=r.catalog.targets.length*r.catalog.stimuli.length*r.catalog.repeats;
  for(let k=0;k<count;k++){const t=await taskForIndex({campaign:r.catalog},k);await send(program,[meta(a.campaign),meta(a.epoch(t.bodyId),true),meta(a.result(t.taskId),true),meta(a.ops,true),meta(payer.publicKey,false,true),meta(SystemProgram.programId)],3,new Writer().bytes(taskBytes(t)).vec(proofs.proof(k),(w,v)=>w.key(v)).result());}
  await send(program,[meta(a.campaign),meta(a.mint,true),meta(payer.publicKey,true,true),meta(SystemProgram.programId),meta(TOKEN),...[0,1,2].map(p=>meta(a.tokens(p),true))],4);
  await send(program,[meta(a.campaign,true),meta(payer.publicKey,false,true),meta(a.mint),...r.catalog.targets.map(t=>meta(a.epoch(t.body_id)))],5);
  const config={schema:'flypow-solana-client-v1',enabled:true,network:'localnet',rpc:connection.rpcEndpoint,wss:connection.rpcEndpoint.replace('http:','ws:').replace(':8899',':8900'),program_id:program.toBase58(),campaign:a.campaign.toBase58(),genesis:await connection.getGenesisHash(),archives:[]};
  if(out){await mkdir(out,{recursive:true});await writeFile(out+'/chain-config.json',JSON.stringify(config,null,2)+'\n',{flag:'wx'});}
  return {program,payer,a,r,config};
}
export async function readReceipt(ctx,sub){const raw=await connection.getAccountInfo(sub);if(!raw?.owner.equals(ctx.program))throw new Error('Receipt missing or wrong owner');return decodeSubmissionV1(raw.data);}
export async function commit(ctx,t,proof,root,miner,beneficiary=miner.publicKey,refund=miner.publicKey,maxOverride=null,payerOverride=miner){
  const raw=await connection.getAccountInfo(ctx.a.result(t.taskId));const p=decodePage(raw.data),sub=ctx.a.submission(t.taskId,p.nextSeq),salt=crypto.getRandomValues(new Uint8Array(32));
  const rent=BigInt(await connection.getMinimumBalanceForRentExemption(1024));const max=rent+BigInt(ctx.r.advance)+BigInt(ctx.r.queue_fee);
  const body=new Writer().bytes(taskBytes(t)).vec(proof,(w,v)=>w.key(v)).key(commitHash(ctx.program,ctx.r,ctx.a.campaign,t.taskId,miner.publicKey,beneficiary,root,salt)).key(beneficiary.toBytes()).key(refund.toBytes()).u32(p.nextSeq).u64(maxOverride??max).result();
  const keys=[meta(ctx.a.campaign),meta(ctx.a.epoch(t.bodyId)),meta(ctx.a.result(t.taskId),true),meta(sub,true),meta(ctx.a.entitlement(sub),true),meta(payerOverride.publicKey,true,true),meta(miner.publicKey,false,true),meta(ctx.a.ops,true),meta(ctx.r.developer,true),meta(SystemProgram.programId)];
  const signers=payerOverride.publicKey.equals(miner.publicKey)?[miner]:[miner,payerOverride];
  const sent=await send(ctx.program,keys,6,body,signers);return {sub,salt,miner,t,proof,body,keys,...sent};
}
export async function reveal(ctx,p,x){
  const r=await readReceipt(ctx,p.sub);while(BigInt(await connection.getSlot('confirmed'))<r.lifecycle.commitSlot+BigInt(ctx.r.min_reveal_slots))await new Promise(resolve=>setTimeout(resolve,200));
  return send(ctx.program,[meta(ctx.a.campaign),meta(ctx.a.result(p.t.taskId),true),meta(p.sub,true),meta(p.miner.publicKey,false,true)],7,encodeReveal({...x,salt:x.salt??p.salt}),[p.miner]);
}
export async function vote(ctx,p,key,index,accept=true,mutate=m=>m){
  const s=await readReceipt(ctx,p.sub),message=mutate(verifyMessage(ctx.program,ctx.a.campaign,p.sub,ctx.r,s,accept));
  const ed=Ed25519Program.createInstructionWithPrivateKey({privateKey:key.secretKey,message});
  return send(ctx.program,[meta(ctx.a.campaign),meta(ctx.a.result(p.t.taskId),true),meta(p.sub,true),meta(SYSVAR_INSTRUCTIONS_PUBKEY),meta(ctx.r.developer,true),meta(ctx.a.ops,true)],8,new Writer().u8(index).u8(accept?1:0).u16(1).result(),[],[ed]);
}
export async function finalize(ctx,p){return send(ctx.program,[meta(ctx.a.campaign),meta(ctx.a.epoch(p.t.bodyId),true),meta(ctx.a.result(p.t.taskId),true),meta(p.sub,true)],9);}
export async function close(ctx,p){return send(ctx.program,[meta(ctx.a.campaign),meta(ctx.a.epoch(p.t.bodyId),true),meta(ctx.a.result(p.t.taskId),true),meta(p.sub,true),meta(ctx.a.entitlement(p.sub),true),meta(ctx.a.settlement(p.t.bodyId),true)],10);}
export async function refund(ctx,p){return send(ctx.program,[meta(ctx.a.campaign),meta(ctx.a.entitlement(p.sub),true),meta(ctx.a.settlement(p.t.bodyId),true),meta(p.miner.publicKey,true)],13);}
export async function claim(ctx,p,pool,verifier,beneficiary,ata,amount){return send(ctx.program,[meta(ctx.a.campaign,pool===2),meta(pool===2?ctx.a.campaign:ctx.a.entitlement(p.sub),pool!==2),meta(ctx.a.mint),meta(ctx.a.tokens(pool),true),meta(ata,true),meta(beneficiary),meta(TOKEN)],17,new Writer().u8(pool).u8(verifier).u64(amount).result());}
