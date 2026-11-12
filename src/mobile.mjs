import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {PilotError,requireValue} from './errors.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex').slice(0,32);
const clip=(value,length=1800)=>String(value??'').slice(0,length);
const plain=content=>({tag:'plain_text',content:clip(content)});
const paragraph=content=>({tag:'div',text:plain(content)});
const categories={all:'全部',homework:'作业',notice:'通知',activity:'活动',intern:'实习',chat:'闲聊'};
const shanghai=value=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
const short=(value,length)=>{const chars=Array.from(String(value??'').replace(/\s+/g,' ').trim());return chars.length>length?chars.slice(0,length).join('')+'…':chars.join('');};
const expired=(value,now)=>!!value&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=now;
function briefTime(value,now){
  const local=new Date(Date.parse(value)+8*3600000),today=new Date(now+8*3600000);
  if(Number.isNaN(local.valueOf()))return '时间待确认';
  const day=local.toISOString().slice(0,10),base=today.toISOString().slice(0,10),tomorrow=new Date(now+86400000+8*3600000).toISOString().slice(0,10),clock=local.toISOString().slice(11,16);
  return (day===base?'今天':day===tomorrow?'明天':day.slice(0,4)===base.slice(0,4)?day.slice(5).replace('-','/'):day.replaceAll('-','/'))+' '+clock;
}
function formDate(value){
  const m=String(value??'').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?: ([+-])(\d{2})(\d{2}))?$/);
  requireValue(m,'请选择有效的日期和时间');
  const [year,month,day,hour,minute]=m.slice(1,6).map(Number);
  const offset=m[6]?(m[6]==='-'?-1:1)*(Number(m[7])*60+Number(m[8])):480;
  requireValue(year>=2020&&year<=2100&&month>=1&&month<=12&&day>=1&&day<=31&&hour<=23&&minute<=59&&Math.abs(offset)<=840&&(!m[8]||Number(m[8])<60),'日期和时间不正确');
  const local=Date.UTC(year,month-1,day,hour,minute),check=new Date(local);
  requireValue(check.getUTCFullYear()===year&&check.getUTCMonth()===month-1&&check.getUTCDate()===day,'日期不存在，请重新选择');
  return new Date(local-offset*60000).toISOString();
}
function tokens(card){
  const result=[];
  function walk(value){if(!value||typeof value!=='object')return;if(['button','select_static'].includes(value.tag)){const token=value.behaviors?.find(b=>b.type==='callback')?.value?.token??(value.name?.startsWith('submit_')?value.name.slice(7):null);if(token)result.push(token);}for(const value2 of Object.values(value))if(Array.isArray(value2))value2.forEach(walk);else walk(value2);}
  walk(card);return result;
}
export class MobileBot {
  constructor({store,config,service,transport,clock=Date.now}){
    Object.assign(this,{store,config,service,transport,clock});this.busy=false;
    // The existing durable reminder outbox still owns delivery and cancellation.
    service.reminderCard=task=>this.taskCard({id:task.ownerId,tenantId:config.tenantKey},task,'待办提醒');
    service.onCardDelivered=(card,messageId)=>this.bindCard(card,messageId);
  }
  user(id){const row=this.store.get('SELECT name FROM users WHERE id=? AND tenant=?',id,this.config.tenantKey);return {id,tenantId:this.config.tenantKey,name:row?.name||'试用成员'};}
  enqueue(id,userId,payload){return this.store.run('INSERT OR IGNORE INTO mobile_jobs(id,owner_id,payload,next_at) VALUES(?,?,?,?)',id,userId,JSON.stringify(payload),this.clock()).changes>0;}
  queueHomeForKnownUser(id){requireValue(this.store.get('SELECT id FROM users WHERE id=? AND tenant=?',id,this.config.tenantKey),'没有找到已核验的试用成员');this.enqueue('home_'+randomUUID(),id,{action:'home'});}
  receiveMessage(raw){
    const e=raw.event??raw,m=e.message,s=e.sender,tenant=raw.header?.tenant_key??raw.tenant_key??s?.tenant_key;
    if(tenant!==this.config.tenantKey||s?.tenant_key&&s.tenant_key!==tenant||s?.sender_type!=='user'||m?.chat_type!=='p2p'||m?.message_type!=='text'||!s.sender_id?.open_id||!m.message_id)return {accepted:false};
    const sentAt=Number(m.create_time);if(!Number.isFinite(sentAt)||sentAt<this.clock()-900000||sentAt>this.clock()+300000)return {accepted:false};
    let text;try{text=JSON.parse(m.content).text?.trim();}catch{return {accepted:false};}if(!text||text.length>1000)return {accepted:false};
    const action=/^(我的待办|待办|待办事项|逾期待办)$/.test(text)?'tasks':/^(消息中心|消息归纳|归纳|历史消息)$/.test(text)?'summaries':'home';
    return {accepted:true,duplicate:!this.enqueue('dm_'+digest(tenant+':'+m.message_id),s.sender_id.open_id,{action,...(text==='历史消息'?{view:'history'}:{}),...(text==='逾期待办'?{filter:'overdue'}:{})})};
  }
  receiveAction(raw){
    try{
      const e=raw.event??raw,tenant=raw.header?.tenant_key??raw.tenant_key??e.operator?.tenant_key,owner=e.operator?.open_id;
      requireValue(tenant===this.config.tenantKey&&owner&&(!e.operator?.tenant_key||e.operator.tenant_key===tenant),'请使用本次试用团队账号');
      const token=e.action?.value?.token??(e.action?.name?.startsWith('submit_')?e.action.name.slice(7):null);
      requireValue(typeof token==='string'&&/^[a-zA-Z0-9_-]{24}$/.test(token),'卡片操作无效，请重新发送“我的待办”');
      const row=this.store.get('SELECT * FROM mobile_actions WHERE token=?',token);
      requireValue(row&&row.owner_id===owner&&row.expires_at>this.clock()&&row.message_id&&row.message_id===e.context?.open_message_id,'这张卡片已过期或不属于你，请重新发送“我的待办”');
      const payload=JSON.parse(row.payload);
      if(e.action?.tag==='select_static'){
        const option=e.action.option;
        if(payload.control==='summary_category'){requireValue(typeof option==='string'&&Object.hasOwn(categories,option),'无效的消息分类');payload.category=option;}
        else if(payload.control==='task_filter'){requireValue(['pending','overdue','done','all'].includes(option),'无效的待办筛选');payload.filter=option;}
        else throw new PilotError('这项筛选已失效，请刷新卡片');
        payload.page=0;
      }
      let input;
      if(['confirm','save'].includes(payload.action)){
        const form=e.action.form_value;requireValue(form&&typeof form==='object'&&!Array.isArray(form),'请填写待办表单');
        input={title:String(form.task_title??'').trim(),dueAt:formDate(form.due_at),remindAt:formDate(form.remind_at)};
        this.service.validateSchedule(input);
      }
      const mutating=['confirm','save','complete','snooze','reopen'].includes(payload.action);
      const eventId=raw.header?.event_id??raw.event_id??e.token;
      const id=mutating?'action_'+token:'view_'+digest(token+':'+(eventId||randomUUID()));
      this.enqueue(id,owner,{...payload,input,messageId:row.message_id});
      return {toast:{type:'info',content:'正在处理，卡片会自动更新'}};
    }catch(error){return {toast:{type:'error',content:clip(error instanceof PilotError?error.message:'暂时无法处理，请稍后重试',100)}};}
  }
  issue(user,payload){const token=randomBytes(18).toString('base64url');this.store.run('INSERT INTO mobile_actions VALUES(?,?,?,?,NULL)',token,user.id,JSON.stringify(payload),this.clock()+2*86400000);return token;}
  button(user,label,payload,type='default'){
    return {tag:'button',text:plain(label),type,behaviors:[{type:'callback',value:{token:this.issue(user,payload)}}]};
  }
  row(buttons){return {tag:'column_set',flex_mode:'none',columns:buttons.map(button=>({tag:'column',width:'weighted',weight:1,elements:[button]}))};}
  select(user,name,options,current,payload){return {tag:'select_static',name,width:'fill',initial_option:current,options:options.map(([value,label])=>({text:plain(label),value})),behaviors:[{type:'callback',value:{token:this.issue(user,payload)}}]};}
  entry(user,title,meta,payload){return {tag:'column_set',flex_mode:'none',horizontal_spacing:'8px',columns:[{tag:'column',width:'weighted',weight:1,vertical_spacing:'2px',padding:'0px',elements:[{tag:'div',text:{...plain(title),text_size:'normal',lines:2}},{tag:'div',text:{...plain(meta),text_size:'notation',text_color:'grey',lines:1}}]},{tag:'column',width:'64px',vertical_align:'center',elements:[{...this.button(user,'详情',payload),width:'fill'}]}]};}
  card(user,title,elements){return {schema:'2.0',config:{update_multi:true},header:{template:'green',title:plain('拾信 · '+title)},body:{padding:'8px 12px 12px 12px',vertical_spacing:'8px',elements:[this.row([this.button(user,'消息中心',{action:'summaries'}),this.button(user,'我的待办',{action:'tasks'})]),...elements]}};}
  home(user){return this.card(user,'手机助手',[paragraph('在飞书里直接查看归纳、确认待办、设置提醒和标记完成，不需要打开浏览器。'),paragraph('群里照常发消息；点击上方按钮查看。也可以私聊我：消息中心 / 我的待办。'),paragraph('只处理已授权的小组群。请把此会话置顶，作为固定入口。后台电脑仍需开机并联网。')]);}
  bindCard(card,messageId){for(const token of tokens(card))this.store.run('UPDATE mobile_actions SET message_id=? WHERE token=?',messageId,token);}
  historical(summary){if(summary.taskId||expired(summary.dueAt,this.clock()))return true;if(summary.dueAt&&Date.parse(summary.dueAt)>this.clock())return false;const sent=Date.parse(summary.source?.sentAt);return Number.isFinite(sent)&&sent<this.clock()-7*86400000;}
  async summaryCard(user,{page=0,category='all',view='current'}={}){
    category=Object.hasOwn(categories,category)?category:'all';view=view==='history'?'history':'current';
    const data=await this.service.dashboard(user),filtered=data.summaries.filter(s=>category==='all'||s.category===category),history=filtered.filter(s=>this.historical(s)),current=filtered.filter(s=>!this.historical(s)),list=view==='history'?history:current,size=6;
    if(view==='current')list.sort((a,b)=>(Date.parse(a.dueAt)||Infinity)-(Date.parse(b.dueAt)||Infinity)||Date.parse(b.source.sentAt)-Date.parse(a.source.sentAt));
    page=Math.max(0,Math.min(Number.isSafeInteger(page)?page:0,Math.max(0,Math.ceil(list.length/size)-1)));
    const elements=[this.row([this.button(user,'待处理 '+current.length,{action:'summaries',category,view:'current'},view==='current'?'primary':'default'),this.button(user,'历史 '+history.length,{action:'summaries',category,view:'history'},view==='history'?'primary':'default')]),this.select(user,'summary_category',Object.entries(categories).map(([id,name])=>[id,name==='全部'?'全部分类':name]),category,{action:'summaries',view,category,control:'summary_category'}),paragraph((view==='history'?'历史 / 已处理':'当前待处理')+' · '+list.length+' 条 · '+(page+1)+'/'+Math.max(1,Math.ceil(list.length/size))+'页（北京时间）')];
    for(const s of list.slice(page*size,(page+1)*size)){
      const status=s.taskStatus==='done'?'已完成':s.taskId?'已转待办':expired(s.dueAt,this.clock())?'已过期':view==='history'?'较早消息':s.uncertainty?'需核对':'';
      const meta=[status,s.dueAt?briefTime(s.dueAt,this.clock()):'时间待确认',short(s.groupName,8)].filter(Boolean).join(' · ');
      elements.push(this.entry(user,'【'+(categories[s.category]||'消息')+'】'+short(s.title||s.text,30),meta,{action:'source',summaryId:s.id}));
    }
    if(!list.length)elements.push(paragraph(view==='history'?'暂无历史消息。':'当前没有待处理的新消息。过期、较早及已转待办的通知可在“历史”中查看。'));
    if(list.length>size)elements.push(this.row([...(page>0?[this.button(user,'上一页',{action:'summaries',category,view,page:page-1})]:[]),...(page*size+size<list.length?[this.button(user,'下一页',{action:'summaries',category,view,page:page+1})]:[])]));
    return this.card(user,'消息中心',elements);
  }
  async getTask(user,id){const row=this.store.get('SELECT payload FROM tasks WHERE id=? AND owner_id=?',id,user.id);requireValue(row,'没有找到你的这项待办',404);const task=JSON.parse(row.payload);await this.service.requireSummary(user,task.summaryId);return task;}
  controls(user,task){const base={taskId:task.id,version:task.version};return task.status==='done'?[this.button(user,'重新打开',{...base,action:'reopen'})]:[this.button(user,'标记完成',{...base,action:'complete'},'primary'),this.button(user,'10分钟后提醒',{...base,action:'snooze'}),this.button(user,'修改时间',{...base,action:'edit'})];}
  taskCard(user,task,title='待办详情',note=''){
    return this.card(user,title,[...(note?[paragraph(note)]:[]),paragraph((task.status==='done'?'已完成':expired(task.dueAt,this.clock())?'已逾期 · 尚未完成':'待完成')+' · '+task.title),paragraph('来源：'+task.sourceGroup+'\n截止：'+shanghai(task.dueAt)+'（北京时间）\n提醒：'+(task.status==='done'?'已取消':task.remindAt?shanghai(task.remindAt):'未设置')),this.row(this.controls(user,task))]);
  }
  async tasksCard(user,{page=0,filter='pending'}={}){
    filter=['pending','overdue','done','all'].includes(filter)?filter:'pending';
    const data=await this.service.dashboard(user),overdue=data.tasks.filter(t=>t.status==='pending'&&expired(t.dueAt,this.clock())),pending=data.tasks.filter(t=>t.status==='pending'&&!expired(t.dueAt,this.clock())),done=data.tasks.filter(t=>t.status==='done'),list=filter==='pending'?pending:filter==='overdue'?overdue:filter==='done'?done:data.tasks,size=6;
    page=Math.max(0,Math.min(Number.isSafeInteger(page)?page:0,Math.max(0,Math.ceil(list.length/size)-1)));
    const options=[['pending','待完成 '+pending.length],['overdue','已逾期 '+overdue.length],['done','已完成 '+done.length],['all','全部待办 '+data.tasks.length]];
    const elements=[this.select(user,'task_filter',options,filter,{action:'tasks',filter,control:'task_filter'}),paragraph('当前 '+list.length+' 项 · '+(page+1)+'/'+Math.max(1,Math.ceil(list.length/size))+'页（北京时间）')];
    if(filter==='pending'&&overdue.length)elements.push(paragraph('另有已逾期 '+overdue.length+' 项尚未完成，可在上方筛选中查看。'));
    for(const task of list.slice(page*size,(page+1)*size))elements.push(this.entry(user,short(task.title,34),[task.status==='done'?'已完成':expired(task.dueAt,this.clock())?'已逾期':'待完成',briefTime(task.dueAt,this.clock()),short(task.sourceGroup,8)].join(' · '),{action:'detail',taskId:task.id}));
    if(!list.length)elements.push(paragraph('这里暂时没有待办。去“消息中心”核对消息后，确认属于自己的事项。'));
    if(list.length>size)elements.push(this.row([...(page>0?[this.button(user,'上一页',{action:'tasks',filter,page:page-1})]:[]),...(page*size+size<list.length?[this.button(user,'下一页',{action:'tasks',filter,page:page+1})]:[])]));
    return this.card(user,'我的待办',elements);
  }
  async formCard(user,payload){
    const editing=!!payload.taskId,item=editing?await this.getTask(user,payload.taskId):await this.service.requireSummary(user,payload.summaryId);
    requireValue(editing||item.actionable,'这条消息暂未识别为可执行事项，请先核对归纳');
    const due=item.dueAt&&Date.parse(item.dueAt)>this.clock()?item.dueAt:null;
    const reminder=editing?item.remindAt:due?new Date(Math.max(this.clock()+180000,Date.parse(due)-1800000)).toISOString():null;
    const token=this.issue(user,editing?{action:'save',taskId:item.id,version:item.version}:{action:'confirm',summaryId:item.id});
    return this.card(user,editing?'修改待办':'确认我的待办',[
      paragraph('请选择截止和提醒时间。所有展示时间均为北京时间；提醒必须晚于现在，并早于截止。'),
      ...(!editing?[paragraph('消息原文：'+clip(item.source.text,1000)+(item.source.text.length>1000?'\n【原文较长，此处仅展示开头，请先查看全文】':'')),this.row([this.button(user,'查看原文',{action:'source',summaryId:item.id})]),paragraph('适用对象：'+(item.audienceHint||'请自行核对')+'。点击确认表示：这件事需要我处理，仅添加到我自己的待办。')]:[]),
      {tag:'form',name:'task_form',elements:[
        {tag:'input',name:'task_title',required:true,max_length:160,default_value:clip(item.title||item.text,160),placeholder:plain('待办名称')},
        paragraph('截止时间'),{tag:'picker_datetime',name:'due_at',required:true,...(due?{initial_datetime:shanghai(due)}:{}),placeholder:plain('选择截止时间')},
        paragraph('提醒时间'),{tag:'picker_datetime',name:'remind_at',required:true,...(reminder&&Date.parse(reminder)>this.clock()?{initial_datetime:shanghai(reminder)}:{}),placeholder:plain('选择提醒时间')},
        {tag:'button',name:'submit_'+token,form_action_type:'submit',type:'primary',text:plain(editing?'保存修改':'确认属于我并设置提醒')}
      ]}
    ]);
  }
  async execute(user,payload){
    await this.service.allowedGroups(user);
    if(payload.action==='home')return this.home(user);
    if(payload.action==='summaries')return this.summaryCard(user,payload);
    if(payload.action==='tasks')return this.tasksCard(user,payload);
    if(payload.action==='source'){
      const summary=await this.service.requireSummary(user,payload.summaryId),size=1500,pages=Math.max(1,Math.ceil(summary.source.text.length/size)),page=Math.max(0,Math.min(Number.isSafeInteger(payload.page)?payload.page:0,pages-1));
      const ownTask=this.store.get('SELECT id FROM tasks WHERE owner_id=? AND summary_id=?',user.id,summary.id),past=expired(summary.dueAt,this.clock());
      return this.card(user,'核对原文',[paragraph(summary.groupName+' · '+shanghai(summary.source.sentAt)+'\n第'+(page+1)+'/'+pages+'页'),...(summary.dueAt?[paragraph((past?'已过截止：':'提取的截止：')+shanghai(summary.dueAt)+'（北京时间）')]:[]),...(summary.uncertainty?[paragraph('需核对：'+summary.uncertainty)]:[]),paragraph(summary.source.text.slice(page*size,(page+1)*size)),...(pages>1?[this.row([...(page>0?[this.button(user,'上一页原文',{action:'source',summaryId:summary.id,page:page-1})]:[]),...(page+1<pages?[this.button(user,'下一页原文',{action:'source',summaryId:summary.id,page:page+1})]:[])])]:[]),...(ownTask?[this.row([this.button(user,'查看我的待办',{action:'detail',taskId:ownTask.id})])]:summary.actionable&&!past?[this.row([this.button(user,'核对并添加待办',{action:'form',summaryId:summary.id},'primary')])]:past?[paragraph('这条通知已归入历史，不自动创建新待办；已有的逾期待办仍需单独处理。')]:[])]);
    }
    if(payload.action==='form'||payload.action==='edit')return this.formCard(user,payload);
    if(payload.action==='confirm'){
      const task=await this.service.createTask(user,{summaryId:payload.summaryId,...payload.input,confirmApplies:true});
      return this.taskCard(user,task,'已加入我的待办');
    }
    const task=await this.getTask(user,payload.taskId);
    if(payload.action==='detail')return this.taskCard(user,task);
    requireValue(['complete','snooze','reopen','save'].includes(payload.action),'不支持这项操作');
    if(task.version!==payload.version)return this.taskCard(user,task,'待办已更新','这张旧卡片对应的事项已发生变化。没有重复执行操作，请查看最新状态。');
    const updated=await this.service.mutateTask(user,task.id,payload.action==='save'?'edit':payload.action,payload.input||{},payload.version);
    return this.taskCard(user,updated,updated.status==='done'?'已完成':'待办已更新');
  }
  async tick(){
    if(this.busy)return;this.busy=true;
    try{
      for(let index=0;index<10;index++){
        const job=this.store.tx(()=>{const row=this.store.get("SELECT * FROM mobile_jobs WHERE (status IN ('ready','retry') AND next_at<=?) OR (status='processing' AND lease_until<=?) ORDER BY rowid LIMIT 1",this.clock(),this.clock());if(row)this.store.run("UPDATE mobile_jobs SET status='processing',lease_until=? WHERE id=?",this.clock()+30000,row.id);return row;});
        if(!job)break;
        try{
          const user=this.user(job.owner_id),payload=JSON.parse(job.payload);
          const cached=job.response?JSON.parse(job.response):null;
          let card=cached?.card,refreshExisting=!!cached?.refreshExisting,redacted=!!cached?.redacted,groups=[];
          try{groups=(await this.service.allowedGroups(user)).map(g=>g.id).sort();}catch(error){if(!(error instanceof PilotError&&error.status===403))throw error;}
          const groupKey=JSON.stringify(groups);
          if(cached&&cached.groupKey!==groupKey){
            card=this.card(user,'访问范围已变化',[paragraph('你的授权群范围发生了变化，旧内容已隐藏。请点击上方按钮重新查询。')]);refreshExisting=true;redacted=true;
          }else if(cached&&groups.length&&!redacted){
            // Read-only pages can be rebuilt. Mutations are never re-applied merely to refresh a failed delivery.
            try{
              if(['home','summaries','tasks','source','form','edit','detail'].includes(payload.action)){card=await this.execute(user,payload);refreshExisting=true;}
              else if(cached.taskId){const current=await this.getTask(user,cached.taskId);if(current.version!==cached.taskVersion){card=this.taskCard(user,current,'待办最新状态');refreshExisting=true;}}
            }catch(error){if(!(error instanceof PilotError)||error.status>=500)throw error;card=this.card(user,'操作未完成',[paragraph(error.message)]);refreshExisting=true;redacted=true;}
          }
          if(!card){
            try{card=await this.execute(user,payload);}catch(error){if(!(error instanceof PilotError)||error.status>=500)throw error;card=this.card(user,'操作未完成',[paragraph(error.message),paragraph('没有自动替你创建其他任务。请点击“消息中心”或“我的待办”重新查看。')]);}
          }
          if(!groups.length){card=this.card(user,'暂不可用',[paragraph('你目前不在已授权试用群中，无法访问归纳和待办。')]);refreshExisting=!!cached;redacted=true;}
          const taskRow=payload.taskId?this.store.get('SELECT id,payload FROM tasks WHERE id=? AND owner_id=?',payload.taskId,user.id):payload.summaryId?this.store.get('SELECT id,payload FROM tasks WHERE summary_id=? AND owner_id=?',payload.summaryId,user.id):null;
          this.store.run('UPDATE mobile_jobs SET response=? WHERE id=?',JSON.stringify({card,groupKey,refreshExisting,redacted,...(taskRow&&!redacted?{taskId:taskRow.id,taskVersion:JSON.parse(taskRow.payload).version}:{})}),job.id);
          let messageId=payload.messageId;
          if(messageId)await this.transport.updateCard(messageId,card);
          else {messageId=(await this.transport.sendCard(user.id,card,digest('mobile:'+job.id))).messageId;if(refreshExisting)await this.transport.updateCard(messageId,card);}
          this.bindCard(card,messageId);
          this.store.run("UPDATE mobile_jobs SET status='done',error=NULL WHERE id=?",job.id);
        }catch{
          const attempts=job.attempts+1;this.store.run('UPDATE mobile_jobs SET status=?,attempts=?,next_at=?,error=? WHERE id=?',attempts>=8?'failed':'retry',attempts,this.clock()+Math.min(300000,1000*2**attempts),'手机卡片处理或发送尚未成功，请检查网络与飞书配置',job.id);
        }
      }
    }finally{this.busy=false;}
  }
}
