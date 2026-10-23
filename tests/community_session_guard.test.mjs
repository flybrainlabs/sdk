import test from 'node:test';
import assert from 'node:assert/strict';
import {CommunityClient} from '../web/community-client.mjs';

function session(){return {generation:1,account:{address:'synthetic-account-a'},login:{token:'synthetic-token-a',csrfToken:'synthetic-csrf-a'},cleared:0,guard(generation,wallet){if(generation!==this.generation||wallet!==this.account.address)throw Object.assign(new Error('Stale account'),{code:'STALE_WALLET'});},clearLogin(){this.cleared++;this.login=null;}};}
function deferred(){let resolve;return {promise:new Promise(done=>{resolve=done;}),resolve:value=>resolve(value)};}
for(const kind of ['json','error','download'])test('Account switch while consuming '+kind+' never returns another account response',async()=>{
  const previous=globalThis.fetch,body=deferred(),headers=deferred(),current=session(),client=new CommunityClient({apiBase:'https://example.invalid'},current);
  globalThis.fetch=async()=>{headers.resolve();return {ok:kind!=='error',status:kind==='error'?401:200,json:()=>body.promise,blob:()=>body.promise};};
  try{
    const result=kind==='download'?client.projectExport():client.projectMe();
    await headers.promise;await Promise.resolve();
    current.account={address:'synthetic-account-b'};current.generation++;current.login={token:'synthetic-token-b',csrfToken:'synthetic-csrf-b'};
    body.resolve(kind==='error'?{code:'SESSION_REQUIRED'}:kind==='download'?new Blob(['synthetic private export']):{applications:[{id:'synthetic-private-record-a'}]});
    await assert.rejects(result,error=>error.code==='STALE_WALLET');assert.equal(current.cleared,0);assert.equal(current.login.token,'synthetic-token-b');
  }finally{globalThis.fetch=previous;}
});

test('Recruitment mutation keeps the existing endpoint and CSRF boundaries',async()=>{
  const previous=globalThis.fetch,current=session(),client=new CommunityClient({apiBase:'https://example.invalid'},current);let request;
  globalThis.fetch=async(url,options)=>{request={url,options};return {ok:true,status:200,json:async()=>({received:true})};};
  try{
    await client.projectInterest({projectId:'FBW-P01',interested:true,requestId:'synthetic-request-0001'});
    assert.equal(request.url,'https://example.invalid/api/community/projects/interests');assert.equal(request.options.method,'POST');assert.equal(request.options.headers['X-Mining-CSRF'],'synthetic-csrf-a');assert.equal(request.options.headers.Authorization,'Bearer synthetic-token-a');assert.equal(request.options.cache,'no-store');
    assert.throws(()=>client.projectChange('invalid','update',{}));assert.throws(()=>client.projectChange('a'.repeat(32),'start-training',{}));
  }finally{globalThis.fetch=previous;}
});

test('An old 401 cannot clear a renewed login on the same wallet',async()=>{
  const previous=globalThis.fetch,body=deferred(),headers=deferred(),current=session(),client=new CommunityClient({apiBase:'https://example.invalid'},current);
  globalThis.fetch=async()=>{headers.resolve();return {ok:false,status:401,json:()=>body.promise};};
  try{
    const result=client.projectMe();await headers.promise;await Promise.resolve();
    current.login={token:'synthetic-renewed-token',csrfToken:'synthetic-renewed-csrf'};
    body.resolve({code:'SESSION_REQUIRED'});
    await assert.rejects(result,error=>error.code==='STALE_WALLET');assert.equal(current.cleared,0);assert.equal(current.login.token,'synthetic-renewed-token');
  }finally{globalThis.fetch=previous;}
});
