// Explicit V4 side-file schemas, sharing only the unchanged FBRP numerical ABI.
import {targetBinding,validateTargetRecord} from './target-response-record.mjs';
import {jsonBytes,digest} from './response-record.mjs';
export async function factoryRecord(bundle,task,round){
  const binding={...targetBinding(task,round),protocolVersion:4},record={...bundle.record,schema:'flybrainlabs-target-response-record-v4',...binding};delete record.global_task_index;
  const preview={...bundle.preview,schema:'flybrainlabs-target-preview-v4',...binding},previewBytes=jsonBytes(preview),previewRoot=await digest(previewBytes);
  const manifest={schema:'flybrainlabs-target-trial-archive-v4',...binding,resultRoot:bundle.resultRoot,previewRoot,files:[{name:'response.bin',bytes:bundle.manifest.files[0].bytes,sha256:bundle.resultRoot},{name:'preview.json',bytes:previewBytes.length,sha256:previewRoot}]};
  const manifestBytes=jsonBytes(manifest),archiveRoot=await digest(manifestBytes);record.preview_root=previewRoot;record.archive_manifest_hash=archiveRoot;
  return {...bundle,record,preview,previewBytes,previewRoot,manifest,manifestBytes,archiveRoot};
}
export function validateFactoryRecord(record,meta,trial,task){
  if(record.schema!=='flybrainlabs-target-response-record-v4'||record.protocolVersion!==4||meta.round.pre.protocolVersion!==4||task.protocolVersion!==4)throw new Error('V4 history schema mismatch');
  // Validate common immutable numerical bindings in memory. Persisted V2/V3
  // records are never rewritten and the returned record retains its V4 schema.
  validateTargetRecord({...record,schema:'flypow-target-response-record-v2',protocolVersion:2},meta,trial,task);return record;
}
