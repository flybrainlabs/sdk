// Wallet-owned V4 transactions and authenticated content publication. Login is
// reused for HTTP authorization; no V3 rent grant is created or consumed.
import {Connection,PublicKey,Transaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import {canonical,hash} from './target-protocol-v2.mjs';
import {waitForFinalizedSignature} from './wallet-rpc-v3.mjs';
import {FactoryContentStoreV4} from './factory-content-store-v4.mjs';

const base58=bytes=>{const a='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n,s='';for(const b of bytes)n=n*256n+BigInt(b);while(n){s=a[Number(n%58n)]+s;n/=58n;}for(const b of bytes){if(b)break;s='1'+s;}return s;};
async function transportRecord(key,value){
  const db=await new Promise((ok,no)=>{const r=indexedDB.open('flybrainlabs-wallet-transactions-v4',1);r.onupgradeneeded=()=>r.result.createObjectStore('transactions');r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error);});
  try{return await new Promise((ok,no)=>{const t=db.transaction('transactions',value===undefined?'readonly':'readwrite'),r=value===undefined?t.objectStore('transactions').get(key):t.objectStore('transactions').put(value,key);let result;r.onsuccess=()=>result=r.result;r.onerror=()=>no(r.error);t.oncomplete=()=>ok(result);t.onerror=()=>no(t.error);});}finally{db.close();}
}
function auth(session){
  if(!session.account||!session.login||session.login.wallet!==session.account.address||Number(session.login.expiresAt)<=Date.now()/1000)throw Object.assign(new Error('Sign in with the connected wallet before mining'),{code:'wallet-login-required'});
  return {Authorization:'Bearer '+session.login.token,'X-Mining-CSRF':session.login.csrfToken};
}
export function factoryWalletAdapter({deployment,session,fetch:fetchImpl=globalThis.fetch}){
  const endpoint=new URL(deployment.rpcUrl),api=new URL(deployment.apiBase);
  if(deployment.cluster!=='devnet'||endpoint.origin!==api.origin||endpoint.pathname!=='/api/task-factory/v4/rpc'||api.protocol!=='https:'||api.username||api.password||api.search||api.hash)throw new Error('Unsupported V4 public gateway');
  const transport=async(url,options={})=>{if(String(url)!==endpoint.href)throw new Error('Factory RPC transport changed');const request=JSON.parse(options.body),headers=new Headers(options.headers);if(request.method==='sendTransaction')for(const [k,v]of Object.entries(auth(session)))headers.set(k,v);const response=await fetchImpl(url,{...options,headers,signal:AbortSignal.timeout(15000),credentials:'omit',cache:'no-store'});if(!response.ok)throw Object.assign(new Error(response.status===429?'Chain gateway is busy; saved results are retained':'Chain gateway is temporarily unavailable'),{code:response.status===429?'RPC_RATE_LIMITED':'RPC_UNAVAILABLE',status:response.status});return response;};
  const connection=new Connection(endpoint.href,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:transport});
  const wallet={get publicKey(){return session.account?.publicKey||null;}};
  let queue=Promise.resolve();
  async function execute(instructions){
    auth(session);const generation=session.generation,address=session.account.address,guard=()=>session.guard(generation,address);guard();
    if(await connection.getGenesisHash()!==deployment.genesisHash)throw new Error('Factory chain identity changed');
    const scope=await hash(canonical({program:deployment.programId,factory:deployment.factory,wallet:address,instructions:instructions.map(ix=>({program:ix.programId.toBase58(),keys:ix.keys.map(k=>({address:k.pubkey.toBase58(),signer:k.isSigner,writable:k.isWritable})),data:Buffer.from(ix.data).toString('hex')}))}));
    const key=deployment.factory+':'+address+':'+scope;let record=await transportRecord(key),previous=[];guard();
    if(record?.signature){
      const status=(await connection.getSignatureStatuses([record.signature],{searchTransactionHistory:true})).value[0];guard();
      if(status?.confirmationStatus==='finalized'&&!status.err){record.finalized=true;await transportRecord(key,record);return record.signature;}
      if(record.finalized)throw new Error('Original finalized receipt is unavailable; reconcile before continuing');
      if(status?.confirmationStatus==='finalized'&&status.err||!status&&await connection.getBlockHeight('finalized')>record.lastValidBlockHeight){previous=[...(record.previous||[]),{signature:record.signature,raw:record.raw,lastValidBlockHeight:record.lastValidBlockHeight}];if(previous.length>=3)throw new Error('Finite wallet retry allowance exhausted; saved artifacts are retained');record=null;}
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
    try{const signature=await connection.sendRawTransaction(Buffer.from(record.raw,'base64'),{maxRetries:0,skipPreflight:false,preflightCommitment:'finalized'});if(signature!==record.signature)throw new Error('RPC returned a different transaction signature');}catch(error){if(!['RPC_UNAVAILABLE','RPC_RATE_LIMITED'].includes(error.code)&&!String(error.message).includes('already processed')){record.lastSendUnconfirmed=true;await transportRecord(key,record);}}
    await waitForFinalizedSignature(connection,record,{guard,timeoutMs:120000});guard();record.finalized=true;await transportRecord(key,record);return record.signature;
  }
  const send=instructions=>{const result=queue.catch(()=>{}).then(()=>execute(instructions));queue=result;return result;};
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
  return {wallet,send,connection,contentStore,assertMiningAuthorization:()=>{auth(session);}};
}
