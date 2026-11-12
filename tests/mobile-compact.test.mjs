import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {PilotService} from '../src/service.mjs';
import {MobileBot} from '../src/mobile.mjs';
const NOW=Date.parse('2026-10-29T02:50:00Z'),EARLIER=Date.parse('2026-10-22T07:00:00Z');
const user={id:'alice',name:'成员A',tenantId:'team'};
const nodes=x=>!x||typeof x!=='object'?[]:[x,...Object.values(x).flatMap(v=>Array.isArray(v)?v.flatMap(nodes):nodes(v))];
const text=card=>nodes(card).filter(n=>n.tag==='plain_text').map(n=>n.content).join('\n');
function setup(t){
  const store=new Store(':memory:'),deliveries=[];let now=NOW;
  const config={mode:'feishu',tenantKey:'team',groups:[{id:'g1',name:'课程群'}],publicBaseUrl:'http://127.0.0.1:5300'};
  const transport={isGroupMember:async()=>true,sendCard:async(owner,card)=>{const messageId='om_'+deliveries.length;deliveries.push({owner,card,messageId});return {messageId};},updateCard:async(messageId,card)=>{deliveries.find(d=>d.messageId===messageId).card=card;}};
  const service=new PilotService({store,config,transport,clock:()=>now}),bot=new MobileBot({store,config,transport,service,clock:()=>now});
  t.after(()=>store.close());
  async function message(id,content,sentAt=NOW){
    service.ingest({header:{tenant_key:'team'},event:{sender:{sender_type:'user',tenant_key:'team',sender_id:{open_id:'alice'}},message:{message_id:id,chat_id:'g1',chat_type:'group',message_type:'text',content:JSON.stringify({text:content}),create_time:String(sentAt)}}});await service.tick();
    return JSON.parse(store.get('SELECT payload FROM summaries WHERE message_id=?',id).payload);
  }
  async function show(card){const result=await transport.sendCard(user.id,card);bot.bindCard(card,result.messageId);return deliveries.at(-1);}
  function click(delivery,button,option){return {tenant_key:'team',event_id:'ev_'+Math.random(),operator:{open_id:'alice',tenant_key:'team'},context:{open_message_id:delivery.messageId},action:{tag:button.tag,value:button.behaviors?.[0]?.value,...(option?{option}:{})}};}
  return {store,service,bot,deliveries,message,show,click,setNow:v=>{now=v;}};
}
test('current summaries exclude expired and undated old notices but keep older future deadlines',async t=>{
  const f=setup(t);
  await f.message('expired','作业过期测试：明天下午5点前提交实验报告。',EARLIER);
  await f.message('old','通知旧闻测试：图书馆开放时间已更新。',NOW-8*86400000);
  await f.message('future','作业未来测试：2026年11月1日下午5点提交报告。',EARLIER);
  const current=text(await f.bot.summaryCard(user));
  assert.doesNotMatch(current,/过期测试|旧闻测试/);assert.match(current,/未来测试/);
  const history=text(await f.bot.summaryCard(user,{view:'history'}));
  assert.match(history,/过期测试/);assert.match(history,/旧闻测试/);assert.doesNotMatch(history,/未来测试/);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM messages').n,3);
});
test('confirmed summaries leave the current inbox without deleting or completing their personal task',async t=>{
  const f=setup(t),summary=await f.message('confirmed','作业已处理测试：明天17:00提交实验报告。');
  const task=await f.service.createTask(user,{summaryId:summary.id});
  assert.doesNotMatch(text(await f.bot.summaryCard(user)),/已处理测试/);
  assert.match(text(await f.bot.summaryCard(user,{view:'history'})),/已处理测试/);
  assert.equal(JSON.parse(f.store.get('SELECT payload FROM tasks WHERE id=?',task.id).payload).status,'pending');
});
test('overdue unfinished tasks have a separate visible view and are never auto-completed',async t=>{
  const f=setup(t);f.setNow(EARLIER);const summary=await f.message('late','作业逾期待办测试：明天17:00提交实验报告。',EARLIER);
  const task=await f.service.createTask(user,{summaryId:summary.id});f.setNow(NOW);
  const current=text(await f.bot.tasksCard(user));assert.doesNotMatch(current,/逾期待办测试/);assert.match(current,/逾期.*1/);
  const overdue=text(await f.bot.tasksCard(user,{filter:'overdue'}));assert.match(overdue,/逾期待办测试/);assert.match(overdue,/已逾期/);
  const saved=JSON.parse(f.store.get('SELECT payload FROM tasks WHERE id=?',task.id).payload);assert.equal(saved.status,'pending');assert.equal(saved.completedAt,null);
});
test('compact list exposes six inline detail entries without expanding source paragraphs',async t=>{
  const f=setup(t);
  for(let i=0;i<7;i++)await f.message('list'+i,'作业'+(i+1)+'：明天17:00提交实验报告。'+'原文内容'.repeat(40)+'不可在列表展开的尾文。');
  const card=await f.bot.summaryCard(user),entries=nodes(card).filter(n=>n.tag==='button'&&n.text?.content==='详情');
  assert.equal(entries.length,6);assert.doesNotMatch(text(card),/不可在列表展开/);
  const entryRows=nodes(card).filter(n=>n.tag==='column_set'&&n.columns?.some(c=>nodes(c).some(v=>v.tag==='button'&&v.text?.content==='详情')));
  assert.ok(entryRows.every(row=>row.flex_mode==='none'&&row.columns.length===2));
  const delivery=await f.show(card);f.bot.receiveAction(f.click(delivery,entries[0]));await f.bot.tick();
  assert.match(text(delivery.card),/不可在列表展开的尾文/);
});
test('category dropdown changes the list without a wall of filter buttons and remains owner-bound',async t=>{
  const f=setup(t);await f.message('work','作业测试：明天17:00提交实验报告。');await f.message('activity','活动测试：明天18:00参加彩排。');
  const card=await f.bot.summaryCard(user),select=nodes(card).find(n=>n.tag==='select_static'&&n.name==='summary_category');assert.ok(select);
  const delivery=await f.show(card),action=f.click(delivery,select,'activity');
  assert.equal(f.bot.receiveAction(action).toast.type,'info');await f.bot.tick();
  assert.match(text(delivery.card),/参加彩排/);assert.doesNotMatch(text(delivery.card),/作业测试/);
  const fresh=nodes(delivery.card).find(n=>n.name==='summary_category'),forged=f.click(delivery,fresh,'made-up-category');
  assert.equal(f.bot.receiveAction(forged).toast.type,'error');
});
test('expired source details do not advertise creating a new task',async t=>{
  const f=setup(t),summary=await f.message('expired-detail','作业过期详情：明天17:00提交实验报告。',EARLIER);
  const card=await f.bot.execute(user,{action:'source',summaryId:summary.id});
  assert.match(text(card),/已过截止/);assert.doesNotMatch(text(card),/核对并添加待办/);
});
test('native time captions distinguish today, tomorrow and an absolute older deadline',async t=>{
  const f=setup(t);await f.message('today','作业今日测试：今天17:00提交报告。');await f.message('tomorrow','作业明日测试：明天17:00提交报告。');
  const card=await f.bot.summaryCard(user);assert.match(text(card),/今天 17:00/);assert.match(text(card),/明天 17:00/);
  const options=nodes(card).find(n=>n.name==='summary_category').options;assert.ok(options.length>=5);
});
