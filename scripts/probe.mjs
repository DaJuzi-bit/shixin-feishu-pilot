import {randomBytes} from 'node:crypto';
import {FeishuTransport} from '../src/feishu.mjs';
const config={appId:process.env.FEISHU_APP_ID,appSecret:process.env.FEISHU_APP_SECRET};
if(!config.appId||!config.appSecret){console.error('请先在本机 .env 填写 FEISHU_APP_ID 和 FEISHU_APP_SECRET。');process.exitCode=1;}
else {
  const marker='拾信接入校验-'+randomBytes(4).toString('hex');
  const transport=new FeishuTransport(config),seen=new Set();
  console.log('临时校验：不会保存或输出群消息正文，不会向飞书发送任何消息。');
  console.log('连接后，请在每个准备试用的群中发送下面这段文字；无需重复发送其他内容：\n'+marker);
  const timer=setTimeout(()=>{console.log('5分钟校验结束。');transport.close();},300000);
  function stop(){clearTimeout(timer);transport.close();}
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  await transport.startReceiver(raw=>{
    const event=raw.event??raw,m=event.message,s=event.sender;
    if(m?.message_type!=='text'||m.chat_type!=='group'||s?.sender_type!=='user')return;
    let text;try{text=JSON.parse(m.content).text;}catch{return;}
    if(text!==marker||seen.has(m.chat_id))return;
    seen.add(m.chat_id);
    console.log('已确认一组标识：'+JSON.stringify({FEISHU_TENANT_KEY:raw.header?.tenant_key??raw.tenant_key??s.tenant_key,FEISHU_ALLOWED_CHAT_ID:m.chat_id}));
    console.log('将标识填入本机 .env；最多选择3个群。按 Ctrl+C 结束校验。');
  }).catch(()=>{console.error('长连接未建立，请检查凭证、机器人能力与事件配置。');stop();process.exitCode=1;});
}
