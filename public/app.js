'use strict';
import {isHistory,isOverdue,updateNotice} from './reading-state.mjs';
const $ = id => document.getElementById(id);
const state = { me: null, csrf: '', status: null, data: null, view: 'summaries', group: '', category: 'all', taskFilter: 'open', timelineDate: '', editing: null, refreshing: false, polling: false, epoch:0, messageSequence:0, taskFocus: new URLSearchParams(location.search).get('task') };
const categories = { homework: '作业 / 任务', notice: '通知', activity: '活动', intern: '实习', chat: '闲聊' };
const reminderLabels = { pending: '等待发送', scheduled: '已安排', queued: '等待发送', sent: '已送达飞书', failed: '发送失败', retry: '等待重试', cancelled: '已取消', none: '未安排' };
const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
const done = task => ['done', 'completed'].includes(task.status);
const date = value => { const d = new Date(value); return value && !Number.isNaN(d.valueOf()) ? d : null; };
const format = value => date(value)?.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) || '未明确';
const inputDate = value => { const d = date(value); return d ? new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''; };
const categoryName = value => categories[value] || value || '未分类';
function feedback(message, error = false) { $('feedback').textContent = message; $('feedback').className = `feedback${error ? ' error' : ''}`; $('feedback').hidden = !message; }
function empty(target, title, message) { const n = el('div', 'empty'); n.append(el('strong', '', title), el('p', '', message)); target.replaceChildren(n); }
function button(label, action, style = 'secondary') { const b = el('button', `button ${style}`, label); b.type = 'button'; b.addEventListener('click', () => action(b)); return b; }
function clearPrivate() {
  state.epoch++; state.messageSequence++; state.data=null; state.group=''; $('new-updates').hidden=true;
  for(const id of ['group-list','messages','summaries','tasks'])$(id).replaceChildren();
  $('group-title').textContent='暂无访问权限';$('category-filters').replaceChildren();$('new-updates').textContent='';
  document.querySelectorAll('[data-task-filter]').forEach(b=>b.textContent=b.textContent.replace(/\s+\d+$/,' 0'));
  delete $('messages').dataset.group;
  for(const id of ['nav-groups','nav-summaries','nav-tasks'])$(id).textContent='0';
  if($('task-dialog').open)$('task-dialog').close();
  $('task-form').reset();
  clearTimeline();
}
function readingAnchor() {
  const nodes=[...document.querySelectorAll('#view-'+state.view+' article[data-key]')];
  const node=nodes.find(n=>n.getBoundingClientRect().bottom>15);
  return {key:node?.dataset.key,top:node?.getBoundingClientRect().top,y:scrollY};
}
function restoreAnchor(anchor) {
  const node=[...document.querySelectorAll('article[data-key]')].find(n=>n.dataset.key===anchor.key);
  if(node)scrollBy(0,node.getBoundingClientRect().top-anchor.top);else scrollTo(0,anchor.y);
}
// Keep unchanged cards in place, including expanded details and unsaved inputs.
function reconcile(list,items,build,prefix) {
  const old=new Map([...list.children].map(n=>[n.dataset.key,n]));let cursor=list.firstChild;
  for(const item of items){
    const key=prefix+item.id,signature=JSON.stringify([item,state.status?.mode]);let node=old.get(key);
    if(!node||node.dataset.signature!==signature){
      const replacement=build(item);replacement.dataset.key=key;replacement.dataset.signature=signature;
      if(node){const expanded=[...node.querySelectorAll('details')].map(d=>d.open);replacement.querySelectorAll('details').forEach((d,i)=>d.open=!!expanded[i]);
        if(node.querySelector('details.correction[open]')){const inputs=[...node.querySelectorAll('.correction input,.correction select')];replacement.querySelectorAll('.correction input,.correction select').forEach((input,i)=>{if(inputs[i]){input.value=inputs[i].value;input.checked=inputs[i].checked;}});}
        if(cursor===node)cursor=replacement;node.replaceWith(replacement);
      }node=replacement;
    }
    if(node!==cursor)list.insertBefore(node,cursor);cursor=node.nextSibling;old.delete(key);
  }
  for(const node of old.values())node.remove();
}
async function api(path, method = 'GET', body) {
  const epoch=state.epoch;
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
  const options = { method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' } };
  if (method !== 'GET') { options.headers['Content-Type'] = 'application/json'; options.headers['x-csrf-token'] = state.csrf; options.body = JSON.stringify(body || {}); }
  let response;
  try { response = await fetch(path, options); } catch { throw new Error(controller.signal.aborted ? '服务响应超时，请稍后刷新重试。' : '无法连接拾信后台。请确认电脑和启动窗口仍在运行，并处于同一网络。'); }
  finally { clearTimeout(timeout); }
  const data = await response.json().catch(() => ({}));
  if(epoch!==state.epoch){const error=new Error('忽略已失效的请求');error.stale=true;throw error;}
  if (!response.ok) {
    if (response.status === 401) { clearPrivate(); state.me = { ...state.me, user: null }; renderSession(); }
    if (response.status === 403 && (path === '/api/dashboard' || path==='/api/updates' || path.startsWith('/api/groups/'))) { clearPrivate(); $('group-title').textContent = '暂无访问权限'; }
    const error = new Error(data.error?.message || `请求失败（${response.status}）`); error.status = response.status; throw error;
  }
  return data;
}
function renderStatus() {
  const s = state.status;
  $('connection').className = 'connection';
  let label = '服务状态暂不可用';
  if (s?.mode === 'local') { label = '本地联调 · 未连接飞书'; $('connection').classList.add('warning'); }
  else if (s?.connected) label = '飞书已连接';
  else if (s?.configured) { label = '已配置 · 飞书连接未建立'; $('connection').classList.add('warning'); }
  else if (s) { label = '飞书尚未配置'; $('connection').classList.add('warning'); }
  else $('connection').classList.add('unknown');
  $('connection-title').textContent = label;
  $('extractor').textContent = s?.extractor ? `归纳：${s.extractor === 'rules' ? '规则提取' : s.extractor}` : '';
  const notes = Array.isArray(s?.notes) ? s.notes.join('\n') : s?.notes || '';
  $('status-notes').textContent = notes; $('status-details').hidden = !notes;
  $('task-intro').textContent = s?.mode === 'local' ? '这里只显示你的个人待办。本地联调仅记录提醒结果，不会向飞书发送。' : '这里只显示你的个人待办。提醒将通过飞书私聊送达。';
}
function renderSession() {
  const signedIn = !!state.me?.user;
  $('user-name').textContent = state.me?.user?.name || '';
  $('logout').hidden = !signedIn; $('workspace').hidden = !signedIn; $('login-panel').hidden = signedIn;
  $('local-login').hidden = !state.me?.localDemoAvailable;
  $('feishu-login').hidden = !!state.me?.localDemoAvailable;
  $('demo-injection').hidden = !state.me?.localDemoAvailable || !signedIn;
  if (!signedIn) { $('group-list').replaceChildren(); $('messages').replaceChildren(); $('summaries').replaceChildren(); $('tasks').replaceChildren(); clearTimeline(); if ($('task-dialog').open) $('task-dialog').close(); }
}
function showView(view) {
  state.view = view;
  for (const name of ['groups', 'summaries', 'tasks', 'timeline']) $('view-' + name).hidden = name !== view;
  document.querySelectorAll('[data-view]').forEach(b => { if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  $('page-title').textContent = { groups: '群消息', summaries: '消息中心', tasks: '我的待办', timeline: '时间轴' }[view];
  if(view==='timeline'&&state.data)renderTimeline();
}
async function refresh() {
  if (state.refreshing || $('task-dialog').open) return;
  const epoch=state.epoch,anchor=readingAnchor();state.refreshing = true; $('refresh').disabled = true; $('refresh').setAttribute('aria-busy', 'true');
  try {
    const results = await Promise.allSettled([api('/api/status'), api('/api/me')]);
    if (results[0].status === 'fulfilled') state.status = results[0].value;
    else { state.status = null; feedback(results[0].reason.message, true); }
    renderStatus();
    if (results[1].status === 'rejected') throw results[1].reason;
    state.me = results[1].value; state.csrf = state.me.csrfToken || ''; renderSession();
    if (!state.me.user) return;
    const dashboard = await api('/api/dashboard');if(epoch!==state.epoch)return;state.data = dashboard;
    if (dashboard.status) { state.status = dashboard.status; renderStatus(); }
    renderDashboard(); await loadMessages();
    if(epoch!==state.epoch)return;
    $('new-updates').hidden=true;restoreAnchor(anchor);
    $('updated').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  } catch (error) { if(!error.stale)feedback(`${error.message}${state.data ? ' 当前保留上次读取的内容。' : ''}`, true); }
  finally { state.refreshing = false; $('refresh').disabled = false; $('refresh').removeAttribute('aria-busy'); }
}
function renderDashboard() {
  const { groups = [], summaries = [], tasks = [] } = state.data;
  $('nav-groups').textContent = groups.length; $('nav-summaries').textContent = summaries.filter(s=>!isHistory(s)).length; $('nav-tasks').textContent = tasks.filter(t => !done(t)).length;
  if (!groups.some(g => g.id === state.group)) state.group = groups[0]?.id || '';
  const list = $('group-list'); list.replaceChildren();
  for (const group of groups) {
    const b = el('button', `group-button${group.id === state.group ? ' active' : ''}`); b.type = 'button'; b.setAttribute('aria-pressed', String(group.id === state.group));
    const info = el('span'); info.append(el('strong', '', group.name), el('small', '', `${group.messageCount || 0} 条消息`));
    b.append(el('span', 'group-initial', Array.from(group.name || '群')[0]), info);
    b.addEventListener('click', async () => { state.group = group.id; renderDashboard(); await loadMessages(); }); list.append(b);
  }
  $('group-title').textContent = groups.find(g => g.id === state.group)?.name || '暂无可访问的群聊';
  $('demo-form').querySelector('button').disabled = !state.group;
  const filters = $('category-filters'); filters.replaceChildren();
  const scoped=summaries.filter(s=>$('summary-scope').value==='all'||($('summary-scope').value==='history'?isHistory(s):!isHistory(s)));
  const values = [...new Set(scoped.map(s => s.category).filter(Boolean))];
  if (state.category !== 'all' && !values.includes(state.category)) state.category = 'all';
  for (const value of ['all', ...values]) {
    const count = value === 'all' ? scoped.length : scoped.filter(s => s.category === value).length;
    const b = el('button', '', `${value === 'all' ? '全部' : categoryName(value)} ${count}`); b.type = 'button'; b.setAttribute('aria-pressed', String(state.category === value));
    b.addEventListener('click', () => { state.category = value; renderDashboard(); }); filters.append(b);
  }
  renderSummaries(); renderTasks(); renderTimeline();
}
async function loadMessages() {
  const groupId = state.group,sequence=++state.messageSequence,epoch=state.epoch;
  if (!groupId) { empty($('messages'), '还没有可查看的群消息', '需要配置授权群，并验证你的群成员身份。'); return; }
  if($('messages').dataset.group!==groupId){empty($('messages'), '正在读取群消息…', '仅显示本服务收到并保存的文字消息。');$('messages').dataset.group=groupId;}
  try {
    const { messages = [] } = await api(`/api/groups/${encodeURIComponent(groupId)}/messages`);
    if (groupId !== state.group||sequence!==state.messageSequence||epoch!==state.epoch) return;
    const list = $('messages');
    if (!messages.length) { empty(list, '这个群暂时没有消息', state.status?.mode === 'local' ? '可以展开下方本地联调入口，手动注入一条测试文字。' : '请在飞书群里正常发送文字，收到授权事件后会出现在这里。'); return; }
    reconcile(list,messages,message=>{
      const card = el('article', 'message'), meta = el('div', 'message-meta');
      meta.append(el('strong', '', message.senderName || '群成员'), el('span', '', format(message.sentAt)));
      card.append(meta, el('p', 'message-text', message.text));return card;
    },'message:');
  } catch (error) { if (!error.stale&&groupId === state.group&&sequence===state.messageSequence&&epoch===state.epoch) { empty($('messages'), '暂时无法读取这个群', error.message); } }
}
function sourceDetails(summary) {
  const details = el('details', 'source'); details.append(el('summary', '', '核对消息原文'));
  const source = summary.source;
  if (!source) { details.append(el('p', 'small', '原文暂不可用，请在飞书中核对。')); return details; }
  details.append(el('p', 'small', `${summary.groupName || '来源群聊'} · ${format(source.sentAt)}`), el('p', 'source-text', source.text || '原文为空'));
  if (source.url) { try { const url = new URL(source.url); if (['http:', 'https:', 'feishu:', 'lark:'].includes(url.protocol)) { const a = el('a', '', '在飞书查看来源 ↗'); a.href = url.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; details.append(a); } } catch {} }
  return details;
}
function renderSummaries() {
  const mode = $('action-filter').value,scope=$('summary-scope').value;
  const summaries = (state.data?.summaries || []).filter(s => (scope==='all'||(scope==='history'?isHistory(s):!isHistory(s)))&&(state.category === 'all' || s.category === state.category) && (mode === 'all' || (mode === 'actionable' ? s.actionable && !s.taskId : !s.actionable || s.uncertainty)));
  const list = $('summaries');
  if (!summaries.length) { empty(list, '这里暂时没有摘要', state.data?.summaries?.length ? '试试其他分类或处理状态。' : '收到授权群文字消息后，会在这里提取线索；不会自动创建待办。'); return; }
  reconcile(list,summaries,summary=>{
    const card=el('article','card compact-card'),details=el('details','summary-details'),head=el('summary','summary-head');
    const top=el('div','card-top');top.append(el('span','tag',categoryName(summary.category)),el('span','card-group',summary.groupName));
    head.append(top,el('h3','compact-title',summary.title||summary.text),el('span','compact-meta',`${summary.dueAt?'截止 '+format(summary.dueAt):'时间待核对'} · ${summary.taskId?'已确认':isHistory(summary)?'历史消息':summary.actionable?'待你确认':'仅供参考'}`),el('span','expand-hint','展开核对 ›'));
    details.append(head,el('p','card-text',summary.text||summary.title));
    if(summary.uncertainty)details.append(el('p','caution',`需核对：${Array.isArray(summary.uncertainty)?summary.uncertainty.join('；'):summary.uncertainty}`));
    const actions = el('div', 'actions');
    if (summary.taskId) actions.append(button('已确认 · 查看我的待办', () => { state.taskFilter = 'all'; renderTasks(); showView('tasks'); }));
    else if (summary.actionable) actions.append(button(summary.dueAt&&Date.parse(summary.dueAt)<=Date.now()?'调整时间后添加待办':'确认为我的待办', () => openTask(summary), 'primary'));
    else actions.append(el('span', 'small', '确认有具体行动后，可在下方修正个人分类。'));
    details.append(actions,sourceDetails(summary),correctionDetails(summary));card.append(details);return card;
  },'summary:');
}
function correctionDetails(summary) {
  const details = el('details', 'correction'); details.append(el('summary', '', '修正我的分类'));
  const form = el('form'), label = el('label', '', '分类'), select = el('select'); select.setAttribute('aria-label', '修正摘要分类');
  for (const value of [...new Set([...Object.keys(categories), summary.category].filter(Boolean))]) { const option = el('option', '', categoryName(value)); option.value = value; option.selected = value === summary.category; select.append(option); }
  label.append(select); const checkLabel = el('label', 'checkbox-row'), check = el('input'); check.type = 'checkbox'; check.checked = !!summary.actionable; checkLabel.append(check, el('span', '', '这条消息包含可执行的任务'));
  const submit = el('button', 'button secondary', '保存个人修正'); submit.type = 'submit'; form.append(label, checkLabel, el('p', 'small', '只影响你自己的消息中心。'), submit);
  form.addEventListener('submit', e => { e.preventDefault(); mutate(submit, `/api/summaries/${encodeURIComponent(summary.id)}/correction`, 'POST', { category: select.value, actionable: check.checked }, '个人分类已更新。'); }); details.append(form); return details;
}
function renderTasks() {
  const all=state.data?.tasks||[],labels={open:'待完成',overdue:'逾期',done:'已完成',all:'全部'};
  const matches=(t,filter)=>filter==='all'||(filter==='done'?done(t):filter==='overdue'?isOverdue(t):!done(t)&&!isOverdue(t));
  document.querySelectorAll('[data-task-filter]').forEach(b => {b.setAttribute('aria-pressed', String(b.dataset.taskFilter === state.taskFilter));b.textContent=labels[b.dataset.taskFilter]+' '+all.filter(t=>matches(t,b.dataset.taskFilter)).length;});
  const tasks = all.filter(t =>matches(t,state.taskFilter));
  const list = $('tasks');
  if (!tasks.length) { empty(list, state.taskFilter === 'done' ? '还没有已完成的待办' : '暂时没有待办', '在消息中心核对原文，再把需要自己完成的事确认到这里。'); return; }
  reconcile(list,tasks,task=>{
    const card = el('article', 'card compact-card'), top = el('div', 'card-top'); top.append(el('span', 'tag', done(task) ? '已完成' : isOverdue(task) ? '已逾期' : '待完成'), el('span', 'card-group', task.sourceGroup || '群消息'));
    card.append(top, el('h3', `task-title${done(task) ? ' done' : ''}`, task.title));
    const meta = el('div', 'card-meta'); meta.append(el('span', '', `截止 ${format(task.dueAt)}`));card.append(meta);
    const details=taskSettings(task);
    if (task.lastError) card.append(el('p', 'task-error', `提醒异常：${task.lastError}`));
    const actions = el('div', 'actions'), path = `/api/tasks/${encodeURIComponent(task.id)}`;
    actions.append(button(done(task) ? '重新打开' : '标记完成', b => mutate(b, `${path}/${done(task) ? 'reopen' : 'complete'}`, 'POST', {}, done(task) ? '待办已重新打开，请检查提醒时间。' : '已完成，未发出的提醒已取消。'), 'primary'));
    card.append(actions,details);return card;
  },'task:');
  if(state.taskFocus){const node=[...list.children].find(n=>n.dataset.key==='task:'+state.taskFocus);if(node){state.taskFocus=null;node.tabIndex=-1;requestAnimationFrame(()=>{node.focus({preventScroll:true});node.scrollIntoView({block:'center'});});}}
}
function taskSettings(task) {
  const details=el('details','task-details');details.append(el('summary','','提醒与时间设置'));
  const reminderState=reminderLabels[task.reminderStatus]||task.reminderStatus||'未安排';
  details.append(el('p','small',`提醒 ${format(task.remindAt)} · ${state.status?.mode==='local'&&task.reminderStatus==='sent'?'本地模拟发送':reminderState}`));
  if(!done(task)){
    const settings=el('div','actions'),path=`/api/tasks/${encodeURIComponent(task.id)}`;
    if(Date.parse(task.dueAt)>Date.now()+600000)settings.append(button('10 分钟后提醒',b=>mutate(b,`${path}/snooze`,'POST',{minutes:10},'已延后提醒。')));
    settings.append(button('修改时间',()=>openTask(task,true)));details.append(settings);
  }
  return details;
}
// Dates use the same local timezone as the task editor. Noon avoids DST edges
// when moving whole calendar days, and deadlines remain points, not durations.
function localDay(value) {
  const d=date(value);return d?`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`:'';
}
function shiftDay(key,amount) {
  const d=new Date(key+'T12:00:00');d.setDate(d.getDate()+amount);return localDay(d);
}
function clearTimeline() {
  for(const id of ['timeline-items','timeline-completed','timeline-undated','timeline-week'])$(id).replaceChildren();
  for(const id of ['timeline-completed-section','timeline-undated-section','timeline-overdue'])$(id).hidden=true;
  $('timeline-count').textContent='';$('timeline-overdue').textContent='';$('timeline-progress').value=0;
  $('timeline-completed-label').textContent='已完成';$('timeline-undated-label').textContent='待定日期';
}
const timelineKinds={homework:['coral','任务'],notice:['blue','通知'],activity:['purple','活动'],intern:['gold','实习'],chat:['green','其他']};
function timelineKind(task){return timelineKinds[task.timelineCategory]||['green','待办'];}
function timelineIcon(category) {
  const paths={homework:'M5 4h10l4 4v12H5z M14 4v5h5 M8 13h8 M8 16h5',notice:'M6 16h12l-2-3V9a4 4 0 0 0-8 0v4z M10 20h4',activity:'m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z',intern:'M4 8h16v12H4z M8 8V4h8v4 M4 13h16 M10 12v3h4v-3',chat:'M4 5h16v12H9l-5 4z M8 9h8 M8 13h5'};
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
  const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',paths[category]||'M8 3h8v3H8z M8 5H5v16h14V5h-3 M8 13l3 3 5-6');svg.append(path);return svg;
}
function timelineRow(task) {
  const [color,category]=timelineKind(task),isDone=done(task),d=date(task.dueAt);
  const card=el('article',`timeline-entry tone-${color}${isDone?' is-done':''}`),stamp=el('div','timeline-stamp');
  stamp.append(el('time','',d?d.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}):'待定'),el('span','','截止'));
  if(d)stamp.querySelector('time').dateTime=d.toISOString();
  const node=el('div','timeline-node');node.append(timelineIcon(task.timelineCategory));
  const content=el('div','timeline-content'),details=el('details','timeline-details'),head=el('summary','timeline-row-head');
  head.append(el('h3','',task.title),el('span','timeline-row-meta',`${category} · ${task.sourceGroup||'群消息'}`));
  if(task.timelineOverdue&&!isDone)head.append(el('span','timeline-late','已逾期'));
  const settings=taskSettings(task);settings.querySelector('summary').remove();
  details.append(head,el('p','small',`截止 ${format(task.dueAt)}`),...settings.childNodes);
  if(task.lastError)details.append(el('p','task-error',`提醒异常：${task.lastError}`));
  content.append(details);
  const toggle=button(isDone?'✓':'',b=>mutate(b,`/api/tasks/${encodeURIComponent(task.id)}/${isDone?'reopen':'complete'}`,'POST',{},isDone?'待办已重新打开，请检查提醒时间。':'已完成，未发出的提醒已取消。'),'timeline-toggle');
  toggle.setAttribute('aria-label',`${isDone?'重新打开':'标记完成'}：${task.title}`);toggle.title=isDone?'重新打开':'标记完成';
  card.append(stamp,node,content,toggle);return card;
}
function renderTimeline() {
  if(!state.data)return;
  const today=localDay(new Date());state.timelineDate||=today;
  const selected=state.timelineDate,d=new Date(selected+'T12:00:00');
  const summaryById=new Map((state.data.summaries||[]).map(s=>[s.id,s]));
  const tasks=(state.data.tasks||[]).map(t=>({...t,timelineCategory:summaryById.get(t.summaryId)?.category||t.category||'',timelineOverdue:isOverdue(t)}));
  $('timeline-date').value=selected;
  $('timeline-month').textContent=d.toLocaleDateString('zh-CN',{year:'numeric',month:'long'});
  const week=$('timeline-week'),start=shiftDay(selected,-((d.getDay()+6)%7));week.replaceChildren();
  for(let i=0;i<7;i++){
    const key=shiftDay(start,i),day=new Date(key+'T12:00:00'),items=tasks.filter(t=>localDay(t.dueAt)===key);
    const b=el('button',`timeline-day${key===today?' is-today':''}`);b.type='button';b.dataset.timelineDate=key;b.setAttribute('aria-pressed',String(key===selected));
    b.setAttribute('aria-label',`${day.getMonth()+1}月${day.getDate()}日，${items.length}项待办`);
    b.append(el('span','timeline-weekday',['一','二','三','四','五','六','日'][i]),el('strong','timeline-day-number',String(day.getDate())));
    const dots=el('span','timeline-day-dots');dots.setAttribute('aria-hidden','true');
    for(const task of items.slice(0,3))dots.append(el('i',`tone-${timelineKind(task)[0]}`));
    b.append(dots);b.addEventListener('click',()=>{state.timelineDate=key;renderTimeline();});week.append(b);
  }
  const daily=tasks.filter(t=>localDay(t.dueAt)===selected).sort((a,b)=>Date.parse(a.dueAt)-Date.parse(b.dueAt)||String(a.id).localeCompare(String(b.id)));
  const pending=daily.filter(t=>!done(t)),completed=daily.filter(done),undated=tasks.filter(t=>!localDay(t.dueAt));
  $('timeline-day-title').textContent=selected===today?'今天的待办':`${d.getMonth()+1}月${d.getDate()}日的待办`;
  $('timeline-count').textContent=daily.length?`${pending.length} 项待完成 · ${completed.length} 项已完成`:'给这一天留一点从容';
  $('timeline-progress').max=daily.length||1;$('timeline-progress').value=completed.length;
  const overdue=tasks.filter(t=>t.timelineOverdue).length;
  $('timeline-overdue').hidden=!overdue;$('timeline-overdue').textContent=`${overdue} 项逾期待处理 · 前往查看 ›`;
  if(pending.length)reconcile($('timeline-items'),pending,timelineRow,'timeline:');
  else empty($('timeline-items'),completed.length?'这一天的待办都完成了':'这一天暂无待办',completed.length?'完成记录已收好，可在下方展开查看。':'在消息中心确认待办后，会按截止日期出现在这里。');
  for(const [name,items,label] of [['completed',completed,'已完成'],['undated',undated,'待定日期']]){
    $(`timeline-${name}-section`).hidden=!items.length;$(`timeline-${name}-label`).textContent=`${label} · ${items.length}`;
    reconcile($(`timeline-${name}`),items,timelineRow,'timeline:');
  }
}
$('timeline-date').addEventListener('change',()=>{if($('timeline-date').value)state.timelineDate=$('timeline-date').value;renderTimeline();});
$('timeline-today').addEventListener('click',()=>{state.timelineDate=localDay(new Date());renderTimeline();});
for(const [id,amount] of [['timeline-prev-week',-7],['timeline-next-week',7]])$(id).addEventListener('click',()=>{state.timelineDate=shiftDay(state.timelineDate,amount);renderTimeline();});
$('timeline-overdue').addEventListener('click',()=>{state.taskFilter='overdue';renderTasks();showView('tasks');});
async function mutate(trigger, path, method, body, message) {
  trigger.disabled = true;
  try { await api(path, method, body); feedback(message); await refresh(); }
  catch (error) { if(!error.stale)feedback(error.message, true); }
  finally { trigger.disabled = false; }
}
function openTask(item, editing = false) {
  state.editing = { item, editing };
  const due = date(item.dueAt), suggestedDue = due && due > new Date() ? due : null;
  const reminder = editing ? date(item.remindAt) : suggestedDue ? new Date(Math.max(Date.now() + 60000, suggestedDue - 30 * 60000)) : null;
  $('dialog-title').textContent = editing ? '修改待办与提醒' : '确认为我的待办';
  $('dialog-context').textContent = editing ? '修改后，未发出的提醒将按新时间安排。' : '仅创建给自己的待办。请核对原文并确认时间。';
  $('task-title').value = item.title || item.text || ''; $('task-due').value = inputDate(suggestedDue); $('task-reminder').value = inputDate(reminder);
  const min = inputDate(new Date(Date.now() + 60000)); $('task-due').min = min; $('task-reminder').min = min;
  $('audience-row').hidden = editing || !item.audienceHint; $('confirm-applies').checked = false; $('confirm-applies').required = !editing && !!item.audienceHint;
  $('audience-label').textContent = `我已核对原文，确认适用对象包含我。${item.audienceHint ? `（${item.audienceHint}）` : ''}`;
  $('form-error').hidden = true; $('save-task').textContent = editing ? '保存修改' : '确认并设置提醒'; $('refresh').disabled = true;
  $('task-dialog').showModal(); $('task-title').focus();
}
$('task-form').addEventListener('submit', async e => {
  e.preventDefault(); const due = date($('task-due').value), reminder = date($('task-reminder').value), title = $('task-title').value.trim();
  if (!title || !due || !reminder || due <= new Date() || reminder <= new Date() || reminder >= due) { $('form-error').textContent = '请填写标题，并设置未来时间；提醒必须早于截止。'; $('form-error').hidden = false; return; }
  const { item, editing } = state.editing, body = { title, dueAt: due.toISOString(), remindAt: reminder.toISOString() };
  if (!editing) Object.assign(body, { summaryId: item.id, confirmApplies: $('confirm-applies').checked });
  $('save-task').disabled = true; $('task-form').setAttribute('aria-busy', 'true');
  try { await api(editing ? `/api/tasks/${encodeURIComponent(item.id)}` : '/api/tasks', editing ? 'PATCH' : 'POST', body); $('task-dialog').close(); feedback(editing ? '待办与提醒已更新。' : '已确认为你的个人待办。'); await refresh(); }
  catch (error) { $('form-error').textContent = error.message; $('form-error').hidden = false; }
  finally { $('save-task').disabled = false; $('task-form').removeAttribute('aria-busy'); }
});
$('task-dialog').addEventListener('close', () => { state.editing = null; $('refresh').disabled = false; });
$('close-dialog').addEventListener('click', () => $('task-dialog').close()); $('cancel-dialog').addEventListener('click', () => $('task-dialog').close());
$('refresh').addEventListener('click', () => { feedback(''); refresh(); });
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
document.querySelectorAll('[data-task-filter]').forEach(b => b.addEventListener('click', () => { state.taskFilter = b.dataset.taskFilter; renderTasks(); }));
$('action-filter').addEventListener('change', renderSummaries);
$('summary-scope').addEventListener('change',()=>{state.category='all';renderDashboard();});
document.querySelectorAll('[data-demo-user]').forEach(b => b.addEventListener('click', () => mutate(b, '/api/demo/login', 'POST', { userId: b.dataset.demoUser }, '已登录本地联调身份。')));
$('logout').addEventListener('click', async()=>{
  state.epoch++;const trigger=$('logout');trigger.disabled=true;
  try{await api('/api/logout','POST',{});clearPrivate();state.me={...state.me,user:null};state.csrf='';renderSession();feedback('已退出登录。');}
  catch(error){if(!error.stale)feedback(error.message,true);}finally{trigger.disabled=false;}
});
$('demo-form').addEventListener('submit', async e => {
  e.preventDefault(); const text = $('demo-text').value.trim(); if (!text || !state.group) return;
  const b = e.currentTarget.querySelector('button'); b.disabled = true;
  try { await api('/api/demo/messages', 'POST', { groupId: state.group, text }); $('demo-text').value = ''; feedback('本地消息已接收。若归纳尚未出现，请稍后刷新。'); await refresh(); }
  catch (error) { feedback(error.message, true); } finally { b.disabled = false; }
});
if (state.taskFocus) state.taskFilter = 'all';
async function pollUpdates(){
  if(!state.me?.user||!state.data||state.refreshing||state.polling||document.hidden)return;
  const epoch=state.epoch;state.polling=true;
  try{
    const update=await api('/api/updates');if(epoch!==state.epoch||!state.data)return;
    if(update.accessRevision&&state.data.accessRevision&&update.accessRevision!==state.data.accessRevision){clearPrivate();feedback('群访问范围已变化，请刷新后重新核验。',true);return;}
    if(update.status&&!$('task-dialog').open){state.status=update.status;renderStatus();}
    const notice=updateNotice(state.data,update);$('new-updates').textContent=notice;$('new-updates').hidden=!notice;
  }catch(error){if(!error.stale)feedback(error.message,true);}finally{state.polling=false;}
}
$('new-updates').addEventListener('click',()=>refresh());
setInterval(pollUpdates,12000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)pollUpdates();});
showView(state.taskFocus ? 'tasks' : 'summaries'); refresh();
