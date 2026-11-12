import {PilotError} from './errors.mjs';
export class FeishuTransport {
  constructor(config,{fetchImpl=fetch,clock=Date.now}={}){Object.assign(this,{config,fetchImpl,clock});this.cachedToken=null;this.tokenPromise=null;this.connection=null;this.connectionError=null;}
  async request(path,{method='GET',body,token}={}) {
    let response;
    try{response=await this.fetchImpl('https://open.feishu.cn/open-apis'+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});}catch{throw new PilotError('飞书连接暂时失败，请稍后重试',503,'feishu_network');}
    const value=await response.json().catch(()=>null);
    if(token===this.cachedToken?.value&&(!response.ok||Number(value?.code)>=99991661&&Number(value?.code)<=99991669))this.cachedToken=null;
    if(!response.ok||!value||(value.code!==undefined&&value.code!==0)||value.error)throw new PilotError('飞书接口未成功，请检查应用权限和配置（'+String(value?.code??response.status)+'）',502,'feishu_api');
    return value;
  }
  async tenantToken() {
    if(this.cachedToken?.expires>this.clock()+60000)return this.cachedToken.value;
    if(this.tokenPromise)return this.tokenPromise;
    this.tokenPromise=(async()=>{const data=await this.request('/auth/v3/tenant_access_token/internal',{method:'POST',body:{app_id:this.config.appId,app_secret:this.config.appSecret}});if(!data.tenant_access_token)throw new PilotError('飞书未返回应用令牌',502);this.cachedToken={value:data.tenant_access_token,expires:this.clock()+Number(data.expire??7200)*1000};return this.cachedToken.value;})();
    try{return await this.tokenPromise;}finally{this.tokenPromise=null;}
  }
  async isGroupMember(groupId,userId) {
    const token=await this.tenantToken();let cursor='';
    for(let page=0;page<50;page++){
      const query=new URLSearchParams({member_id_type:'open_id',page_size:'100',...(cursor?{page_token:cursor}:{})});
      const response=await this.request('/im/v1/chats/'+encodeURIComponent(groupId)+'/members?'+query,{token});
      if((response.data?.items??[]).some(m=>m.member_id===userId))return true;
      if(!response.data?.has_more)return false;
      cursor=response.data.page_token;if(!cursor)throw new PilotError('群成员分页未完整返回',503);
    }
    throw new PilotError('群成员过多，首轮试用暂不支持',503);
  }
  async sendText(userId,text,uuid,canSend=()=>true) {
    const token=await this.tenantToken();
    // Token refresh can await the network. Re-check the durable task at the POST boundary.
    if(!canSend())return {cancelled:true};
    const result=await this.request('/im/v1/messages?receive_id_type=open_id',{method:'POST',token,body:{receive_id:userId,msg_type:'text',content:JSON.stringify({text}),uuid}});
    if(!result.data?.message_id)throw new PilotError('飞书未确认提醒已发送',502);
    return {messageId:result.data.message_id};
  }
  async sendCard(userId,card,uuid,canSend=()=>true) {
    const content=JSON.stringify(card);
    if(Buffer.byteLength(content)>30000)throw new PilotError('卡片内容过长，请缩小展示范围');
    const token=await this.tenantToken();
    if(!canSend())return {cancelled:true};
    const result=await this.request('/im/v1/messages?receive_id_type=open_id',{method:'POST',token,body:{receive_id:userId,msg_type:'interactive',content,uuid}});
    if(!result.data?.message_id)throw new PilotError('飞书未确认卡片已发送',502);
    return {messageId:result.data.message_id};
  }
  async updateCard(messageId,card) {
    const content=JSON.stringify(card);
    if(Buffer.byteLength(content)>30000)throw new PilotError('卡片内容过长，请缩小展示范围');
    const token=await this.tenantToken();
    await this.request('/im/v1/messages/'+encodeURIComponent(messageId),{method:'PATCH',token,body:{content}});
    return {messageId};
  }
  async exchangeCode(code,verifier,redirectUri) {
    const result=await this.request('/authen/v2/oauth/token',{method:'POST',body:{grant_type:'authorization_code',client_id:this.config.appId,client_secret:this.config.appSecret,code,redirect_uri:redirectUri,code_verifier:verifier}});
    if(!result.access_token)throw new PilotError('飞书未返回登录令牌',502);
    const info=await this.request('/authen/v1/user_info',{token:result.access_token});
    const user=info.data;
    if(!user?.open_id||user.tenant_key!==this.config.tenantKey)throw new PilotError('请使用本次试用团队的飞书账号登录',403,'wrong_team');
    return {id:user.open_id,name:user.name||'试用成员',tenantId:user.tenant_key};
  }
  async startReceiver(onMessage,{onCardAction=()=>({})}={}) {
    const sdk=await import('@larksuiteoapi/node-sdk');
    // Suppress raw SDK errors: their HTTP details may include app credentials.
    const logger={debug(){},trace(){},info(){},warn:()=>{this.connectionError='飞书连接正在重试';},error:()=>{this.connectionError='飞书连接异常，请检查凭证与事件配置';}};
    this.connection=new sdk.WSClient({appId:this.config.appId,appSecret:this.config.appSecret,domain:sdk.Domain.Feishu,logger,loggerLevel:sdk.LoggerLevel.warn,onReady:()=>{this.connectionError=null;},onReconnected:()=>{this.connectionError=null;},onReconnecting:()=>{this.connectionError='飞书连接正在恢复';},onError:()=>{this.connectionError='飞书连接失败';}});
    const dispatcher=new sdk.EventDispatcher({logger,loggerLevel:sdk.LoggerLevel.warn}).register({'im.message.receive_v1':data=>{onMessage(data);return {};},'card.action.trigger':data=>onCardAction(data)});
    await this.connection.start({eventDispatcher:dispatcher});
  }
  status(){return {connected:this.connection?.getConnectionStatus?.().state==='connected',note:this.connectionError};}
  close(){this.connection?.close({force:true});}
}
export class LocalTransport {
  constructor(){this.deliveries=[];}
  async isGroupMember(){return true;}
  async sendText(user,text,uuid,canSend=()=>true){if(!canSend())return {cancelled:true};if(!this.deliveries.some(x=>x.uuid===uuid))this.deliveries.push({user,text,uuid});return {messageId:'local-'+uuid};}
  status(){return {connected:false,note:'本地联调只记录提醒，不会向飞书发送消息'};}
  close(){}
}

