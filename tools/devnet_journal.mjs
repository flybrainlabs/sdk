// Bounded operator transport. Private signed bytes are persisted before sending.
import {Connection,Transaction} from '@solana/web3.js';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
const encodeBase58=bytes=>{const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=BigInt('0x'+Buffer.from(bytes).toString('hex')),s='';while(n){s=alphabet[Number(n%58n)]+s;n/=58n;}for(const b of bytes){if(b)break;s='1'+s;}return s;};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hash=b=>createHash('sha256').update(b).digest('hex');
export class DevnetJournal {
  constructor(path,payer,{maxTransactions=96,maxFees=2_000_000}={}){Object.assign(this,{path,payer,maxTransactions,maxFees});this.connection=new Connection('https://api.devnet.solana.com','finalized');}
  async initialize(scope){
    if(await this.connection.getGenesisHash()!=='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')throw new Error('Wrong genesis');
    this.scope={...scope,payer:this.payer.publicKey.toBase58(),genesisHash:await this.connection.getGenesisHash()};
    await mkdir(dirname(this.path),{recursive:true,mode:0o700});try{this.journal=JSON.parse(await readFile(this.path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;this.journal={schema:'flybrainlabs-devnet-transport-v1',scope:this.scope,operations:{}};}
    if(JSON.stringify(this.journal.scope)!==JSON.stringify(this.scope))throw new Error('Frozen journal identity changed');return this;
  }
  async save(){const temp=this.path+'.tmp';await writeFile(temp,JSON.stringify(this.journal,null,2)+'\n',{mode:0o600});await rename(temp,this.path);}
  async run(name,instructions,signers=[],completed=async()=>false,{replacementSafe=true}={}){
    const ixs=Array.isArray(instructions)?instructions:[instructions],scope=hash(JSON.stringify(ixs.map(ix=>({program:ix.programId.toBase58(),keys:ix.keys.map(k=>[k.pubkey.toBase58(),k.isSigner,k.isWritable]),data:ix.data.toString('hex')}))));
    let op=this.journal.operations[name];if(op&&op.scope!==scope)throw new Error('Operator instruction scope changed');if(!op)this.journal.operations[name]=op={scope,attempts:[]};
    if(op.receipt){const status=(await this.connection.getSignatureStatuses([op.receipt.signature],{searchTransactionHistory:true})).value[0];if(status?.confirmationStatus==='finalized'&&!status.err)return op.receipt;throw new Error('Retained finalized receipt unavailable; operator reconciliation required');}
    if(await completed()){return {alreadyComplete:true};}
    for(let attempt=0;attempt<3;attempt++){
      let record=op.attempts.at(-1),height=await this.connection.getBlockHeight('finalized');
      if(record){const status=(await this.connection.getSignatureStatuses([record.signature],{searchTransactionHistory:true})).value[0];
        if(status?.confirmationStatus==='finalized'){if(status.err)throw new Error('Operator transaction failed');op.receipt=await this.receipt(record.signature);await this.save();return op.receipt;}
        if(height>record.lastValidBlockHeight){if(await completed())return {alreadyComplete:true,signature:record.signature};if(!replacementSafe)throw new Error('Non-idempotent transport unknown; reconcile before retrying');record=null;}
      }
      if(!record){
        const all=Object.values(this.journal.operations).flatMap(v=>v.attempts);if(all.length>=this.maxTransactions||op.attempts.length>=3)throw new Error('Operator transaction ceiling');
        const latest=await this.connection.getLatestBlockhash('finalized'),tx=new Transaction({feePayer:this.payer.publicKey,recentBlockhash:latest.blockhash}).add(...ixs);tx.sign(this.payer,...signers.filter(s=>!s.publicKey.equals(this.payer.publicKey)));const raw=tx.serialize(),fee=(await this.connection.getFeeForMessage(tx.compileMessage(),'finalized')).value;
        if(raw.length>1232||fee===null||fee>20_000||all.reduce((n,r)=>n+r.feeLamports,0)+fee>this.maxFees)throw new Error('Operator packet/fee ceiling');
        record={signature:encodeBase58(tx.signature),rawBase64:raw.toString('base64'),lastValidBlockHeight:latest.lastValidBlockHeight,feeLamports:fee,packetBytes:raw.length,sends:0};op.attempts.push(record);await this.save();
      }
      while(record.sends<3){record.sends++;await this.save();try{const returned=await this.connection.sendRawTransaction(Buffer.from(record.rawBase64,'base64'),{maxRetries:0,skipPreflight:false});if(returned!==record.signature)throw new Error('Signature mismatch');}catch{}
        for(let poll=0;poll<25;poll++){await pause(1800);const status=(await this.connection.getSignatureStatuses([record.signature],{searchTransactionHistory:true})).value[0];if(status?.confirmationStatus==='finalized'){if(status.err)throw new Error('Operator transaction failed');op.receipt=await this.receipt(record.signature);await this.save();console.log(JSON.stringify({operation:name,...op.receipt}));return op.receipt;}if(await this.connection.getBlockHeight('finalized')>record.lastValidBlockHeight)break;}
        if(await this.connection.getBlockHeight('finalized')>record.lastValidBlockHeight)break;
      }
    }
    throw new Error('Operator transport remains unknown; private journal retained');
  }
  async receipt(signature){const tx=await this.connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(!tx||tx.meta?.err)throw new Error('Finalized transaction unavailable');return {signature,slot:String(tx.slot),feeLamports:String(tx.meta.fee),computeUnits:tx.meta.computeUnitsConsumed,commitment:'finalized'};}
  publicReceipts(){return Object.fromEntries(Object.entries(this.journal.operations).filter(([,r])=>r.receipt).map(([name,r])=>[name,r.receipt]));}
}
