"use strict";
(() => {
 const storageKey="flypow-wallet-v1",encoder=new TextEncoder();
 let signingKey=null,keystore=null,unlockPromise=null;
 try{keystore=JSON.parse(localStorage.getItem(storageKey)||"null");}catch{}
 const t=(s)=>window.FlyI18n?.t(s)||s;
 const hex=bytes=>[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,"0")).join("");
 const fromHex=s=>Uint8Array.from(s.match(/../g)||[],x=>parseInt(x,16));
 const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes)));
 const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
 function concat(...parts){let out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0)),at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;}
 function le(n,size){const b=new Uint8Array(size);let x=BigInt(n);for(let i=0;i<size;i++){b[i]=Number(x&255n);x>>=8n;}return b;}
 async function addressOf(raw){
  const domain=encoder.encode("FlyPoW/wallet-address/v1");
  const transcript=concat(le(domain.length,4),domain,le(1,4),le(raw.length,8),raw);
  return "fly1"+hex(await crypto.subtle.digest("SHA-256",transcript)).slice(0,40);
 }
 async function encryptionKey(password,salt){
  const key=await crypto.subtle.importKey("raw",encoder.encode(password),"PBKDF2",false,["deriveKey"]);
  return crypto.subtle.deriveKey({name:"PBKDF2",salt,iterations:310000,hash:"SHA-256"},key,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
 }
 function notify(){document.dispatchEvent(new CustomEvent("flypow:wallet"));refreshHeader();}
 function refreshHeader(){
  const element=document.getElementById("wallet-link");if(element)element.textContent=keystore?keystore.address.slice(0,8)+"…"+keystore.address.slice(-4):t("Wallet");
 }
 async function create(password){
  if(keystore)throw new Error(t("Back up and remove the current wallet before creating another."));
  if(password.length<10)throw new Error(t("Use a password of at least 10 characters."));
  const pair=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]);
  const raw=new Uint8Array(await crypto.subtle.exportKey("raw",pair.publicKey));
  const secret=new Uint8Array(await crypto.subtle.exportKey("pkcs8",pair.privateKey));
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await encryptionKey(password,salt);
  const encrypted=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,secret);
  signingKey=await crypto.subtle.importKey("pkcs8",secret,"Ed25519",false,["sign"]);secret.fill(0);
  keystore={format:"flypow-ed25519-aesgcm-v1",kdf:"PBKDF2-SHA256",iterations:310000,address:await addressOf(raw),public_key:hex(raw),salt:b64(salt),iv:b64(iv),ciphertext:b64(encrypted)};
  localStorage.setItem(storageKey,JSON.stringify(keystore));notify();return keystore.address;
 }
 async function unlock(password){
  if(!keystore)throw new Error(t("Create or import a wallet first."));
  const key=await encryptionKey(password,unb64(keystore.salt));
  let secret;try{secret=new Uint8Array(await crypto.subtle.decrypt({name:"AES-GCM",iv:unb64(keystore.iv)},key,unb64(keystore.ciphertext)));}catch{throw new Error(t("Wrong password or damaged wallet backup."));}
  const imported=await crypto.subtle.importKey("pkcs8",secret,"Ed25519",true,["sign"]);secret.fill(0);
  const jwk=await crypto.subtle.exportKey("jwk",imported);
  const raw=unb64(jwk.x.replace(/-/g,"+").replace(/_/g,"/"));
  if(hex(raw)!==keystore.public_key||await addressOf(raw)!==keystore.address)throw new Error(t("Wallet identity does not match its encrypted key."));
  const pkcs8=await crypto.subtle.exportKey("pkcs8",imported);
  signingKey=await crypto.subtle.importKey("pkcs8",pkcs8,"Ed25519",false,["sign"]);new Uint8Array(pkcs8).fill(0);
  notify();
 }
 async function importBackup(text,password){
  const value=JSON.parse(text);
  if(value.format!=="flypow-ed25519-aesgcm-v1"||value.iterations!==310000||!/^fly1[0-9a-f]{40}$/.test(value.address)||!/^[0-9a-f]{64}$/.test(value.public_key))throw new Error(t("Unsupported wallet backup."));
  if(keystore)throw new Error(t("Back up and remove the current wallet before importing another."));
  const previous=keystore;keystore=value;
  try{await unlock(password);localStorage.setItem(storageKey,JSON.stringify(value));notify();}catch(error){keystore=previous;signingKey=null;throw error;}
 }
 function exportBackup(){if(!keystore)throw new Error(t("Create or import a wallet first."));window.FlySite.downloadJSON(keystore,"flypow-wallet-"+keystore.address.slice(-8)+".json");}
 async function askUnlock(){
  if(signingKey)return;
  if(!keystore){location.href="/wallet";throw new Error(t("Create or import a wallet first."));}
  if(unlockPromise)return unlockPromise;
  unlockPromise=new Promise((resolve,reject)=>{
   const dialog=document.createElement("dialog");dialog.className="wallet-dialog";
   const title=document.createElement("h2");title.textContent=t("Unlock wallet");
   const note=document.createElement("p");note.textContent=t("Your private key stays in this browser. It is never sent to the server.");
   const form=document.createElement("form"),input=document.createElement("input");input.type="password";input.autocomplete="current-password";input.placeholder=t("Wallet password");input.required=true;
   const error=document.createElement("p");error.className="notice";
   const submit=document.createElement("button");submit.className="button button-light";submit.textContent=t("Unlock");
   const cancel=document.createElement("button");cancel.type="button";cancel.className="button button-ghost";cancel.textContent=t("Cancel");
   form.append(input,error,submit,cancel);dialog.append(title,note,form);document.body.append(dialog);
   const close=()=>{dialog.close();dialog.remove();unlockPromise=null;};
   cancel.onclick=()=>{close();reject(new Error(t("Wallet unlock cancelled.")));};
   dialog.addEventListener("cancel",event=>{event.preventDefault();close();reject(new Error(t("Wallet unlock cancelled.")));});
   form.onsubmit=async event=>{event.preventDefault();submit.disabled=true;try{await unlock(input.value);input.value="";close();resolve();}catch(e){error.textContent=e.message;submit.disabled=false;}};
   dialog.showModal();input.focus();
  });return unlockPromise;
 }
 async function account(){if(!keystore)return null;return window.FlySite.api("/api/network/accounts/"+keystore.address);}
 async function action(name,payload={}){
  await askUnlock();
  const a=await account();
  const request={public_key:keystore.public_key,nonce:a.nonce,expires_at:a.server_time+180,action:name,payload:JSON.stringify(payload),signature:""};
  const message=["FlyPoW signed action v1",a.network_id,request.public_key,request.nonce,String(request.expires_at),name,request.payload].join("\n");
  request.signature=hex(await crypto.subtle.sign("Ed25519",signingKey,encoder.encode(message)));
  return window.FlySite.api("/api/network/action",request);
 }
 async function register(){
  const a=await account();if(!a)throw new Error(t("Create or import a wallet first."));
  if(a.exists)return a;
  const referrer=localStorage.getItem("flypow-referrer")||"";
  await action("register",{referrer});return account();
 }
 const ref=new URLSearchParams(location.search).get("ref");
 if(ref&&/^fly1[0-9a-f]{40}$/.test(ref)&&!localStorage.getItem("flypow-referrer"))localStorage.setItem("flypow-referrer",ref);
 window.FlyWallet={create,unlock,importBackup,exportBackup,action,register,account,askUnlock,
  lock(){signingKey=null;localStorage.setItem("flypow-wallet-lock",String(Date.now()));notify();},
  remove(){signingKey=null;keystore=null;localStorage.removeItem(storageKey);notify();},
  get address(){return keystore?.address||null;},get unlocked(){return !!signingKey;},
  amount(atoms){const n=BigInt(atoms||"0");return (n/100000000n).toLocaleString("en-US")+"."+String(n%100000000n).padStart(8,"0");},
  short(address){return address?address.slice(0,10)+"…"+address.slice(-6):"—";}
 };
 document.addEventListener("DOMContentLoaded",refreshHeader);
 document.addEventListener("flypow:language",refreshHeader);
 window.addEventListener?.("pagehide",()=>{signingKey=null;});
 window.addEventListener?.("pageshow",notify);
 window.addEventListener?.("storage",event=>{
  if(event.key===storageKey){signingKey=null;try{keystore=JSON.parse(event.newValue||"null");}catch{keystore=null;}notify();}
  if(event.key==="flypow-wallet-lock"){signingKey=null;notify();}
 });
})();
