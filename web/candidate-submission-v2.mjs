import { hex,hash,id,commitment,claimId,goalResultRoot } from './target-protocol-v2.mjs';
export class CandidateSubmissionV2 {
  constructor(client,store,onChange=()=>{},financial=null){Object.assign(this,{client,store,onChange,financial});this.active=new Map();}
  submit(candidateId){if(this.active.has(candidateId))return this.active.get(candidateId);const p=this.run(candidateId).finally(()=>this.active.delete(candidateId));this.active.set(candidateId,p);return p;}
  async changed(m,phase){m.phase=phase;await this.store.update(m);this.onChange(m);}
  async run(candidateId){const m=await this.store.metadata(candidateId),r=m.round;if(!m.sciencePassed||m.partial||m.trials.length!==r.pre.requiredBackgrounds||!m.trials.every((t,j)=>t.metrics.passed&&t.repeatIndex===j))throw new Error('Only saved complete passing candidates may claim a round');
    if(!this.client.identity){await this.changed(m,'identity-unavailable');throw new Error('Original contribution identity is unavailable; export records.');}
    if(!m.claimId&&(this.client.round?.roundId!==m.roundId||this.client.serverNow>=r.pre.claimDeadline)){await this.changed(m,'claim-deadline-expired');return m;}
    if(m.minerId&&m.minerId!==this.client.identity.publicKey){m.identityLost=true;await this.changed(m,'identity-lost');throw new Error('Original local contribution key is unavailable; export scientific records.');}
    const recoveringClaim=!!m.claimId||!!m.receipt;
    const manifest={schema:'flypow-candidate-manifest-v2',roundId:m.roundId,goalId:m.goalId,candidateId:m.candidateId,input:m.input,trials:m.trials,goalResultRoot:await goalResultRoot(m.trials)};
    for(let j=0;j<m.trials.length;j++)await this.store.archive(m,j);
    m.salt||=hex(crypto.getRandomValues(new Uint8Array(32)));m.minerId=this.client.identity.publicKey;m.manifest=manifest;
    const c=await commitment(r,m.minerId,manifest,m.salt);m.claimId=await claimId(r.roundId,m.minerId,c);m.commitRequest||=await this.client.request('claim',r.roundId,{commitment:c});await this.store.update(m);
    let status;if(recoveringClaim)try{status=await this.client.claimState(m.claimId);}catch(e){if(e.status!==404)throw e;}
    if(status){m.receipt=status.receipt;if(['VALID','REVEALED','INVALID','TIMED_OUT'].includes(status.status)){await this.changed(m,status.status==='REVEALED'?'verifying':status.status.toLowerCase());return m;}}
    if(!status&&!m.receipt&&(this.client.round?.roundId!==m.roundId||this.client.serverNow>=r.pre.claimDeadline)){await this.changed(m,'claim-deadline-expired');return m;}
    if(!m.receipt&&this.financial&&!m.financial){await this.changed(m,'authorizing-financial-intent');m.financial=await this.financial.acceptCandidate(m,this.client);await this.store.update(m);}
    if(!m.receipt){await this.changed(m,'submitting-commitment');m.receipt=await this.client.post('claims',m.commitRequest,'claim-receipt');await this.store.update(m);}
    if(this.client.serverNow>m.receipt.revealDeadline){await this.changed(m,'reveal-deadline-expired');return m;}
    m.uploads||=[];await this.changed(m,'uploading');
    for(let j=0;j<m.trials.length;j++){const t=m.trials[j],file=await this.store.archive(m,j);let upload=m.uploads[j];
      if(!upload){const req=await this.client.request('upload-create',r.roundId,{claimId:m.claimId,trialIndex:j,bytes:t.bytes,sha256:t.resultRoot},'upload-'+m.claimId+'-'+j);upload=m.uploads[j]=await this.client.post('artifacts/uploads',req,'upload-receipt');await this.store.update(m);}
      const state=await this.client.post('artifacts/uploads/'+upload.uploadId+'/status',await this.client.request('upload-status',r.roundId,{uploadId:upload.uploadId}),'upload-state');
      if(state.status!=='SEALED'){const received=new Set(state.receivedChunks);for(let index=0;index<upload.chunks;index++){if(received.has(index))continue;const bytes=await file.slice(index*upload.chunkBytes,(index+1)*upload.chunkBytes).arrayBuffer(),digest=await hash(bytes),req=await this.client.request('upload-chunk',r.roundId,{uploadId:upload.uploadId,index,bytes:bytes.byteLength,sha256:digest},'chunk-'+upload.uploadId+'-'+index);
        const response=await this.client.fetch('artifacts/uploads/'+upload.uploadId+'/chunks/'+index,{method:'PUT',headers:{'Content-Type':'application/octet-stream','X-Flypow-Action':JSON.stringify(req)},body:bytes});await this.client.check('chunk-receipt',await response.json());m.uploadCursor={trialIndex:j,chunkIndex:index+1};await this.store.update(m);this.onChange(m);
      }await this.client.post('artifacts/uploads/'+upload.uploadId+'/seal',await this.client.request('upload-seal',r.roundId,{uploadId:upload.uploadId},'seal-'+upload.uploadId),'seal-receipt');}
    }
    m.revealRequest||=await this.client.request('reveal',r.roundId,{claimId:m.claimId,manifest,salt:m.salt});await this.changed(m,'revealing');await this.client.post('claims/'+m.claimId+'/reveal',m.revealRequest,'reveal-receipt');await this.changed(m,'verifying');return m;
  }
  async reconcileFinancial(m){if(!this.financial||!m.financial)return m;const latest=await this.financial.candidateRecord(m.claimId,m.financialScope?.wallet);if(latest){m.financial=latest;await this.store.update(m);this.onChange(m);}return m;}
  async reconcile(m){if(!m.claimId)return m;const r=await this.client.roundState(m.roundId),s=await this.client.claimState(m.claimId);m.receipt=s.receipt;m.validVotes=s.validVotes??0;m.invalidVotes=s.invalidVotes??0;m.quorum=s.quorum??2;m.verificationQueue=s.verificationQueue??null;m.terminalReason=s.terminalReason||null;m.independentlyReplayed=s.status==='VALID';m.phase=s.status.toLowerCase();if(r.winner){m.won=r.winner.claimId===m.claimId;if(m.won)m.phase='winner-confirmed';else if(s.status==='VALID')m.phase='saved-not-selected';m.authorityWinner=r.winner;}else if(r.status==='EXPIRED_NO_VALID_RESULT'&&s.status==='VALID')m.phase='round-expired-no-valid-result';m.terminalCompetition=["INVALID","TIMED_OUT"].includes(s.status)||(s.status==='VALID'&&(!!r.winner||r.status==='EXPIRED_NO_VALID_RESULT'));await this.store.update(m);await this.reconcileFinancial(m);this.onChange(m);return m;}
}
