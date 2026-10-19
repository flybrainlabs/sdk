// Opt-in V4 client: authoritative task state is read directly from Solana.
// The transaction sender belongs to the connected wallet, never a node relayer.
import {Connection,PublicKey} from '@solana/web3.js';
import {FactoryReader,addresses,instruction,meta} from '../tools/task_factory_v4_client.mjs';
import {decodeTask,decodeSubmission,hex,fromHex,NONE,STATE} from './task-factory-v4-codec.mjs';
import {canonical,hash} from './target-protocol-v2.mjs';
import {makeRound} from './task-factory-v4-science.mjs';
// Recovery advances frozen accounts on explicit Start/Resume or while that
// mining session remains active. Idle pages never consume catalog tasks.
export class FactoryMiningContinuationV4 {
  constructor({client,runner,canPay,hasPendingOutputs=()=>false,onError=()=>{}}){Object.assign(this,{client,runner,canPay,hasPendingOutputs,onError});this.pending=null;}
  eligible(){const r=this.runner;return r.running&&r.intent&&!r.paused&&!r.stopAfterRound&&this.client.online&&this.canPay()&&!this.hasPendingOutputs();}
  tick(){
    if(this.pending)return this.pending;if(!this.eligible()||!this.client.snapshot?.recovery)return Promise.resolve(false);
    const generation=this.runner.generation,epoch=this.runner.poolEpoch,identity=this.client.identity?.publicKey;
    const beforeSend=()=>{if(!this.eligible()||generation!==this.runner.generation||epoch!==this.runner.poolEpoch||identity!==this.client.identity?.publicKey)throw Object.assign(new Error('MINING_SESSION_STOPPED'),{code:'MINING_SESSION_STOPPED'});};
    this.pending=this.client.recoverTask({beforeSend}).then(()=>true).catch(error=>{if(error.code==='MINING_SESSION_STOPPED')return false;this.runner.pauseNow(error.code||'contract-continuation-error');this.onError(error);return false;}).finally(()=>this.pending=null);return this.pending;
  }
}
export function factoryTaskRecoveryV4(f,t,now){
  if(!Number.isSafeInteger(now)||f.state!==STATE.RUNNING||f.paused)return null;
  if(f.activeIndex===NONE)return f.nextIndex<f.count&&now<Number(f.deadline)?{kind:'advance',index:f.nextIndex}:null;
  if(!t||t.state!==STATE.ACTIVE||t.index!==f.activeIndex)return null;
  const eligible=t.queue.filter(e=>e.state===STATE.VALID||e.state===STATE.COMMITTED&&now<=Number(t.revealDeadline)||e.state===STATE.REVEALED&&now<=Number(t.verifyDeadline));
  if(eligible[0]?.state===STATE.VALID)return {kind:'finalize',index:t.index,attempt:t.attempt,submission:new PublicKey(eligible[0].submission).toBase58()};
  if(now>Number(t.verifyDeadline))return {kind:'expire',index:t.index,attempt:t.attempt};
  return null;
}
export function readerForDeployment(deployment,connection=null){
  if(deployment?.schema!=='flybrainlabs-task-factory-deployment-v4'||deployment.enabled!==true||!['localnet','devnet'].includes(deployment.cluster))throw new Error('Task factory V4 is not enabled');
  if(deployment.personalRpcRequired&&!connection)throw Object.assign(new Error('RPC_REQUIRED'),{code:'RPC_REQUIRED'});
  return new FactoryReader(connection||new Connection(deployment.rpcUrl,'finalized'),deployment.programId,{genesis:deployment.genesisHash,factoryAddress:deployment.factory,id:fromHex(deployment.factoryId),catalogRoot:fromHex(deployment.catalogRoot),policy:fromHex(deployment.policyHash)});
}
export async function verifyFactoryRound(reader,r){
  const f=await reader.factory(),t=await reader.task(r.pre.taskIndex);
  const expected=await makeRound({program:reader.program.toBase58(),genesis:reader.expected.genesis,factoryAddress:reader.expected.factoryAddress.toBase58(),taskAddress:reader.a.task(reader.expected.factoryAddress,t.index).toBase58(),factory:f,task:t,spec:r.specification});
  if(r.roundId!==expected.roundId||hex(canonical(r.pre))!==hex(canonical(expected.pre))||hex(canonical(r.goal))!==hex(canonical(expected.goal))||hex(canonical(r.seeds))!==hex(canonical(expected.seeds)))throw new Error('Round differs from authoritative chain task');
  if(t.state!==STATE.ACTIVE||f.activeIndex!==t.index||f.paused)throw new Error('Chain task is not open for computation');return expected;
}
export class FactoryMiningClientV4 {
  constructor({deployment,wallet,send,contentStore,reserveInput=null,renewInput=null,releaseInput=null,connection=null,onSnapshot=()=>{},onConnection=()=>{},onEvent=()=>{}}){
    Object.assign(this,{deployment,wallet,send,contentStore,reserveInput,renewInput,releaseInput,onSnapshot,onConnection,onEvent});this.reader=readerForDeployment(deployment,connection);this.rounds=new Map();this.generation=0;
    this.network={networkId:deployment.genesisHash,campaignId:deployment.factory,authorityId:deployment.policyHash,protocolVersion:4};this.specifications=new Map();
  }
  bindWallet(){this.identity=this.wallet?.publicKey?{publicKey:hex(new PublicKey(this.wallet.publicKey).toBytes())}:null;}
  async initialize(){
    this.bindWallet();await this.sync();
    if(this.deployment.useWebSocket!==false)this.factorySubscription=this.reader.connection.onAccountChange(this.reader.expected.factoryAddress,()=>this.sync().catch(e=>this.disconnected(e)),'finalized');
    this.startPolling();return this;
  }
  startPolling(){if(!this.timer)this.timer=setInterval(()=>this.sync().catch(e=>this.disconnected(e)),this.deployment.useWebSocket===false?5000:60000);}
  poll(){return this.sync();}
  async specification(t){const key=hex(t.descriptor.content);if(this.specifications.has(key))return this.specifications.get(key);const bytes=await this.contentStore.get(key,1024*1024);if(await hash(bytes)!==key)throw new Error('Scientific content unavailable or corrupted');const spec=JSON.parse(new TextDecoder().decode(bytes));if(this.specifications.size>=64)this.specifications.delete(this.specifications.keys().next().value);this.specifications.set(key,spec);return spec;}
  async roundAt(index,factory=null){const f=factory||await this.reader.factory(),t=await this.reader.task(index),r=await makeRound({program:this.reader.program.toBase58(),genesis:this.network.networkId,factoryAddress:this.deployment.factory,taskAddress:this.reader.a.task(this.deployment.factory,index).toBase58(),factory:f,task:t,spec:await this.specification(t)});this.rounds.set(r.roundId,{round:r,task:t});return {f,t,r};}
  async sync(){
    if(this.syncing)return this.syncing;const generation=this.generation;
    this.syncing=(async()=>{
      const connected=this.wallet?.publicKey?hex(new PublicKey(this.wallet.publicKey).toBytes()):null;if(connected!==(this.identity?.publicKey||null))throw new Error('Connected wallet changed');
      const f=await this.reader.factory();let r=null,t=null;
      if(f.state===STATE.RUNNING&&f.activeIndex!==NONE&&!f.paused){const loaded=await this.roundAt(f.activeIndex,f);r=loaded.r;t=loaded.t;}
      const slot=await this.reader.connection.getSlot('finalized'),now=await this.reader.connection.getBlockTime(slot);if(now===null)throw new Error('Finalized chain clock unavailable');
      if(generation!==this.generation)return this.snapshot;
      this.lastSync={serverTime:now,localAt:performance.now()};this.factory=f;this.round=r;this.online=true;
      const address=t?this.reader.a.task(this.deployment.factory,t.index):null;
      if(address?.toBase58()!==this.observedTask){if(this.taskSubscription!==undefined)await this.reader.connection.removeAccountChangeListener(this.taskSubscription);this.taskSubscription=undefined;this.observedTask=address?.toBase58();if(address&&this.deployment.useWebSocket!==false)this.taskSubscription=this.reader.connection.onAccountChange(address,()=>this.sync().catch(e=>this.disconnected(e)),'finalized');}
      const reason=r?null:f.paused?'paused':f.state===STATE.EXHAUSTED?'catalog-exhausted':f.state===STATE.CLOSED?'campaign-closed':now>=Number(f.deadline)?'campaign-deadline':f.state===STATE.DRAFT?'catalog-not-sealed':'waiting-for-advance';
      this.snapshot={schema:'flybrainlabs-factory-snapshot-v4',serverTime:now,round:r,factory:f,task:t,recovery:factoryTaskRecoveryV4(f,t,now),reason,state:[STATE.EXHAUSTED,STATE.CLOSED].includes(f.state)?'RESEARCH_STAGE_COMPLETE':f.paused?'PAUSED':'READY'};this.lastError=null;this.onConnection(true);this.onSnapshot(this.snapshot);return this.snapshot;
    })().catch(e=>{if(generation===this.generation)this.disconnected(e);throw e;}).finally(()=>this.syncing=null);return this.syncing;
  }
  async suspend(error){
    this.generation++;clearInterval(this.timer);this.timer=null;this.round=null;this.factory=null;this.snapshot=null;this.lastSync=null;this.observedTask=null;this.disconnected(error);
    for(const key of ['factorySubscription','taskSubscription'])if(this[key]!==undefined){const id=this[key];this[key]=undefined;await this.reader.connection.removeAccountChangeListener(id);}
  }
  get serverNow(){return this.lastSync?this.lastSync.serverTime+(performance.now()-this.lastSync.localAt)/1000:null;}
  disconnected(error){this.online=false;this.lastError=error?.message;this.onConnection(false,error);}
  async recoverTask({beforeSend=()=>{}}={}){
    if(this.recoveryPending)return this.recoveryPending;
    this.recoveryPending=(async()=>{
      beforeSend();this.assertMiningAuthorization?.();const snapshot=await this.sync(),action=snapshot.recovery;
      if(!action)return snapshot;
      const f=snapshot.factory,task=this.reader.a.task(this.deployment.factory,action.index),keys=[meta(this.deployment.factory,true),meta(task,true)];
      let tag=3;
      if(action.kind==='advance'){
        const next=await this.reader.task(action.index);if(snapshot.serverTime+next.descriptor.verifySeconds>Number(f.deadline))throw new Error('Insufficient campaign time for the next frozen task');
      }else{
        tag=action.kind==='finalize'?7:8;if(action.submission){const s=await this.reader.submission(action.submission,task);if(s.state!==STATE.VALID||s.attempt!==action.attempt||((s.validVotes&1)+((s.validVotes>>1)&1)+((s.validVotes>>2)&1))<2)throw new Error('Verified candidate quorum changed');keys.push(meta(action.submission));}
        if(f.nextIndex<f.count)keys.push(meta(this.reader.a.task(this.deployment.factory,f.nextIndex),true));
      }
      beforeSend();await this.send([instruction(this.reader.program,keys,tag)],{intent:`task-recovery-v4:${action.kind}:${action.index}:${action.attempt??0}`,replacementSafe:false,beforeSend});
      return this.sync();
    })().finally(()=>this.recoveryPending=null);return this.recoveryPending;
  }
  async advance(){const snapshot=await this.sync();return snapshot.recovery?.kind==='advance'?this.recoverTask():snapshot;}
  async expire(){return this.recoverTask();}
  // Both methods are optional telemetry. They never create or select tasks.
  async heartbeat(){} async reportWork(){}
  async dispose(){this.generation++;clearInterval(this.timer);for(const id of [this.factorySubscription,this.taskSubscription])if(id!==undefined)await this.reader.connection.removeAccountChangeListener(id);this.online=false;}
}
