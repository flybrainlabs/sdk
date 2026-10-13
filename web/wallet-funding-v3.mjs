// Presentation never replaces the fresh gateway, rent and device checks at start.
export function fundingFingerprint(config,account,grant,round){
  return [config.stage,account?.address,round?.pre.goalId,grant?.address,grant?.generation,grant?.available,grant?.maxResultRent,grant?.maxSpend,grant?.spent,grant?.successes,grant?.maxResults,grant?.expiresAt].join('\0');
}
export function miningFundingGate({config,account,login,balances,grant,round,issue=null,now=Math.floor(Date.now()/1000)}){
  if(!account)return 'wallet-required';
  if(!login||Number(login.expiresAt)<=now)return 'wallet-login-required';
  if(!balances)return 'funding-check-required';
  if(!config.enabled||!config.units?.some(u=>u.goalId===round?.pre.goalId)||balances.funding?.state==='complete')return 'funding-unavailable';
  if(!grant||grant.revoked||BigInt(grant.expiresAt)<BigInt(now)||BigInt(grant.available)<=0n||BigInt(grant.successes)>=BigInt(grant.maxResults)||BigInt(grant.spent)>=BigInt(grant.maxSpend))return 'funding-required';
  if(issue?.scope===fundingFingerprint(config,account,grant,round))return issue.code;
  return null;
}
const details={
  'wallet-required':'Connect your wallet before mining',
  'wallet-login-required':'Sign in before mining',
  'funding-check-required':'Synchronize wallet balances and grants before mining',
  'funding-unavailable':'This round has no usable frozen reward budget',
  'funding-required':'Create or renew a finite rent grant',
  'funding-insufficient':'Insufficient finite result-rent credit',
  'funding-device-required':'Renew this grant for the current device'
};
export function fundingError(code){return Object.assign(new Error(details[code]||code),{code});}
