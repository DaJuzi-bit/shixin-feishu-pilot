export function isHistory(summary,now=Date.now()) {
  if(summary.taskId)return true;
  const due=Date.parse(summary.dueAt);
  if(Number.isFinite(due))return due<=now;
  const sent=Date.parse(summary.source?.sentAt);
  return Number.isFinite(sent)&&sent<now-7*86400000;
}
export function isOverdue(task,now=Date.now()) {
  return task.status==='pending'&&Number.isFinite(Date.parse(task.dueAt))&&Date.parse(task.dueAt)<=now;
}
export function updateNotice(applied,next) {
  if(!applied||!next||next.revision===applied.revision)return '';
  const count=Math.max(0,(next.messageCount||0)-(applied.messageCount||0));
  return count?`有 ${count} 条新消息 · 点击更新`:'事项有更新 · 点击查看';
}
