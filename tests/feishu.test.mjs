import test from 'node:test';
import assert from 'node:assert/strict';
import {FeishuTransport} from '../src/feishu.mjs';
const response=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
test('official REST adapter caches tenant token, pages membership and preserves send UUID',async()=>{
  const calls=[];
  const client=new FeishuTransport({appId:'cli_x',appSecret:'secret'}, {fetchImpl:async(url,options)=>{
    calls.push({url,options});
    if(url.includes('tenant_access_token'))return response({code:0,tenant_access_token:'token',expire:7200});
    if(url.includes('/members'))return response({code:0,data:url.includes('page_token=next')?{items:[{member_id:'ou_b'}],has_more:false}:{items:[{member_id:'ou_a'}],has_more:true,page_token:'next'}});
    if(url.includes('/messages'))return response({code:0,data:{message_id:'om_sent'}});
    throw Error('unexpected request');
  }});
  assert.equal(await client.isGroupMember('oc_group','ou_b'),true);
  await client.sendText('ou_b','提醒','fixed-id');
  assert.equal(calls.filter(c=>c.url.includes('tenant_access_token')).length,1);
  const sent=calls.find(c=>c.url.includes('/messages'));assert.equal(JSON.parse(sent.options.body).uuid,'fixed-id');assert.equal(sent.options.headers.authorization,'Bearer token');
});
test('OAuth exchange keeps secret server-side and rejects a different team',async()=>{
  const calls=[];
  const client=new FeishuTransport({appId:'app',appSecret:'secret',tenantKey:'expected'}, {fetchImpl:async(url,options)=>{calls.push({url,options});return response(url.includes('/oauth/token')?{access_token:'user-token'}:{code:0,data:{open_id:'ou_x',name:'成员',tenant_key:'other'}});}});
  await assert.rejects(()=>client.exchangeCode('code','verifier','https://pilot.example/auth/feishu/callback'),/试用团队/);
  const body=JSON.parse(calls[0].options.body);assert.equal(body.code_verifier,'verifier');assert.equal(body.client_secret,'secret');
});
test('a revoked tenant token is discarded so the next durable retry can refresh it',async()=>{
  let tokenRequests=0,sends=0;
  const client=new FeishuTransport({appId:'app',appSecret:'secret'}, {fetchImpl:async(url)=>{
    if(url.includes('tenant_access_token'))return response({code:0,tenant_access_token:'token-'+(++tokenRequests),expire:7200});
    return response(++sends===1?{code:99991663}:{code:0,data:{message_id:'sent'}});
  }});
  await assert.rejects(()=>client.sendText('ou_a','提醒','same-id'),/接口未成功/);
  await client.sendText('ou_a','提醒','same-id');
  assert.equal(tokenRequests,2);
});
test('native mobile cards use official interactive send and PATCH without a browser URL',async()=>{
  const calls=[],card={schema:'2.0',body:{elements:[]}};
  const client=new FeishuTransport({appId:'app',appSecret:'secret'},{fetchImpl:async(url,options)=>{
    calls.push({url,options});
    return response(url.includes('tenant_access_token')?{code:0,tenant_access_token:'token',expire:7200}:{code:0,data:{message_id:'om_card'}});
  }});
  assert.deepEqual(await client.sendCard('ou_a',card,'stable-card-id'),{messageId:'om_card'});
  const sent=calls.find(c=>c.url.includes('/messages?'));
  assert.deepEqual(JSON.parse(sent.options.body),{receive_id:'ou_a',msg_type:'interactive',content:JSON.stringify(card),uuid:'stable-card-id'});
  await client.updateCard('om_card',card);
  const patched=calls.find(c=>c.options.method==='PATCH');
  assert.ok(patched.url.endsWith('/im/v1/messages/om_card'));
  assert.deepEqual(JSON.parse(patched.options.body),{content:JSON.stringify(card)});
  const count=calls.length;
  assert.deepEqual(await client.sendCard('ou_a',card,'cancelled',()=>false),{cancelled:true});
  assert.equal(calls.length,count);
});
