import { Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_CLOCK_PUBKEY, ComputeBudgetProgram } from '@solana/web3.js';
import { getWallets } from '@wallet-standard/app';
import { Buffer } from 'buffer';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { taskForIndex } from './catalog-task.mjs';
import { Writer, fromHex, hex, text, commitHash, decodeCampaign, decodePage, decodeEpoch, decodeEntitlement, isAccount, taskBytes, encodeReveal } from './campaign-codec.mjs';
import { decodeSubmissionV1 } from './receipt-v1.mjs';
export { Writer, fromHex, text, commitHash, decodeCampaign, decodePage, taskBytes, encodeReveal } from './campaign-codec.mjs';
export { merkle, hex, verifyMessage } from './campaign-codec.mjs';
export const TOKEN=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const pk=x=>x instanceof PublicKey?x:new PublicKey(x);
export function base58(bytes){
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n;for(const b of bytes)n=(n<<8n)+BigInt(b);
  let out='';while(n){out=alphabet[Number(n%58n)]+out;n/=58n;}for(const b of bytes){if(b!==0)break;out='1'+out;}return out;
}
export async function readChainClock(connection){
  const account=await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  if(!account||account.data.length!==40)throw new Error('Chain Clock is unavailable');
  const v=new DataView(account.data.buffer,account.data.byteOffset,account.data.length);
  return {slot:v.getBigUint64(0,true),unixTimestamp:v.getBigInt64(32,true)};
}
export const meta=(key,writable=false,signer=false)=>({pubkey:pk(key),isWritable:writable,isSigner:signer});
export function addresses(program,campaignId){
  const pid=pk(program),pda=(...parts)=>PublicKey.findProgramAddressSync(parts.map(p=>Buffer.from(p)),pid)[0];
  const campaign=pda(text('campaign'),campaignId);
  return {campaign,ops:pda(text('ops'),campaign.toBytes()),mint:pda(text('mint'),campaign.toBytes()),
    epoch:body=>pda(text('epoch'),campaign.toBytes(),new Writer().u64(body).result()),settlement:body=>pda(text('settlement'),campaign.toBytes(),new Writer().u64(body).result()),
    result:id=>pda(text('result'),campaign.toBytes(),typeof id==='string'?fromHex(id):id),submission:(id,seq)=>pda(text('submission'),campaign.toBytes(),typeof id==='string'?fromHex(id):id,new Writer().u32(seq).result()),
    entitlement:sub=>pda(text('entitlement'),pk(sub).toBytes()),tokens:pool=>pda(text('tokens'),campaign.toBytes(),[pool])};
}
export function instruction(program,keys,tag,body=new Uint8Array()){return new TransactionInstruction({programId:pk(program),keys,data:Buffer.from(new Writer().u8(tag).bytes(body).result())});}
export function validateConfig(c,deployment=null){
  if(deployment&&(!deployment.capabilities?.solana||deployment.schema!=='flybrain-mining-deployment-v1'||deployment.version!==1||deployment.capabilities.solana.programId!==c.program_id||deployment.capabilities.solana.genesis!==c.genesis||!deployment.capabilities.solana.allowedRPCs?.includes(c.rpc)))throw new Error('Chain configuration does not match deployed identity/capabilities');
  if(c.schema!=='flypow-solana-client-v1' || !['localnet','devnet'].includes(c.network))throw new Error('Unsupported chain configuration');
  if(!c.enabled)return c;
  const u=new URL(c.rpc),ws=new URL(c.wss);
  if(c.network==='localnet' ? !['127.0.0.1','localhost','[::1]'].includes(u.hostname) || !['http:','https:'].includes(u.protocol) || ws.hostname!==u.hostname || !['ws:','wss:'].includes(ws.protocol) || u.username || u.password || ws.username || ws.password : u.href!=='https://api.devnet.solana.com/' || ws.href!=='wss://api.devnet.solana.com/')throw new Error('RPC is not an explicit permitted development network');
  pk(c.program_id);pk(c.campaign);pk(c.genesis);if(!Array.isArray(c.archives)||c.archives.length>4)throw new Error('Archive configuration');
  for(const a of c.archives){const u=new URL(a);if(u.protocol!=='https:' && !(c.network==='localnet' && u.protocol==='http:' && ['localhost','127.0.0.1'].includes(u.hostname)))throw new Error('Invalid archive origin');}
  return c;
}
export class CampaignClient {
  constructor(config,deployment=null){this.config=validateConfig(config,deployment);if(!config.enabled)throw new Error('No configured campaign');this.connection=new Connection(config.rpc,{commitment:'confirmed',wsEndpoint:config.wss});this.program=pk(config.program_id);this.campaign=pk(config.campaign);}
  async load(){
    if(await this.connection.getGenesisHash()!==this.config.genesis)throw new Error('RPC genesis differs from configured deployment');
    const a=await this.connection.getAccountInfo(this.campaign);if(!a?.owner.equals(this.program))throw new Error('Campaign owner mismatch');
    this.state=decodeCampaign(a.data);this.rules=this.state.rules;this.a=addresses(this.program,this.rules.catalog.campaign_id);
    if(!this.a.campaign.equals(this.campaign)||!pk(this.rules.genesis).equals(pk(this.config.genesis)) || this.rules.network!==(this.config.network==='localnet'?0:1))throw new Error('Frozen deployment identity mismatch');
    return this.state;
  }
  async receipt(sub){const a=await this.connection.getAccountInfo(pk(sub));if(!a?.owner.equals(this.program))throw new Error('Submission owner mismatch');return decodeSubmissionV1(a.data);}
  assertCatalog(catalog){
    const a=catalog.campaign,b=this.rules.catalog;
    for(const n of ['campaign_id','source_root','registry_root','graph_root','model_root','experiment_root','public_seed'])if(hex(a[n])!==hex(b[n]))throw new Error('Catalog deployment mismatch: '+n);
    for(const n of ['model_neuron_count','simulation_steps','time_step_us','repeats'])if(a[n]!==b[n])throw new Error('Catalog parameter mismatch: '+n);
    if(a.targets.length!==b.targets.length||a.stimuli.length!==b.stimuli.length||a.targets.some((t,i)=>BigInt(t.body_id)!==b.targets[i].body_id||t.model_index!==b.targets[i].model_index)||a.stimuli.some((s,i)=>s.start_step!==b.stimuli[i].start_step||s.end_step!==b.stimuli[i].end_step||BigInt(s.current)!==b.stimuli[i].current))throw new Error('Frozen targets/inputs mismatch');
    if(hex(catalog.task_manifest_root)!==hex(this.rules.manifest_root))throw new Error('Task manifest mismatch');
  }
  async snapshot(){
    await this.load();
    const rows=await this.connection.getProgramAccounts(this.program,{filters:[{memcmp:{offset:8,bytes:this.campaign.toBase58()}}]});
    const pages=[],epochs=[],entitlements=[];
    for(const row of rows){
      const b=row.account.data;
      if(isAccount(b,'ResultPage')){
        const p=decodePage(b);const task=await taskForIndex({campaign:this.rules.catalog},Number(p.k));
        if(hex(p.taskId)!==task.taskId||!row.pubkey.equals(this.a.result(p.taskId)))throw new Error('Noncanonical result page');
        pages.push({...p,address:row.pubkey,task});
      }else if(isAccount(b,'NeuronEpoch')){
        const e=decodeEpoch(b);if(!row.pubkey.equals(this.a.epoch(e.bodyId)))throw new Error('Noncanonical epoch');epochs.push({...e,address:row.pubkey});
      }else if(isAccount(b,'MinerEntitlement')){
        const e=decodeEntitlement(b);if(!row.pubkey.equals(this.a.entitlement(e.submission)))throw new Error('Noncanonical entitlement');entitlements.push({...e,address:row.pubkey});
      }
    }
    pages.sort((a,b)=>Number(a.k-b.k));epochs.sort((a,b)=>Number(a.bodyId-b.bodyId));
    return {state:this.state,pages,epochs,entitlements,clock:await readChainClock(this.connection)};
  }
  async quote(){const principal=BigInt(await this.connection.getMinimumBalanceForRentExemption(1024));return {bytes:1024,principal,advance:this.rules.advance,queueFee:this.rules.queue_fee,max:principal+this.rules.advance+this.rules.queue_fee};}
  async commitInstruction(task,proof,miner,beneficiary,refund,resultRoot,salt,max){
    const pa=this.a.result(task.taskId),raw=await this.connection.getAccountInfo(pa);
    if(!raw?.owner.equals(this.program))throw new Error('Result page owner mismatch');const p=decodePage(raw.data);if(p.complete)throw new Error('This scientific task is already complete');
    const sub=this.a.submission(task.taskId,p.nextSeq),commit=commitHash(this.program,this.rules,this.campaign,task.taskId,pk(miner),pk(beneficiary),resultRoot,salt);
    const b=new Writer().bytes(taskBytes(task)).vec(proof,(w,x)=>w.key(x)).key(commit).key(pk(beneficiary).toBytes()).key(pk(refund).toBytes()).u32(p.nextSeq).u64(max).result();
    return {submission:sub,instruction:instruction(this.program,[meta(this.campaign),meta(this.a.epoch(task.bodyId)),meta(pa,true),meta(sub,true),meta(this.a.entitlement(sub),true),meta(miner,true,true),meta(miner,false,true),meta(this.a.ops,true),meta(this.rules.developer,true),meta(SystemProgram.programId)],6,b)};
  }
  revealInstruction(sub,miner,x){return instruction(this.program,[meta(this.campaign),meta(this.a.result(x.taskId),true),meta(sub,true),meta(miner,false,true)],7,encodeReveal(x));}
  finalizeInstruction(sub,task){return instruction(this.program,[meta(this.campaign),meta(this.a.epoch(task.bodyId),true),meta(this.a.result(task.taskId),true),meta(sub,true)],9);}
  closeInstruction(sub,task){return instruction(this.program,[meta(this.campaign),meta(this.a.epoch(task.bodyId),true),meta(this.a.result(task.taskId),true),meta(sub,true),meta(this.a.entitlement(sub),true),meta(this.a.settlement(task.bodyId),true)],10);}
  refundInstruction(sub,body,recipient){return instruction(this.program,[meta(this.campaign),meta(this.a.entitlement(sub),true),meta(this.a.settlement(body),true),meta(recipient,true)],13);}
  sealInstruction(body){return instruction(this.program,[meta(this.campaign,true),meta(this.a.epoch(body),true)],11);}
  endInstruction(){return instruction(this.program,[meta(this.campaign,true)],12);}
  tgeInstruction(){return instruction(this.program,[meta(this.campaign,true),meta(this.a.mint,true),meta(TOKEN),...[0,1,2].map(i=>meta(this.a.tokens(i),true))],16);}
  claimInstructions(sub,pool,index,beneficiary,payer,amount){
    const who=pk(beneficiary),ata=getAssociatedTokenAddressSync(this.a.mint,who,true);
    const create=createAssociatedTokenAccountIdempotentInstruction(pk(payer),ata,who,this.a.mint);
    const claim=instruction(this.program,[meta(this.campaign,pool===2),meta(pool===2?this.campaign:this.a.entitlement(sub),pool!==2),meta(this.a.mint),meta(this.a.tokens(pool),true),meta(ata,true),meta(who),meta(TOKEN)],17,new Writer().u8(pool).u8(index).u64(amount).result());
    return [create,claim];
  }
  async send(wallet,account,ixs,hooks={}){
    const latest=await this.connection.getLatestBlockhash();const tx=new Transaction({feePayer:pk(account.address),...latest}).add(ComputeBudgetProgram.setComputeUnitLimit({units:1_000_000}),...ixs);
    const signing=wallet.features['solana:signTransaction'];if(!signing)throw new Error('Wallet standard Solana signing is required');
    const chain=this.config.network==='devnet'?'solana:devnet':'solana:localnet';
    const [signed]=await signing.signTransaction({account,chain,transaction:tx.serialize({requireAllSignatures:false,verifySignatures:false})});
    const decoded=Transaction.from(signed.signedTransaction);
    if(!decoded.signature||!decoded.verifySignatures())throw new Error('Wallet returned an invalid signed transaction');
    if(!decoded.serializeMessage().equals(tx.serializeMessage()))throw new Error('Wallet changed the transaction message');
    const id=base58(decoded.signature);
    // Persist the exact signature and block expiry BEFORE broadcasting. A transport
    // timeout can then be reconciled, without creating a new paid candidate.
    await hooks.onSigned?.({signature:id,...latest});
    const sent=await this.connection.sendRawTransaction(signed.signedTransaction);if(sent!==id)throw new Error('RPC returned a different transaction signature');
    const status=await this.connection.confirmTransaction({signature:id,...latest},'confirmed');if(status.value.err)throw new Error('Transaction failed: '+JSON.stringify(status.value.err));return id;
  }
}
export function standardWallets(){return getWallets().get().filter(w=>w.features['standard:connect']&&w.features['solana:signTransaction']);}
export async function connectStandardWallet(name){
  const wallets=standardWallets();
  if(!wallets.length)throw new Error('Install or unlock a Wallet Standard Solana wallet');
  const wallet=name?wallets.find(w=>w.name===name):wallets[0];if(!wallet)throw new Error('Selected wallet is unavailable');const out=await wallet.features['standard:connect'].connect();const account=out.accounts[0];if(!account)throw new Error('Wallet has no account');return {wallet,account};
}
