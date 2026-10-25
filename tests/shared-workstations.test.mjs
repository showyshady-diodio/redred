import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile,mkdtemp,mkdir,rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { onRequestPost as heartbeat } from '../functions/api/connectors/heartbeat.js';
import { onRequestPost as register } from '../functions/api/connectors/register.js';
import { onRequestPost as manage } from '../functions/api/connectors/manage.js';
import { onRequestGet as controls } from '../functions/api/connectors/control.js';
import { onRequestGet as computers } from '../functions/api/connectors/index.js';
import { onRequestPatch as transfer,onRequestGet as devices } from '../functions/api/devices/[[id]].js';
import { onRequestPost as create } from '../functions/api/tasks/[[id]].js';
import { onRequestPost as enqueue,onRequestPatch as cancel } from '../functions/api/task-runs/[[id]].js';
import { onRequestPost as worker } from '../functions/api/connectors/tasks.js';
import { deviceRef } from '../connector/adb-connector.mjs';
import { workstationInstance,adbExecutable } from '../connector/workstation.mjs';

const secret='shared-project-token-01234567890123456789',a=crypto.randomUUID(),b=crypto.randomUUID();
const operator=data=>new Request('https://example.test/api',{method:'POST',headers:{'content-type':'application/json','x-device-control-token':secret},body:JSON.stringify(data)});
const agent=(data,instance=a)=>new Request('https://example.test/api',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+secret,'x-connector-instance':instance},body:JSON.stringify(data)});
const phone=serial=>({device_ref:deviceRef(serial),name:serial,connection_status:'online',adb_state:'device',connection_type:'wireless'});
const snapshot=(id,phones)=>({connector_id:id,agent_name:id,appium_status:'ready',devices:phones});
async function fixture(){
  const db=new DatabaseSync(':memory:');db.exec(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
  const prepare=sql=>{const s=db.prepare(sql),bound=v=>({first:async()=>s.get(...v)||null,all:async()=>({results:s.all(...v)}),run:async()=>({meta:{changes:s.run(...v).changes}})});return {...bound([]),bind:(...v)=>bound(v)};};
  const env={DEVICE_CONNECTOR_TOKEN:secret,DEVICE_CONTROL_TOKEN:secret,DB:{prepare,batch:async statements=>{db.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}}};
  const result=await register({env,request:operator({name:'Test computer',request_id:crypto.randomUUID()})});
  assert.equal(result.status,201);const registration=await result.json();
  return {db,env,testId:registration.connector_id,registration};
}

test('independent computer registration reuses the project token and keeps snapshots/control policy scoped to the assigned computer',async()=>{
  const {db,env,testId,registration}=await fixture();
  try{
    assert.equal(registration.config.token,secret);assert.equal(registration.config.work_dir,'./work');
    assert.equal((await heartbeat({env,request:agent(snapshot('local-adb',[phone('primary-phone')]))})).status,200);
    const response=await heartbeat({env,request:agent(snapshot(testId,[phone('primary-phone'),phone('test-phone')]),b)});
    const receipt=await response.json();assert.equal(response.status,200);assert.equal(receipt.received,1);assert.equal(receipt.ignored,1);
    let rows=db.prepare('SELECT connector_id,connection_status FROM devices ORDER BY name').all();assert.equal(rows.length,2);assert.equal(rows.find(x=>x.connector_id==='local-adb').connection_status,'online');
    await heartbeat({env,request:agent(snapshot(testId,[]),b)});
    assert.equal(db.prepare("SELECT connection_status FROM devices WHERE connector_id='local-adb'").get().connection_status,'online');
    const scoped=await(await controls({env,request:new Request('https://example.test/api/connectors/control?connector_id='+testId,{headers:{authorization:'Bearer '+secret,'x-connector-instance':b}})})).json();
    assert.equal(scoped.connector_id,testId);assert.equal(scoped.controls.length,1);assert.equal(scoped.controls[0].device_ref,deviceRef('test-phone'));
    const info=await(await computers({env})).json();assert.equal(info.connectors.find(c=>c.id==='local-adb').role,'primary');assert.ok(info.connectors.every(c=>!('instance_id' in c)));
    const rid=crypto.randomUUID(),data={name:'Second test',request_id:rid};
    const first=await(await register({env,request:operator(data)})).json(),second=await(await register({env,request:operator(data)})).json();assert.equal(first.connector_id,second.connector_id);
  }finally{db.close();}
});

test('a copied connector ID cannot replace an active computer; a stopped instance can recover after lease expiry',async()=>{
  const {db,env}=await fixture();
  try{
    const payload=snapshot('local-adb',[phone('primary-phone')]);
    assert.equal((await heartbeat({env,request:agent(payload,a)})).status,200);
    assert.equal((await heartbeat({env,request:agent({...payload,devices:[]},b)})).status,409);
    assert.equal(db.prepare('SELECT connection_status FROM devices').get().connection_status,'online');
    db.exec("UPDATE device_connectors SET instance_seen_at='2000-01-01T00:00:00Z'");
    assert.equal((await heartbeat({env,request:agent(payload,b)})).status,200);
    assert.equal((await heartbeat({env,request:agent(payload,a)})).status,409);
  }finally{db.close();}
});

test('transferring a phone preserves identity/login/history and routes future work only to its new computer; pending work prevents transfer/disable',async()=>{
  const {db,env,testId}=await fixture();
  try{
    await heartbeat({env,request:agent(snapshot('local-adb',[phone('moving-phone')]),a)});
    const d=db.prepare('SELECT id FROM devices').get();
    db.exec(`INSERT INTO work_accounts(id,platform,handle,phone_country_code,phone_number,display_name,status)VALUES('account','xiaohongshu','test','+86','123','Shared account','active')`);
    db.prepare(`INSERT INTO account_device_sessions(id,account_id,device_id,status)VALUES('login','account',?,'active')`).run(d.id);
    const task=await(await create({env,request:operator({name:'Shared task',note_url:'https://xhslink.cn/o/test',actions:['like']})})).json();
    const runData=()=>({request_id:crypto.randomUUID(),task_id:task.id,device_id:d.id,account_id:'account'});
    await worker({env,request:agent({connector_id:'local-adb',action:'heartbeat'},a)});
    const first=runData();assert.equal((await enqueue({env,request:operator(first)})).status,201);
    assert.equal((await transfer({env,params:{id:d.id},request:operator({connector_id:testId})})).status,409);
    assert.equal((await manage({env,request:operator({connector_id:'local-adb',enabled:false})})).status,409);
    await cancel({env,params:{id:first.request_id},request:operator({action:'cancel'})});
    assert.equal((await transfer({env,params:{id:d.id},request:operator({connector_id:testId})})).status,200);
    assert.equal(db.prepare('SELECT id,connector_id FROM devices').get().id,d.id);
    assert.equal(db.prepare('SELECT status FROM account_device_sessions').get().status,'active');
    const revision=db.prepare('SELECT control_revision FROM devices').get().control_revision;
    await heartbeat({env,request:agent({...snapshot(testId,[phone('moving-phone')]),control_results:[{device_ref:deviceRef('moving-phone'),revision,mode:'active',status:'applied'}]},b)});
    await worker({env,request:agent({connector_id:testId,action:'heartbeat'},b)});
    const next=runData();assert.equal((await enqueue({env,request:operator(next)})).status,201);
    assert.equal((await(await worker({env,request:agent({connector_id:'local-adb',action:'claim'},a)})).json()).task,null);
    const claimed=(await(await worker({env,request:agent({connector_id:testId,action:'claim'},b)})).json()).task;assert.equal(claimed.id,next.request_id);
    assert.equal((await manage({env,request:operator({connector_id:testId,enabled:false})})).status,409);
    await worker({env,request:agent({connector_id:testId,action:'finish',run_id:claimed.id,lease_token:claimed.lease_token,status:'succeeded',results:{like:'skipped'},message:'done'},b)});
    assert.equal((await manage({env,request:operator({connector_id:testId,enabled:false})})).status,200);
    assert.equal((await heartbeat({env,request:agent(snapshot(testId,[]),b)})).status,403);
    assert.equal((await(await devices({env,params:{id:d.id}})).json()).connection_status,'offline');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM task_runs').get().n,2);
  }finally{db.close();}
});

test('local services share one persistent instance and resolve ADB through PATH or explicit paths',async()=>{
  const folder=resolve(new URL('.',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'),'.state');await mkdir(folder,{recursive:true});
  const root=await mkdtemp(resolve(folder,'computer-'));
  try{
    const values=await Promise.all(Array.from({length:3},()=>workstationInstance(resolve(root,'connector.testing.local.json'))));
    assert.equal(new Set(values).size,1);
    assert.equal(adbExecutable(resolve(root,'config.json'),'adb'),'adb');
    assert.equal(adbExecutable(resolve(root,'config.json'),'./platform-tools/adb.exe'),resolve(root,'platform-tools/adb.exe'));
  }finally{await rm(root,{recursive:true,force:true});}
});
