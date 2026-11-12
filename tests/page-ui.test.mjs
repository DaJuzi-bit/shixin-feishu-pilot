import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {existsSync} from 'node:fs';

// Exercise the shipped browser code against an isolated HTTP boundary. No app
// server, database, SDK, credentials, or external service is loaded by this file.
const require = createRequire(import.meta.url);
let playwright;try{playwright=require('playwright');}catch{try{playwright=createRequire(join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json'))('playwright');}catch{}}
const chromium=playwright?.chromium;
const edge=process.env.PILOT_BROWSER||join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe');
const uiTest=(name,fn)=>test(name,{skip:!chromium||!existsSync(edge)?'Browser QA requires Playwright and Edge (or PILOT_BROWSER).':false},fn);
const NOW = Date.parse('2026-10-29T04:00:00Z');
const future = '2026-11-01T09:00:00.000Z';
const past = '2026-10-28T09:00:00.000Z';
const sourceText = '请逐项核对适用对象、提交地点和附件要求。'.repeat(50) + '最后仅限实验一组。';
const status = { mode: 'feishu', configured: true, connected: true, extractor: 'rules', notes: [] };
const user = { id: 'alice', name: 'Alice', tenantId: 'team' };

function summary(id, overrides = {}) {
  return {
    id, groupId: 'g1', groupName: '课程群 A', category: 'homework',
    title: `待核对的事项 ${id}`, text: `待核对的事项 ${id}`, actionable: true,
    dueAt: future, taskId: null, taskStatus: null, uncertainty: [], audienceHint: '实验一组',
    source: { messageId: `m-${id}`, senderId: 'teacher', text: sourceText, sentAt: new Date(NOW - 3600000).toISOString(), url: null },
    ...overrides,
  };
}

function board() {
  return {
    user, revision: 'r1', messageCount: 24, status,
    groups: [{ id: 'g1', name: '课程群 A', messageCount: 20 }, { id: 'g2', name: '课程群 B', messageCount: 4 }],
    summaries: [
      ...Array.from({ length: 12 }, (_, i) => summary(`s${i + 1}`)),
      summary('expired', { text: '已经过期的实验通知', dueAt: past }),
      summary('boundary', { text: '恰好截止的实验通知', dueAt: new Date(NOW).toISOString() }),
      summary('confirmed', { text: '已确认给自己的事项', taskId: 't-future', taskStatus: 'pending' }),
      summary('old', { text: '八天前的无期限旧通知', dueAt: null, actionable: false, source: { text: '旧通知原文', sentAt: new Date(NOW - 8 * 86400000).toISOString() } }),
    ],
    tasks: [
      { id: 't-future', summaryId: 'confirmed', title: '将来截止的个人任务', status: 'pending', sourceGroup: '课程群 A', dueAt: future, remindAt: '2026-11-01T08:00:00.000Z', reminderStatus: 'scheduled', completedAt: null, version: 1 },
      { id: 't-late', summaryId: 'expired', title: '逾期但仍未完成的个人任务', status: 'pending', sourceGroup: '课程群 A', dueAt: past, remindAt: '2026-10-28T08:00:00.000Z', reminderStatus: 'sent', completedAt: null, version: 1 },
      { id: 't-done', summaryId: 'done-source', title: '已经完成的个人任务', status: 'done', sourceGroup: '课程群 B', dueAt: past, remindAt: null, reminderStatus: 'cancelled', completedAt: past, version: 2 },
    ],
    counts: { summaries: 16, pending: 2, done: 1 },
  };
}

function json(res, code, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function start(t, options = {}) {
  const model = { board: board(), loggedIn: true, holdUpdates: false, holdMessages: false, updates: [], messages: [], posts: [], ...options };
  const files = new Map([
    ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
    ['/app.js', ['app.js', 'text/javascript']], ['/reading-state.mjs', ['reading-state.mjs', 'text/javascript']],
    ['/styles.css', ['styles.css', 'text/css']],
  ]);
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && files.has(path)) {
        const [name, type] = files.get(path);
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
        res.end(await readFile(new URL(`../public/${name}`, import.meta.url)));
      } else if (path === '/api/status') json(res, 200, status);
      else if (path === '/api/me') json(res, 200, { user: model.loggedIn ? user : null, csrfToken: 'test-csrf', localDemoAvailable: false });
      else if (path === '/api/dashboard') {
        if (model.denyDashboard) json(res, 403, { error: { message: '群成员授权已撤销' } });
        else json(res, 200, model.board);
      } else if (path === '/api/updates') {
        const value = { revision: model.board.revision, messageCount: model.board.messageCount, status };
        const pending = { res, value, release: (code = 200, payload = value) => json(res, code, payload) };
        model.updates.push(pending);
        if (!model.holdUpdates) pending.release();
      } else if (/^\/api\/groups\/(g1|g2)\/messages$/.test(path)) {
        const groupId = path.split('/')[3];
        const value = { messages: [{ id: `m-${groupId}`, groupId, senderName: '老师', text: `群 ${groupId} 的最新文字`, sentAt: new Date(NOW).toISOString(), summaryId: null }] };
        const pending = { groupId, res, release: (payload = value) => json(res, 200, payload) };
        model.messages.push(pending);
        if (!model.holdMessages) pending.release();
      } else if (req.method === 'POST' || req.method === 'PATCH') {
        let body = '';
        for await (const chunk of req) body += chunk;
        model.posts.push({ path, body: body ? JSON.parse(body) : {} });
        if (path === '/api/logout') model.loggedIn = false;
        const match=path.match(/^\/api\/tasks\/([^/]+)(?:\/(complete|reopen))?$/);
        if(match){
          const task=model.board.tasks.find(task=>task.id===match[1]);
          if(task){
            if(match[2])Object.assign(task,{status:match[2]==='complete'?'done':'pending',version:task.version+1});
            else if(req.method==='PATCH')Object.assign(task,JSON.parse(body),{version:task.version+1});
            model.board.revision+='-task';
          }
        }
        json(res, 200, { ok: true });
      } else json(res, 404, { error: { message: 'Unmocked test request' } });
    } catch (error) { json(res, 500, { error: { message: error.message } }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: edge, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 780 }, isMobile: true, deviceScaleFactor: 1, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  page.setDefaultTimeout(4000);
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.clock.install({ time: new Date(NOW) });
  await page.goto(origin);
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#summaries article'));
  if(!options.holdMessages)await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);
  return { page, model };
}

const card = (page, id = 's1') => page.locator(`article[data-key="summary:${id}"]`);
async function waitText(page, selector, text) {
  await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text });
}
async function tickPoll(page) {
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/updates');
  await page.clock.runFor(12001);
  return response;
}
async function noHorizontalOverflow(page) {
  const size = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(size.document <= size.viewport + 1 && size.body <= size.viewport + 1, `horizontal overflow: ${JSON.stringify(size)}`);
}

