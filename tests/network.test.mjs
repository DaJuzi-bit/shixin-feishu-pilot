import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import {Store} from '../src/store.mjs';
import {PilotService} from '../src/service.mjs';
import {MobileBot} from '../src/mobile.mjs';
import {loadConfig} from '../src/config.mjs';

const env={FEISHU_MODE:'feishu',FEISHU_APP_ID:'app',FEISHU_APP_SECRET:'test-secret',FEISHU_TENANT_KEY:'team',FEISHU_ALLOWED_CHAT_IDS:'g1',PILOT_LAN_PREVIEW:'1',HOST:'172.20.10.3',PORT:'5300',PUBLIC_BASE_URL:'http://172.20.10.3:5300',PILOT_LAN_CLIENTS:'172.20.10.1'};

test('private HTTP preview requires explicit mode, exact private host and client addresses',()=>{
  const config=loadConfig(env);
  assert.equal(config.lanPreview,true);assert.equal(config.lanAuthority,'172.20.10.3:5300');
  assert.deepEqual(config.lanClients,['172.20.10.1']);assert.equal(config.primaryUi,'page');
  assert.equal(loadConfig({...env,PILOT_PRIMARY_UI:'cards'}).primaryUi,'cards');
  for(const override of [
    {PILOT_LAN_PREVIEW:'0'},{PILOT_LAN_PREVIEW:'true'},{FEISHU_MODE:'local'},{NODE_ENV:'production'},
    {HOST:'0.0.0.0'},{HOST:'8.8.8.8'},{HOST:'127.0.0.1'},{HOST:'172.32.0.1'},
    {HOST:'172.020.10.3'},{HOST:'localhost'},{PUBLIC_BASE_URL:'http://172.20.10.4:5300'},
    {PUBLIC_BASE_URL:'http://172.20.10.3:5301'},{PUBLIC_BASE_URL:'https://172.20.10.3:5300'},
    {PUBLIC_BASE_URL:'http://2886994435:5300'},{PUBLIC_BASE_URL:'http://172.20.10.3:5300/path'},
    {PILOT_LAN_CLIENTS:''},{PILOT_LAN_CLIENTS:'*'},{PILOT_LAN_CLIENTS:'8.8.8.8'},
    {PILOT_LAN_CLIENTS:'127.0.0.1'},{PILOT_LAN_CLIENTS:'172.20.10.0/24'},
    {PILOT_LAN_CLIENTS:'172.20.10.1,,172.20.10.2'},{PILOT_PRIMARY_UI:'unknown'},
    {PORT:'0'},{PORT:'5300.5'},{PORT:'65536'},
  ])assert.throws(()=>loadConfig({...env,...override}),undefined,JSON.stringify(override));
});

test('normal configuration defaults to loopback and preserves the explicit cards rollback',()=>{
  assert.equal(loadConfig({}).host,'127.0.0.1');assert.equal(loadConfig({}).primaryUi,'page');
  assert.equal(loadConfig({}).lanPreview,false);
  const real=loadConfig({...env,PILOT_LAN_PREVIEW:'0',HOST:'127.0.0.1',PUBLIC_BASE_URL:'http://127.0.0.1:5300'});
  assert.equal(real.lanPreview,false);
});

test('LAN authorization rejects spoofed hosts, duplicate Host headers and unlisted peers',async()=>{
  const {authorizeLanRequest}=await import('../src/network.mjs'),config=loadConfig(env);
  const req=(host='172.20.10.3:5300',peer='172.20.10.1')=>({headers:{host},rawHeaders:['Host',host],socket:{remoteAddress:peer}});
  for(const peer of ['172.20.10.1','172.20.10.3','127.0.0.1','::ffff:172.20.10.1'])assert.equal(authorizeLanRequest(req(undefined,peer),config),true,peer);
  for(const host of ['evil.example','172.20.10.3','172.20.10.3:05300','172.20.10.3:5300.evil','172.20.10.3:5300 ','172.20.10.3:5300@evil',undefined])assert.equal(authorizeLanRequest({...req(),headers:{host}},config),false,String(host));
  for(const peer of ['172.20.10.2','8.8.8.8','::1','::ffff:8.8.8.8','::ffff:172.020.10.1',undefined])assert.equal(authorizeLanRequest({...req(),socket:{remoteAddress:peer}},config),false,String(peer));
  const duplicate=req();duplicate.rawHeaders.push('host','172.20.10.3:5300');assert.equal(authorizeLanRequest(duplicate,config),false);
  assert.equal(authorizeLanRequest(req('anything','8.8.8.8'),{lanPreview:false}),true);
});

test('loopback alias redirects only safe origin paths and only exact loopback requests',async()=>{
  const {createLoopbackRedirectHandler}=await import('../src/network.mjs'),handler=createLoopbackRedirectHandler(loadConfig(env));
  const request=(url,host='127.0.0.1:5300',peer='127.0.0.1')=>{
    const response={headers:{},writeHead(status,headers={}){this.status=status;Object.assign(this.headers,headers);},end(){this.ended=true;}};
    handler({url,headers:{host},rawHeaders:['Host',host],socket:{remoteAddress:peer}},response);return response;
  };
  const good=request('/?task=one%20two&view=tasks');assert.equal(good.status,302);assert.equal(good.headers.location,'http://172.20.10.3:5300/?task=one%20two&view=tasks');assert.equal(good.headers['cache-control'],'no-store');
  for(const path of ['//evil.test/path','http://evil.test/','/\\evil','/%5cevil','/%0d%0aLocation:evil','/bad\r\npath','*'])assert.equal(request(path).status,400,path);
  assert.equal(request('/','localhost:5300').status,403);assert.equal(request('/','127.0.0.1:5300','172.20.10.1').status,403);
});

