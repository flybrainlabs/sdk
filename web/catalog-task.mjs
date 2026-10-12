// Byte-compatible development TaskID/seed derivation. This does not verify Solana state.
const enc = new TextEncoder();
const bytes = value => Uint8Array.from(value);
const le = (value, width, signed = false) => {
  const output = new Uint8Array(width);
  const view = new DataView(output.buffer);
  if (width === 4) view.setUint32(0, Number(value), true);
  else if (signed) view.setBigInt64(0, BigInt(value), true);
  else view.setBigUint64(0, BigInt(value), true);
  return output;
};
const domain = value => enc.encode(`${value}\0`);
const concat = parts => {
  const total = parts.reduce((sum, item) => sum + item.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};
const digest = async parts => new Uint8Array(await crypto.subtle.digest('SHA-256', concat(parts)));
export const hex = array => Array.from(array, value => value.toString(16).padStart(2, '0')).join('');

export async function checkCatalog(raw, config) {
  if (hex(await digest([raw])) !== config.task_catalog_sha256) throw new Error('Task catalog hash mismatch');
  const catalog = JSON.parse(new TextDecoder().decode(raw));
  const c = catalog.campaign;
  if (catalog.state !== 'UNCALIBRATED_DEV_ONLY_NO_PAYMENT'
    || hex(catalog.graph_data_sha256) !== config.graph_sha256
    || hex(catalog.model_data_sha256) !== config.model_sha256
    || hex(c.graph_root)!==config.graph_sha256||hex(c.registry_root)!==config.registry_sha256||hex(c.model_root)!==config.model_root_sha256
    || c.model_neuron_count !== config.neuron_count || c.simulation_steps !== config.steps
    || c.time_step_us !== config.time_step_us
    || c.targets.length !== config.target_body_ids.length
    || c.targets.some((target, i) => target.body_id !== config.target_body_ids[i])
    || c.stimuli.length !== (config.stimulus_count || 64) || c.repeats !== (config.repeat_count || 4) || catalog.task_manifest_root.length !== 32) {
    throw new Error('Task catalog differs from checked development model');
  }
  if(config.campaign_id_sha256&&hex(c.campaign_id)!==config.campaign_id_sha256)throw new Error('Cross-campaign catalog');
  if(config.task_manifest_root&&hex(catalog.task_manifest_root)!==config.task_manifest_root)throw new Error('Task manifest root mismatch');
  if((config.observe_start||0)!==0||(config.parameter_version||'lif-point-v0-dev')!=='lif-point-v0-dev')throw new Error('Unknown scientific configuration');
  if(catalog.profile_definition){
    const d=catalog.profile_definition,p=d.parameters;
    if(d.schema!=='flypow-duration-profile-v1'||d.steps!==config.steps||d.observe_start!==0||d.time_step_us!==1000||d.parameter_version!=='lif-point-v0-dev'
      ||JSON.stringify(sortKeys(p))!==JSON.stringify({background_current:10,background_probability_u16:256,leak_divisor:8,membrane_limit:1000000,refractory_steps:2,reset:0,synaptic_delay_steps:1,synaptic_unit:1,threshold:100}))throw new Error('Unknown scientific profile parameters');
    const canonical=new TextEncoder().encode(JSON.stringify(sortKeys(d)));
    if(hex(await digest([canonical]))!==config.profile_definition_sha256)throw new Error('Frozen profile definition differs');
    if(d.profile_id!==config.profile_id||d.source_root!==hex(c.source_root)||d.registry_root!==hex(c.registry_root)||d.graph_root!==hex(c.graph_root)||d.model_root!==hex(c.model_root)||d.neuron_count!==c.model_neuron_count||JSON.stringify(sortKeys(d.targets))!==JSON.stringify(sortKeys(c.targets))||JSON.stringify(sortKeys(d.stimuli))!==JSON.stringify(sortKeys(c.stimuli))||d.repeats!==c.repeats||d.payment!==false||d.rewards!==false||d.resources.max_archive_bytes!==config.max_archive_bytes)throw new Error('Profile/catalog identity mismatch');
    const id=await digest([domain('FlyPoW/duration-campaign/v1'),canonical]),experiment=await digest([domain('FlyPoW/duration-experiment/v1'),canonical]),seed=await digest([domain('FlyPoW/duration-public-seed/v1'),le(c.simulation_steps,4)]);
    if(hex(id)!==hex(c.campaign_id)||hex(experiment)!==hex(c.experiment_root)||hex(seed)!==hex(c.public_seed)||hex(experiment)!==config.experiment_root_sha256)throw new Error('Frozen profile roots differ');
  }else if(config.steps!==32)throw new Error('Missing frozen duration profile');
  return catalog;
}
function sortKeys(v){if(Array.isArray(v))return v.map(sortKeys);return v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sortKeys(v[k])])):v;}

export async function taskForIndex(catalog, k) {
  const c = catalog.campaign;
  const count = c.targets.length * c.stimuli.length * c.repeats;
  if (!Number.isSafeInteger(k) || k < 0 || k >= count) throw new Error('Task index outside finite catalog');
  const perTarget = c.stimuli.length * c.repeats;
  const target = c.targets[Math.floor(k / perTarget)];
  const stimulusIndex = Math.floor((k % perTarget) / c.repeats);
  const repeatIndex = k % c.repeats;
  const stimulus = c.stimuli[stimulusIndex];
  const taskId = await digest([
    domain('FlyPoW/task-id/v1'), bytes(c.campaign_id), bytes(c.source_root),
    bytes(c.registry_root), bytes(c.graph_root), bytes(c.model_root),
    bytes(c.experiment_root), bytes(c.public_seed),
    le(c.model_neuron_count, 4), le(c.simulation_steps, 4), le(c.time_step_us, 4),
    le(k, 8), le(target.body_id, 8), le(target.model_index, 4), le(stimulusIndex, 4),
    le(stimulus.start_step, 4), le(stimulus.end_step, 4), le(stimulus.current, 8, true),
    le(repeatIndex, 4),
  ]);
  const seed = await digest([domain('FlyPoW/task-seed/v1'), bytes(c.public_seed), taskId]);
  return {
    k, bodyId: target.body_id, targetIndex: target.model_index, stimulusIndex, repeatIndex,
    stimulus, taskId: hex(taskId), seed: new DataView(seed.buffer).getBigUint64(0, true),
  };
}