uiTest('mobile inbox starts compact and long source text never creates horizontal scrolling', async t => {
  const { page } = await start(t);
  assert.equal(await page.locator('[data-view="summaries"]').getAttribute('aria-current'), 'page');
  assert.equal(await page.locator('#new-updates').isVisible(), false);
  assert.equal(await card(page).locator('details.summary-details').evaluate(node => node.open), false);
  assert.ok(await card(page).boundingBox().then(rect => rect.height < 210), 'a collapsed summary should fit several entries on a mobile screen');
  if(process.env.PILOT_SCREENSHOT)await page.screenshot({path:process.env.PILOT_SCREENSHOT});
  await noHorizontalOverflow(page);
  await card(page).locator('details.summary-details > summary').click();
  await card(page).locator('details.source > summary').click();
  assert.match(await card(page).textContent(), /最后仅限实验一组/);
  await noHorizontalOverflow(page);
  await page.setViewportSize({ width: 375, height: 740 });
  await noHorizontalOverflow(page);
  await page.evaluate(()=>document.querySelector('#user-name').textContent='很长的成员姓名'.repeat(8));
  await page.setViewportSize({width:320,height:640});await noHorizontalOverflow(page);
  await page.setViewportSize({width:1280,height:900});await noHorizontalOverflow(page);
});

