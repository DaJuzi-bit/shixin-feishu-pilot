import {createHash,randomUUID} from 'node:crypto';
import {extract} from './extract.mjs';
import {PilotError,requireValue} from './errors.mjs';
const key=value=>createHash('sha256').update(value).digest('hex').slice(0,32);
const json=JSON.stringify;
const dateString=value=>Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const display=value=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
export class PilotService {
  constructor({store,config,transport,clock=Date.now}){Object.assign(this,{store,config,transport,clock});this.busy=false;}
  ingest(raw) {
    const e=raw.event??raw,m=e.message,s=e.sender;
    const tenant=raw.header?.tenant_key??raw.tenant_key??s?.tenant_key;
    if(!m||!s||s.sender_type!=='user'||tenant!==this.config.tenantKey||m.chat_type!=='group'||!this.config.groups.some(g=>g.id===m.chat_id)||m.message_type!=='text')return {accepted:false};
    let text;try{text=JSON.parse(m.content).text;}catch{return {accepted:false};}
    if(typeof text!=='string'||!text.trim()||text.length>10000||!m.message_id||!s.sender_id?.open_id)return {accepted:false};
    const timestamp=Number(m.create_time);if(!Number.isFinite(timestamp)||timestamp<=0||timestamp>this.clock()+300000)return {accepted:false};
    const payload={id:m.message_id,tenant,groupId:m.chat_id,senderId:s.sender_id.open_id,text,sentAt:timestamp};
    const result=this.store.run('INSERT OR IGNORE INTO inbox(id,payload,next_at) VALUES(?,?,?)',key(tenant+':'+m.message_id),json(payload),this.clock());
    return {accepted:true,duplicate:result.changes===0};
  }
  async allowedGroups(user) {
    requireValue(user?.tenantId===this.config.tenantKey,'没有这个团队的访问权限',403);
    const allowed=[];
    for(const group of this.config.groups){
      const cached=this.store.get('SELECT * FROM memberships WHERE group_id=? AND user_id=?',group.id,user.id);
      let isMember=cached?.checked_at>this.clock()-120000?!!cached.allowed:false;
      if(!cached||cached.checked_at<=this.clock()-120000){
        // Network errors fail closed: stale membership never grants access.
        try{isMember=await this.transport.isGroupMember(group.id,user.id);}catch{throw new PilotError('暂时无法核验群成员，请稍后重试',503,'membership_unavailable');}
        this.store.run('INSERT OR REPLACE INTO memberships VALUES(?,?,?,?)',group.id,user.id,isMember?1:0,this.clock());
      }
      if(isMember)allowed.push(group);
    }
    requireValue(allowed.length>0,'你不在已授权试用群中，暂无群消息访问权限',403);
    return allowed;
  }
  async requireSummary(user,id) {
    const row=this.store.get('SELECT * FROM summaries WHERE id=?',id);requireValue(row,'没有找到这条归纳',404);
    const groups=await this.allowedGroups(user);requireValue(groups.some(g=>g.id===row.group_id),'没有这个群的访问权限',403);
    const value=JSON.parse(row.payload),override=this.store.get('SELECT payload FROM overrides WHERE user_id=? AND summary_id=?',user.id,id);
    return {...value,...(override?JSON.parse(override.payload):{})};
  }
  async dashboard(user) {
    const groups=await this.allowedGroups(user),ids=new Set(groups.map(g=>g.id));
    const tasks=this.store.all('SELECT t.payload,s.group_id FROM tasks t JOIN summaries s ON s.id=t.summary_id WHERE t.owner_id=?',user.id).filter(r=>ids.has(r.group_id)).map(r=>JSON.parse(r.payload));
    const overrides=new Map(this.store.all('SELECT summary_id,payload FROM overrides WHERE user_id=?',user.id).map(r=>[r.summary_id,JSON.parse(r.payload)]));
    const summaries=this.store.all('SELECT * FROM summaries ORDER BY rowid DESC LIMIT 1000').filter(r=>ids.has(r.group_id)).map(r=>{
      const value={...JSON.parse(r.payload),...(overrides.get(r.id)??{})},task=tasks.find(t=>t.summaryId===r.id);
      return {...value,taskId:task?.id??null,taskStatus:task?.status??null};
    });
    const visibleGroups=groups.map(g=>({...g,messageCount:this.store.get('SELECT COUNT(*) AS count FROM messages WHERE group_id=?',g.id).count}));
    tasks.sort((a,b)=>a.dueAt.localeCompare(b.dueAt));
    return {user,groups:visibleGroups,summaries,tasks,revision:key(json([visibleGroups,summaries,tasks])),accessRevision:key(json(groups.map(g=>g.id).sort())),messageCount:visibleGroups.reduce((total,g)=>total+g.messageCount,0),counts:{summaries:summaries.length,pending:tasks.filter(t=>t.status==='pending').length,done:tasks.filter(t=>t.status==='done').length}};
  }
  async messages(user,groupId) {
    const groups=await this.allowedGroups(user);requireValue(groups.some(g=>g.id===groupId),'没有这个群的访问权限',403);
    return this.store.all('SELECT m.*,s.id AS summary_id,u.name AS sender_name FROM messages m LEFT JOIN summaries s ON s.message_id=m.id LEFT JOIN users u ON u.id=m.sender_id WHERE m.group_id=? ORDER BY m.sent_at DESC LIMIT 200',groupId).reverse().map(m=>({id:m.id,groupId:m.group_id,senderName:m.sender_id===user.id?user.name:m.sender_name||'群成员',text:m.text,sentAt:new Date(m.sent_at).toISOString(),summaryId:m.summary_id}));
  }
  validateSchedule(input,summary) {
    const dueAt=dateString(input.dueAt??summary?.dueAt),now=this.clock();
    requireValue(dueAt&&Date.parse(dueAt)>now,'请补充晚于当前时间的截止时间');
    let remindAt=input.remindAt;
    if(remindAt===undefined)remindAt=new Date(Math.max(now+1000,Date.parse(dueAt)-3600000)).toISOString();
    if(remindAt===null||remindAt==='')remindAt=null;
    else {remindAt=dateString(remindAt);requireValue(remindAt&&Date.parse(remindAt)>now&&Date.parse(remindAt)<Date.parse(dueAt),'提醒时间必须晚于现在并早于截止时间');}
    const title=String(input.title??summary?.title??'').trim();requireValue(title&&title.length<=160,'任务名称需为1到160个字符');
    return {title,dueAt,remindAt};
  }
  async createTask(user,input) {
    const summary=await this.requireSummary(user,input.summaryId);
    const existing=this.store.get('SELECT payload FROM tasks WHERE owner_id=? AND summary_id=?',user.id,summary.id);if(existing)return JSON.parse(existing.payload);
    requireValue(summary.actionable,'这条消息当前没有被确认为待办，请先调整归纳');
    requireValue(!summary.audienceHint||input.confirmApplies===true,'请先确认这件事需要你处理');
    const schedule=this.validateSchedule(input,summary);
    const task={id:randomUUID(),ownerId:user.id,summaryId:summary.id,sourceGroup:summary.groupName,...schedule,status:'pending',version:1,reminderStatus:schedule.remindAt?'scheduled':'none',lastError:null,completedAt:null};
    this.store.run('INSERT OR IGNORE INTO tasks VALUES(?,?,?,?)',task.id,user.id,summary.id,json(task));
    return JSON.parse(this.store.get('SELECT payload FROM tasks WHERE owner_id=? AND summary_id=?',user.id,summary.id).payload);
  }
  async mutateTask(user,id,action,input={},expectedVersion) {
    const row=this.store.get('SELECT payload FROM tasks WHERE id=? AND owner_id=?',id,user.id);requireValue(row,'没有找到你的这项待办',404);
    const task=JSON.parse(row.payload);
    await this.requireSummary(user,task.summaryId);
    if(action==='complete'&&task.status==='done')return task;
    if(action==='reopen'&&task.status==='pending')return task;
    this.store.tx(()=>{
      const latest=this.store.get('SELECT payload FROM tasks WHERE id=? AND owner_id=?',id,user.id);
      requireValue(latest&&JSON.parse(latest.payload).version===task.version&&(expectedVersion===undefined||task.version===expectedVersion),'待办已发生变化，请刷新后重新操作',409,'stale_task');
      if(action==='complete'){task.status='done';task.completedAt=new Date(this.clock()).toISOString();task.reminderStatus='cancelled';}
      else if(action==='reopen'){task.status='pending';task.completedAt=null;task.remindAt=null;task.reminderStatus='none';}
      else if(action==='snooze'){requireValue(task.status==='pending','已完成的任务不能稍后提醒');requireValue(input.minutes===undefined||input.minutes===10,'第一版支持10分钟后提醒');requireValue(this.clock()+600000<Date.parse(task.dueAt),'10分钟后已超过截止时间，请先修改截止时间或及时完成');task.remindAt=new Date(this.clock()+600000).toISOString();task.reminderStatus='scheduled';}
      else if(action==='edit'){Object.assign(task,this.validateSchedule({...task,...input},null));task.reminderStatus=task.remindAt?'scheduled':'none';}
      else throw new PilotError('不支持这个操作');
      task.version++;task.lastError=null;
      this.store.run("UPDATE outbox SET status='cancelled' WHERE task_id=? AND status IN ('ready','retry','sending')",id);
      this.store.run('UPDATE tasks SET payload=? WHERE id=?',json(task),id);
    });return task;
  }
  async correct(user,id,input) {
    const summary=await this.requireSummary(user,id);
    requireValue(['homework','notice','activity','intern','chat'].includes(input.category)&&typeof input.actionable==='boolean','分类或行动判断格式不正确');
    const override={category:input.category,actionable:input.actionable};this.store.run('INSERT OR REPLACE INTO overrides VALUES(?,?,?)',user.id,id,json(override));return {...summary,...override};
  }
  async tick() {
    if(this.busy)return;this.busy=true;
    try{await this.processInbox();this.scheduleReminders();await this.processOutbox();}finally{this.busy=false;}
  }
  async processInbox() {
    for(let index=0;index<20;index++){
      const job=this.store.tx(()=>{const r=this.store.get("SELECT * FROM inbox WHERE (status IN ('ready','retry') AND next_at<=?) OR (status='processing' AND lease_until<=?) ORDER BY rowid LIMIT 1",this.clock(),this.clock());if(r)this.store.run("UPDATE inbox SET status='processing',lease_until=? WHERE id=?",this.clock()+30000,r.id);return r;});
      if(!job)break;
      try{const m=JSON.parse(job.payload),group=this.config.groups.find(g=>g.id===m.groupId);if(!group){this.store.run("UPDATE inbox SET status='ignored' WHERE id=?",job.id);continue;}
        // Keep the full source in-app. A message ID is not an official deep-link token.
        const summary={id:'s_'+key(m.tenant+':'+m.id),groupId:m.groupId,groupName:group.name,...extract(m.text,{sentAt:m.sentAt}),source:{messageId:m.id,senderId:m.senderId,text:m.text,sentAt:new Date(m.sentAt).toISOString(),url:null}};
        this.store.tx(()=>{this.store.run('INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?,?)',m.id,m.tenant,m.groupId,m.senderId,m.text,m.sentAt);this.store.run('INSERT OR IGNORE INTO summaries VALUES(?,?,?,?)',summary.id,m.id,m.groupId,json(summary));this.store.run("UPDATE inbox SET status='done',error=NULL WHERE id=?",job.id);});
      }catch{const attempts=job.attempts+1;this.store.run('UPDATE inbox SET status=?,attempts=?,next_at=?,error=? WHERE id=?',attempts>=5?'failed':'retry',attempts,this.clock()+Math.min(300000,1000*2**attempts),'消息处理失败，等待重试',job.id);}
    }
  }
  scheduleReminders() {
    for(const row of this.store.all('SELECT payload FROM tasks')){const task=JSON.parse(row.payload);
      if(task.status!=='pending'||!task.remindAt||Date.parse(task.remindAt)>this.clock()||!['scheduled','queued'].includes(task.reminderStatus))continue;
      const id=key('reminder:'+task.id+':'+task.version);
      if(this.store.get('SELECT id FROM outbox WHERE id=?',id))continue;
      this.store.tx(()=>{this.store.run('INSERT OR IGNORE INTO outbox(id,task_id,version,payload,next_at) VALUES(?,?,?,?,?)',id,task.id,task.version,json({recipient:task.ownerId,...(this.reminderCard?{card:this.reminderCard(task)}:{text:'待办提醒：'+task.title+'\n截止：'+display(task.dueAt)+'\n来自：'+task.sourceGroup+'\n打开消息助手处理：'+this.config.publicBaseUrl+'/?task='+encodeURIComponent(task.id)}),uuid:id}),this.clock());task.reminderStatus='queued';this.store.run('UPDATE tasks SET payload=? WHERE id=?',json(task),task.id);});
    }
  }
  async processOutbox() {
    for(let index=0;index<10;index++){
      const job=this.store.tx(()=>{const r=this.store.get("SELECT * FROM outbox WHERE (status IN ('ready','retry') AND next_at<=?) OR (status='sending' AND lease_until<=?) ORDER BY rowid LIMIT 1",this.clock(),this.clock());if(r)this.store.run("UPDATE outbox SET status='sending',lease_until=? WHERE id=?",this.clock()+30000,r.id);return r;});if(!job)break;
      const row=this.store.get('SELECT payload FROM tasks WHERE id=?',job.task_id),task=row?JSON.parse(row.payload):null;
      if(!task||task.status!=='pending'||task.version!==job.version){this.store.run("UPDATE outbox SET status='cancelled' WHERE id=?",job.id);continue;}
      const canSend=()=>{const current=this.store.get('SELECT payload FROM tasks WHERE id=?',job.task_id),delivery=this.store.get('SELECT status FROM outbox WHERE id=?',job.id);if(!current||delivery?.status!=='sending')return false;const value=JSON.parse(current.payload);return value.status==='pending'&&value.version===job.version;};
      try{const payload=JSON.parse(job.payload);
        {
          try{await this.requireSummary({id:task.ownerId,tenantId:this.config.tenantKey},task.summaryId);}catch(error){
            if(error instanceof PilotError&&error.status===403){this.store.tx(()=>{this.store.run("UPDATE outbox SET status='cancelled',error=NULL WHERE id=?",job.id);const latest=JSON.parse(this.store.get('SELECT payload FROM tasks WHERE id=?',task.id).payload);if(latest.version===job.version){latest.reminderStatus='cancelled';latest.lastError='群访问权限已变化，提醒已停止';this.store.run('UPDATE tasks SET payload=? WHERE id=?',json(latest),task.id);}});continue;}
            throw error;
          }
        }
        const card=payload.card&&this.config.primaryUi!=='page';
        const text=payload.text||'待办提醒：'+task.title+'\n截止：'+display(task.dueAt)+'\n打开拾信处理：'+this.config.publicBaseUrl+'/?task='+encodeURIComponent(task.id);
        const result=card?await this.transport.sendCard(payload.recipient,payload.card,payload.uuid,canSend):await this.transport.sendText(payload.recipient,text,payload.uuid,canSend);
        if(result?.cancelled){this.store.run("UPDATE outbox SET status='cancelled',error=NULL WHERE id=?",job.id);continue;}
        if(card)this.onCardDelivered?.(payload.card,result.messageId);
        this.store.tx(()=>{this.store.run("UPDATE outbox SET status='sent',error=NULL WHERE id=?",job.id);const latest=JSON.parse(this.store.get('SELECT payload FROM tasks WHERE id=?',task.id).payload);if(latest.version===job.version&&latest.status==='pending'){latest.reminderStatus='sent';latest.lastError=null;this.store.run('UPDATE tasks SET payload=? WHERE id=?',json(latest),task.id);}});
      }catch{if(!canSend()){this.store.run("UPDATE outbox SET status='cancelled',error=NULL WHERE id=?",job.id);continue;}const attempts=job.attempts+1,failed=attempts>=8;
        this.store.tx(()=>{this.store.run('UPDATE outbox SET status=?,attempts=?,next_at=?,error=? WHERE id=?',failed?'failed':'retry',attempts,this.clock()+Math.min(300000,1000*2**attempts),'飞书发送未确认，等待重试',job.id);const latest=JSON.parse(this.store.get('SELECT payload FROM tasks WHERE id=?',task.id).payload);if(latest.version===job.version&&latest.status==='pending'){latest.reminderStatus=failed?'failed':'retry';latest.lastError=failed?'多次发送失败，请检查应用权限和服务连接':'发送失败，后台将重试';this.store.run('UPDATE tasks SET payload=? WHERE id=?',json(latest),task.id);}});
      }
    }
  }
}
