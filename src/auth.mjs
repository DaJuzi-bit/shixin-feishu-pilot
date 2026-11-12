import {createHash,randomBytes} from 'node:crypto';
const secret=()=>randomBytes(32).toString('base64url');
const hash=value=>createHash('sha256').update(value).digest('hex');
export function cookies(request) {
  return Object.fromEntries((request.headers.cookie||'').split(';').map(item=>{const [name,...value]=item.trim().split('=');return [name,value.join('=')];}));
}
export class Auth {
  constructor(store,config,clock=Date.now){Object.assign(this,{store,config,clock});}
  cookie(name,value,maxAge){return name+'='+value+'; HttpOnly; SameSite=Lax; Path=/; Max-Age='+maxAge+(this.config.publicBaseUrl.startsWith('https:')?'; Secure':'');}
  login(user) {
    this.store.run('INSERT OR REPLACE INTO users VALUES(?,?,?)',user.id,user.tenantId,user.name);
    const token=secret(),csrf=secret();this.store.run('INSERT INTO sessions VALUES(?,?,?,?)',hash(token),user.id,csrf,this.clock()+7*86400000);
    return {cookie:this.cookie('pilot_session',token,7*86400),csrf,user};
  }
  session(request) {
    const token=cookies(request).pilot_session;if(!token)return null;
    const row=this.store.get('SELECT s.*,u.name,u.tenant FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires_at>?',hash(token),this.clock());
    return row?{hash:row.hash,csrf:row.csrf,user:{id:row.user_id,name:row.name,tenantId:row.tenant}}:null;
  }
  logout(request){const token=cookies(request).pilot_session;if(token)this.store.run('DELETE FROM sessions WHERE hash=?',hash(token));return this.cookie('pilot_session','',0);}
  beginOAuth() {
    const state=secret(),verifier=secret();this.store.run('DELETE FROM oauth_states WHERE expires_at<?',this.clock());this.store.run('INSERT INTO oauth_states VALUES(?,?,?)',hash(state),verifier,this.clock()+600000);
    const url=new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
    url.search=new URLSearchParams({client_id:this.config.appId,response_type:'code',redirect_uri:this.config.publicBaseUrl+'/auth/feishu/callback',scope:this.config.oauthScope,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
    return {url:url.href,cookie:this.cookie('pilot_oauth',state,600)};
  }
  consumeOAuth(state,request) {
    if(!state||cookies(request).pilot_oauth!==state)return null;
    return this.store.tx(()=>{const row=this.store.get('SELECT verifier FROM oauth_states WHERE hash=? AND expires_at>?',hash(state),this.clock());this.store.run('DELETE FROM oauth_states WHERE hash=?',hash(state));return row?.verifier??null;});
  }
}
