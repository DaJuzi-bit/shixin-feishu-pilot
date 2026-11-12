import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {PilotService} from '../src/service.mjs';
import {extract} from '../src/extract.mjs';
import {EventDispatcher} from '@larksuiteoapi/node-sdk';
import {FeishuTransport} from '../src/feishu.mjs';
const NOW=Date.parse('2026-10-15T02:00:00Z');
function fixture(t,options={}) {
  const dir=mkdtempSync(join(tmpdir(),'feishu-pilot-'));
  const store=new Store(join(dir,'test.sqlite'));
  const sent=[];
  const transport={isGroupMember:async(_group,user)=>user!=='outsider',sendText:async(user,text,uuid)=>{sent.push({user,text,uuid});return {messageId:'om_out'};}};
  const config={mode:'local',tenantKey:'local-team',groups:[{id:'g1',name:'课程群'},{id:'g2',name:'小组群'}],publicBaseUrl:'http://127.0.0.1:5300'};
  const service=new PilotService({store,config,transport,clock:()=>NOW,...options});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {store,service,sent,transport,config,dir};
}
function event(id='om_1',text='作业6：明天下午五点前提交实验报告。',group='g1') {
  return {header:{event_id:'ev_'+id,tenant_key:'local-team'},event:{sender:{sender_type:'user',tenant_key:'local-team',sender_id:{open_id:'alice'}},message:{message_id:id,chat_id:group,chat_type:'group',message_type:'text',create_time:String(NOW),content:JSON.stringify({text})}}};
}
test('relative Chinese dates anchor to the original message, and uncertain notices stay cautious',()=>{
  assert.equal(extract('作业明天下午五点半提交',{sentAt:NOW}).dueAt,'2026-10-16T09:30:00.000Z');
  for(const text of ['作业明天18:00提交吗？','彩排取消，不用参加了。'])assert.equal(extract(text,{sentAt:NOW}).actionable,false);
  assert.equal(extract('作业今天开始做，明天18:00提交',{sentAt:NOW}).dueAt,null);
  assert.equal(extract('2026年2月30日18:00提交作业',{sentAt:NOW}).dueAt,null);
});
test('durable ingestion deduplicates repeated events and excludes unapproved groups and bots',async t=>{
  const {service,store}=fixture(t);
  assert.equal(service.ingest(event()).accepted,true);
  assert.equal(service.ingest(event()).duplicate,true);
  assert.equal(service.ingest(event('om_other','作业明天18:00交','not-allowed')).accepted,false);
  const bot=event('om_bot');bot.event.sender.sender_type='app';assert.equal(service.ingest(bot).accepted,false);
  await service.tick();
  assert.equal(store.all('SELECT * FROM messages').length,1);
  assert.equal(store.all('SELECT * FROM summaries').length,1);
});
test('the installed SDK dispatcher shape retains tenant authorization without optional sender tenant',async t=>{
  const {service,store}=fixture(t),raw=event('om_sdk');
  delete raw.event.sender.tenant_key;
  raw.schema='2.0';raw.header.event_type='im.message.receive_v1';
  const dispatcher=new EventDispatcher({logger:{debug(){},trace(){},info(){},warn(){},error(){}}}).register({'im.message.receive_v1':data=>service.ingest(data)});
  await dispatcher.invoke(raw);
  await service.tick();
  assert.equal(store.all('SELECT * FROM messages').length,1);
});
test('confirmation is idempotent per member, and tasks remain private',async t=>{
  const {service}=fixture(t);service.ingest(event());await service.tick();
  const alice={id:'alice',tenantId:'local-team',name:'小组A'},bob={id:'bob',tenantId:'local-team',name:'小组B'};
  const summary=(await service.dashboard(alice)).summaries[0];
  const first=await service.createTask(alice,{summaryId:summary.id});
  const second=await service.createTask(alice,{summaryId:summary.id});
  assert.equal(first.id,second.id);
  assert.equal((await service.dashboard(bob)).tasks.length,0);
  await assert.rejects(()=>service.mutateTask(bob,first.id,'complete',{}),/没有找到/);
  await assert.rejects(()=>service.dashboard({id:'outsider',tenantId:'local-team'}),/群|权限/);
});
test('dashboard revisions change only for authorized content and personal changes',async t=>{
  const {service}=fixture(t),alice={id:'alice',tenantId:'local-team'},bob={id:'bob',tenantId:'local-team'};
  const before=await service.dashboard(alice);assert.match(before.revision,/^[a-f0-9]{32}$/);assert.equal(before.messageCount,0);
  service.ingest(event());await service.tick();
  const first=await service.dashboard(alice),other=await service.dashboard(bob);assert.notEqual(first.revision,before.revision);assert.equal(first.messageCount,1);
  await service.createTask(alice,{summaryId:first.summaries[0].id});
  assert.notEqual((await service.dashboard(alice)).revision,first.revision);
  assert.equal((await service.dashboard(bob)).revision,other.revision);
});
test('conditional recipients and missing times cannot silently create tasks',async t=>{
  const {service}=fixture(t);service.ingest(event('c','还未提交的同学请明天18:00前补交实验报告。'));service.ingest(event('u','作业尽快提交。'));await service.tick();
  const user={id:'alice',tenantId:'local-team',name:'A'},s=(await service.dashboard(user)).summaries;
  await assert.rejects(()=>service.createTask(user,{summaryId:s.find(x=>x.source.messageId==='c').id}),/确认/);
  await assert.rejects(()=>service.createTask(user,{summaryId:s.find(x=>x.source.messageId==='u').id}),/时间/);
});
test('revoked membership blocks task changes and page reminders as well as cards',async t=>{
  let now=NOW;const f=fixture(t,{clock:()=>now});f.service.ingest(event());await f.service.tick();
  const user={id:'alice',tenantId:'local-team'},summary=(await f.service.dashboard(user)).summaries[0];
  const task=await f.service.createTask(user,{summaryId:summary.id,remindAt:new Date(NOW+60000).toISOString()});
  f.transport.isGroupMember=async()=>false;now+=121000;
  for(const action of ['complete','reopen','snooze','edit'])await assert.rejects(()=>f.service.mutateTask(user,task.id,action,{}),e=>e.status===403);
  await f.service.tick();assert.equal(f.sent.length,0);assert.equal(f.store.get('SELECT status FROM outbox WHERE task_id=?',task.id).status,'cancelled');
});
test('page mode converts an already queued card reminder without changing delivery id',async t=>{
  let now=NOW;const f=fixture(t,{clock:()=>now});f.service.ingest(event());await f.service.tick();
  const user={id:'alice',tenantId:'local-team'},summary=(await f.service.dashboard(user)).summaries[0];
  const task=await f.service.createTask(user,{summaryId:summary.id,remindAt:new Date(NOW+60000).toISOString()});
  f.service.reminderCard=()=>({schema:'2.0'});now+=61000;f.service.scheduleReminders();
  const id=f.store.get('SELECT id FROM outbox WHERE task_id=?',task.id).id;f.config.primaryUi='page';
  await f.service.processOutbox();await f.service.processOutbox();assert.equal(f.sent.length,1);assert.equal(f.sent[0].uuid,id);assert.match(f.sent[0].text,/打开拾信处理/);
});
test('reminders retry with the same delivery id, completion cancels pending work, and restart retains tasks',async t=>{
  let now=NOW;const f=fixture(t,{clock:()=>now});f.service.ingest(event());await f.service.tick();
  const user={id:'alice',tenantId:'local-team',name:'A'},s=(await f.service.dashboard(user)).summaries[0];
  const task=await f.service.createTask(user,{summaryId:s.id,remindAt:new Date(NOW+60000).toISOString()});
  let calls=0;const uuids=[];f.transport.sendText=async(_id,_text,uuid)=>{uuids.push(uuid);if(++calls===1)throw Error('temporary network failure');return {messageId:'sent'};};
  now+=61000;await f.service.tick();assert.equal(calls,1);
  now+=120000;await f.service.tick();assert.equal(calls,2);assert.equal(uuids[0],uuids[1]);
  const second=await f.service.createTask({id:'bob',tenantId:'local-team'},{summaryId:s.id,remindAt:new Date(now+60000).toISOString()});
  await f.service.mutateTask({id:'bob',tenantId:'local-team'},second.id,'complete',{});now+=61000;await f.service.tick();assert.equal(calls,2);
  const reopened=new Store(join(f.dir,'test.sqlite'));assert.equal(JSON.parse(reopened.get('SELECT payload FROM tasks WHERE id=?',task.id).payload).title,'完成作业6');reopened.close();
});
test('snooze refuses a reminder later than the confirmed deadline',async t=>{
  const {service}=fixture(t);service.ingest(event());await service.tick();
  const user={id:'alice',tenantId:'local-team'},summary=(await service.dashboard(user)).summaries[0];
  const task=await service.createTask(user,{summaryId:summary.id,dueAt:'2026-10-15T02:05:00Z',remindAt:'2026-10-15T02:01:00Z'});
  await assert.rejects(()=>service.mutateTask(user,task.id,'snooze',{}),/截止/);
  assert.equal((await service.dashboard(user)).tasks[0].remindAt,'2026-10-15T02:01:00.000Z');
});
test('completion during token refresh cancels before the actual Feishu message POST',async t=>{
  let now=NOW,releaseToken,tokenStarted,posts=0;
  const ready=new Promise(resolve=>{tokenStarted=resolve;});
  const f=fixture(t,{clock:()=>now});
  f.service.ingest(event());await f.service.tick();
  const user={id:'alice',tenantId:'local-team'},summary=(await f.service.dashboard(user)).summaries[0];
  const task=await f.service.createTask(user,{summaryId:summary.id,remindAt:'2026-10-15T02:01:00Z'});
  f.service.transport=new FeishuTransport({...f.config,appId:'app',appSecret:'secret'},{clock:()=>now,fetchImpl:async(url)=>{
    if(url.includes('tenant_access_token')){tokenStarted();return new Promise(resolve=>{releaseToken=()=>resolve(new Response(JSON.stringify({code:0,tenant_access_token:'token',expire:7200})));});}
    posts++;return new Response(JSON.stringify({code:0,data:{message_id:'sent'}}));
  }});
  now+=61000;const ticking=f.service.tick();await ready;
  await f.service.mutateTask(user,task.id,'complete',{});
  releaseToken();await ticking;
  assert.equal(posts,0);
  assert.equal(f.store.get('SELECT status FROM outbox WHERE task_id=?',task.id).status,'cancelled');
  assert.equal((await f.service.dashboard(user)).tasks[0].reminderStatus,'cancelled');
});
