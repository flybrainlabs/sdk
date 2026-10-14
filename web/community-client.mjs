// @ts-check
// Transport shares the connected wallet and authenticated tab session.
export class CommunityClient {
  constructor(config,session=null){this.config=config;this.session=session;}
  async request(path,{body=null,authenticated=false,download=false}={}){
    if(!/^\/api\/(social|community)\//.test(path))throw new Error('Unexpected community endpoint');
    const session=this.session,gen=session?.generation,wallet=session?.account?.address;
    /** @type {Record<string,string>} */
    const headers={};
    if(authenticated){if(!session?.account||!session.login)throw Object.assign(new Error('Sign in with your wallet to continue'),{code:'SESSION_REQUIRED'});headers.Authorization='Bearer '+session.login.token;if(body!==null)headers['X-Mining-CSRF']=session.login.csrfToken;}
    if(body!==null)headers['Content-Type']='application/json';
    const response=await fetch(this.config.apiBase+path,{method:body===null?'GET':'POST',headers,body:body===null?undefined:JSON.stringify(body),credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(20000)});
    if(authenticated)session.guard(gen,wallet);
    if(!response.ok){let value;try{value=await response.json();}catch{value={code:'provider_unavailable'};}if(response.status===401&&value.code==='SESSION_REQUIRED'&&session?.login)session.clearLogin();throw Object.assign(new Error(value.code||'Community service unavailable'),{code:value.code,status:response.status});}
    return download?response.blob():response.json();
  }
  async signIn(){if(!this.session?.account){await this.session?.requestConnection();return false;}if(!this.session.login){try{await this.session.signIn();}catch(error){if(!this.session.login)throw error;}}return !!this.session.login;}
  async freshSignIn(){if(!this.session?.account||!await this.signIn())return false;if(this.session.login.expiresAt-28800<Date.now()/1000-240){try{await this.session.signIn();}catch(error){if(!this.session.login)throw error;}}return true;}
  register(inviteCode=null){return this.request('/api/social/register',{authenticated:true,body:inviteCode?{inviteCode}:{}});}
  checkIn(){return this.request('/api/social/check-in',{authenticated:true,body:{}});}
  invite(create=false){return this.request('/api/social/invite',{authenticated:true,...(create?{body:{}}:{})});}
  dailyChallenge(create=false){return this.request('/api/social/daily-x/challenge',{authenticated:true,...(create?{body:{}}:{})});}
  verifyDailyPost(challengeId,postUrl){return this.request('/api/social/daily-x/verify',{authenticated:true,body:{challengeId,postUrl}});}
}
