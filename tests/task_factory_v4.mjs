// Interface, content and replay fault tests. Full-model science is not claimed
// by the injected native outcomes used in these unit/integration fixtures.
import assert from 'node:assert/strict';
import {readFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Keypair,PublicKey} from '@solana/web3.js';
import {canonical,hash,id,candidateId,trialId,goalResultRoot} from '../web/target-protocol-v2.mjs';
import {descriptorFor,makeRound,scientificDescriptorHash,validateSpecification,scientificIdentity} from '../web/task-factory-v4-science.mjs';
import {catalogRoot,descriptorHash,hex,fromHex,voteMessage,STATE,Reader} from '../web/task-factory-v4-codec.mjs';
import {addresses} from '../tools/task_factory_v4_client.mjs';
import {verifyFactoryRound} from '../web/task-factory-client-v4.mjs';
import {compileCatalog} from '../tools/compile_task_catalog_v4.mjs';
import {verifyFactorySubmission,watchFactoryVerifier} from '../tools/factory_verifier_v4.mjs';
import {FactorySubmissionV4} from '../web/factory-submission-v4.mjs';
import {FactoryContentStoreV4} from '../web/factory-content-store-v4.mjs';
const vector=JSON.parse(await readFile('tests/vectors/target-v2.json','utf8')),spec={schema:'flybrainlabs-scientific-task-v4',goal:vector.goal,seeds:['0000000000000001','0000000000000002']},rules={rewardAtoms:100n,claimSeconds:10,revealSeconds:20,verifySeconds:30,maxAttempts:2},d=await descriptorFor(spec,rules);
assert.deepEqual(await scientificDescriptorHash(d),descriptorHash(d));
const checks=[];checks.push('portable Worker descriptor hash matches transaction codec');
const plan={schema:'flybrainlabs-task-catalog-plan-v4',approval:{approved:true,evidenceHash:'e'.repeat(64)},factoryId:'f'.repeat(64),budgetAtoms:'100',deadline:'2000000000',excludedScientificIdentities:[],tasks:[{specification:'goal',approvedCalibrationHash:spec.goal.calibrationHash,rules}]};
const compiled=await compileCatalog(plan,async()=>spec);assert.equal(compiled.root,hex(catalogRoot([d])));assert.equal(compiled.instructions[0][0],11);assert.equal(compiled.rewardSum,'100');
await assert.rejects(compileCatalog({...plan,approval:{approved:false}},async()=>spec));
await assert.rejects(compileCatalog({...plan,budgetAtoms:'99'},async()=>spec));
await assert.rejects(compileCatalog({...plan,excludedScientificIdentities:[hex(d.scientificIdentity)]},async()=>spec));
await assert.rejects(compileCatalog({...plan,budgetAtoms:'200',tasks:[...plan.tasks,...plan.tasks]},async()=>({...spec,goal:{...spec.goal,description:'renamed fixture'}})));
await assert.rejects(validateSpecification({...spec,seeds:[...spec.seeds].reverse()},d));checks.push('approved finite catalog, calibration, seed and historical duplicate checks');
const program=Keypair.generate().publicKey,miner=Keypair.generate().publicKey,genesis=Keypair.generate().publicKey,a=addresses(program),factory=a.factory(fromHex(plan.factoryId)),task=a.task(factory,0),sub=a.submission(task,0,miner,new Uint8Array(32).fill(8));
const f={id:fromHex(plan.factoryId),genesis:genesis.toBytes(),policy:new Uint8Array(32).fill(3),activeIndex:0,nextIndex:1,count:1,state:1,paused:false,verifiers:[miner.toBytes(),Keypair.generate().publicKey.toBytes(),Keypair.generate().publicKey.toBytes()]};
let t={factory:factory.toBytes(),index:0,descriptor:d,state:1,attempt:0,openedAt:1n,claimDeadline:11n,revealDeadline:21n,verifyDeadline:31n,queue:[],winner:new Uint8Array(32),beneficiary:new Uint8Array(32),paid:false};
let s={task:task.toBytes(),attempt:0,sequence:0n,miner:miner.toBytes(),beneficiary:miner.toBytes(),commitment:new Uint8Array(32).fill(8),commitSlot:1n,state:2,validVotes:0,invalidVotes:0,reports:Array.from({length:3},()=>new Uint8Array(32))};
const contents=new Map(),put=async(root,value)=>{const bytes=value instanceof Blob?new Uint8Array(await value.arrayBuffer()):new Uint8Array(value);assert.equal(await hash(bytes),root);contents.set(root,bytes);},contentStore={get:async root=>{if(!contents.has(root))throw new Error('Content unavailable');return contents.get(root);},put};
await put(hex(d.content),canonical(spec));
const reader={program,a,expected:{factoryAddress:factory,genesis:genesis.toBase58()},factory:async()=>f,task:async()=>t,submission:async()=>s,account:async address=>new PublicKey(address).equals(task)?t:s};
const round=await makeRound({program:program.toBase58(),genesis:genesis.toBase58(),factoryAddress:factory.toBase58(),taskAddress:task.toBase58(),factory:f,task:t,spec});
assert.doesNotThrow(()=>canonical(round));assert.equal((await verifyFactoryRound(reader,round)).roundId,round.roundId);
await assert.rejects(verifyFactoryRound(reader,{...round,pre:{...round.pre,claimDeadline:9999}}));
await assert.rejects(verifyFactoryRound(reader,{...round,goal:{...round.goal,description:'wrong content'}}));checks.push('chain-authoritative rounds reject forged deadlines/content and persist without BigInt');
const input=vector.input,candidate=await candidateId(round.roundId,input),metrics={windows:[{targetNet:999,positiveCells:99,offTargetAbs:0,passed:true},{targetNet:999,positiveCells:99,offTargetAbs:0,passed:true}],stimulusCost:1,baselineSpikes:0,passed:true};
const trialBytes=[new Uint8Array(480).fill(1),new Uint8Array(480).fill(2)],trials=[];
for(let j=0;j<2;j++){const root=await hash(trialBytes[j]);await put(root,trialBytes[j]);trials.push({trialId:await trialId(round.roundId,round.goal,input,j,round.seeds[j]),repeatIndex:j,seedHex:round.seeds[j],resultRoot:root,bytes:480,metrics});}
const manifest={schema:'flybrainlabs-candidate-manifest-v4',roundId:round.roundId,goalId:round.pre.goalId,candidateId:candidate,input,trials,goalResultRoot:await goalResultRoot(trials)},mb=canonical(manifest),ab=canonical({schema:'flybrainlabs-candidate-archive-v4',trials:trials.map(t=>({root:t.resultRoot,bytes:t.bytes}))});
s.evidence={candidate:fromHex(candidate),result:fromHex(manifest.goalResultRoot),manifest:fromHex(await hash(mb)),archive:fromHex(await hash(ab))};await put(hex(s.evidence.manifest),mb);await put(hex(s.evidence.archive),ab);
const outputDir=await mkdtemp(join(tmpdir(),'flybrainlabs-v4-test-')),readiness=async()=>({graphRoot:spec.goal.graphRoot,modelDataRoot:spec.goal.modelDataRoot,parameterProfileHashes:[spec.goal.parameterProfileHash],evaluatorVersions:[spec.goal.evaluatorVersion],nativeBinaryReady:true});let calls=0;
const replay=async(binary,args)=>{const j=spec.seeds.indexOf(args[4]);assert(j>=0);calls++;return {replayStatus:'VALID',replayVerified:true,fullReplay:true,steps:256,bytes:480,resultRoot:trials[j].resultRoot,metrics};};
const options={reader,address:sub,contentStore,modelDir:'/fixture-no-model-read',outputDir,binary:'/fixture-injected-native',readiness,replay};
const verified=await verifyFactorySubmission(options);assert.equal(calls,2);assert.equal(verified.report.valid,true);assert.equal(verified.report.completeTrials,2);
assert.deepEqual(verified.message,voteMessage(program,f,t,sub,s,true,verified.reportHash,2));
await assert.rejects(verifyFactorySubmission({...options,replay:async()=>({fullReplay:false,replayStatus:'VALID',steps:256})}),/Complete frozen replay/);
await assert.rejects(verifyFactorySubmission({...options,readiness:async()=>({...await readiness(),graphRoot:'0'.repeat(64)})}),/not ready/);
await assert.rejects(verifyFactorySubmission({...options,contentStore:{get:async()=>{throw new Error('Content temporarily unavailable');}}}));
calls=0;const negative=await verifyFactorySubmission({...options,replay:async(binary,args)=>({...await replay(binary,args),replayStatus:'INVALID_RESULT',replayVerified:false})});assert.equal(negative.report.valid,false);assert.equal(calls,2);checks.push('all backgrounds replayed before either verdict; infrastructure/missing data/partial replay yields no vote');
// Exercise the actual miner commit/reveal adapter against an injected chain
// transport. Real packet/runtime behavior is checked by the SBF suite.
const metadata={schema:'flybrainlabs-candidate-state-v4',round,roundId:round.roundId,goalId:round.pre.goalId,candidateId:candidate,input,trials,partial:false,sciencePassed:true};let recorded=null,sends=0,updates=0;
const store={metadata:async()=>metadata,update:async m=>{canonical(m);updates++;return m;},archive:async(m,j)=>new Blob([trialBytes[j]])};
const fakeClient={wallet:{publicKey:miner},deployment:{factory:factory.toBase58()},reader:{...reader,connection:{getAccountInfo:async()=>recorded,getSlot:async()=>2},submission:async()=>recorded},contentStore,serverNow:2,roundAt:async()=>({f,t,r:round}),send:async ixs=>{
  sends++;const bytes=ixs[0].data,r=new Reader(bytes);assert.equal(r.u8(),11);r.u32();const tag=r.u8();
  if(tag===4){recorded={...s,commitment:r.key(),beneficiary:r.key(),state:1};}else if(tag===5){recorded.state=2;}else throw new Error('Unexpected instruction');
}};
const flow=new FactorySubmissionV4(fakeClient,store);const duplicate=flow.submit(candidate);assert.equal(flow.submit(candidate),duplicate);await duplicate;assert.equal(metadata.phase,'verifying');assert.equal(sends,2);await flow.submit(candidate);assert.equal(sends,2);assert(updates>0);
await assert.rejects(new FactorySubmissionV4({...fakeClient,wallet:{publicKey:Keypair.generate().publicKey}},store).submit(candidate),/original wallet/);checks.push('miner durable commit/reveal, coalesced requests, idempotent retries and wallet ownership');
let uploaded=0;const objects=new FactoryContentStoreV4({sources:['https://fixture-bad.invalid/','https://fixture-good.invalid/'],maxBytes:1024,upload:async()=>{uploaded++;},fetch:async url=>new Response(String(url).includes('bad')?new Uint8Array([99]):trialBytes[0])});
assert.deepEqual(await objects.get(trials[0].resultRoot),trialBytes[0]);await objects.put(trials[0].resultRoot,trialBytes[0]);assert.equal(uploaded,1);await assert.rejects(objects.put(trials[0].resultRoot,new Uint8Array([99])));await assert.rejects(objects.get(trials[0].resultRoot,100));checks.push('corrupt content mirror fallback, bounded reads and verified publication');
const callbacks=new Map();let listenerId=0,voteCalls=0,releaseReplay,signalBudget;
const replayGate=new Promise(resolve=>releaseReplay=resolve),budgetSignal=new Promise(resolve=>signalBudget=resolve);
t.queue=[{submission:sub.toBytes(),state:2,sequence:0n}];
const watcher=await watchFactoryVerifier({reader:{...reader,connection:{onAccountChange:(address,fn)=>{callbacks.set(++listenerId,fn);return listenerId;},removeAccountChangeListener:async id=>callbacks.delete(id)}},verifier:{publicKey:miner},maxVoteTransactions:1,verifyAndVote:async()=>{voteCalls++;await replayGate;},onBudget:signalBudget,onError:e=>{throw e;}});
await new Promise(setImmediate);for(let i=0;i<100;i++)for(const fn of callbacks.values())fn();releaseReplay();
let deadline;try{await Promise.race([budgetSignal,new Promise((_,reject)=>deadline=setTimeout(()=>reject(new Error('Verifier allowance did not stop the event storm')),1000))]);}finally{clearTimeout(deadline);await watcher.stop();}
assert.equal(voteCalls,1);assert.equal(watcher.transactions,1);assert.equal(callbacks.size,0);checks.push('verifier event storms coalesce into serial replay with a finite transaction allowance');
console.log(JSON.stringify({passed:true,checks,scientificFixtures:true,chainTransactions:0}));
