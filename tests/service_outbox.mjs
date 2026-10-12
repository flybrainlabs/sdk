import assert from 'node:assert/strict';
const stored=new Map();globalThis.localStorage={getItem:k=>stored.get(k)||null,setItem:(k,v)=>stored.set(k,v),removeItem:k=>stored.delete(k)};
const {persistRequest,pendingRequest,commitRequest}=await import('../web/service-outbox.mjs');
const fields={problem:'isolated transport recovery',termsAccepted:true};
const first=persistRequest(fields);
// Lost POST response / refreshed module reads the same durable identity.
const refreshed=await import('../web/service-outbox.mjs?refresh');
assert.equal(refreshed.pendingRequest().requestId,first.requestId);
assert.equal(refreshed.persistRequest(fields).accessToken,first.accessToken);
assert.throws(()=>persistRequest({...fields,problem:'changed request'}),/unfinished/);
commitRequest('unrelated-response');assert.equal(pendingRequest().requestId,first.requestId);
commitRequest(first.requestId);assert.equal(pendingRequest(),null);
console.log('Private outbox retains original request across lost response/refresh; payload change rejected');
