import test from 'node:test';
import assert from 'node:assert/strict';
import {isHistory,isOverdue,updateNotice} from '../public/reading-state.mjs';
const now=Date.parse('2026-10-29T04:00:00Z');
test('history hides expired and confirmed summaries without deleting future notices',()=>{
  assert.equal(isHistory({dueAt:'2026-10-28T04:00:00Z'},now),true);
  assert.equal(isHistory({taskId:'mine'},now),true);
  assert.equal(isHistory({source:{sentAt:'2026-10-20T04:00:00Z'}},now),true);
  assert.equal(isHistory({dueAt:'2026-11-01T04:00:00Z',source:{sentAt:'2026-10-01T04:00:00Z'}},now),false);
  assert.equal(isHistory({source:{sentAt:'2026-10-28T04:00:00Z'}},now),false);
  assert.equal(isOverdue({status:'pending',dueAt:new Date(now).toISOString()},now),true);
  assert.equal(isOverdue({status:'done',dueAt:new Date(now-1).toISOString()},now),false);
});
test('update notice compares revisions and counts without applying remote state',()=>{
  const applied={revision:'a',messageCount:5};
  assert.equal(updateNotice(applied,{revision:'a',messageCount:5}),'');
  assert.equal(updateNotice(applied,{revision:'b',messageCount:8}),'有 3 条新消息 · 点击更新');
  assert.equal(updateNotice(applied,{revision:'b',messageCount:5}),'事项有更新 · 点击查看');
  assert.deepEqual(applied,{revision:'a',messageCount:5});
});
