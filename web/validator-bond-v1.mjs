// Fixed-term FBW collateral, separate from historical economic instructions.
import {PublicKey,TransactionInstruction,SystemProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,unpackAccount,unpackMint} from '@solana/spl-token';
import {Writer,Reader} from './campaign-codec.mjs';
export const MINIMUM_BOND_ATOMS=10000000000000n,LOCK_SECONDS=2592000n,UNBOND_SECONDS=604800n;
export const DEVNET_GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const error=code=>Object.assign(new Error(code),{code});
const key=v=>new PublicKey(v),same=(a,b)=>key(a).equals(key(b));
export function bondAddresses(program,validator){
  const p=key(program),pda=(...v)=>PublicKey.findProgramAddressSync(v.map(x=>Buffer.from(x)),p)[0];
  const policy=pda(Buffer.from('validator-policy-v1'));
  const bond=validator?pda(Buffer.from('validator-bond-v1'),key(validator).toBytes()):null;
  return {policy,bond,vault:bond?pda(Buffer.from('validator-vault-v1'),bond.toBytes()):null,
    programData:PublicKey.findProgramAddressSync([p.toBytes()],key('BPFLoaderUpgradeab1e11111111111111111111111'))[0]};
}
function begin(data,tag){const r=new Reader(data);if(data.length!==256||Buffer.from(r.bytes(8)).toString()!==tag)throw error('BOND_ACCOUNT_FORMAT');return r;}
function end(r){if(r.b.slice(r.p).some(x=>x!==0))throw error('BOND_ACCOUNT_PADDING');}
export function decodeBondPolicy(data){const r=begin(data,'FBWPOL01'),v={network:r.key(),mint:r.key(),clearanceAuthority:r.key(),minimum:r.u64(),lockSeconds:r.i64(),unbondSeconds:r.i64()};end(r);return v;}
export function decodeBond(data){const r=begin(data,'FBWBND01'),v={policy:r.key(),validator:r.key(),amount:r.u64(),generation:r.u64(),activatedAt:r.i64(),exitRequestedAt:r.i64(),withdrawAfter:r.i64(),state:r.u8(),clearanceEvidence:r.key()};end(r);if(v.state>2||v.generation<1n)throw error('BOND_ACCOUNT_STATE');return v;}
const meta=(pubkey,isWritable=false,isSigner=false)=>({pubkey:key(pubkey),isWritable,isSigner});
export function bondInstruction(program,tag,{mint,validator,payer=validator,source,destination,network=DEVNET_GENESIS,amount=MINIMUM_BOND_ATOMS,clearanceAuthority,generation,evidence}={}){
  const a=bondAddresses(program,validator),w=new Writer().u8(tag);let keys;
  if(tag===0){w.key(key(network));keys=[meta(a.policy,true),meta(mint),meta(payer,true,true),meta(SystemProgram.programId),meta(a.programData)];}
  else if(tag===1){w.u64(amount);keys=[meta(a.policy),meta(a.bond,true),meta(a.vault,true),meta(mint),meta(source,true),meta(validator,false,true),meta(payer,true,true),meta(SystemProgram.programId),meta(TOKEN_PROGRAM_ID)];}
  else if(tag===2)keys=[meta(a.policy),meta(a.bond,true),meta(validator,false,true)];
  else if(tag===3){w.u64(generation).key(evidence);keys=[meta(a.policy),meta(a.bond,true),meta(a.vault,true),meta(mint),meta(destination,true),meta(validator,false,true),meta(clearanceAuthority,false,true),meta(TOKEN_PROGRAM_ID)];}
  else throw error('BOND_INSTRUCTION');
  return new TransactionInstruction({programId:key(program),keys,data:Buffer.from(w.result())});
}
export class ValidatorBondReaderV1 {
  constructor(connection,deployment){
    if(deployment?.schema!=='flybrain-validator-bond-deployment-v1'||deployment.cluster!=='devnet'||deployment.genesisHash!==DEVNET_GENESIS)throw error('BOND_DEPLOYMENT_REQUIRED');
    for(const n of ['programId','mint','clearanceAuthority'])key(deployment[n]);
    Object.assign(this,{connection,deployment});
  }
  async check(validator,{allowExiting=false}={}){
    if(await this.connection.getGenesisHash()!==this.deployment.genesisHash)throw error('BOND_CHAIN_SCOPE');
    const d=this.deployment,a=bondAddresses(d.programId,validator),keys=[a.policy,a.bond,a.vault,key(d.mint)];
    const result=await this.connection.getMultipleAccountsInfoAndContext(keys,{commitment:'finalized'});
    const [pi,bi,vi,mi]=result.value;
    if(!pi||!bi||!vi||!mi||!same(pi.owner,d.programId)||!same(bi.owner,d.programId))throw error('VALIDATOR_BOND_REQUIRED');
    const p=decodeBondPolicy(pi.data),b=decodeBond(bi.data),v=unpackAccount(a.vault,vi),m=unpackMint(key(d.mint),mi);
    if(!same(p.network,d.genesisHash)||!same(p.mint,d.mint)||!same(p.clearanceAuthority,d.clearanceAuthority)||p.minimum!==MINIMUM_BOND_ATOMS||p.lockSeconds!==LOCK_SECONDS||p.unbondSeconds!==UNBOND_SECONDS||!same(b.policy,a.policy)||!same(b.validator,validator)||m.decimals!==8||m.mintAuthority!==null||m.freezeAuthority!==null||!same(v.mint,d.mint)||!same(v.owner,a.bond)||v.delegate!==null||v.closeAuthority!==null||!v.isInitialized||v.isFrozen)throw error('VALIDATOR_BOND_SCOPE');
    if(b.amount<p.minimum||v.amount<b.amount||(b.state!==1&&!(allowExiting&&b.state===2))||b.activatedAt<=0n||b.generation<1n)throw error('VALIDATOR_BOND_INACTIVE');
    if(b.state===1&&(b.exitRequestedAt!==0n||b.withdrawAfter!==0n))throw error('VALIDATOR_BOND_STATE');
    return {schema:'flybrain-validator-bond-status-v1',validator:key(validator).toBase58(),bond:a.bond.toBase58(),vault:a.vault.toBase58(),amountAtoms:String(b.amount),generation:String(b.generation),activatedAt:String(b.activatedAt),minimumLockUntil:String(b.activatedAt+p.lockSeconds),state:b.state===1?'active':'exiting',exitRequestedAt:String(b.exitRequestedAt),withdrawAfter:String(b.withdrawAfter),finalizedSlot:result.context.slot};
  }
}