uiTest('history hides expired or confirmed summaries without deleting them, and overdue tasks stay pending in their own filter', async t => {
  const { page, model } = await start(t);
  await page.locator('[data-view="summaries"]').click();
  assert.equal(await page.locator('#summary-scope').inputValue(), 'current');
  assert.equal(await page.locator('#summaries article').count(), 12);
  assert.doesNotMatch(await page.locator('#summaries').textContent(), /已经过期|恰好截止|已确认给自己|八天前/);
  await page.locator('#summary-scope').selectOption('history');
  assert.equal(await page.locator('#summaries article').count(), 4);
  assert.match(await page.locator('#summaries').textContent(), /已经过期的实验通知/);
  assert.match(await page.locator('#summaries').textContent(), /恰好截止的实验通知/);
  assert.match(await page.locator('#summaries').textContent(), /已确认给自己的事项/);
  await page.locator('#summary-scope').selectOption('all');
  assert.equal(await page.locator('#summaries article').count(), 16);
  await page.locator('[data-view="tasks"]').click();
  assert.match(await page.locator('#tasks').textContent(), /将来截止的个人任务/);
  assert.doesNotMatch(await page.locator('#tasks').textContent(), /逾期但仍未完成|已经完成/);
  await page.locator('[data-task-filter="overdue"]').click();
  assert.match(await page.locator('#tasks').textContent(), /逾期但仍未完成的个人任务/);
  assert.doesNotMatch(await page.locator('#tasks').textContent(), /将来截止|已经完成/);
  assert.match(await page.locator('#tasks').textContent(), /标记完成/);
  assert.equal(model.posts.length, 0, 'view changes must never mutate or delete stored items');
  assert.equal(model.board.tasks.find(task => task.id === 't-late').status, 'pending');
});

