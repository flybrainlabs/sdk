// Content availability is independent of task authority. Deployments can use
// multiple object stores or mirrors; every returned object is hash checked.
import {hash,root} from './target-protocol-v2.mjs';
export class FactoryContentStoreV4 {
  constructor({sources,upload=null,maxBytes=128*1024*1024,fetch:transport=globalThis.fetch}){
    if(!Array.isArray(sources)||!sources.length||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new Error('Content sources and finite byte limit required');
    this.sources=sources.map(base=>{const u=new URL(base);if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error('Invalid content source');return u.href.endsWith('/')?u.href:u.href+'/';});Object.assign(this,{upload,maxBytes,transport});
  }
  async get(identity,maxBytes=this.maxBytes){
    root(identity);maxBytes=Math.min(maxBytes,this.maxBytes);let last;
    for(const base of this.sources)try{
      const response=await this.transport(new URL(identity+'.bin',base),{cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(30000)});
      if(!response.ok)throw new Error('Content source unavailable');
      const declared=response.headers.get('content-length');if(declared!==null&&Number(declared)>maxBytes)throw new Error('Content exceeds frozen byte limit');
      const reader=response.body.getReader(),chunks=[];let size=0;
      try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes)throw new Error('Content exceeds frozen byte limit');chunks.push(value);}}catch(e){await reader.cancel().catch(()=>{});throw e;}
      const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
      if(await hash(bytes)!==identity)throw new Error('Content hash mismatch');return bytes;
    }catch(error){last=error;}
    throw last||new Error('Content unavailable');
  }
  async put(identity,value){
    root(identity);if(!this.upload)throw new Error('No artifact publisher configured');const blob=value instanceof Blob?value:new Blob([value]);
    if(blob.size>this.maxBytes||await hash(await blob.arrayBuffer())!==identity)throw new Error('Artifact hash or size mismatch');
    // The deployment supplies an authorized uploader, for example a signed
    // object-store request. No write credential is embedded in public code.
    await this.upload(identity,blob);await this.get(identity,blob.size);return identity;
  }
}
