import assert from 'node:assert/strict';
import { CandidateSubmissionV2 } from '../web/candidate-submission-v2.mjs';

const candidate=()=>({claimId:'a'.repeat(64),roundId:'b'.repeat(64),phase:'submitting-commitment',round:{pre:{claimDeadline:100}},trials:[{resultRoot:'c'.repeat(64)}]});
let checks=0;
async function missing({status='FINALIZED',serverTime=101,httpStatus=404,receipt=null}={}){
  const record=candidate();if(receipt)record.receipt=receipt;
  let writes=0,changes=0;
  const client={roundState:async()=>({status,serverTime}),claimState:async()=>{throw Object.assign(new Error('claim lookup failed'),{status:httpStatus});}};
  const submission=new CandidateSubmissionV2(client,{update:async()=>writes++},()=>changes++);
  return {record,submission,counts:()=>({writes,changes})};
}
for(const status of ['FINALIZED','EXPIRED_NO_VALID_RESULT']){
  const test=await missing({status});const original=structuredClone(test.record);
  await test.submission.reconcile(test.record);
  assert.equal(test.record.phase,'claim-not-recorded');assert.equal(test.record.terminalCompetition,true);
  assert.deepEqual(test.record.trials,original.trials);assert.equal(test.record.claimId,original.claimId);
  assert.equal(test.record.receipt,undefined);assert.equal(test.record.won,undefined);
  assert.deepEqual(test.counts(),{writes:1,changes:1});checks++;
}
for(const options of [{status:'OPEN'},{status:'VERIFYING'},{serverTime:99},{receipt:{claimId:'a'.repeat(64)}},{httpStatus:503},{httpStatus:403}]){
  const test=await missing(options);const original=structuredClone(test.record);
  await assert.rejects(test.submission.reconcile(test.record));
  assert.deepEqual(test.record,original);assert.deepEqual(test.counts(),{writes:0,changes:0});checks++;
}
const record=candidate();
const valid=new CandidateSubmissionV2({roundState:async()=>({status:'FINALIZED',winner:{claimId:record.claimId}}),claimState:async()=>({status:'VALID',receipt:{claimId:record.claimId},validVotes:2})},{update:async()=>{}},()=>{});
await valid.reconcile(record);assert.equal(record.phase,'winner-confirmed');assert.equal(record.independentlyReplayed,true);assert.equal(record.claimNotRecorded,false);checks++;
console.log(JSON.stringify({passed:true,checks,artifactsRetained:true,financialTransactions:0}));
