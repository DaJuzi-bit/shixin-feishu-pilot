import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Auth} from './auth.mjs';
import {PilotError,requireValue} from './errors.mjs';
import {authorizeLanRequest} from './network.mjs';
const root=fileURLToPath(new URL('../public/',import.meta.url));
const assets=new Map([['/',['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/reading-state.mjs',['reading-state.mjs','text/javascript; charset=utf-8']],['/styles.css',['styles.css','text/css; charset=utf-8']],['/favicon.svg',['favicon.svg','image/svg+xml']]]);
function respond(res,status,value,headers={}){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});res.end(JSON.stringify(value));}
async function body(req) {
  requireValue((req.headers['content-type']||'').split(';')[0]==='application/json','请使用JSON请求',415);
  let data='',size=0;for await(const chunk of req){size+=chunk.length;if(size>32768)throw new PilotError('请求内容过大',413);data+=chunk;}
  try{const value=JSON.parse(data||'{}');requireValue(value&&typeof value==='object'&&!Array.isArray(value),'请求格式不正确');return value;}catch(e){if(e instanceof PilotError)throw e;throw new PilotError('请求JSON格式不正确');}
}
const loopback=value=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(value);
export function createHttpServer({store,service,transport,config,clock=Date.now}) {
  const auth=new Auth(store,config,clock);
  const limits=new Map();
  const status=()=>({mode:config.mode,lanPreview:!!config.lanPreview,primaryUi:config.primaryUi||'page',configured:config.mode==='feishu'&&!!config.appId&&!!config.appSecret,connected:!!transport.status().connected,extractor:'rules',notes:config.mode==='local'?'本地联调 · 未连接飞书。只记录提醒，不实际发送。':transport.status().note??'请在指定飞书群内正常发言，网页会同步已授权的群消息。'});
  const server=createServer(async(req,res)=>{
    res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');res.setHeader('x-frame-options','DENY');
    res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try{
      requireValue(authorizeLanRequest(req,config),'这个地址仅允许指定设备进行同网测试',403,'lan_access');
      const url=new URL(req.url,'http://127.0.0.1');
      if(config.mode==='local'){
        let hostname;try{hostname=new URL('http://'+req.headers.host).hostname;}catch{throw new PilotError('请求地址不正确');}
        requireValue(loopback(req.socket.remoteAddress)&&['127.0.0.1','localhost','[::1]'].includes(hostname),'本地联调只允许从本机访问',403);
      }
      const session=auth.session(req);
      if(req.method==='GET'&&url.pathname==='/api/status'){respond(res,200,status());return;}
      if(req.method==='GET'&&url.pathname==='/api/me'){respond(res,200,{user:session?.user??null,csrfToken:session?.csrf??null,loginUrl:'/auth/feishu/start',localDemoAvailable:config.mode==='local'});return;}
      if(req.method==='GET'&&url.pathname==='/auth/feishu/start'){
        requireValue(config.mode==='feishu','本地联调未配置飞书登录',409);
        const result=auth.beginOAuth();res.writeHead(302,{location:result.url,'set-cookie':result.cookie,'cache-control':'no-store'});res.end();return;
      }
      if(req.method==='GET'&&url.pathname==='/auth/feishu/callback'){
        requireValue(config.mode==='feishu','本地联调不接受飞书授权回调',409);
        const verifier=auth.consumeOAuth(url.searchParams.get('state'),req);requireValue(verifier,'登录请求已过期或校验失败，请重新登录',400,'oauth_state');
        const code=url.searchParams.get('code');requireValue(code&&code.length<2048,'未获得飞书授权码，请重新登录');
        const user=await transport.exchangeCode(code,verifier,config.publicBaseUrl+'/auth/feishu/callback');await service.allowedGroups(user);
        const result=auth.login(user);res.writeHead(302,{location:'/', 'set-cookie':[result.cookie,auth.cookie('pilot_oauth','',0)],'cache-control':'no-store'});res.end();return;
      }
      if(req.method==='GET'&&assets.has(url.pathname)){
        const [file,type]=assets.get(url.pathname);const data=await readFile(root+file);res.writeHead(200,{'content-type':type,'cache-control':'no-cache'});res.end(data);return;
      }
      if(!url.pathname.startsWith('/api/'))throw new PilotError('没有这个页面',404);
      let input={};
      if(['POST','PATCH'].includes(req.method)){
        const expected=config.mode==='local'?'http://'+req.headers.host:config.publicBaseUrl;
        requireValue(!req.headers.origin||req.headers.origin===expected,'请求来源不受信任',403,'origin');
        requireValue(req.headers['sec-fetch-site']!=='cross-site','不接受跨站请求',403,'origin');
        input=await body(req);
      }
      if(req.method==='POST'&&url.pathname==='/api/demo/login'){
        requireValue(config.mode==='local','这个接口只用于本地联调',404);
        const minute=Math.floor(clock()/60000),key=req.socket.remoteAddress+':'+minute;
        limits.set(key,(limits.get(key)??0)+1);requireValue(limits.get(key)<=30,'请求过于频繁，请稍后重试',429);
        if(limits.size>1000)limits.clear();
        requireValue(['alice','bob'].includes(input.userId),'请选择一个联调成员');
        const user={id:'ou_local_'+input.userId,name:input.userId==='alice'?'小组成员A':'小组成员B',tenantId:config.tenantKey};
        const result=auth.login(user);respond(res,200,{user,csrfToken:result.csrf},{'set-cookie':result.cookie});return;
      }
      requireValue(session,'请先登录',401,'login_required');
      if(['POST','PATCH'].includes(req.method))requireValue(req.headers['x-csrf-token']===session.csrf,'操作校验失败，请刷新页面重试',403,'csrf');
      if(req.method==='POST'&&url.pathname==='/api/logout'){respond(res,200,{ok:true},{'set-cookie':auth.logout(req)});return;}
      if(req.method==='GET'&&url.pathname==='/api/dashboard'){respond(res,200,{...await service.dashboard(session.user),status:status()});return;}
      if(req.method==='GET'&&url.pathname==='/api/updates'){const board=await service.dashboard(session.user);respond(res,200,{revision:board.revision,accessRevision:board.accessRevision,messageCount:board.messageCount,status:status()});return;}
      let match;
      if(req.method==='GET'&&(match=url.pathname.match(/^\/api\/groups\/([^/]+)\/messages$/))){respond(res,200,{messages:await service.messages(session.user,decodeURIComponent(match[1]))});return;}
      if(req.method==='POST'&&url.pathname==='/api/demo/messages'){
        requireValue(config.mode==='local','这个接口只用于本地联调',404);
        requireValue(config.groups.some(g=>g.id===input.groupId)&&typeof input.text==='string'&&input.text.trim()&&input.text.length<=10000,'请选择群并填写1到10000字的消息');
        const id='om_local_'+randomUUID();
        const result=service.ingest({header:{tenant_key:config.tenantKey},event:{sender:{sender_type:'user',tenant_key:config.tenantKey,sender_id:{open_id:session.user.id}},message:{message_id:id,chat_id:input.groupId,chat_type:'group',message_type:'text',create_time:String(clock()),content:JSON.stringify({text:input.text})}}});
        await service.tick();respond(res,202,result);return;
      }
      if(req.method==='POST'&&url.pathname==='/api/tasks'){respond(res,200,{task:await service.createTask(session.user,input)});return;}
      if((match=url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(complete|reopen|snooze))?$/))&&((req.method==='PATCH'&&!match[2])||(req.method==='POST'&&match[2]))){respond(res,200,{task:await service.mutateTask(session.user,decodeURIComponent(match[1]),match[2]||'edit',input)});return;}
      if(req.method==='POST'&&(match=url.pathname.match(/^\/api\/summaries\/([^/]+)\/correction$/))){respond(res,200,{summary:await service.correct(session.user,decodeURIComponent(match[1]),input)});return;}
      throw new PilotError('没有这个接口',404);
    }catch(error){
      if(!res.headersSent)respond(res,error instanceof PilotError?error.status:500,{error:{code:error.code||'server_error',message:error instanceof PilotError?error.message:'服务暂时无法完成操作，请稍后重试'}});
      else res.end();
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return {server,auth,status};
}

