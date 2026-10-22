import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { onRequestPost as create,onRequestGet as tasks,onRequestPatch as edit } from '../functions/api/tasks/[[id]].js';
import { onRequestPost as enqueue,onRequestGet as runs,onRequestPatch as cancel } from '../functions/api/task-runs/[[id]].js';
import { onRequestPost as connector } from '../functions/api/connectors/tasks.js';
import { onRequestGet as accounts } from '../functions/api/accounts/[[id]].js';
import { executionResult } from '../connector/task-worker.mjs';

const secret='test-task-secret-012345678901234567890';
function request(data,agent=false,token=secret){return new Request('https://example.test/api/tasks',{method:'POST',headers:{'content-type':'application/json',...(agent?{authorization:'Bearer '+token}:{'x-device-control-token':token})},body:JSON.stringify(agent?{connector_id:'local-adb',...data}:data)});}
async function fixture(){
  const db=new DatabaseSync(':memory:');db.exec(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
  const prepare=sql=>{const s=db.prepare(sql);const bound=v=>({first:async()=>s.get(...v)||null,all:async()=>({results:s.all(...v)}),run:async()=>({meta:{changes:s.run(...v).changes}})});return {...bound([]),bind:(...v)=>bound(v)};};
  const env={DEVICE_CONNECTOR_TOKEN:secret,DEVICE_CONTROL_TOKEN:secret,DB:{prepare,batch:async statements=>{db.exec('BEGIN');try{for(const s of statements)await s.run();db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}}}};
  const now=new Date().toISOString();
  db.prepare(`INSERT INTO device_connectors(id,name,last_seen_at)VALUES('local-adb','Test',?)`).run(now);
  db.prepare(`INSERT INTO devices(id,name,connector_id,device_ref,connection_mode,connection_status,adb_state,last_seen_at)VALUES('phone','Phone','local-adb','ref','active','online','device',?)`).run(now);
  db.exec(`INSERT INTO work_accounts(id,platform,handle,phone_country_code,phone_number,display_name,status)VALUES('account','xiaohongshu','test','+86','100','Account','active'),('other','xiaohongshu','other','+86','200','Other','active');INSERT INTO account_device_sessions(id,account_id,device_id,status)VALUES('session','account','phone','active');`);
  const data={name:'Target note',note_url:'分享 https://xhslink.cn/o/example 保留口令',expected_author:'Author',expected_title:'',actions:['like','collect','follow']};
  const made=await create({env,request:request(data)});assert.equal(made.status,201);const taskId=(await made.json()).id;
  const agent=async data=>connector({env,request:request(data,true)});
  const queue=async(extra={})=>{const payload={request_id:crypto.randomUUID(),task_id:taskId,account_id:'account',device_id:'phone',...extra};return {payload,response:await enqueue({env,request:request(payload)})};};
  return {db,env,data,taskId,agent,queue};
}

test('task dispatch requires authorization, an online worker and the selected account login; snapshots and cancellation are immutable',async()=>{
  const {db,env,data,taskId,agent,queue}=await fixture();
  try{
    assert.equal((await create({env,request:request(data,false,'bad')})).status,401);
    assert.equal((await create({env,request:request({...data,note_url:'https://example.test/note'})})).status,400);
    assert.equal((await create({env,request:request({...data,actions:[]})})).status,400);
    assert.equal((await queue()).response.status,409);
    await agent({action:'heartbeat'});
    assert.equal((await queue({account_id:'other'})).response.status,409);
    db.exec("UPDATE devices SET connection_mode='paused'");assert.equal((await queue()).response.status,409);db.exec("UPDATE devices SET connection_mode='active'");
    const {payload,response}=await queue();assert.equal(response.status,201);
    assert.equal((await enqueue({env,request:request(payload)})).status,200);
    assert.equal((await queue()).response.status,409);
    await edit({env,params:{id:taskId},request:request({...data,name:'Changed task',actions:['like']})});
    const row=await(await runs({env,params:{id:payload.request_id},request:new Request('https://example.test/api/task-runs')})).json();
    assert.equal(row.snapshot.name,'Target note');assert.equal(row.snapshot.actions.length,3);assert.equal(row.snapshot.note_url,'https://xhslink.cn/o/example');
    assert.equal((await cancel({env,params:{id:payload.request_id},request:request({action:'cancel'})})).status,200);
    assert.equal((await(await tasks({env,params:{id:taskId}})).json()).execution_count,0);
    assert.equal((await(await agent({action:'claim'})).json()).task,null);
  }finally{db.close();}
});

test('confirmed action ledger counts partial successes exactly once; skipped actions and queued jobs never inflate statistics',async()=>{
  const {db,env,taskId,agent,queue}=await fixture();
  try{
    await agent({action:'heartbeat'});const first=await queue();assert.equal(first.response.status,201);
    const task=(await(await agent({action:'claim'})).json()).task;assert.equal(task.id,first.payload.request_id);
    const lease={run_id:task.id,lease_token:task.lease_token};
    assert.equal((await agent({action:'progress',...lease,lease_token:'wrong',results:{like:'performed'}})).status,409);
    for(let i=0;i<2;i++)assert.equal((await agent({action:'progress',...lease,results:{like:'performed'}})).status,200);
    assert.equal((await agent({action:'progress',...lease,results:{like:'skipped'}})).status,409);
    assert.equal((await agent({action:'finish',...lease,status:'succeeded',results:{},message:'bad'})).status,400);
    const finish={action:'finish',...lease,status:'unknown',current_action:'collect',results:{like:'performed'},message:'Unconfirmed collect'};
    assert.equal((await agent(finish)).status,200);assert.equal((await agent(finish)).status,200);
    let stats=await(await tasks({env,params:{id:taskId}})).json();assert.equal(stats.execution_count,1);assert.equal(stats.like_count,1);assert.equal(stats.collect_count,0);assert.equal(stats.follow_count,0);
    await queue();const next=(await(await agent({action:'claim'})).json()).task;
    assert.equal((await agent({action:'finish',run_id:next.id,lease_token:next.lease_token,status:'succeeded',results:{like:'skipped',collect:'performed',follow:'skipped'},message:'done'})).status,200);
    stats=await(await tasks({env,params:{id:taskId}})).json();assert.equal(stats.execution_count,2);assert.equal(stats.succeeded_count,1);assert.equal(stats.like_count,1);assert.equal(stats.collect_count,1);assert.equal(stats.follow_count,0);
    const account=(await(await accounts({env,params:{}})).json()).find(a=>a.id==='account');assert.equal(account.execution_count,2);assert.equal(account.like_count,1);assert.equal(account.collect_count,1);
    const history=await(await runs({env,params:{},request:new Request('https://example.test/api/task-runs?task_id='+taskId)})).json();assert.equal(history.length,2);
    assert.equal(history.find(r=>r.id===task.id).action_results.find(a=>a.action==='collect').outcome,'unknown');
  }finally{db.close();}
});

test('database enforces APK/task mutual exclusion and stale executions become unknown without retry',async()=>{
  const {db,env,taskId,agent,queue}=await fixture();
  try{
    await agent({action:'heartbeat'});await queue();
    db.exec(`INSERT INTO apk_packages(id,connector_id,filename,sha256,size_bytes,updated_at)VALUES('apk','local-adb','app.apk','hash',100,'now')`);
    const insert=()=>db.exec(`INSERT INTO apk_installations(id,device_id,connector_id,device_ref,package_id,filename,sha256,size_bytes,status,created_at)VALUES('install','phone','local-adb','ref','apk','app.apk','hash',100,'queued','now')`);
    assert.throws(insert,/device has a note task/);
    const task=(await(await agent({action:'claim'})).json()).task;
    db.prepare("UPDATE task_runs SET updated_at=? WHERE id=?").run('2000-01-01T00:00:00.000Z',task.id);
    await agent({action:'heartbeat'});
    assert.equal(db.prepare('SELECT status FROM task_runs WHERE id=?').get(task.id).status,'unknown');
    assert.equal((await(await agent({action:'claim'})).json()).task,null);
    insert();assert.equal((await queue()).response.status,409);
    const stats=await(await tasks({env,params:{id:taskId}})).json();assert.equal(stats.execution_count,1);assert.equal(stats.like_count,0);
  }finally{db.close();}
});

test('worker maps only confirmed clicks to performed and retains partial confirmed actions after interruption',()=>{
  const report={status:'failed',current_action:'follow',error:'connection lost',actions:{like:{action:'clicked_once'},collect:{action:'already_collected'}}};
  const result=executionResult(report,true);assert.equal(result.status,'unknown');assert.deepEqual(result.results,{like:'performed',collect:'skipped'});assert.equal(result.current_action,'follow');
  assert.equal(executionResult(null).status,'failed');
});
