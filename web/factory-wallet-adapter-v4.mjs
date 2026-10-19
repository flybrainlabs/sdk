// Wallet-owned V4 transactions and authenticated content publication. Login is
// reused for HTTP authorization; no V3 rent grant is created or consumed.
import {Connection,PublicKey,Transaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import {getAssociatedTokenAddressSync,unpackAccount} from '@solana/spl-token';
import {canonical,hash} from './target-protocol-v2.mjs';
import {waitForFinalizedSignature} from './wallet-rpc-v3.mjs';
import {FactoryContentStoreV4} from './factory-content-store-v4.mjs';
import {FactoryUserRpcV4} from './factory-user-rpc-v4.mjs';

const base58=bytes=>{const a='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n,s='';for(const b of bytes)n=n*256n+BigInt(b);while(n){s=a[Number(n%58n)]+s;n/=58n;}for(const b of bytes){if(b)break;s='1'+s;}return s;};
async function transportRecord(key,value){
  const db=await new Promise((ok,no)=>{const r=indexedDB.open('flybrainlabs-wallet-transactions-v4',1);r.onupgradeneeded=()=>r.result.createObjectStore('transactions');r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error);});
  try{return await new Promise((ok,no)=>{const t=db.transaction('transactions',value===undefined?'readonly':'readwrite'),r=value===undefined?t.objectStore('transactions').get(key):t.objectStore('transactions').put(value,key);let result;r.onsuccess=()=>result=r.result;r.onerror=()=>no(r.error);t.oncomplete=()=>ok(result);t.onerror=()=>no(t.error);});}finally{db.close();}
}
function signedIn(session){
  const expires=Number(session.login?.expiresAt);
  return !!session.account&&session.login?.wallet===session.account.address&&Number.isFinite(expires)&&expires>Date.now()/1000;
}
function auth(session){
  if(!signedIn(session))throw Object.assign(new Error('Sign in with the connected wallet before mining'),{code:'wallet-login-required'});
  return {Authorization:'Bearer '+session.login.token,'X-Mining-CSRF':session.login.csrfToken};
}
export function factoryWalletAdapter({deployment,session,fetch:fetchImpl=globalThis.fetch,rpc:personalRpc=null}){
  const api=new URL(deployment.apiBase),endpoint=new URL('/api/task-factory/v4/rpc',api);
  if(deployment.cluster!=='devnet'||endpoint.origin!==api.origin||endpoint.pathname!=='/api/task-factory/v4/rpc'||api.protocol!=='https:'||api.username||api.password||api.search||api.hash)throw new Error('Unsupported V4 public gateway');
  const rpc=personalRpc||new FactoryUserRpcV4({deployment,fetch:fetchImpl});
  // The connection address is a compatibility identifier, never a fallback.
  const transport=async(url,options={})=>{if(String(url)!==endpoint.href)throw new Error('Factory RPC transport changed');return rpc.request(options);};
  const connection=new Connection(endpoint.href,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:transport});
  const wallet={get publicKey(){return session.account?.publicKey||null;}};
  async function readBalances({wallet:address}){
    rpc.assertReady();const generation=rpc.generation,miner=new PublicKey(address),mint=new PublicKey(deployment.mint);
    const guard=()=>{rpc.assertReady();if(generation!==rpc.generation)throw Object.assign(new Error('RPC_CHANGED'),{code:'RPC_CHANGED'});};
    if(await connection.getGenesisHash()!==deployment.genesisHash)throw new Error('Factory chain identity changed');guard();
    const sol=await connection.getBalance(miner,'finalized');guard();
    if(!Number.isSafeInteger(sol)||sol<0)throw new Error('Invalid finalized SOL balance');
    const ata=getAssociatedTokenAddressSync(mint,miner),info=await connection.getAccountInfo(ata,'finalized');guard();let amount=0n;
    if(info){const token=unpackAccount(ata,info);if(!token.owner.equals(miner)||!token.mint.equals(mint))throw new Error('Token balance identity mismatch');amount=token.amount;}
    return {wallet:address,mint:deployment.mint,cluster:deployment.cluster,solLamports:String(sol),tokenAtoms:String(amount),symbol:'FBW',grants:[],pendingRewardAtoms:null,asOf:Math.floor(Date.now()/1000),commitment:'finalized',source:'personal-rpc-v4',historicalGrantsIncluded:false};
  }
  let queue=Promise.resolve();
  async function execute(instructions,{intent=null,replacementSafe=true,beforeSend=()=>{}}={}){
    beforeSend();rpc.assertReady();auth(session);const local=session.wallet.features['flybrainlabs:miningWallet'];local?.assertAuthorized();const generation=session.generation,rpcGeneration=rpc.generation,address=session.account.address,guard=()=>{beforeSend();rpc.assertReady();if(rpc.generation!==rpcGeneration)throw Object.assign(new Error('RPC_CHANGED'),{code:'RPC_CHANGED'});session.guard(generation,address);local?.assertAuthorized();};guard();
    if(await connection.getGenesisHash()!==deployment.genesisHash)throw new Error('Factory chain identity changed');
    if(intent!==null&&(typeof intent!=='string'||intent.length>160))throw new Error('Invalid wallet transaction intent');
    const scope=await hash(canonical({program:deployment.programId,factory:deployment.factory,wallet:address,...(intent===null?{}:{intent}),instructions:instructions.map(ix=>({program:ix.programId.toBase58(),keys:ix.keys.map(k=>({address:k.pubkey.toBase58(),signer:k.isSigner,writable:k.isWritable})),data:Buffer.from(ix.data).toString('hex')}))}));
    const key=deployment.factory+':'+address+':'+scope;let record=await transportRecord(key),previous=[];guard();
    if(record?.signature){
      const status=(await connection.getSignatureStatuses([record.signature],{searchTransactionHistory:true})).value[0];guard();
      if(status?.confirmationStatus==='finalized'&&!status.err){record.finalized=true;await transportRecord(key,record);return record.signature;}
      if(record.finalized)throw new Error('Original finalized receipt is unavailable; reconcile before continuing');
      if(status?.confirmationStatus==='finalized'&&status.err||!status&&await connection.getBlockHeight('finalized')>record.lastValidBlockHeight){if(!status&&!replacementSafe)throw new Error('Original recovery transaction is unconfirmed; reconcile chain state before retrying');previous=[...(record.previous||[]),{signature:record.signature,raw:record.raw,lastValidBlockHeight:record.lastValidBlockHeight}];if(previous.length>=3)throw new Error('Finite wallet retry allowance exhausted; saved artifacts are retained');record=null;}
    }
    if(!record){
      const latest=await connection.getLatestBlockhash('finalized'),tx=new Transaction({feePayer:new PublicKey(address),recentBlockhash:latest.blockhash}).add(...instructions);
      const fee=(await connection.getFeeForMessage(tx.compileMessage(),'finalized')).value;if(fee===null||fee>20000)throw new Error('Unexpected wallet transaction fee');guard();
      const feature=session.wallet.features['solana:signTransaction'];if(!feature)throw new Error('This task flow requires a wallet supporting transaction signing');
      const [signed]=await feature.signTransaction({account:session.account,chain:'solana:devnet',transaction:tx.serialize({requireAllSignatures:false,verifySignatures:false})});guard();
      const actual=Transaction.from(Buffer.from(signed.signedTransaction));if(!actual.serializeMessage().equals(tx.serializeMessage())||!actual.verifySignatures())throw new Error('Wallet changed the approved transaction');
      const raw=actual.serialize();if(raw.length>1232)throw new Error('Wallet packet exceeds chain limit');
      record={schema:'flybrainlabs-wallet-transport-v4',scope,signature:base58(actual.signature),raw:raw.toString('base64'),lastValidBlockHeight:latest.lastValidBlockHeight,feeLamports:fee,previous,finalized:false};
      await transportRecord(key,record);guard();
    }
    await local?.reserveTransaction(Buffer.from(record.raw,'base64'));guard();
    try{const signature=await connection.sendRawTransaction(Buffer.from(record.raw,'base64'),{maxRetries:0,skipPreflight:false,preflightCommitment:'finalized'});if(signature!==record.signature)throw new Error('RPC returned a different transaction signature');}catch(error){if(!['RPC_UNAVAILABLE','RPC_RATE_LIMITED'].includes(error.code)&&!String(error.message).includes('already processed')){record.lastSendUnconfirmed=true;await transportRecord(key,record);}}
    await waitForFinalizedSignature(connection,record,{guard,timeoutMs:120000});guard();record.finalized=true;await transportRecord(key,record);return record.signature;
  }
  const send=(instructions,options)=>{const result=queue.catch(()=>{}).then(()=>execute(instructions,options));queue=result;return result;};
  const publishers=new Map();
  async function request(path,body,headers={}){
    const response=await fetchImpl(new URL('/api/task-factory/v4/'+path,api),{method:'POST',headers:{...auth(session),...headers},body,credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(30000)});
    let value;try{value=await response.json();}catch{throw new Error('Artifact gateway response unavailable');}
    if(!response.ok)throw Object.assign(new Error(value.code||'Artifact publication failed'),{status:response.status,code:value.code});return value;
  }
  const contentStore=new FactoryContentStoreV4({sources:deployment.contentSources,fetch:fetchImpl,maxBytes:deployment.maxContentBytes||128*1024*1024,
    authorizeUpload:async value=>{const result=await request('uploads',JSON.stringify(value),{'Content-Type':'application/json'});for(const object of result.objects)publishers.set(object.hash,value.submission);return result;},
    upload:async(identity,blob)=>{
      const submission=publishers.get(identity);if(!submission)throw new Error('Original commitment upload authorization is required');
      for(let offset=0;offset<blob.size;){const part=blob.slice(offset,Math.min(offset+1024*1024,blob.size));let result;
        for(let attempt=0;attempt<4;attempt++)try{result=await request('content/'+identity+'.bin?submission='+encodeURIComponent(submission)+'&offset='+offset+'&total='+blob.size,part,{'Content-Type':'application/octet-stream'});break;}catch(error){if(attempt===3||error.status&&error.status<500&&error.status!==429)throw error;await new Promise(ok=>setTimeout(ok,1000*(attempt+1)));}
        if(!Number.isSafeInteger(result.received)||result.received<=offset||result.received>blob.size)throw new Error('Artifact upload cursor mismatch');offset=result.received;
      }
    }});
  return {wallet,send,connection,contentStore,rpc,readBalances,isSignedIn:()=>signedIn(session),assertMiningAuthorization:()=>{rpc.assertReady();auth(session);}};
}
