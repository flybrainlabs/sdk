// Execute the retained SBF program in an isolated in-memory Solana VM.
// Account/science fixtures and VM lamports do not create a public budget.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {LiteSVM,Clock,FailedTransactionMetadata} from 'litesvm';
import {getTransactionDecoder} from '@solana/kit';
import {PublicKey,Transaction} from '@solana/web3.js';
import {MiningWalletV4,newMiningMnemonic} from '../web/mining-wallet-v4.mjs';
import {MiningWalletPolicyV4} from '../web/mining-wallet-policy-v4.mjs';
import {instruction,meta,system} from '../tools/task_factory_v4_client.mjs';
import {decodeFactory,decodeTask,decodeSubmission,commitment,hash,text} from '../web/task-factory-v4-codec.mjs';
const vector=JSON.parse(await readFile('tests/vectors/factory-user-rpc-v4.json','utf8')),d=vector.deployment;
const binary=process.env.MINING_WALLET_SBF||'/workspace/.flypow-publish/task-factory-v4-20261015/sbf/flypow_economy_v2_program.so',svm=new LiteSVM();
svm.addProgramFromFile(d.programId,binary);
for(const [address,value]of Object.entries(vector.accounts))svm.setAccount({address,lamports:BigInt(value.lamports),data:new Uint8Array(Buffer.from(value.data[0],'base64')),programAddress:value.owner,executable:!!value.executable});
svm.setClock(new Clock(BigInt(vector.slot),0n,0n,0n,BigInt(vector.clock)));
const memory={record:null,async load(){return this.record;},async save(v){this.record=structuredClone(v);}},wallet=new MiningWalletV4({deployment:d,store:memory});await wallet.initialize();
const phrase=newMiningMnemonic(),password=Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');await wallet.save(phrase,password,{confirmed:true,restored:true});const address=wallet.address;
svm.airdrop(address,50000000n);
const connection={async getGenesisHash(){return d.genesisHash;},async getAccountInfo(key){const value=svm.getAccount(key.toBase58());return value.exists?{owner:new PublicKey(value.programAddress),data:Buffer.from(value.data),lamports:Number(value.lamports)}:null;},async getBalance(key){return Number(svm.getBalance(key.toBase58())||0n);},async getMinimumBalanceForRentExemption(size){return Number(svm.minimumBalanceForRentExemption(BigInt(size)));},async getFeeForMessage(){return {value:5000};}};
const policy=new MiningWalletPolicyV4({deployment:d,connection,address});wallet.policy=policy;await policy.approve();
const f=await policy.reader.factory(),t=await policy.reader.task(f.activeIndex),task=policy.reader.a.task(d.factory,t.index),miner=new PublicKey(address),salt=hash(text('isolated-wallet-sbf-salt'));
const evidence={candidate:hash(text('isolated-candidate')),result:hash(text('isolated-result')),manifest:hash(text('isolated-manifest')),archive:hash(text('isolated-archive'))};
const digest=commitment(policy.reader.program,f,task,t.attempt,miner,miner,evidence,salt),submission=policy.reader.a.submission(task,t.attempt,miner,digest);
const provider=wallet.provider(),account=provider.accounts[0],checks=[];let transactions=0;
async function send(ix){
  const tx=new Transaction({feePayer:miner,recentBlockhash:svm.latestBlockhash()}).add(ix),[out]=await provider.features['solana:signTransaction'].signTransaction({account,chain:'solana:devnet',transaction:tx.serialize({requireAllSignatures:false,verifySignatures:false})});
  const result=svm.sendTransaction(getTransactionDecoder().decode(out.signedTransaction));assert(!(result instanceof FailedTransactionMetadata),'SBF transaction failed: '+(result instanceof FailedTransactionMetadata?String(result.err()):''));transactions++;return result;
}
const before=svm.getBalance(address),factoryBalance=svm.getBalance(d.factory),taskBalance=svm.getBalance(task.toBase58());
await send(instruction(d.programId,[meta(d.factory),meta(task,true),meta(submission,true),meta(miner,false,true),meta(miner,true,true),system()],4,{commitment:digest,beneficiary:miner}));
const stored=svm.getAccount(submission.toBase58()),rent=svm.minimumBalanceForRentExemption(768n),after=svm.getBalance(address);
assert(stored.exists&&stored.programAddress===d.programId);assert.equal(stored.lamports,rent);assert.equal(before-after,rent+5000n);assert.equal(svm.getBalance(d.factory),factoryBalance);assert.equal(svm.getBalance(task.toBase58()),taskBalance);assert.equal(decodeSubmission(Buffer.from(stored.data)).state,1);
checks.push('The local mnemonic wallet signs a real SBF Commit without an extension');checks.push('The wallet loses exactly the live PDA deposit plus the transaction fee; factory/task balances receive no SOL');
const clock=svm.getClock();clock.slot+=2n;svm.setClock(clock);svm.expireBlockhash();
await send(instruction(d.programId,[meta(d.factory),meta(task,true),meta(submission,true),meta(miner,false,true)],5,{evidence,salt}));assert.equal(decodeSubmission(Buffer.from(svm.getAccount(submission.toBase58()).data)).state,2);assert.equal(svm.getBalance(address),after-5000n);
checks.push('A second automatic signature reveals the same commitment and charges only its network fee');
wallet.lock();assert(!policy.approved);await assert.rejects(provider.features['solana:signTransaction'].signTransaction({account,chain:'solana:devnet',transaction:new Uint8Array()}),e=>e.code==='MINING_WALLET_LOCKED');
const recovered=new MiningWalletV4({deployment:d,store:{async load(){return null;},async save(){}}});await recovered.initialize();await recovered.save(phrase,password+'new',{confirmed:true,restored:true});assert.equal(recovered.address,address);
checks.push('Locking revokes automatic payments, and phrase recovery retains the funded on-chain address');
const report={schema:'flybrainlabs-mining-wallet-sbf-v4',passed:true,checks,transactions,environment:'isolated LiteSVM; imported public frozen account fixtures; no public finality claim',programSha256:createHash('sha256').update(await readFile(binary)).digest('hex'),pdaRentLamports:String(rent),networkFeeLamports:'10000',teamSolReceived:'0',publicChainTransactions:0,secretMaterialLogged:false};
if(process.env.MINING_WALLET_SBF_REPORT)await writeFile(process.env.MINING_WALLET_SBF_REPORT,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
