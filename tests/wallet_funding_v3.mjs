import assert from 'node:assert/strict';
import {miningFundingGate,fundingFingerprint,fundingError} from '../web/wallet-funding-v3.mjs';

const base={config:{enabled:true,stage:'approved-stage',units:[{goalId:'open-goal'}]},account:{address:'wallet'},login:{expiresAt:200},balances:{funding:{state:'funded'}},grant:{address:'grant',generation:'1',available:'100',maxResultRent:'100',maxSpend:'100',spent:'0',successes:'0',maxResults:'2',expiresAt:'150',revoked:false},round:{pre:{goalId:'open-goal'}},now:100};
let checks=0;
const check=(patch,expected)=>{assert.equal(miningFundingGate({...base,...patch}),expected);checks++;};
check({},null);
check({account:null},'wallet-required');
check({login:null},'wallet-login-required');
check({login:{expiresAt:100}},'wallet-login-required');
check({balances:null},'funding-check-required');
check({grant:null},'funding-required');
for(const patch of [{revoked:true},{expiresAt:'99'},{available:'0'},{successes:'2'},{spent:'100'}])check({grant:{...base.grant,...patch}},'funding-required');
check({config:{...base.config,enabled:false}},'funding-unavailable');
check({round:{pre:{goalId:'unfunded-goal'}}},'funding-unavailable');
check({balances:{funding:{state:'complete'}}},'funding-unavailable');
const issue={scope:fundingFingerprint(base.config,base.account,base.grant,base.round),code:'funding-device-required'};
check({issue},'funding-device-required');
check({issue,grant:{...base.grant,generation:'2'}},null);
check({issue,account:{address:'other-wallet'}},null);
check({issue,config:{...base.config,stage:'new-approved-stage'}},null);
check({issue,round:{pre:{goalId:'other-goal'}},config:{...base.config,units:[{goalId:'other-goal'}]}},null);
check({issue:{...issue,code:'funding-insufficient'},grant:{...base.grant,available:'101'}},null);
for(const code of ['funding-required','funding-insufficient','funding-device-required']){assert.equal(fundingError(code).code,code);checks++;}
console.log(JSON.stringify({passed:true,checks,transactions:0}));
