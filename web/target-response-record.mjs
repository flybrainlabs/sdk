// Separate V2 wrapper/index. The deterministic FBRP scientific bytes stay V1 compatible.
import { jsonBytes,digest } from './response-record.mjs';
export const targetBinding=(task,round)=>({protocolVersion:2,roundId:task.roundId,goalId:task.goalId,candidateId:task.candidateId,trialId:task.trialId,repeatIndex:task.repeatIndex,seedHex:task.seed.toString(16).padStart(16,'0'),input:task.input,parameterProfileHash:round.goal.parameterProfileHash});
export async function targetRecord(bundle,task,round){
  const binding=targetBinding(task,round);
  const record={...bundle.record,schema:'flypow-target-response-record-v2',...binding};delete record.global_task_index;
  const preview={...bundle.preview,schema:'flypow-target-preview-v2',...binding},previewBytes=jsonBytes(preview),previewRoot=await digest(previewBytes);
  const manifest={schema:'flypow-target-trial-archive-v2',...binding,resultRoot:bundle.resultRoot,previewRoot,files:[{name:'response.bin',bytes:bundle.manifest.files[0].bytes,sha256:bundle.resultRoot},{name:'preview.json',bytes:previewBytes.length,sha256:previewRoot}]};
  const manifestBytes=jsonBytes(manifest),archiveRoot=await digest(manifestBytes);record.preview_root=previewRoot;record.archive_manifest_hash=archiveRoot;
  return {...bundle,record,preview,previewBytes,previewRoot,manifest,manifestBytes,archiveRoot};
}
export function validateTargetRecord(record,meta,trial,task){
  const binding=targetBinding(task,meta.round),legacy=record.roundId===undefined&&record.v2;
  if(!(record.schema==='flypow-target-response-record-v2'||legacy&&record.schema==='flypow-response-record-v2')||task.roundId!==meta.roundId||task.goalId!==meta.goalId||task.candidateId!==meta.candidateId||task.trialId!==trial.trialId||task.repeatIndex!==trial.repeatIndex||binding.seedHex!==trial.seedHex||record.result_root!==trial.resultRoot||record.task_id!==task.trialId||record.seed_hex!==binding.seedHex||record.body_id!==task.bodyId||record.target_index!==task.targetIndex||record.stimulus.start_step!==task.input.startStep||record.stimulus.end_step!==task.input.endStep||String(record.stimulus.current)!==String(task.input.current))throw new Error('V2 historical record binding');
  for(const key of ['roundId','goalId','candidateId','trialId','repeatIndex'])if((legacy?record.v2:record)[key]!==binding[key])throw new Error('V2 historical record binding');
  if(!legacy&&(record.protocolVersion!==2||record.seedHex!==binding.seedHex||record.parameterProfileHash!==binding.parameterProfileHash||!record.input||Object.keys(record.input).length!==4||['stimulatedBodyId','startStep','endStep','current'].some(k=>record.input[k]!==task.input[k])))throw new Error('V2 historical scientific configuration');
  // Early development caches used a V2 nested index and unchanged V1 side files.
  // Normalize only in memory; the existing bytes and their hashes stay intact.
  return legacy?{...record,...binding,schema:'flypow-target-response-record-v2',compatibility:'nested-development-v2'}:record;
}
