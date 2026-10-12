// Actual FBRP1 spikes only. No inferred voltage or dendritic propagation is generated.
export const hex = a => Array.from(a,b=>b.toString(16).padStart(2,'0')).join('');
export const canonical = v => JSON.stringify(normalize(v));
function normalize(v){if(typeof v==='bigint')return v.toString();if(Array.isArray(v))return v.map(normalize);if(v && typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,normalize(v[k])]));return v;}
export const jsonBytes = v => new TextEncoder().encode(canonical(v)+'\n');
export const digest = async b => hex(new Uint8Array(await crypto.subtle.digest('SHA-256',b)));
// Zero-copy event views. Only the bounded preview creates two-element arrays.
export class SpikeEvents {
  constructor(bytes,start,count){this.length=count;this.view=new DataView(bytes.buffer,bytes.byteOffset+start,count*8);}
  step(i){return this.view.getUint32(i*8,true);}
  index(i){return this.view.getUint32(i*8+4,true);}
  forEach(fn){for(let i=0;i<this.length;i++)fn(this.step(i),this.index(i),i);}
  *[Symbol.iterator](){for(let i=0;i<this.length;i++)yield [this.step(i),this.index(i)];}
}
export function decodeResponse(buffer,config,task,headerOnly=false,declaredBytes=null){
  const b=buffer instanceof Uint8Array?buffer:new Uint8Array(buffer);const v=new DataView(b.buffer,b.byteOffset,b.length);
  if(b.length<480 || new TextDecoder().decode(b.slice(0,8))!=='FBRP1\0\0\0')throw new Error('Unsupported full response archive');
  const n=v.getUint32(8,true),target=v.getUint32(12,true),steps=v.getUint32(16,true),topCount=b[20];
  if(n!==config.neuron_count || steps!==config.steps || target!==task.targetIndex || topCount>8 || b.slice(21,24).some(x=>x))throw new Error('Response identity/count mismatch');
  const global=Array.from({length:8},(_,i)=>v.getBigUint64(24+8*i,true));const roi=Array.from({length:16},(_,i)=>v.getBigInt64(88+8*i,true));const time=Array.from({length:32},(_,i)=>v.getInt32(216+4*i,true));
  const top=Array.from({length:8},(_,i)=>({bodyId:v.getBigUint64(344+16*i,true),delta:v.getInt32(352+16*i,true),firstStep:v.getUint32(356+16*i,true)}));
  const a=v.getUint32(472,true),c=v.getUint32(476,true);
  if(480+8*(a+c)!==(declaredBytes??b.length) || global[0]!==BigInt(a) || global[1]!==BigInt(c) || time.reduce((s,x)=>s+BigInt(x),0n)!==BigInt(c)-BigInt(a))throw new Error('Full archive summary/event counts disagree');
  for(let i=0;i<8;i++){const t=top[i];if(i>=topCount){if(t.bodyId||t.delta||t.firstStep)throw new Error('Unused Top8 is nonzero');continue;}if(!t.bodyId||t.firstStep>=steps||top.slice(0,i).some(p=>p.bodyId===t.bodyId))throw new Error('Top8 identity/step');if(i && (Math.abs(top[i-1].delta)<Math.abs(t.delta)||(Math.abs(top[i-1].delta)===Math.abs(t.delta)&&top[i-1].bodyId>=t.bodyId)))throw new Error('Top8 ordering');}
  function events(start,count){const out=new SpikeEvents(b,start,count);let lastStep=-1,lastIndex=-1;out.forEach((step,index)=>{if(step>=steps||index>=n||step<lastStep||(step===lastStep&&index<=lastIndex))throw new Error('Unordered/duplicate/out-of-range spike');lastStep=step;lastIndex=index;});return out;}
  return {global,roi,time,top,topCount,aCount:a,bCount:c,eventsA:headerOnly?null:events(480,a),eventsB:headerOnly?null:events(480+8*a,c)};
}
function previewCells(r,config,task,bodyIndex){
  const selected=[BigInt(task.bodyId),...r.top.slice(0,r.topCount).map(x=>x.bodyId)].filter((x,i,a)=>a.indexOf(x)===i);
  const cells=selected.map(body=>({body_id:body.toString(),model_index:bodyIndex(body)}));
  if(cells.some(c=>!Number.isInteger(c.model_index)||c.model_index<0||c.model_index>=config.neuron_count))throw new Error('Preview cell missing from full frozen registry');
  return cells;
}
export async function buildRecord(buffer,config,task,bodyIndex,checkedRoot=null){
  const bytes=buffer instanceof Uint8Array?buffer:new Uint8Array(buffer);const r=decodeResponse(bytes,config,task);
  const cells=previewCells(r,config,task,bodyIndex);
  const byIndex=new Map(cells.map(c=>[c.model_index,c.body_id]));
  const spikes=[[],[]];for(const [lane,events]of [r.eventsA,r.eventsB].entries())events.forEach((step,index)=>{if(byIndex.has(index))spikes[lane].push([step,byIndex.get(index)]);});
  return assembleRecord(r,config,task,cells,spikes,checkedRoot||await digest(bytes),bytes.length);
}
// A complete file is validated in bounded event pages without materializing every event.
export async function buildRecordFile(file,config,task,bodyIndex,checkedRoot){
  if(!checkedRoot||file.size>(config.max_archive_bytes||128*1024*1024))throw new Error('Response file resource bound');
  const r=decodeResponse(new Uint8Array(await file.slice(0,480).arrayBuffer()),config,task,true,file.size),cells=previewCells(r,config,task,bodyIndex),byIndex=new Map(cells.map(c=>[c.model_index,c.body_id])),spikes=[[],[]];
  const prior=[[-1,-1],[-1,-1]];let atEvent=0;
  for(let at=480;at<file.size;at+=4*1024*1024){
    const bytes=new Uint8Array(await file.slice(at,at+4*1024*1024).arrayBuffer()),events=new SpikeEvents(bytes,0,bytes.length/8);
    events.forEach((step,index)=>{const lane=atEvent++<r.aCount?0:1;const lastStep=prior[lane][0],lastIndex=prior[lane][1];if(step>=config.steps||index>=config.neuron_count||step<lastStep||(step===lastStep&&index<=lastIndex))throw new Error('Unordered/duplicate/out-of-range spike');prior[lane][0]=step;prior[lane][1]=index;if(byIndex.has(index))spikes[lane].push([step,byIndex.get(index)]);});
  }
  return assembleRecord(r,config,task,cells,spikes,checkedRoot,file.size);
}
async function assembleRecord(r,config,task,cells,spikes,root,byteLength){
  const preview={schema:'flypow-preview-v1',task_id:task.taskId,body_id:String(task.bodyId),target_index:task.targetIndex,registry_root:config.registry_sha256,model_root:config.model_root_sha256,
    result_root:root,steps:config.steps,time_step_us:config.time_step_us,stimulus:task.stimulus,seed_hex:task.seed.toString(16).padStart(16,'0'),cells,
    spikes_a:spikes[0],spikes_b:spikes[1],population_delta_by_bin:r.time,global:r.global,roi:r.roi,top:r.top,top_count:r.topCount};
  const previewBytes=jsonBytes(preview),previewRoot=await digest(previewBytes);
  const manifest={schema:'flypow-archive-manifest-v1',task_id:task.taskId,result_root:root,preview_root:previewRoot,
    files:[{name:'response.bin',bytes:byteLength,sha256:root},{name:'preview.json',bytes:previewBytes.length,sha256:previewRoot}]};
  const manifestBytes=jsonBytes(manifest),archiveRoot=await digest(manifestBytes);
  const record={schema:'flypow-response-record-v1',task_id:task.taskId,global_task_index:String(task.k),body_id:String(task.bodyId),target_index:task.targetIndex,
    seed_hex:preview.seed_hex,stimulus:task.stimulus,full_model_neuron_count:config.neuron_count,result_root:root,preview_root:previewRoot,archive_manifest_hash:archiveRoot,
    contributor:null,verification:'LOCAL_UNVERIFIED',chain:null,claim_atoms:'0',summary:{global:r.global,roi:r.roi,time:r.time,top:r.top.slice(0,r.topCount)}};
  return {record,preview,previewBytes,manifest,manifestBytes,parsed:r,resultRoot:root,previewRoot,archiveRoot};
}
export function replayFrame(preview,body,step,mode){
  if(!Number.isInteger(step)||step<0||step>=preview.steps||!['a','b','difference'].includes(mode)||!preview.cells.some(c=>c.body_id===String(body)))throw new Error('Replay frame outside recorded identity/time');
  const a=preview.spikes_a.some(e=>e[0]===step&&e[1]===String(body)),b=preview.spikes_b.some(e=>e[0]===step&&e[1]===String(body));
  return {a,b,active:mode==='a'?a:mode==='b'?b:a!==b,color:mode==='difference'?(a===b?'#808080':b?'#d8ff85':'#ff8f88'):(mode==='a'?a:b)?'#d8ff85':'#808080'};
}
