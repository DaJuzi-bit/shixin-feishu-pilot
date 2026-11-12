import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {PilotService} from '../src/service.mjs';
import {MobileBot} from '../src/mobile.mjs';
import {EventDispatcher} from '@larksuiteoapi/node-sdk';
const NOW=Date.parse('2026-10-22T07:00:00Z');
function setup(t){
  const store=new Store(':memory:'),deliveries=[];
  let now=NOW,member=true,failSend=false;
  const config={mode:'feishu',tenantKey:'team',groups:[{id:'g1',name:'课程群'}],publicBaseUrl:'http://127.0.0.1:5300'};
  const transport={isGroupMember:async()=>member,
    sendCard:async(user,card,uuid,canSend=()=>true)=>{if(!canSend())return {cancelled:true};if(failSend)throw Error('offline');const existing=deliveries.find(x=>x.uuid===uuid);if(existing)return {messageId:existing.messageId};const value={user,card:structuredClone(card),uuid,messageId:'om_card_'+deliveries.length};deliveries.push(value);return {messageId:value.messageId};},
    updateCard:async(messageId,card)=>{if(failSend)throw Error('offline');const value=deliveries.find(x=>x.messageId===messageId);assert.ok(value,'must update an existing private card');value.card=structuredClone(card);return {messageId};},
    sendText:async()=>{throw Error('mobile reminder must not require a browser');}};
  const service=new PilotService({store,config,transport,clock:()=>now});
  const bot=new MobileBot({store,config,service,transport,clock:()=>now});
  t.after(()=>store.close());
  return {store,config,service,transport,bot,deliveries,setNow:v=>{now=v;},revoke:()=>{member=false;store.run('DELETE FROM memberships');},offline:v=>{failSend=v;}};
}
function dm(text='我的待办',user='alice',id='dm_1'){
  return {schema:'2.0',header:{event_id:'ev_'+id,event_type:'im.message.receive_v1',tenant_key:'team'},event:{sender:{sender_type:'user',tenant_key:'team',sender_id:{open_id:user}},message:{message_id:id,chat_id:'dm_chat_'+user,chat_type:'p2p',message_type:'text',content:JSON.stringify({text}),create_time:String(NOW)}}};
}
function group(id='notice',text='作业通知：请大家明天下午5点前提交实验报告。'){
  const e=dm(text,'alice',id);e.event.message.chat_type='group';e.event.message.chat_id='g1';return e;
}
function nodes(value){return !value||typeof value!=='object'?[]:[value,...Object.values(value).flatMap(v=>Array.isArray(v)?v.flatMap(nodes):nodes(v))];}
function button(card,label){const found=nodes(card).find(n=>n.tag==='button'&&n.text?.content===label);assert.ok(found,'button '+label);return found;}
function click(delivery,label,{user=delivery.user,id='click_1',form}={}){
  const b=button(delivery.card,label);
  return {schema:'2.0',header:{event_id:id,event_type:'card.action.trigger',tenant_key:'team'},event:{operator:{open_id:user,tenant_key:'team'},context:{open_message_id:delivery.messageId,open_chat_id:'dm_chat_'+user},action:{tag:'button',name:b.name,value:b.behaviors?.find(x=>x.type==='callback')?.value,...(form?{form_value:form}:{})}}};
}
async function summaries(f){f.service.ingest(group());await f.service.tick();f.bot.receiveMessage(dm('消息中心'));await f.bot.tick();return f.deliveries.at(-1);}
async function formCard(f){const list=await summaries(f);f.bot.receiveAction(click(list,'详情'));await f.bot.tick();f.bot.receiveAction(click(f.deliveries.at(-1),'核对并添加待办'));await f.bot.tick();return f.deliveries.at(-1);}
const schedule={task_title:'提交实验报告',due_at:'2026-10-23 17:00 +0800',remind_at:'2026-10-22 15:03 +0800'};
async function create(f){const form=await formCard(f);f.bot.receiveAction(click(form,'确认属于我并设置提醒',{id:'confirm',form:schedule}));await f.bot.tick();return JSON.parse(f.store.get('SELECT payload FROM tasks').payload);}
test('DM summaries are native 2.0 cards, group events do not become bot queries',async t=>{
  const f=setup(t);assert.equal(f.bot.receiveMessage(group()).accepted,false);
  const card=await summaries(f);assert.equal(card.user,'alice');assert.equal(card.card.schema,'2.0');
  assert.match(JSON.stringify(card.card),/实验报告/);assert.doesNotMatch(JSON.stringify(card.card),/https?:\/\//);
  button(card.card,'我的待办');button(card.card,'消息中心');
});
test('forwarded, forged, expired and mismatched-message card actions cannot read or mutate a task',async t=>{
  const f=setup(t),card=await summaries(f);
  assert.equal(f.bot.receiveAction(click(card,'详情',{user:'bob'})).toast.type,'error');
  const mismatched=click(card,'详情');mismatched.event.context.open_message_id='om_other';
  assert.equal(f.bot.receiveAction(mismatched).toast.type,'error');
  const forged=click(card,'详情');forged.event.action.value={token:'made-up'};
  assert.equal(f.bot.receiveAction(forged).toast.type,'error');
  f.setNow(NOW+3*86400000);assert.equal(f.bot.receiveAction(click(card,'详情')).toast.type,'error');
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM tasks').n,0);
});
test('confirmation form keeps Chinese local times and repeated submit creates one personal task',async t=>{
  const f=setup(t),card=await formCard(f);
  assert.equal(nodes(card.card).find(n=>n.name==='due_at').initial_datetime,'2026-10-23 17:00');
  const action=click(card,'确认属于我并设置提醒',{id:'submit_1',form:schedule});
  const ack=f.bot.receiveAction(action);assert.equal(ack instanceof Promise,false,'callback must not wait for a network request');
  f.bot.receiveAction(action);await f.bot.tick();
  const tasks=f.store.all('SELECT payload FROM tasks').map(r=>JSON.parse(r.payload));
  assert.equal(tasks.length,1);assert.equal(tasks[0].ownerId,'alice');assert.equal(tasks[0].dueAt,'2026-10-23T09:00:00.000Z');assert.equal(tasks[0].remindAt,'2026-10-22T07:03:00.000Z');
  assert.equal((await f.service.dashboard({id:'bob',tenantId:'team'})).tasks.length,0);
  button(f.deliveries.at(-1).card,'标记完成');
});
test('a removed group member cannot use an earlier private card',async t=>{
  const f=setup(t),card=await summaries(f);f.revoke();
  f.bot.receiveAction(click(card,'详情'));await f.bot.tick();
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM tasks').n,0);
  assert.doesNotMatch(JSON.stringify(f.deliveries.at(-1).card),/实验报告/);
});
test('reminder is a native card and completion cancels the durable task without browser navigation',async t=>{
  const f=setup(t),task=await create(f);f.setNow(NOW+181000);await f.service.tick();
  const reminder=f.deliveries.at(-1);assert.match(JSON.stringify(reminder.card),/待办提醒/);assert.doesNotMatch(JSON.stringify(reminder.card),/127\.0\.0\.1|https?:\/\//);
  f.bot.receiveAction(click(reminder,'标记完成',{id:'complete'}));await f.bot.tick();
  const done=JSON.parse(f.store.get('SELECT payload FROM tasks WHERE id=?',task.id).payload);assert.equal(done.status,'done');assert.equal(done.reminderStatus,'cancelled');
  assert.match(JSON.stringify(f.deliveries.at(-1).card),/已完成/);
});
test('old task controls and redelivered clicks cannot reschedule an already changed task',async t=>{
  const f=setup(t),task=await create(f),card=structuredClone(f.deliveries.at(-1));
  f.bot.receiveAction(click(card,'10分钟后提醒',{id:'snooze'}));await f.bot.tick();
  const once=JSON.parse(f.store.get('SELECT payload FROM tasks WHERE id=?',task.id).payload);
  f.setNow(NOW+60000);f.bot.receiveAction(click(card,'10分钟后提醒',{id:'snooze-redelivered'}));await f.bot.tick();
  const twice=JSON.parse(f.store.get('SELECT payload FROM tasks WHERE id=?',task.id).payload);
  assert.equal(twice.remindAt,once.remindAt);assert.equal(twice.version,once.version);
});
test('outgoing native card replies retry durably after restart with the same delivery id',async t=>{
  const f=setup(t);f.offline(true);f.bot.receiveMessage(dm('我的待办'));await f.bot.tick();assert.equal(f.deliveries.length,0);
  f.offline(false);f.setNow(NOW+120000);
  const restarted=new MobileBot({store:f.store,config:f.config,service:f.service,transport:f.transport,clock:()=>NOW+120000});await restarted.tick();
  assert.equal(f.deliveries.length,1);await restarted.tick();assert.equal(f.deliveries.length,1);
});
test('SDK-flattened card callbacks dispatch the same owner-bound action',async t=>{
  const f=setup(t),card=await summaries(f);
  const dispatcher=new EventDispatcher({logger:{debug(){},trace(){},info(){},warn(){},error(){}}}).register({'card.action.trigger':data=>f.bot.receiveAction(data)});
  const ack=await dispatcher.invoke(click(card,'我的待办'));assert.equal(ack.toast.type,'info');await f.bot.tick();
  assert.match(JSON.stringify(f.deliveries.at(-1).card),/我的待办/);
});
test('invalid form dates and cross-team messages fail closed',async t=>{
  const f=setup(t),card=await formCard(f);
  const e=dm('我的待办','alice','foreign');e.header.tenant_key='foreign';assert.equal(f.bot.receiveMessage(e).accepted,false);
  f.bot.receiveAction(click(card,'确认属于我并设置提醒',{form:{...schedule,due_at:'2026-02-30 17:00 +0800'}}));await f.bot.tick();
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM tasks').n,0);
});
test('retry cannot deliver a cached summary from a group the user has left while keeping another membership',async t=>{
  const f=setup(t);f.config.groups.push({id:'g2',name:'另一试用群'});
  f.service.ingest(group());await f.service.tick();f.offline(true);
  f.bot.receiveMessage(dm('消息中心'));await f.bot.tick();
  f.store.run('DELETE FROM memberships');f.transport.isGroupMember=async groupId=>groupId==='g2';
  f.offline(false);f.setNow(NOW+120000);await f.bot.tick();
  assert.equal(f.deliveries.length,1);
  assert.doesNotMatch(JSON.stringify(f.deliveries[0].card),/实验报告/);
});
test('long source text is paged rather than silently hiding the final audience condition',async t=>{
  const f=setup(t);f.service.ingest(group('long','作业明天17:00提交报告。'+'说明'.repeat(900)+'最后仅限A组成员。'));await f.service.tick();
  f.bot.receiveMessage(dm('消息中心'));await f.bot.tick();
  f.bot.receiveAction(click(f.deliveries.at(-1),'详情'));await f.bot.tick();
  assert.match(JSON.stringify(f.deliveries.at(-1).card),/第1/);
  f.bot.receiveAction(click(f.deliveries.at(-1),'下一页原文',{id:'source_page_2'}));await f.bot.tick();
  assert.match(JSON.stringify(f.deliveries.at(-1).card),/最后仅限A组成员/);
});
test('native reminders do not disclose source text after the member leaves the authorized group',async t=>{
  const f=setup(t);await create(f);const before=f.deliveries.length;f.revoke();f.setNow(NOW+181000);await f.service.tick();
  assert.equal(f.deliveries.length,before);
});
test('a website edit while the mobile action awaits authorization makes the old control stale',async t=>{
  const f=setup(t),task=await create(f),card=structuredClone(f.deliveries.at(-1));
  let release,started;const paused=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const original=f.service.requireSummary.bind(f.service);let stopOnce=true;
  f.service.requireSummary=async(...args)=>{if(stopOnce){stopOnce=false;started();await gate;}return original(...args);};
  f.bot.receiveAction(click(card,'10分钟后提醒',{id:'racing-snooze'}));const ticking=f.bot.tick();await paused;
  await f.service.mutateTask({id:'alice',tenantId:'team'},task.id,'edit',{title:'网页修改后的任务',dueAt:'2026-10-23T10:00:00Z',remindAt:'2026-10-22T08:00:00Z'});
  release();await ticking;
  const current=JSON.parse(f.store.get('SELECT payload FROM tasks WHERE id=?',task.id).payload);
  assert.equal(current.version,2);assert.equal(current.remindAt,'2026-10-22T08:00:00.000Z');
});
test('authorization redaction also replaces an ambiguously delivered card after UUID-deduplicated resend',async t=>{
  const f=setup(t);f.config.groups.push({id:'g2',name:'另一群'});f.service.ingest(group());await f.service.tick();
  const send=f.transport.sendCard;let loseOnce=true;
  f.transport.sendCard=async(...args)=>{const value=await send(...args);if(loseOnce){loseOnce=false;throw Error('response lost after accepted');}return value;};
  f.bot.receiveMessage(dm('消息中心'));await f.bot.tick();assert.match(JSON.stringify(f.deliveries[0].card),/实验报告/);
  f.store.run('DELETE FROM memberships');f.transport.isGroupMember=async id=>id==='g2';f.setNow(NOW+120000);await f.bot.tick();
  assert.equal(f.deliveries.length,1);assert.doesNotMatch(JSON.stringify(f.deliveries[0].card),/实验报告/);
});
test('a failed PATCH retry shows the latest completed task instead of restoring a pending snapshot',async t=>{
  const f=setup(t),task=await create(f);f.offline(true);
  f.bot.receiveAction(click(f.deliveries.at(-1),'10分钟后提醒',{id:'offline-snooze'}));await f.bot.tick();
  await f.service.mutateTask({id:'alice',tenantId:'team'},task.id,'complete');
  f.offline(false);f.setNow(NOW+120000);await f.bot.tick();
  assert.match(JSON.stringify(f.deliveries.at(-1).card),/已完成/);
  assert.ok(!nodes(f.deliveries.at(-1).card).some(n=>n.tag==='button'&&n.text?.content==='标记完成'));
});
test('fresh task lists exclude tasks whose source group is no longer authorized',async t=>{
  const f=setup(t);await create(f);f.config.groups.push({id:'g2',name:'另一群'});
  f.store.run('DELETE FROM memberships');f.transport.isGroupMember=async id=>id==='g2';
  f.bot.receiveMessage(dm('我的待办','alice','after-leave'));await f.bot.tick();
  assert.doesNotMatch(JSON.stringify(f.deliveries.at(-1).card),/实验报告/);
});
test('a failed redaction PATCH remains deliverable even when its old task is no longer authorized',async t=>{
  const f=setup(t);await create(f);f.config.groups.push({id:'g2',name:'另一群'});f.offline(true);
  f.bot.receiveAction(click(f.deliveries.at(-1),'10分钟后提醒',{id:'redact-retry'}));await f.bot.tick();
  f.store.run('DELETE FROM memberships');f.transport.isGroupMember=async id=>id==='g2';f.setNow(NOW+120000);await f.bot.tick();
  f.offline(false);f.setNow(NOW+240000);await f.bot.tick();
  assert.doesNotMatch(JSON.stringify(f.deliveries.at(-1).card),/实验报告/);
});
