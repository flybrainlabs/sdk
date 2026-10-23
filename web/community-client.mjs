// @ts-check
// Transport shares the connected wallet and authenticated tab session.
export class CommunityClient {
  constructor(config,session=null){this.config=config;this.session=session;}
  async request(path,{body=null,authenticated=false,download=false,oauth=false}={}){
    if(!/^\/api\/(social|community)\//.test(path))throw new Error('Unexpected community endpoint');
    const session=this.session,gen=session?.generation,wallet=session?.account?.address,login=session?.login;
    const guard=()=>{if(!authenticated)return;session.guard(gen,wallet);if(session.login!==login)throw Object.assign(new Error('Wallet session changed'),{code:'STALE_WALLET'});};
    /** @type {Record<string,string>} */
    const headers={};
    if(authenticated){if(!session?.account||!session.login)throw Object.assign(new Error('Sign in with your wallet to continue'),{code:'SESSION_REQUIRED'});headers.Authorization='Bearer '+session.login.token;if(body!==null)headers['X-Mining-CSRF']=session.login.csrfToken;}
    if(body!==null)headers['Content-Type']='application/json';
    if(oauth&&!['/api/social/github/start','/api/social/github/complete'].includes(path))throw new Error('Unexpected OAuth endpoint');
    const base=oauth?globalThis.location.origin:this.config.apiBase;
    const response=await fetch(base+path,{method:body===null?'GET':'POST',headers,body:body===null?undefined:JSON.stringify(body),credentials:oauth?'same-origin':'omit',cache:'no-store',signal:AbortSignal.timeout(30000)});
    guard();
    if(!response.ok){let value;try{value=await response.json();}catch{value={code:'provider_unavailable'};}guard();if(response.status===401&&value.code==='SESSION_REQUIRED'&&session?.login)session.clearLogin();throw Object.assign(new Error(value.code||'Community service unavailable'),{code:value.code,status:response.status});}
    const value=download?await response.blob():await response.json();
    guard();
    return value;
  }
  async signIn(){if(!this.session?.account){await this.session?.requestConnection();return false;}if(!this.session.login){try{await this.session.signIn();}catch(error){if(!this.session.login)throw error;}}return !!this.session.login;}
  async freshSignIn(){if(!this.session?.account||!await this.signIn())return false;if(this.session.login.expiresAt-28800<Date.now()/1000-240){try{await this.session.signIn();}catch(error){if(!this.session.login)throw error;}}return true;}
  register(inviteCode=null){return this.request('/api/social/register',{authenticated:true,body:inviteCode?{inviteCode}:{}});}
  checkIn(){return this.request('/api/social/check-in',{authenticated:true,body:{}});}
  invite(create=false){return this.request('/api/social/invite',{authenticated:true,...(create?{body:{}}:{})});}
  dailyChallenge(create=false){return this.request('/api/social/daily-x/challenge',{authenticated:true,...(create?{body:{}}:{})});}
  verifyDailyPost(challengeId,postUrl){return this.request('/api/social/daily-x/verify',{authenticated:true,body:{challengeId,postUrl}});}
  startGitHub(){return this.request('/api/social/github/start',{authenticated:true,body:{},oauth:true});}
  completeGitHub(){return this.request('/api/social/github/complete',{authenticated:true,body:{},oauth:true});}
  githubBinding(){return this.request('/api/social/github/binding',{authenticated:true});}
  verifyGitHub(taskId){return this.request('/api/social/github/verify',{authenticated:true,body:{taskId}});}
  projectStats(){return this.request('/api/community/projects/stats');}
  projectMe(){return this.request('/api/community/projects/me',{authenticated:true});}
  projectInterest(body){return this.request('/api/community/projects/interests',{authenticated:true,body});}
  projectPreference(body){return this.request('/api/community/projects/preferences',{authenticated:true,body});}
  projectSubmit(body){return this.request('/api/community/projects/applications/submit',{authenticated:true,body});}
  projectChange(id,action,body){if(!/^[a-f0-9]{32}$/.test(id)||!['update','withdraw','resubmit'].includes(action))throw new Error('Unexpected project action');return this.request('/api/community/projects/applications/'+id+'/'+action,{authenticated:true,body});}
  projectAdminList(filters={}){return this.request('/api/community/projects/admin/applications?'+new URLSearchParams(filters),{authenticated:true});}
  projectAdminSummary(){return this.request('/api/community/projects/admin/summary',{authenticated:true});}
  projectAdminDetail(id,before=0){if(!/^[a-f0-9]{32}$/.test(id))throw new Error('Unexpected application ID');return this.request('/api/community/projects/admin/applications/'+id+'?before='+encodeURIComponent(before),{authenticated:true});}
  projectReview(id,body){if(!/^[a-f0-9]{32}$/.test(id))throw new Error('Unexpected application ID');return this.request('/api/community/projects/admin/applications/'+id+'/review',{authenticated:true,body});}
  projectExport(filters={}){return this.request('/api/community/projects/admin/export?'+new URLSearchParams(filters),{authenticated:true,download:true});}
}
