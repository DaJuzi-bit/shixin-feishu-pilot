import {createServer as createNodeServer} from 'node:http';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfig} from './config.mjs';
import {Store} from './store.mjs';
import {PilotService} from './service.mjs';
import {FeishuTransport,LocalTransport} from './feishu.mjs';
import {createHttpServer} from './http.mjs';
import {MobileBot} from './mobile.mjs';
import {createLoopbackRedirectHandler} from './network.mjs';

function listen(server,port,host){
  return new Promise((resolve,reject)=>{
    const failed=error=>{server.removeListener('error',failed);reject(error);};
    server.once('error',failed);
    server.listen(port,host,()=>{server.removeListener('error',failed);resolve();});
  });
}
function closeServer(server){return server?new Promise(resolve=>server.close(()=>resolve())):Promise.resolve();}

export async function startRuntime({config=loadConfig(),store,transport,service,createServer=createHttpServer,createAliasServer=createNodeServer,logger=console}={}){
  let server,aliasServer,mobile,timer,stopping;
  try{
    store??=new Store(config.databasePath);
    transport??=config.mode==='local'?new LocalTransport():new FeishuTransport(config);
    service??=new PilotService({store,config,transport});
    mobile=config.mode==='feishu'&&config.primaryUi==='cards'?new MobileBot({store,config,service,transport}):null;
    ({server}=createServer({store,service,transport,config}));
    await listen(server,config.port,config.host);
    if(config.lanPreview){
      aliasServer=createAliasServer(createLoopbackRedirectHandler(config));
      await listen(aliasServer,config.port,'127.0.0.1');
    }
  }catch(error){
    await Promise.all([closeServer(aliasServer),closeServer(server)]);
    transport?.close();store?.close();throw error;
  }
  const tick=async()=>{try{await service.tick();await mobile?.tick();}catch{logger.error('后台处理暂时失败，持久任务将在后续重试。');}};
  if(config.mode==='feishu'){
    const receiveMessage=data=>{
      const event=data.event??data;
      if(event.message?.chat_type==='p2p')return mobile?.receiveMessage(data)??{accepted:false};
      return service.ingest(data);
    };
    const receiveAction=data=>mobile?mobile.receiveAction(data):{toast:{type:'info',content:'请在固定页面查看和处理待办：'+config.publicBaseUrl}};
    Promise.resolve().then(()=>transport.startReceiver(receiveMessage,{onCardAction:receiveAction})).catch(()=>logger.error('飞书连接尚未建立，请检查应用配置；服务会按SDK策略重连。'));
  }
  timer=setInterval(tick,1000);
  logger.log('消息助手已启动：'+config.publicBaseUrl);
  logger.log(config.mode==='local'?'当前为本地联调，尚未连接真实飞书。':'当前为飞书模式，只处理配置的团队与指定群。');
  if(config.lanPreview)logger.log('临时HTTP同网预览：仅使用虚构测试消息和独立测试数据库；请勿输入真实敏感内容。');
  async function stop(){
    if(stopping)return stopping;
    stopping=(async()=>{
      clearInterval(timer);transport.close();
      await Promise.all([closeServer(aliasServer),closeServer(server)]);
      while(service.busy||mobile?.busy)await new Promise(resolve=>setTimeout(resolve,30));
      store.close();
    })();
    return stopping;
  }
  return {server,aliasServer,mobile,tick,stop};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  startRuntime().then(runtime=>{
    const stop=()=>{runtime.stop().catch(()=>{console.error('服务关闭失败，请检查进程状态。');process.exitCode=1;});};
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
  }).catch(error=>{console.error(error.code==='EADDRINUSE'?'端口已被占用，请修改PORT后重试。':error.message);process.exitCode=1;});
}
