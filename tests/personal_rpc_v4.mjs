// Provider replies are fixtures. No real API key, wallet signature or chain write.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {FactoryUserRpcV4,heliusRpcUrl,personalRpcFetchV4} from '../web/factory-user-rpc-v4.mjs';
import {factoryWalletAdapter} from '../web/factory-wallet-adapter-v4.mjs';
const fixture=JSON.parse(await readFile('tests/vectors/factory-user-rpc-v4.json','utf8')),deployment=fixture.deployment;
const key='fixture-not-a-secret',url='https://devnet.helius-rpc.com/?api-key='+key;
const memory=()=>{const data=new Map([['unrelated-model-key','retained']]);return {getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k),data};};
const session=memory(),persistent=memory(),calls=[];let wrongNetwork=false,wrongOwner=false,unavailable=false,gate=null;
const transport=async(input,options)=>{
  if(gate)await gate;
  if(unavailable)throw new Error('Provider failed: '+url);
  const headers=new Headers(options.headers),request=JSON.parse(options.body),target=String(input),custom=target.startsWith('https://devnet.helius-rpc.com/');
  calls.push({target,headers,method:request.method,options});
  if(custom){assert(!headers.has('authorization')&&!headers.has('x-mining-csrf')&&!headers.has('cookie'));assert.equal(options.credentials,'omit');assert.equal(options.referrerPolicy,'no-referrer');assert.equal(options.redirect,'error');}
  if(target.endsWith('/uploads'))return new Response(JSON.stringify({objects:[],authorized:true}));
  assert(custom,'Mining must never use a shared RPC');
  const method=request.method;let result;
  if(method==='getGenesisHash')result=wrongNetwork?'wrong-network':deployment.genesisHash;
  else if(method==='getAccountInfo'){const value=structuredClone(fixture.accounts[request.params[0]]);if(wrongOwner)value.owner='11111111111111111111111111111111';result={context:{slot:fixture.slot},value};}
  else if(method==='sendTransaction')result='fixture-signature';
  else throw new Error('Unexpected fixture request');
  return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
};
const rpc=new FactoryUserRpcV4({deployment,fetch:transport,session,persistent});
assert.equal(rpc.status,'required');assert(!rpc.ready);assert.throws(()=>rpc.request({}),e=>e.code==='RPC_REQUIRED');
assert.equal(heliusRpcUrl(' '+key+' ',deployment),url);
assert.equal(heliusRpcUrl(key,{cluster:'mainnet-beta',genesisHash:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'}),'https://mainnet.helius-rpc.com/?api-key='+key);
assert.throws(()=>heliusRpcUrl(key,{...deployment,cluster:'mainnet-beta'}),e=>e.code==='RPC_DEPLOYMENT_NETWORK');
for(const bad of ['',url,'https://evil.invalid/',key+'?x=1','with whitespace','x'.repeat(257)])await assert.rejects(rpc.apply(bad),e=>e.code==='RPC_INVALID_KEY');
assert.equal(calls.length,0);
wrongNetwork=true;await assert.rejects(rpc.apply(key),e=>e.code==='RPC_WRONG_NETWORK');assert.equal(rpc.endpoint,null);assert.equal(session.getItem(rpc.key),null);wrongNetwork=false;
wrongOwner=true;await assert.rejects(rpc.apply(key),e=>e.code==='RPC_FACTORY_MISMATCH');assert.equal(rpc.endpoint,null);wrongOwner=false;
let release;gate=new Promise(ok=>release=ok);const first=rpc.apply(key);assert.equal(rpc.apply(key),first);assert(rpc.busy&&!rpc.ready);release();await first;gate=null;assert.equal(rpc.endpoint,url);assert(rpc.ready);assert.equal(persistent.getItem(rpc.key),null);assert.equal(JSON.parse(session.getItem(rpc.key)).apiKey,key);assert(!JSON.parse(session.getItem(rpc.key)).endpoint);
assert(!JSON.stringify(rpc).includes(key));assert.equal(rpc.status,'custom-session');
const restored=new FactoryUserRpcV4({deployment,fetch:transport,session,persistent});assert.equal(restored.endpoint,null);await restored.initialize();assert.equal(restored.endpoint,url);
await restored.apply(key,{remember:true});assert.equal(session.getItem(rpc.key),null);assert.equal(JSON.parse(persistent.getItem(rpc.key)).apiKey,key);
const before=persistent.getItem(rpc.key);wrongNetwork=true;await assert.rejects(restored.apply(key,{remember:true}));assert(!restored.ready);assert.equal(persistent.getItem(rpc.key),before);wrongNetwork=false;
unavailable=true;const failedRestore=new FactoryUserRpcV4({deployment,fetch:transport,session,persistent});await failedRestore.initialize();assert.equal(failedRestore.endpoint,null);assert.equal(failedRestore.status,'restore-unavailable');assert.throws(()=>failedRestore.request({}),e=>e.code==='RPC_REQUIRED');await assert.rejects(personalRpcFetchV4(url,{},transport),e=>!e.message.includes(key));unavailable=false;
persistent.setItem(rpc.key,JSON.stringify({schema:'flybrainlabs-personal-rpc-v4',endpoint:url}));
const migrated=new FactoryUserRpcV4({deployment,fetch:transport,session,persistent});assert.equal(migrated.value,key);await migrated.initialize();assert.equal(migrated.endpoint,url);assert.deepEqual(JSON.parse(persistent.getItem(rpc.key)),{schema:'flybrainlabs-personal-rpc-v4',apiKey:key});
const financial={account:{address:'fixture-wallet'},login:{wallet:'fixture-wallet',token:'fixture-project-session',csrfToken:'fixture-project-csrf',expiresAt:Date.now()/1000+3600}};
const adapter=factoryWalletAdapter({deployment,session:financial,fetch:transport,rpc:migrated});
await adapter.connection.getGenesisHash();await adapter.connection.sendRawTransaction(Uint8Array.of(1,2,3));
assert(calls.at(-1).target.startsWith('https://devnet.helius-rpc.com/'));assert(!calls.at(-1).headers.has('authorization'));
await adapter.contentStore.begin({submission:'fixture'});assert(calls.at(-1).target.endsWith('/uploads'));assert.equal(calls.at(-1).headers.get('authorization'),'Bearer fixture-project-session');assert(!calls.at(-1).target.includes('api-key'));
migrated.reset();const count=calls.length;
await assert.rejects(adapter.connection.getGenesisHash(),e=>e.message.includes('RPC_REQUIRED'));
await assert.rejects(adapter.connection.sendRawTransaction(Uint8Array.of(1,2,3)),e=>e.message.includes('RPC_REQUIRED'));
assert.throws(()=>adapter.assertMiningAuthorization(),e=>e.code==='RPC_REQUIRED');assert.equal(calls.length,count);
assert.equal(session.getItem(rpc.key),null);assert.equal(persistent.getItem(rpc.key),null);assert.equal(persistent.getItem('unrelated-model-key'),'retained');
// A reset also cancels a request already waiting in the paced lane.
await migrated.apply(key);const queued=migrated.request({body:JSON.stringify({jsonrpc:'2.0',id:88,method:'getGenesisHash',params:[]})});migrated.reset();await assert.rejects(queued);assert.equal(calls.length,count+2);
const sanitized=await personalRpcFetchV4(url,{headers:{Authorization:'never-forward','X-Mining-CSRF':'never-forward',Cookie:'never-forward'}},async(u,o)=>{assert(!new Headers(o.headers).has('authorization'));return new Response(JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32000,message:url,data:{secret:url}}}));});assert(!JSON.stringify(await sanitized.json()).includes(key));
assert(calls.every(c=>c.target.startsWith('https://devnet.helius-rpc.com/')||c.target.endsWith('/uploads')));
console.log(JSON.stringify({passed:true,groups:8,checks:['key-only input and endpoint selection from the pinned deployment','missing key blocks reads, broadcasts and mining authorization without a shared RPC','wrong network and contract identity fail closed','coalesced checks and explicit storage persistence','failed reload remains blocked without deleting preferences','existing URL preferences migrate to keys after revalidation','personal RPC strips project credentials; uploads retain authorization','reset cancels queued requests and retains model keys'],fixtureProvider:true,realHeliusKeyUsed:false,sharedRpcRequests:0,chainWrites:0}));
