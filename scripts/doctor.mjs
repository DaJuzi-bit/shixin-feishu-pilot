import {existsSync} from 'node:fs';
import {loadConfig} from '../src/config.mjs';
import {FeishuTransport} from '../src/feishu.mjs';
try {
  if(Number(process.versions.node.split('.')[0])<24)throw Error('请安装 Node.js 24 或更新版本');
  const config=loadConfig();
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE check_sqlite(id INTEGER)');db.close();
  await import('@larksuiteoapi/node-sdk');
  console.log('通过：Node.js、SQLite、官方飞书SDK可用。');
  console.log('模式：'+(config.mode==='local'?'本地联调（不接收/发送飞书消息）':'真实飞书配置（尚不代表已连通）'));
  console.log('配置文件：'+(existsSync('.env')?'已找到 .env':'未找到 .env，使用环境变量或本地默认值'));
  if(config.mode==='feishu')console.log('通过：应用凭证、团队标识、'+config.groups.length+'个白名单群已填写；未输出任何密钥。');
  if(process.argv.includes('--online')){
    if(config.mode!=='feishu')throw Error('--online 仅用于真实飞书模式');
    const client=new FeishuTransport(config);await client.tenantToken();
    console.log('通过：飞书接受应用凭证。仍需真人登录、群成员权限、正常消息和实际提醒验收。');
  }
}catch(error){console.error('检查未通过：'+error.message);process.exitCode=1;}
