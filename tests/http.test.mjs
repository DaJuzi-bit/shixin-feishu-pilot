import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {PilotService} from '../src/service.mjs';
import {createHttpServer} from '../src/http.mjs';
import {LocalTransport} from '../src/feishu.mjs';
import {loadConfig} from '../src/config.mjs';
import {request as wireRequest} from 'node:http';
async function fixture(t,live=false,extra={}){
  const store=new Store(':memory:'),transport=new LocalTransport();
  const config=loadConfig({...live?{FEISHU_MODE:'feishu',FEISHU_APP_ID:'cli_test',FEISHU_APP_SECRET:'never-return-this',FEISHU_TENANT_KEY:'team',FEISHU_ALLOWED_CHAT_IDS:'g1',PUBLIC_BASE_URL:'https://pilot.example'}:{},...extra});
  transport.exchangeCode=async()=>({id:'ou_test',name:'小组成员',tenantId:config.tenantKey});
  const service=new PilotService({store,config,transport}),{server,auth}=createHttpServer({store,service,transport,config});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();});
  return {store,service,server,auth,base,config,transport};
}
async function login(base,userId='alice'){
  const result=await fetch(base+'/api/demo/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId})});
  return {cookie:result.headers.get('set-cookie').split(';')[0],...(await result.json())};
}
function request(base,path,session,body,method='POST',headers={}){return fetch(base+path,{method,headers:{cookie:session.cookie,'content-type':'application/json','x-csrf-token':session.csrfToken,...headers},body:JSON.stringify(body)});}
test('mobile API uses cookie login and CSRF; real server persistence separates members',async t=>{
  const f=await fixture(t);
  assert.equal((await fetch(f.base+'/api/dashboard')).status,401);
  assert.equal((await fetch(f.base+'/api/updates')).status,401);
  const alice=await login(f.base),bob=await login(f.base,'bob');
  assert.equal((await request(f.base,'/api/demo/messages',alice,{groupId:'local-course',text:'作业66：明天18:00前提交实验报告。'})).status,202);
  const board=await (await fetch(f.base+'/api/dashboard',{headers:{cookie:alice.cookie}})).json();assert.equal(board.summaries.length,1);
  const updates=await (await fetch(f.base+'/api/updates',{headers:{cookie:alice.cookie}})).json();assert.equal(updates.revision,board.revision);assert.equal(updates.messageCount,1);assert.equal(updates.summaries,undefined);
  const create=await request(f.base,'/api/tasks',alice,{summaryId:board.summaries[0].id});assert.equal(create.status,200);const {task}=await create.json();
  const other=await (await fetch(f.base+'/api/dashboard',{headers:{cookie:bob.cookie}})).json();assert.equal(other.tasks.length,0);
  assert.equal((await request(f.base,'/api/tasks/'+task.id+'/complete',bob,{})).status,404);
  assert.equal((await request(f.base,'/api/tasks/'+task.id+'/complete',alice,{},'POST',{'x-csrf-token':'wrong'})).status,403);
  assert.equal((await request(f.base,'/api/tasks/'+task.id+'/complete',alice,{},'POST',{origin:'https://attacker.example'})).status,403);
  assert.equal((await request(f.base,'/api/tasks/'+task.id+'/complete',alice,{})).status,200);
  const done=await (await fetch(f.base+'/api/dashboard',{headers:{cookie:alice.cookie}})).json();assert.equal(done.tasks[0].status,'done');
});
test('OAuth state is browser-bound and single use; live mode exposes no demo login or secret',async t=>{
  const f=await fixture(t,true);
  assert.equal((await fetch(f.base+'/api/demo/login',{method:'POST',headers:{'content-type':'application/json'},body:'{"userId":"alice"}'})).status,404);
  const start=await fetch(f.base+'/auth/feishu/start',{redirect:'manual'}),url=new URL(start.headers.get('location')),state=url.searchParams.get('state'),cookie=start.headers.get('set-cookie').split(';')[0];
  assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  assert.equal((await fetch(f.base+'/auth/feishu/callback?code=code&state='+state,{redirect:'manual'})).status,400);
  const good=await fetch(f.base+'/auth/feishu/callback?code=code&state='+state,{headers:{cookie},redirect:'manual'});assert.equal(good.status,302);
  assert.equal((await fetch(f.base+'/auth/feishu/callback?code=code&state='+state,{headers:{cookie},redirect:'manual'})).status,400);
  assert.ok(good.headers.get('set-cookie').includes('HttpOnly'));
  assert.doesNotMatch(await (await fetch(f.base+'/api/status')).text(),/never-return-this|cli_test/);
});
test('local mode refuses public binding and production mode',()=>{
  assert.throws(()=>loadConfig({HOST:'0.0.0.0'}),/本机/);
  assert.throws(()=>loadConfig({NODE_ENV:'production'}),/生产/);
  assert.throws(()=>loadConfig({FEISHU_MODE:'feishu'}),/缺少/);
});
test('LAN guard runs before assets and auth; canonical host still requires a normal session',async t=>{
  const f=await fixture(t,true,{PILOT_LAN_PREVIEW:'1',HOST:'172.20.10.3',PUBLIC_BASE_URL:'http://172.20.10.3:5300',PILOT_LAN_CLIENTS:'172.20.10.1'});
  assert.equal((await fetch(f.base+'/')).status,403);
  // Browser/Fetch forbids overriding Host; use the actual wire request for this boundary test.
  const send=(path,method='GET',body)=>new Promise((resolve,reject)=>{const req=wireRequest(f.base+path,{method,headers:{host:'172.20.10.3:5300','content-type':'application/json'}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,text}));});req.on('error',reject);req.end(body);});
  assert.equal((await send('/')).status,200);
  assert.equal((await send('/api/dashboard')).status,401);
  const status=JSON.parse((await send('/api/status')).text);assert.equal(status.lanPreview,true);assert.equal(status.primaryUi,'page');
  assert.equal((await send('/api/demo/login','POST','{"userId":"alice"}')).status,404);
});