uiTest('background polling only shows an update button and applying or mutating preserves reading state', async t => {
  const { page, model } = await start(t);
  await page.locator('[data-view="summaries"]').click();
  await card(page).locator('details.summary-details > summary').click();
  await card(page).locator('details.source > summary').click();
  await card(page).locator('details.correction > summary').click();
  await card(page).locator('details.correction select').selectOption('activity');
  await card(page, 's2').locator('details.summary-details > summary').click();
  await card(page, 's2').getByRole('button', { name: '确认为我的待办', exact: true }).click();
  await page.locator('#task-title').fill('尚未提交的私人草稿');
  const before = await page.locator('#summaries').innerHTML();
  model.board = { ...model.board, revision: 'r2', messageCount: 25, summaries: [summary('new', { text: '点击更新后才出现的新消息' }), ...model.board.summaries] };
  await tickPoll(page);
  await page.locator('#new-updates').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#summaries').innerHTML(), before, 'polling must not replace or edit list DOM');
  assert.equal(await page.locator('#task-dialog').evaluate(node => node.open), true);
  assert.equal(await page.locator('#task-title').inputValue(), '尚未提交的私人草稿');
  assert.equal(await card(page).locator('details.correction select').inputValue(), 'activity');
  await page.locator('#cancel-dialog').click();
  await page.evaluate(() => scrollTo(0, 700));
  const anchorTop = await card(page).evaluate(node=>node.getBoundingClientRect().top);
  const sameElement = await card(page).elementHandle();
  await page.locator('#new-updates').click();
  await waitText(page, '#summaries', '点击更新后才出现的新消息');
  await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);
  assert.equal(await sameElement.evaluate(node => node.isConnected), true, 'applying a dashboard must retain existing keyed summary elements');
  assert.equal(await card(page).locator('details.summary-details').evaluate(node => node.open), true);
  assert.equal(await card(page).locator('details.source').evaluate(node => node.open), true);
  assert.equal(await card(page).locator('details.correction').evaluate(node => node.open), true);
  assert.equal(await card(page).locator('details.correction select').inputValue(), 'activity');
  assert.ok(Math.abs((await card(page).evaluate(node=>node.getBoundingClientRect().top))-anchorTop)<3,'applying an update must preserve the visible reading anchor');
  assert.equal(await page.locator('#new-updates').isVisible(), false);
  const other = card(page, 's2');
  await other.locator('details.correction > summary').click();
  await other.getByRole('button', { name: '保存个人修正', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#refresh')?.disabled);
  assert.equal(await card(page).locator('details.source').evaluate(node => node.open), true);
  assert.equal(await card(page).locator('details.correction select').inputValue(), 'activity');
});

uiTest('logout and revoked access clear private content even when an older update response finishes later', async t => {
  for (const reason of ['logout', 'revoked']) {
    await t.test(reason, async sub => {
      const { page, model } = await start(sub);
      model.holdUpdates = true;
      await page.clock.runFor(12001);
      // The held HTTP response is released only after the access-changing action.
      for (let i = 0; model.updates.length === 0 && i < 20; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(model.updates.length, 1);
      if (reason === 'logout') {
        await page.locator('#logout').click();
        await page.locator('#login-panel').waitFor({ state: 'visible' });
      } else {
        model.denyDashboard = true;
        await page.locator('#refresh').click();
        await waitText(page, '#feedback', '群成员授权已撤销');
      }
      const finished = page.waitForResponse(r => new URL(r.url()).pathname === '/api/updates');
      model.updates[0].release(200, { revision: 'old-private-response', messageCount: 999, status });
      await finished;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      for (const id of ['summaries', 'tasks', 'messages', 'group-list','timeline-items','timeline-completed','timeline-undated','timeline-week']) assert.equal(await page.locator(`#${id}`).textContent(), '', `${id} must be cleared after ${reason}`);
      assert.equal(await page.locator('#new-updates').isVisible(), false);
      assert.equal(await page.locator('#task-dialog').evaluate(node => node.open), false);
    });
  }
});

// Catches grouping by UTC day, unsorted deadlines, leaked unconfirmed summaries,
// disappearing malformed dates, and responsive overflow from the fourth tab.
uiTest('timeline groups confirmed tasks by local deadline with reachable history and compact mobile rows', async t=>{
  const data=board(), base=data.tasks[0];
  data.tasks.push(
    {...base,id:'evening',title:'完成实验报告',dueAt:'2026-10-29T10:00:00Z'},
    {...base,id:'morning',title:'提交分工表',dueAt:'2026-10-29T05:30:00Z'},
    {...base,id:'midnight',title:'当地凌晨任务',dueAt:'2026-10-28T16:30:00Z'},
    {...base,id:'undated',title:'待补充日期的事项',dueAt:null},
  );
  const {page,model}=await start(t,{board:data});
  await page.locator('[data-view="timeline"]').click();
  assert.equal(await page.locator('#timeline-date').inputValue(),'2026-10-29');
  assert.deepEqual(await page.locator('#timeline-items article').evaluateAll(nodes=>nodes.map(n=>n.dataset.key)),['timeline:midnight','timeline:morning','timeline:evening']);
  assert.doesNotMatch(await page.locator('#timeline-items').textContent(),/待核对的事项|将来截止|已经完成/);
  assert.match(await page.locator('#timeline-items').textContent(),/00:30/);
  await page.locator('#timeline-undated-section > summary').click();
  assert.match(await page.locator('#timeline-undated').textContent(),/待补充日期的事项/);
  assert.ok(await page.locator('[data-key="timeline:morning"]').boundingBox().then(r=>r.height<140));
  if(process.env.PILOT_TIMELINE_SCREENSHOT)await page.screenshot({path:process.env.PILOT_TIMELINE_SCREENSHOT});
  for(const width of [320,375,390,1280]){await page.setViewportSize({width,height:800});await noHorizontalOverflow(page);}
  await page.locator('#timeline-overdue').click();
  assert.match(await page.locator('#tasks').textContent(),/逾期但仍未完成/);
  await page.locator('[data-view="timeline"]').click();
  await page.locator('#timeline-date').fill('2026-12-31');
  await page.locator('#timeline-next-week').click();
  assert.equal(await page.locator('#timeline-date').inputValue(),'2027-01-07');
  await page.locator('#timeline-prev-week').click();
  assert.equal(await page.locator('#timeline-date').inputValue(),'2026-12-31');
  await page.locator('#timeline-today').click();
  assert.equal(await page.locator('#timeline-date').inputValue(),'2026-10-29');
  await page.locator('[data-timeline-date="2026-11-01"]').click();
  assert.match(await page.locator('#timeline-items').textContent(),/将来截止/);
  assert.equal(model.posts.length,0);
});

// Catches separate shadow task state, wrong task IDs/actions, and stale dates
// after editing through the same existing reminder form.
uiTest('timeline completion and rescheduling use the same personal task as the list',async t=>{
  const {page,model}=await start(t);
  await page.locator('[data-view="timeline"]').click();
  await page.locator('#timeline-date').fill('2026-11-01');
  await page.getByRole('button',{name:'标记完成：将来截止的个人任务',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('#refresh').disabled&&document.querySelector('#timeline-completed article'));
  assert.deepEqual(model.posts[0],{path:'/api/tasks/t-future/complete',body:{}});
  assert.equal(await page.locator('#timeline-items article').count(),0);
  await page.locator('[data-view="tasks"]').click();
  await page.locator('[data-task-filter="done"]').click();
  assert.match(await page.locator('#tasks').textContent(),/将来截止的个人任务/);
  await page.locator('[data-view="timeline"]').click();
  await page.locator('#timeline-completed-section > summary').click();
  await page.getByRole('button',{name:'重新打开：将来截止的个人任务',exact:true}).click();
  await page.locator('#timeline-items article').waitFor();
  await page.locator('#timeline-items .timeline-details > summary').click();
  await page.locator('#timeline-items').getByRole('button',{name:'修改时间',exact:true}).click();
  await page.locator('#task-due').fill('2026-11-02T18:00');
  await page.locator('#task-reminder').fill('2026-11-02T17:30');
  await page.locator('#save-task').click();
  await page.locator('#task-dialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>!document.querySelector('#refresh').disabled&&document.querySelector('#timeline-items article')===null);
  assert.equal(await page.locator('#timeline-date').inputValue(),'2026-11-01');
  await page.locator('#timeline-date').fill('2026-11-02');
  assert.match(await page.locator('#timeline-items').textContent(),/18:00.*将来截止的个人任务/s);
});

// Catches automatic feed jumping or lost selected day when updates arrive.
uiTest('timeline keeps the selected day and expanded content during polling and refresh',async t=>{
  const data=board();data.tasks[0].title='很长的待办标题'.repeat(20);
  const {page,model}=await start(t,{board:data});
  await page.locator('[data-view="timeline"]').click();
  await page.locator('#timeline-date').fill('2026-11-01');
  await page.locator('#timeline-items .timeline-details > summary').click();
  await noHorizontalOverflow(page);
  const before=await page.locator('#timeline-items').innerHTML();
  model.board.revision='changed';model.board.messageCount++;
  await tickPoll(page);
  await page.locator('#new-updates').waitFor({state:'visible'});
  assert.equal(await page.locator('#timeline-items').innerHTML(),before);
  await page.locator('#new-updates').click();
  await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);
  assert.equal(await page.locator('#timeline-date').inputValue(),'2026-11-01');
  assert.equal(await page.locator('#timeline-items .timeline-details').evaluate(n=>n.open),true);
});

uiTest('switching group A to B to A ignores the first A response that arrives last', async t => {
  const { page, model } = await start(t, { holdMessages: true });
  await page.locator('[data-view="groups"]').click();
  await page.locator('#group-list button').filter({ hasText: '课程群 B' }).click();
  await page.locator('#group-list button').filter({ hasText: '课程群 A' }).click();
  for (let i = 0; model.messages.length < 3 && i < 20; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(model.messages.map(request => request.groupId), ['g1', 'g2', 'g1']);
  const payload = (groupId, text) => ({ messages: [{ id: text, groupId, senderName: '老师', sentAt: new Date(NOW).toISOString(), text, summaryId: null }] });
  model.messages[2].release(payload('g1', 'A 的最后一次选择结果'));
  await waitText(page, '#messages', 'A 的最后一次选择结果');
  const oldA = page.waitForResponse(r => new URL(r.url()).pathname === '/api/groups/g1/messages');
  model.messages[1].release(payload('g2', 'B 的迟到结果'));
  model.messages[0].release(payload('g1', 'A 的第一次过时结果'));
  await oldA;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.match(await page.locator('#messages').textContent(), /A 的最后一次选择结果/);
  assert.doesNotMatch(await page.locator('#messages').textContent(), /第一次过时|B 的迟到/);
});
