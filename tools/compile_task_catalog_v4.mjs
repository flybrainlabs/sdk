#!/usr/bin/env node
// Compile existing approved specifications; this tool never generates goals,
// signs chain transactions, assigns a new reward budget or republishes science.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {canonical,hash} from '../web/target-protocol-v2.mjs';
import {descriptorFor} from '../web/task-factory-v4-science.mjs';
import {catalogRoot,hex,operationData,fromHex} from '../web/task-factory-v4-codec.mjs';
export async function compileCatalog(plan,load){
  if(plan.schema!=='flybrainlabs-task-catalog-plan-v4'||plan.approval?.approved!==true||! /^[a-f0-9]{64}$/.test(plan.approval.evidenceHash)||!Array.isArray(plan.tasks)||!plan.tasks.length||plan.tasks.length>4096||!Array.isArray(plan.excludedScientificIdentities))throw new Error('Approved finite plan and historical exclusion inventory required');
  const seen=new Set(plan.excludedScientificIdentities),descriptors=[],contents=[];let rewardSum=0n;
  for(const entry of plan.tasks){
    const spec=await load(entry.specification),d=await descriptorFor(spec,entry.rules),identity=hex(d.scientificIdentity);
    if(seen.has(identity))throw new Error('Scientific task already registered/solved: '+identity);seen.add(identity);
    if(spec.goal.calibrationHash!==entry.approvedCalibrationHash)throw new Error('Approved calibration mismatch');
    descriptors.push(d);contents.push({hash:hex(d.content),bytes:canonical(spec)});rewardSum+=BigInt(d.rewardAtoms);
  }
  const budget=BigInt(plan.budgetAtoms);if(budget<=0n||rewardSum>budget||budget>0xffffffffffffffffn)throw new Error('Finite FBW budget exceeded');
  fromHex(plan.factoryId);const root=catalogRoot(descriptors);
  const instructions=[operationData(0,{id:plan.factoryId,catalogRoot:root,count:descriptors.length,budget,deadline:BigInt(plan.deadline)}),...descriptors.map(descriptor=>operationData(1,{descriptor})),operationData(2)];
  return {descriptors,contents,instructions,root:hex(root),rewardSum:rewardSum.toString(),budget:budget.toString()};
}
async function main(){
  const [file,out]=process.argv.slice(2);if(!file||!out)throw new Error('Usage: compile_task_catalog_v4.mjs APPROVED_PLAN.json NEW_OUTPUT_DIRECTORY');
  const plan=JSON.parse(await readFile(file,'utf8')),base=resolve(file,'..');
  const compiled=await compileCatalog(plan,async path=>JSON.parse(await readFile(resolve(base,path),'utf8')));
  // Refuse to replace any existing prepared campaign or private artifacts.
  await mkdir(out,{recursive:false});await mkdir(join(out,'content'));
  for(const x of compiled.contents)await writeFile(join(out,'content',x.hash+'.bin'),x.bytes,{flag:'wx'});
  const report={schema:'flybrainlabs-compiled-task-catalog-v4',factoryId:plan.factoryId,catalogRoot:compiled.root,count:compiled.descriptors.length,rewardAtoms:compiled.rewardSum,budgetAtoms:compiled.budget,deadline:plan.deadline,approvalEvidenceHash:plan.approval.evidenceHash,instructions:compiled.instructions.map(hex),descriptors:compiled.descriptors.map(d=>({...d,...Object.fromEntries(Object.entries(d).filter(([,v])=>v instanceof Uint8Array).map(([k,v])=>[k,hex(v)])),rewardAtoms:String(d.rewardAtoms),seeds:d.seeds.map(String)})),chainTransactions:0};
  await writeFile(join(out,'catalog.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({prepared:true,count:report.count,catalogRoot:report.catalogRoot,chainTransactions:0}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
