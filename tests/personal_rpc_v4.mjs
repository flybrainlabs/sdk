// All provider replies are fixtures. No API key, wallet signature or chain write.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {FactoryUserRpcV4,heliusRpcUrl,personalRpcFetchV4} from '../web/factory-user-rpc-v4.mjs';
import {factoryWalletAdapter} from '../web/factory-wallet-adapter-v4.mjs';
const fixture=JSON.parse(await readFile('tests/vectors/factory-user-rpc-v4.json','utf8')),deployment=fixture.deployment;
const url='https://devnet.helius-rpc.com/?api-key='+'fixture-not-a-secret';
const mainnet='https://mainnet.helius-rpc.com/?api-key='+'fixture-not-a-secret';
const memory=()=>{const data=new Map([['unrelated-model-key','retained']]);return {getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k),data};};
const session=memory(),persistent=memory(),calls=[];let wrongNetwork=false,wrongOwner=false,unavailable=false,gate=null;
const transport=async(input,options)=>{
  if(gate)await gate;
  if(unavailable)throw new Error('Provider failed: '+url);
  const headers=new Headers(options.headers),request=JSON.parse(options.body),target=String(input),custom=target.startsWith('https://devnet.helius-rpc.com/')||target.startsWith('https://mainnet.helius-rpc.com/');
  calls.push({target,headers,method:request.method,options});
  if(custom){assert(!headers.has('authorization')&&!headers.has('x-mining-csrf')&&!headers.has('cookie'));assert.equal(options.credentials,'omit');assert.equal(options.referrerPolicy,'no-referrer');assert.equal(options.redirect,'error');}
  if(target.endsWith('/uploads'))return new Response(JSON.stringify({objects:[],authorized:true}));
  const method=request.method;let result;
  if(method==='getGenesisHash')result=wrongNetwork?'wrong-network':deployment.genesisHash;
  else if(method==='getAccountInfo'){const value=structuredClone(fixture.accounts[request.params[0]]);if(wrongOwner)value.owner='11111111111111111111111111111111';result={context:{slot:fixture.slot},value};}
  else if(method==='sendTransaction')result='fixture-signature';
  else throw new Error('Unexpected fixture request');
  return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
};
const rpc=new FactoryUserRpcV4({deployment,fetch:transport,session,persistent});
for(const bad of ['http://devnet.helius-rpc.com/?api-key=x','https://evil.invalid/?api-key=x','https://devnet.helius-rpc.com/','https://user:pass@devnet.helius-rpc.com/?api-key=x',url+'#fragment'])assert.throws(()=>heliusRpcUrl(bad));
wrongNetwork=true;await assert.rejects(rpc.apply(mainnet),e=>e.code==='RPC_WRONG_NETWORK');assert.equal(rpc.endpoint,null);assert.equal(session.getItem(rpc.key),null);wrongNetwork=false;
wrongOwner=true;await assert.rejects(rpc.apply(url),e=>e.code==='RPC_FACTORY_MISMATCH');assert.equal(rpc.endpoint,null);wrongOwner=false;
let release;gate=new Promise(ok=>release=ok);const first=rpc.apply(url);assert.equal(rpc.apply(url),first);assert(rpc.busy);release();await first;gate=null;assert.equal(rpc.endpoint,url);assert.equal(persistent.getItem(rpc.key),null);assert.equal(JSON.parse(session.getItem(rpc.key)).endpoint,url);
assert(!JSON.stringify(rpc).includes('fixture-not-a-secret'));assert.equal(rpc.status,'custom-session');
const restored=new FactoryUserRpcV4({deployment,fetch:transport,session,persistent});assert.equal(restored.endpoint,null);await restored.initialize();assert.equal(restored.endpoint,url);
await restored.apply(url,{remember:true});assert.equal(session.getItem(rpc.key),null);assert.equal(JSON.parse(persistent.getItem(rpc.key)).endpoint,url);
const before=persistent.getItem(rpc.key);wrongNetwork=true;await assert.rejects(restored.apply(mainnet,{remember:true}));assert.equal(restored.endpoint,url);assert.equal(persistent.getItem(rpc.key),before);wrongNetwork=false;
unavailable=true;const failedRestore=new FactoryUserRpcV4({deployment,fetch:transport,session,persistent});await failedRestore.initialize();assert.equal(failedRestore.endpoint,null);assert.equal(failedRestore.status,'restore-unavailable');await assert.rejects(personalRpcFetchV4(url,{},transport),e=>!e.message.includes('fixture-not-a-secret'));unavailable=false;
const financial={account:{address:'fixture-wallet'},login:{wallet:'fixture-wallet',token:'fixture-project-session',csrfToken:'fixture-project-csrf',expiresAt:Date.now()/1000+3600}};
const adapter=factoryWalletAdapter({deployment,session:financial,fetch:transport,rpc:restored});
await adapter.connection.getGenesisHash();await adapter.connection.sendRawTransaction(Uint8Array.of(1,2,3));
assert(calls.at(-1).target.startsWith('https://devnet.helius-rpc.com/'));assert(!calls.at(-1).headers.has('authorization'));
await adapter.contentStore.begin({submission:'fixture'});assert(calls.at(-1).target.endsWith('/uploads'));assert.equal(calls.at(-1).headers.get('authorization'),'Bearer fixture-project-session');assert(!calls.at(-1).target.includes('api-key'));
restored.reset();await adapter.connection.sendRawTransaction(Uint8Array.of(1,2,3));assert.equal(calls.at(-1).target,deployment.rpcUrl);assert.equal(calls.at(-1).headers.get('authorization'),'Bearer fixture-project-session');assert.equal(calls.at(-1).headers.get('x-mining-csrf'),'fixture-project-csrf');assert.equal(session.getItem(rpc.key),null);assert.equal(persistent.getItem(rpc.key),null);assert.equal(persistent.getItem('unrelated-model-key'),'retained');
const sanitized=await personalRpcFetchV4(url,{headers:{Authorization:'never-forward','X-Mining-CSRF':'never-forward',Cookie:'never-forward'}},async(u,o)=>{assert(!new Headers(o.headers).has('authorization'));return new Response(JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32000,message:url,data:{secret:url}}}));});assert(!JSON.stringify(await sanitized.json()).includes('fixture-not-a-secret'));
console.log(JSON.stringify({passed:true,groups:6,checks:['wrong network and contract ownership cannot replace a connection','Helius HTTPS allowlist and private credential-free errors','coalesced checks, tab storage, explicit persistence and reload revalidation','unavailable saved RPC falls back without deleting preferences','personal RPC receives no project session, CSRF or cookies; uploads retain project authorization','default reset retains model keys and wallet authorization'],fixtureProvider:true,realHeliusKeyUsed:false,chainWrites:0}));
