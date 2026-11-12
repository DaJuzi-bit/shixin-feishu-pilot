import {loadConfig} from '../src/config.mjs';
import {Store} from '../src/store.mjs';
import {PilotService} from '../src/service.mjs';
import {FeishuTransport} from '../src/feishu.mjs';
import {MobileBot} from '../src/mobile.mjs';
let store;
try{
  const config=loadConfig();
  if(config.mode!=='feishu')throw Error('请在真实飞书模式下使用');
  store=new Store(config.databasePath);
  const users=store.all('SELECT id FROM users WHERE tenant=?',config.tenantKey);
  if(users.length!==1)throw Error('此快捷入口仅在恰好一位已登录试用成员时可用；多人请直接私聊机器人“我的待办”');
  const transport=new FeishuTransport(config),service=new PilotService({store,config,transport});
  const mobile=new MobileBot({store,config,service,transport});
  mobile.queueHomeForKnownUser(users[0].id);
  console.log('已将手机入口卡片加入发送队列。请保持主服务运行，在飞书私聊中查看；按钮需先开通卡片回调。');
}catch(error){console.error(error.message);process.exitCode=1;}
finally{store?.close();}
