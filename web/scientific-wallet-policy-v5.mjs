// A separate explicit approval extends the existing dedicated wallet to the
// published V5 rounds. No generic transfer or budget authorization is added.
import {PublicKey,Transaction} from '@solana/web3.js';
import {getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,ASSOCIATED_TOKEN_PROGRAM_ID,TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {Buffer} from 'buffer';
import {ScientificReaderV5,instruction,meta,system,slotHashes} from './scientific-client-v5.mjs';
import {Reader,hex,uploadMessage} from './scientific-round-v5.mjs';
const equal=(a,b)=>new PublicKey(a).equals(new PublicKey(b));
const fail=()=>Object.assign(new Error('Scientific wallet authorization required'),{code:'SCIENTIFIC_WALLET_APPROVAL'});
export class ScientificWalletPolicyV5 extends EventTarget {
  constructor({deployment,connection,address,basePolicy=null}){super();Object.assign(this,{deployment,connection,address,basePolicy});this.reader=new ScientificReaderV5(connection,deployment);this.authorization=null;this.reservations=new Set();if(!deployment.rounds?.length||deployment.rounds.length>64)throw fail();}
  assertAuthorized(){if(!this.authorization)throw fail();this.basePolicy?.assertAuthorized();}
  async approve(){for(const a of this.deployment.rounds)await this.reader.round(a);this.authorization={};this.dispatchEvent(new Event('change'));}
  revoke(){this.authorization=null;this.reservations.clear();this.basePolicy?.revoke();this.dispatchEvent(new Event('change'));}
  async quote(){const rent=await this.connection.getMinimumBalanceForRentExemption(768,'finalized');if(!Number.isSafeInteger(rent))throw fail();return {submissionRentLamports:String(rent),networkFeeCeilingLamports:'20000',scope:'Solana network fees and claim account rent; no project fee'};}
  async checkUploadMessage(bytes){
    this.assertAuthorized();const approval=this.authorization,value=JSON.parse(new TextDecoder().decode(bytes));
    if(value.schema!=='flybrain-scientific-upload-v5'||value.genesis!==this.deployment.genesisHash||value.program!==this.deployment.programId||!this.deployment.rounds.includes(value.round)||!/^[a-f0-9]{64}$/.test(value.root)||!Number.isSafeInteger(value.bytes)||value.bytes<1||value.bytes>128*1024*1024||hex(uploadMessage(value))!==hex(bytes))throw fail();
    const c=await this.reader.claim(value.claim,value.round);if(!equal(c.miner,this.address))throw fail();
    this.assertAuthorized();if(approval!==this.authorization)throw fail();
  }
  async check(tx){
    if(tx.instructions.every(ix=>ix.data[0]!==12||!ix.programId.equals(this.reader.program))&&this.basePolicy)return this.basePolicy.check(tx);
    this.assertAuthorized();const approval=this.authorization,address=new PublicKey(this.address),expected=[];let rent=0n;
    if(!tx.feePayer?.equals(address)||tx.instructions.length<1||tx.instructions.length>2||tx.signatures.some(s=>!s.publicKey.equals(address)))throw fail();
    let ata=false;
    for(const [position,ix]of tx.instructions.entries()){
      if(ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)){if(position!==0||tx.instructions.length!==2)throw fail();ata=true;continue;}
      if(!ix.programId.equals(this.reader.program)||ix.data[0]!==12||ix.data.readUInt32LE(1)!==ix.data.length-5)throw fail();
      const b=new Reader(ix.data.subarray(5)),tag=b.u8(),round=ix.keys[tag===6?1:0]?.pubkey;
      if(!round||!this.deployment.rounds.includes(round.toBase58())||![1,2,3,5,6].includes(tag)||ata&&tag!==6)throw fail();
      const r=await this.reader.round(round);if(!equal(r.mint,this.deployment.mint))throw fail();let keys,value={};
      if(tag===1){value={commitment:b.key(),beneficiary:b.key(),role:b.u8(),assignment:b.u8()};if(!equal(value.beneficiary,address))throw fail();const claim=this.reader.a.claim(round,address,value.commitment);keys=[meta(round,true),meta(claim,true),meta(address,true,true),system()];if(!await this.connection.getAccountInfo(claim,'finalized'))rent+=BigInt(await this.connection.getMinimumBalanceForRentExemption(768,'finalized'));}
      if(tag===2)keys=[meta(round,true),slotHashes()];
      if(tag===3||tag===5||tag===6){const claim=ix.keys[tag===6?2:1]?.pubkey;if(!claim)throw fail();const c=await this.reader.claim(claim,round);if(!equal(c.miner,address)||!equal(c.beneficiary,address))throw fail();
        if(tag===3){for(const k of ['input','salt','manifest','result'])value[k]=b.key();keys=[meta(round),meta(claim,true),meta(address,false,true)];}
        if(tag===5){const marker=this.reader.a.computation(c.computation);keys=[meta(round,true),meta(claim,true),meta(marker,true),meta(address,true,true),system()];if(!await this.connection.getAccountInfo(marker,'finalized'))rent+=BigInt(await this.connection.getMinimumBalanceForRentExemption(128,'finalized'));}
        if(tag===6){const destination=getAssociatedTokenAddressSync(new PublicKey(r.mint),address);keys=[meta(this.reader.a.global),meta(round,true),meta(claim,true),meta(this.reader.a.pool(0),true),meta(destination,true),meta(TOKEN_PROGRAM_ID)];if(ata){expected.push(createAssociatedTokenAccountIdempotentInstruction(address,destination,address,new PublicKey(r.mint)));if(!await this.connection.getAccountInfo(destination,'finalized'))rent+=BigInt(await this.connection.getMinimumBalanceForRentExemption(165,'finalized'));}}
      }
      if(b.p!==b.b.length)throw fail();expected.push(instruction(this.reader.program,keys,tag,value));
    }
    const canonical=new Transaction({feePayer:address,recentBlockhash:tx.recentBlockhash}).add(...expected);
    if(!canonical.serializeMessage().equals(tx.serializeMessage()))throw fail();
    const fee=(await this.connection.getFeeForMessage(tx.compileMessage(),'finalized')).value,balance=await this.connection.getBalance(address,'finalized');
    if(!Number.isSafeInteger(fee)||fee<0||fee>20000||!Number.isSafeInteger(balance)||rent+BigInt(fee)>BigInt(balance))throw fail();
    this.assertAuthorized();if(approval!==this.authorization)throw fail();return rent+BigInt(fee);
  }
  async reserve(tx){
    if(tx.instructions.every(ix=>ix.data[0]!==12||!ix.programId.equals(this.reader.program))&&this.basePolicy)return this.basePolicy.reserve(tx);
    this.assertAuthorized();if(!tx.signature||!tx.verifySignatures())throw fail();const key=hex(tx.signature);if(this.reservations.has(key))return;await this.check(tx);this.reservations.add(key);
  }
}
