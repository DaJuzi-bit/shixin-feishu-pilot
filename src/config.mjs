import {resolve} from 'node:path';
import {isPrivateIpv4} from './network.mjs';
export function loadConfig(env=process.env) {
  const mode=env.FEISHU_MODE||'local';
  if(!['local','feishu'].includes(mode))throw Error('FEISHU_MODE 必须为 local 或 feishu');
  const host=env.HOST||'127.0.0.1',port=Number(env.PORT||5300);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('PORT 必须为1到65535的整数');
  const primaryUi=env.PILOT_PRIMARY_UI||'page';
  if(!['page','cards'].includes(primaryUi))throw Error('PILOT_PRIMARY_UI 必须为 page 或 cards');
  if(env.PILOT_LAN_PREVIEW&&!['0','1'].includes(env.PILOT_LAN_PREVIEW))throw Error('PILOT_LAN_PREVIEW 仅支持0或1');
  const lanPreview=env.PILOT_LAN_PREVIEW==='1';
  const publicBaseUrl=(env.PUBLIC_BASE_URL||'http://127.0.0.1:'+port).replace(/\/$/,'');
  const base=new URL(publicBaseUrl);
  if(base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw Error('PUBLIC_BASE_URL 只填写网站根地址');
  if(mode==='local'&&(!['127.0.0.1','localhost','::1'].includes(host)||!['localhost','127.0.0.1','[::1]'].includes(base.hostname)||env.NODE_ENV==='production'))throw Error('本地联调模式只允许绑定本机，不能用于生产部署');
  let lanClients=[],lanAuthority=null;
  if(lanPreview){
    if(mode!=='feishu'||env.NODE_ENV==='production'||!isPrivateIpv4(host))throw Error('同网预览仅支持非生产飞书模式和明确的私有IPv4地址');
    lanAuthority=host+':'+port;
    if(publicBaseUrl!=='http://'+lanAuthority)throw Error('同网预览根地址必须为 http://HOST:PORT，且与监听地址完全一致');
    const clients=String(env.PILOT_LAN_CLIENTS||'').split(',').map(value=>value.trim());
    if(!clients.length||clients.some(value=>!isPrivateIpv4(value)))throw Error('PILOT_LAN_CLIENTS 必须填写明确的私有IPv4客户端白名单');
    lanClients=[...new Set(clients)];
  }
  const ids=(env.FEISHU_ALLOWED_CHAT_IDS||'').split(',').map(s=>s.trim()).filter(Boolean);
  const names=(env.FEISHU_CHAT_NAMES||'').split(',').map(s=>s.trim());
  const config={mode,host,port,publicBaseUrl,primaryUi,lanPreview,lanClients,lanAuthority,databasePath:resolve(env.DATABASE_PATH||(lanPreview?'./data/phone-preview.sqlite':'./data/'+mode+'.sqlite')),appId:env.FEISHU_APP_ID||'',appSecret:env.FEISHU_APP_SECRET||'',tenantKey:mode==='local'?'local-team':env.FEISHU_TENANT_KEY||'',groups:mode==='local'?[{id:'local-course',name:'课程试用群'},{id:'local-project',name:'小组协作群'}]:[...new Set(ids)].map((id,index)=>({id,name:names[index]||id})),oauthScope:'contact:user.base:readonly'};
  if(mode==='feishu'){
    if(!config.appId||!config.appSecret||!config.tenantKey||!config.groups.length)throw Error('真实模式缺少飞书应用凭证、团队标识或群白名单，请先按接入说明完成配置');
    if(!lanPreview&&base.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(base.hostname))throw Error('真实团队访问地址需要 HTTPS');
    if(config.groups.length>3)throw Error('首轮试用最多配置3个群');
  }
  return config;
}

