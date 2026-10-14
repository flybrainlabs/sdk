// Adopt a prospectively funded stage without changing wallet permissions.
const stable=['schema','cluster','rpc','genesisHash','programId','mint','policyHash','project','relayer','authorityId','retentionSeconds'];
const budget=['stage','deadline','budgetAtoms','units'];
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const atoms=s=>{if(typeof s!=='string'||!/^(0|[1-9][0-9]*)$/.test(s)||BigInt(s)>0xffffffffffffffffn)throw new Error('Invalid frozen plan amount');return BigInt(s);};
export function adoptWalletPlan(current,approved,live){
  if(!approved?.enabled||!live?.enabled||approved.testOnly!==true||live.testOnly!==true||approved.apiBase!==current.apiBase||stable.some(k=>approved[k]!==current[k]||live[k]!==current[k])||!equal(approved.settlers,current.settlers)||!equal(live.settlers,current.settlers)||!equal(approved.defaultGrant,current.defaultGrant))throw new Error('Wallet plan changed its pinned identity or permission defaults');
  if(budget.some(k=>!equal(approved[k],live[k]))||!Array.isArray(approved.units)||approved.units.length<1||approved.units.length>128||new Set(approved.units.map(u=>u.economicTaskId)).size!==approved.units.length||new Set(approved.units.map(u=>u.goalId)).size!==approved.units.length)throw new Error('Wallet gateway does not match the published frozen plan');
  if(!approved.units.every(u=>/^[a-f0-9]{64}$/.test(u.goalId)&&/^[a-f0-9]{64}$/.test(u.economicTaskId)&&atoms(u.rewardAtoms)>0n)||approved.units.reduce((n,u)=>n+atoms(u.rewardAtoms),0n)!==atoms(approved.budgetAtoms))throw new Error('Wallet plan budget does not equal its fixed units');
  const result={...current};for(const k of [...budget,'planState','paidAtoms'])if(approved[k]!==undefined)result[k]=approved[k];return result;
}