class Listener extends EventEmitter {
  constructor(fail=false){super();this.fail=fail;this.listening=false;this.closed=false;}
  listen(port,host,ready){this.bound={port,host};queueMicrotask(()=>{if(this.fail)this.emit('error',Object.assign(Error('occupied'),{code:'EADDRINUSE'}));else{this.listening=true;ready();}});}
  close(done){this.closed=true;this.listening=false;done?.();}
}

test('page runtime ignores routine DM queries and old card mutations while preserving group ingest and service ticks',async t=>{
  const {startRuntime}=await import('../src/main.mjs');
  const config=loadConfig({...env,PILOT_LAN_PREVIEW:'0',HOST:'127.0.0.1',PUBLIC_BASE_URL:'http://127.0.0.1:5300'}),server=new Listener();
  let receiver,actions,connections=0,ingested=0,ticks=0,closed=false;
  const store={close(){closed=true;}},service={busy:false,ingest(){ingested++;},async tick(){ticks++;}};
  const transport={startReceiver(onMessage,{onCardAction}){connections++;receiver=onMessage;actions=onCardAction;return Promise.resolve();},close(){}};
  const runtime=await startRuntime({config,store,service,transport,createServer:()=>({server}),logger:{log(){},error(){}}});
  t.after(()=>runtime.stop());
  assert.equal(runtime.mobile,null);assert.equal(connections,1);
  receiver({event:{message:{chat_type:'p2p'}}});assert.equal(ingested,0);
  receiver({message:{chat_type:'group'}});assert.equal(ingested,1);
  assert.match(actions({action:{value:{action:'complete'}}}).toast.content,/固定页面/);assert.equal(ingested,1);
  await runtime.tick();assert.equal(ticks,1);await runtime.stop();assert.equal(closed,true);
});

test('LAN startup binds an exact host plus loopback and closes both if the alias port is occupied',async()=>{
  const {startRuntime}=await import('../src/main.mjs'),primary=new Listener(),alias=new Listener(true);
  let receivers=0,closed=false,transportClosed=false;
  await assert.rejects(()=>startRuntime({config:loadConfig(env),store:{close(){closed=true;}},service:{busy:false},transport:{startReceiver(){receivers++;},close(){transportClosed=true;}},createServer:()=>({server:primary}),createAliasServer:()=>alias,logger:{log(){},error(){}}}),{code:'EADDRINUSE'});
  assert.deepEqual(primary.bound,{port:5300,host:'172.20.10.3'});assert.deepEqual(alias.bound,{port:5300,host:'127.0.0.1'});
  assert.equal(primary.closed,true);assert.equal(alias.closed,true);assert.equal(receivers,0);assert.equal(closed,true);assert.equal(transportClosed,true);
});

test('page runtime retries a previously queued native reminder exactly once using its existing delivery ID',async t=>{
  const {startRuntime}=await import('../src/main.mjs'),store=new Store(':memory:'),deliveries=[];
  let now=Date.parse('2026-10-29T02:00:00Z'),offline=true;
  const config=loadConfig({...env,PILOT_LAN_PREVIEW:'0',HOST:'127.0.0.1',PUBLIC_BASE_URL:'http://127.0.0.1:5300'});
  const transport={isGroupMember:async()=>true,async sendCard(_user,card,uuid,canSend){if(offline)throw Error('offline');if(!canSend())return {cancelled:true};deliveries.push({card,uuid});return {messageId:'sent'};},async sendText(_user,text,uuid,canSend){if(offline)throw Error('offline');if(!canSend())return {cancelled:true};deliveries.push({text,uuid});return {messageId:'sent'};},startReceiver:async()=>{},close(){}};
  const oldService=new PilotService({store,config:{...config,primaryUi:'cards'},transport,clock:()=>now});
  new MobileBot({store,config:{...config,primaryUi:'cards'},service:oldService,transport,clock:()=>now});
  oldService.ingest({header:{tenant_key:'team'},event:{sender:{sender_type:'user',sender_id:{open_id:'alice'}},message:{message_id:'test_reminder',chat_id:'g1',chat_type:'group',message_type:'text',create_time:String(now),content:JSON.stringify({text:'作业明天下午5点前提交实验报告。'})}}});
  await oldService.tick();const user={id:'alice',tenantId:'team'},summary=(await oldService.dashboard(user)).summaries[0];
  await oldService.createTask(user,{summaryId:summary.id,remindAt:new Date(now+1000).toISOString()});
  now+=1100;await oldService.tick();const deliveryId=store.get('SELECT id FROM outbox').id;
  const service=new PilotService({store,config,transport,clock:()=>now});
  const runtime=await startRuntime({config,store,service,transport,createServer:()=>({server:new Listener()}),logger:{log(){},error(){}}});t.after(()=>runtime.stop());
  offline=false;now+=3000;await runtime.tick();await runtime.tick();
  assert.equal(runtime.mobile,null);assert.equal(deliveries.length,1);assert.equal(deliveries[0].uuid,deliveryId);
  assert.match(deliveries[0].text,/待办提醒/);assert.equal(deliveries[0].card,undefined);assert.equal(store.get('SELECT status FROM outbox').status,'sent');
});

test('phone launcher rejects invalid addresses before reading configuration or starting a process',()=>{
  for(const [address,client,message] of [['8.8.8.8','172.20.10.1','Address must be an explicit RFC1918 IPv4 address.'],['172.20.10.3','*','Client must contain explicit RFC1918 IPv4 addresses.']]){
    const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','start-phone.ps1','-Address',address,'-Client',client],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
    assert.notEqual(result.status,0);assert.ok((result.stdout+result.stderr).includes(message),result.stdout+result.stderr);
  }
});
