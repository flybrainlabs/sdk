// One explicit unlocked-session approval for a pinned signed task pool. Each
// transaction still passes the original canonical account and beneficiary checks.
import {PublicKey} from '@solana/web3.js';
import {MiningWalletPolicyV4} from './mining-wallet-policy-v4.mjs';
import {verifyPoolManifestV4,verifyPoolCatalogV4} from './factory-pool-v4.mjs';
const fail=code=>Object.assign(new Error(code),{code});
export class MiningWalletPoolPolicyV4 extends EventTarget {
  constructor({deployment,connection,address}){
    super();Object.assign(this,{deployment,connection,address});this.trust=deployment.taskPool?.trust;
    if(this.trust?.anchorFactory!==deployment.factory)throw fail('POOL_TRUST_REQUIRED');
    this.base=new MiningWalletPolicyV4({deployment,connection,address});this.policies=new Map([[deployment.factory,this.base]]);this.base.addEventListener('change',()=>this.changed());
  }
  changed(){this.dispatchEvent(new Event('change'));}
  get approved(){return this.base.approved&&!this.blocked;}
  get blocked(){return this.base.blocked||[...this.policies.values()].find(p=>p.blocked)?.blocked||null;}
  get balance(){return this.base.balance;}
  get minimumLamports(){return this.base.minimumLamports;}
  toJSON(){return {...this.base.toJSON(),approved:this.approved,blocked:this.blocked,poolId:this.trust.poolId,catalogs:this.policies.size};}
  assertAuthorized(){this.base.assertAuthorized();if(this.blocked)throw fail(this.blocked);}
  assertCanMine(){this.assertAuthorized();this.base.assertCanMine();}
  revoke(){for(const p of this.policies.values())p.revoke();this.manifest=null;this.changed();}
  async quote(){const q=await this.base.quote();for(const p of this.policies.values())if(p!==this.base){p.balance=this.base.balance;p.minimumLamports=this.base.minimumLamports;if(p.blocked==='MINING_WALLET_BALANCE'&&p.balance>=BigInt(p.minimumLamports))p.blocked=null;}this.changed();return q;}
  async approve(){const r=await this.base.approve();for(const p of this.policies.values())p.authorization=this.base.authorization;return r;}
  async include(deployment,document){
    this.assertAuthorized();const approval=this.base.authorization;
    const verified=await verifyPoolManifestV4(document,this.trust,{previous:this.manifest});
    const entry=verified.body.catalogs.find(c=>c.factory===deployment.factory);
    if(!entry||['factoryId','catalogRoot','budgetAtoms','taskCount','deadline'].some(k=>String(entry[k])!==String(deployment[k])))throw fail('POOL_CATALOG_NOT_AUTHORIZED');
    await verifyPoolCatalogV4(deployment,this.trust,this.connection);
    this.assertAuthorized();if(this.base.authorization!==approval)throw fail('MINING_WALLET_APPROVAL');
    if(!this.policies.has(deployment.factory)){const p=new MiningWalletPolicyV4({deployment,connection:this.connection,address:this.address});p.authorization=approval;p.balance=this.base.balance;p.minimumLamports=this.base.minimumLamports;p.addEventListener('change',()=>this.changed());this.policies.set(deployment.factory,p);}
    this.manifest={revision:verified.revision,hash:verified.hash};return verified;
  }
  policy(tx){
    this.assertAuthorized();const ix=tx.instructions.find(i=>i.programId.equals(new PublicKey(this.deployment.programId)));
    if(!ix||ix.data.length<6)throw fail('MINING_WALLET_TRANSACTION');const factory=ix.keys[ix.data[5]===9?1:0]?.pubkey.toBase58(),policy=this.policies.get(factory);
    if(!policy)throw fail('POOL_CATALOG_NOT_AUTHORIZED');return policy;
  }
  check(tx){return this.policy(tx).check(tx);}
  reserve(tx){return this.policy(tx).reserve(tx);}
}
