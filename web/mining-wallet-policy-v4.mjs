// Local automatic payments for this frozen factory; no spending budget.
import {PublicKey,Transaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import {getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,ASSOCIATED_TOKEN_PROGRAM_ID,TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {readerForDeployment} from './task-factory-client-v4.mjs';
import {decodeTask,decodeSubmission,Reader,hex} from './task-factory-v4-codec.mjs';
import {instruction,meta,system} from '../tools/task_factory_v4_client.mjs';
const fail=code=>Object.assign(new Error(code),{code});
const equal=(a,b)=>new PublicKey(a).equals(new PublicKey(b));
export class MiningWalletPolicyV4 extends EventTarget {
  constructor({deployment,connection,address}){super();Object.assign(this,{deployment,connection,address});this.reader=readerForDeployment(deployment,connection);this.authorization=null;this.balance=null;this.blocked=null;}
  changed(){this.dispatchEvent(new Event('change'));}
  get approved(){return !!this.authorization&&(!this.blocked||this.blocked==='MINING_WALLET_BALANCE');}
  toJSON(){return {approved:this.approved,balanceLamports:this.balance===null?null:String(this.balance),blocked:this.blocked};}
  assertAuthorized(){if(this.blocked&&this.blocked!=='MINING_WALLET_BALANCE')throw fail(this.blocked);if(!this.approved)throw fail('MINING_WALLET_APPROVAL');}
  assertCanMine(){this.assertAuthorized();const required=BigInt(this.minimumLamports||0);if(this.balance!==null&&this.balance<required)throw fail('MINING_WALLET_BALANCE');}
  revoke(){this.authorization=null;this.blocked=null;this.changed();}
  async quote(){
    const [balance,rent]=await Promise.all([this.connection.getBalance(new PublicKey(this.address),'finalized'),this.connection.getMinimumBalanceForRentExemption(768,'finalized')]);
    if(!Number.isSafeInteger(balance)||!Number.isSafeInteger(rent)||rent<0)throw fail('MINING_WALLET_RPC');this.balance=BigInt(balance);this.minimumLamports=String(BigInt(rent)+40000n);if(this.blocked==='MINING_WALLET_BALANCE'&&this.balance>=BigInt(this.minimumLamports))this.blocked=null;this.changed();
    return {balanceLamports:String(balance),submissionRentLamports:String(rent),networkFeeCeilingLamports:'20000',minimumLamports:String(BigInt(rent)+80000n)};
  }
  async approve(){
    const quote=await this.quote();await this.reader.factory();if(this.balance<BigInt(quote.minimumLamports))throw fail('MINING_WALLET_BALANCE');
    this.authorization={reservations:new Map()};this.blocked=null;this.changed();return this.toJSON();
  }
  async check(tx){
    this.assertAuthorized();const approval=this.authorization,address=new PublicKey(this.address),factory=this.reader.expected.factoryAddress;
    if(!tx.feePayer?.equals(address)||tx.instructions.length<1||tx.instructions.length>2||tx.signatures.some(s=>!s.publicKey.equals(address)))throw fail('MINING_WALLET_TRANSACTION');
    const f=await this.reader.factory(),expected=[];if(!equal(f.mint,this.deployment.mint))throw fail('MINING_WALLET_TRANSACTION');let rent=0n,ataRequested=false;
    for(const [position,ix] of tx.instructions.entries()){
      if(ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)){
        if(position!==0||tx.instructions.length!==2)throw fail('MINING_WALLET_TRANSACTION');
        const ata=getAssociatedTokenAddressSync(new PublicKey(this.deployment.mint),address);expected.push(createAssociatedTokenAccountIdempotentInstruction(address,ata,address,new PublicKey(this.deployment.mint)));ataRequested=true;
        if(!await this.connection.getAccountInfo(ata,'finalized'))rent+=BigInt(await this.connection.getMinimumBalanceForRentExemption(165,'finalized'));
        continue;
      }
      if(!ix.programId.equals(this.reader.program)||ix.data.length<6||ix.data[0]!==11||ix.data.readUInt32LE(1)!==ix.data.length-5)throw fail('MINING_WALLET_TRANSACTION');
      const r=new Reader(ix.data.subarray(5)),tag=r.u8(),factoryIndex=tag===9?1:0,taskIndex=tag===9?2:1;
      if(![3,4,5,7,8,9].includes(tag)||ataRequested&&tag!==9||!ix.keys[factoryIndex]?.pubkey.equals(factory)||!ix.keys[taskIndex])throw fail('MINING_WALLET_TRANSACTION');
      const task=ix.keys[taskIndex].pubkey,t=await this.reader.account(task,decodeTask);
      if(!equal(t.factory,factory)||!this.reader.a.task(factory,t.index).equals(task))throw fail('MINING_WALLET_TRANSACTION');
      let keys,values={};
      if(tag===3){keys=[meta(factory,true),meta(task,true)];if(t.index!==f.nextIndex&&t.index!==f.activeIndex)throw fail('MINING_WALLET_TRANSACTION');}
      if(tag===4){
        values={commitment:r.key(),beneficiary:r.key()};if(!equal(values.beneficiary,address))throw fail('MINING_WALLET_TRANSACTION');
        const submission=this.reader.a.submission(task,t.attempt,address,values.commitment);
        keys=[meta(factory),meta(task,true),meta(submission,true),meta(address,false,true),meta(address,true,true),system()];
        const saved=await this.connection.getAccountInfo(submission,'finalized');if(!saved)rent+=BigInt(await this.connection.getMinimumBalanceForRentExemption(768,'finalized'));
        else{const s=decodeSubmission(saved.data);if(!saved.owner.equals(this.reader.program)||!equal(s.miner,address)||!equal(s.beneficiary,address)||!equal(s.task,task))throw fail('MINING_WALLET_TRANSACTION');}
      }
      if(tag===5){
        values.evidence={};for(const field of ['candidate','result','manifest','archive'])values.evidence[field]=r.key();values.salt=r.key();
        if(!ix.keys[2])throw fail('MINING_WALLET_TRANSACTION');const s=await this.reader.submission(ix.keys[2].pubkey,task);if(!equal(s.miner,address)||!equal(s.beneficiary,address)||s.attempt!==t.attempt)throw fail('MINING_WALLET_TRANSACTION');
        keys=[meta(factory),meta(task,true),meta(ix.keys[2].pubkey,true),meta(address,false,true)];
      }
      if(tag===7||tag===8){
        keys=[meta(factory,true),meta(task,true)];
        if(tag===7){if(!ix.keys[2])throw fail('MINING_WALLET_TRANSACTION');await this.reader.submission(ix.keys[2].pubkey,task);keys.push(meta(ix.keys[2].pubkey));}
        if(f.nextIndex<f.count)keys.push(meta(this.reader.a.task(factory,f.nextIndex),true));
      }
      if(tag===9){
        if(!equal(t.beneficiary,address)||!ix.keys[3]?.pubkey.equals(new PublicKey(t.winner)))throw fail('MINING_WALLET_TRANSACTION');
        const ata=getAssociatedTokenAddressSync(new PublicKey(this.deployment.mint),address);
        keys=[meta(this.reader.a.global),meta(factory,true),meta(task,true),meta(new PublicKey(t.winner)),meta(this.reader.a.pool(0),true),meta(ata,true),meta(TOKEN_PROGRAM_ID)];
      }
      if(r.p!==r.b.length)throw fail('MINING_WALLET_TRANSACTION');expected.push(instruction(this.reader.program,keys,tag,values));
    }
    const canonical=new Transaction({feePayer:address,recentBlockhash:tx.recentBlockhash}).add(...expected);
    if(!canonical.serializeMessage().equals(tx.serializeMessage()))throw fail('MINING_WALLET_TRANSACTION');
    const fee=(await this.connection.getFeeForMessage(tx.compileMessage(),'finalized')).value;
    if(!Number.isSafeInteger(fee)||fee<0||fee>20000)throw fail('MINING_WALLET_FEE');
    const cost=rent+BigInt(fee),balance=await this.connection.getBalance(address,'finalized');if(!Number.isSafeInteger(balance)||balance<0)throw fail('MINING_WALLET_RPC');this.balance=BigInt(balance);
    this.assertAuthorized();if(approval!==this.authorization)throw fail('MINING_WALLET_APPROVAL');
    if(cost>this.balance){this.blocked='MINING_WALLET_BALANCE';this.changed();throw fail(this.blocked);}
    return cost;
  }
  async reserve(tx){
    this.assertAuthorized();if(!tx.signature||!tx.verifySignatures())throw fail('MINING_WALLET_TRANSACTION');const approval=this.authorization,key=hex(tx.signature);
    if(approval.reservations.has(key))return;
    const cost=await this.check(tx);if(approval!==this.authorization)throw fail('MINING_WALLET_APPROVAL');if(approval.reservations.has(key))return;
    approval.reservations.set(key,cost);this.balance-=cost;this.changed();
  }
}
