// Browser-private durable idempotent outbox. Saved before the first network
// request, and retained on any ambiguous response; never exposed by Explorer.
const key='flybrain-service-pending-v1';
export function pendingRequest(){try{return JSON.parse(localStorage.getItem(key)||'null');}catch{return null;}}
export function persistRequest(fields){const serialized=JSON.stringify(fields),prior=pendingRequest();if(prior&&prior.serialized!==serialized)throw new Error('Recover the unfinished request before creating a different one.');const pending=prior||{requestId:crypto.randomUUID(),accessToken:Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join(''),serialized,fields,state:'pending'};localStorage.setItem(key,JSON.stringify(pending));return pending;}
export function commitRequest(requestId){const old=pendingRequest();if(old?.requestId===requestId)localStorage.removeItem(key);}
