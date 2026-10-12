import fs from "node:fs";
import vm from "node:vm";
import {webcrypto,createHash} from "node:crypto";
import assert from "node:assert/strict";
const store=new Map();let backup,lastRequest;
const context={crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,BigInt,JSON,Promise,console,CustomEvent:class{},URLSearchParams,location:{search:"",href:""},
 btoa:s=>Buffer.from(s,"binary").toString("base64"),atob:s=>Buffer.from(s,"base64").toString("binary"),
 localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},
 document:{dispatchEvent(){},addEventListener(){},getElementById(){return null;}},
 window:{FlyI18n:{t:s=>s},FlySite:{downloadJSON:value=>backup=JSON.parse(JSON.stringify(value)),api:async(path,body)=>{
  if(path.startsWith("/api/network/accounts/"))return {nonce:"0",network_id:"unit-network",server_time:1000,exists:false};
  lastRequest=body;return {ok:true};
 }}}
};
vm.createContext(context);vm.runInContext(fs.readFileSync("web/wallet-core.js","utf8"),context);
const wallet=context.window.FlyWallet;
const password="temporary-test-password";
const address=await wallet.create(password);assert.match(address,/^fly1[0-9a-f]{40}$/);
wallet.exportBackup();assert.equal(backup.address,address);assert(!JSON.stringify(backup).includes(password));
await wallet.action("register",{referrer:""});
const publicKey=await webcrypto.subtle.importKey("raw",Buffer.from(lastRequest.public_key,"hex"),"Ed25519",false,["verify"]);
const message=["FlyPoW signed action v1","unit-network",lastRequest.public_key,lastRequest.nonce,String(lastRequest.expires_at),lastRequest.action,lastRequest.payload].join("\n");
assert(await webcrypto.subtle.verify("Ed25519",publicKey,Buffer.from(lastRequest.signature,"hex"),Buffer.from(message)));
wallet.lock();assert.equal(wallet.unlocked,false);
await assert.rejects(()=>wallet.unlock("wrong-password"));
await wallet.unlock(password);assert.equal(wallet.unlocked,true);
wallet.remove();await wallet.importBackup(JSON.stringify(backup),password);assert.equal(wallet.address,address);
wallet.remove();const changed={...backup,address:"fly1"+"0".repeat(40)};
await assert.rejects(()=>wallet.importBackup(JSON.stringify(changed),password));assert.equal(wallet.address,null);
console.log("Wallet encryption, backup recovery, signing and tamper tests passed.");

