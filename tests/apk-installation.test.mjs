import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile,mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onRequestPost as connector } from '../functions/api/connectors/installations.js';
import { onRequestPost as enqueue,onRequestGet as list } from '../functions/api/installations.js';
import { onRequestGet as catalog } from '../functions/api/apks.js';
import { deviceRef } from '../connector/adb-connector.mjs';
import { scanPackages,installTask } from '../connector/apk-installer.mjs';
import { onRequestPost as confirmLogin,onRequestPatch as changeLogin } from '../functions/api/sessions/[[id]].js';

const secret='test-installation-token-01234567890123456789';
async function database(){
  const db=new DatabaseSync(':memory:');db.exec(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
  const prepare=sql=>{const s=db.prepare(sql);const bound=v=>({first:async()=>s.get(...v)||null,all:async()=>({results:s.all(...v)}),run:async()=>({meta:{changes:s.run(...v).changes}})});return {...bound([]),bind:(...v)=>bound(v)};};
  const env={DEVICE_CONNECTOR_TOKEN:secret,DEVICE_CONTROL_TOKEN:secret,DB:{prepare,batch:async statements=>{db.exec('BEGIN');try{for(const s of statements)await s.run();db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}}}};
  db.prepare(`INSERT INTO device_connectors(id,name,last_seen_at)VALUES('local-adb','Test',?)`).run(new Date().toISOString());
  db.prepare(`INSERT INTO devices(id,name,connector_id,device_ref,connection_mode,connection_status,adb_state,last_seen_at)VALUES('phone','Phone','local-adb',?,'active','online','device',?)`).run(deviceRef('hardware'),new Date().toISOString());
  return {db,env};
}
function request(data,control=false,token=secret){return new Request('https://example.test/api/installations',{method:'POST',headers:{'content-type':'application/json',...(control?{'x-device-control-token':token}:{authorization:`Bearer ${token}`})},body:JSON.stringify(control?data:{connector_id:'local-adb',...data})});}

test('installation authorization, pause gating, request deduplication and exclusive device execution',async()=>{
  const {db,env}=await database();
  try{
    const p={filename:'app.apk',sha256:'a'.repeat(64),size_bytes:100};
    assert.equal((await connector({env,request:request({action:'catalog',packages:[p]},false,'bad')})).status,401);
    assert.equal((await connector({env,request:request({action:'catalog',packages:[{...p,filename:'../app.apk'}]})})).status,400);
    assert.equal((await connector({env,request:request({action:'catalog',packages:[p]})})).status,200);
    const packages=await(await catalog({env})).json();assert.equal(packages[0].installer_online,true);
    const data={device_id:'phone',package_id:packages[0].id,request_id:crypto.randomUUID()};
    assert.equal((await enqueue({env,request:request(data,true,'bad')})).status,401);
    const cross=request(data,true);cross.headers.set('origin','https://other.test');assert.equal((await enqueue({env,request:cross})).status,403);
    db.exec("UPDATE devices SET connection_mode='paused'");
    assert.equal((await enqueue({env,request:request(data,true)})).status,409);
    db.exec("UPDATE devices SET connection_mode='active'");
    assert.equal((await enqueue({env,request:request(data,true)})).status,201);
    assert.equal((await enqueue({env,request:request(data,true)})).status,200);
    assert.equal((await enqueue({env,request:request({...data,request_id:crypto.randomUUID()},true)})).status,409);
    db.exec("UPDATE devices SET connection_mode='paused'");
    assert.equal((await(await connector({env,request:request({action:'claim'})})).json()).task,null);
    db.exec("UPDATE devices SET connection_mode='active'");
    const {task}=await(await connector({env,request:request({action:'claim'})})).json();assert.equal(task.id,data.request_id);
    assert.equal((await(await connector({env,request:request({action:'claim'})})).json()).task,null);
    assert.equal((await connector({env,request:request({action:'finish',task_id:task.id,lease_token:'wrong',status:'succeeded',message:'ok'})})).status,409);
    assert.equal((await connector({env,request:request({action:'finish',task_id:task.id,lease_token:task.lease_token,status:'succeeded',message:'ok'})})).status,200);
    const rows=await(await list({env,request:new Request('https://example.test/api/installations?device_id=phone')})).json();
    assert.equal(rows[0].status,'succeeded');assert.equal(rows[0].lease_token,undefined);
  }finally{db.close();}
});

test('catalog removal blocks claims and abandoned installation becomes unknown without retry',async()=>{
  const {db,env}=await database();
  try{
    await connector({env,request:request({action:'catalog',packages:[{filename:'app.apk',sha256:'b'.repeat(64),size_bytes:20}]})});
    const p=(await(await catalog({env})).json())[0];
    await enqueue({env,request:request({device_id:'phone',package_id:p.id,request_id:crypto.randomUUID()},true)});
    await connector({env,request:request({action:'catalog',packages:[]})});
    assert.equal((await(await connector({env,request:request({action:'claim'})})).json()).task,null);
    db.exec("UPDATE apk_packages SET available=1");
    const {task}=await(await connector({env,request:request({action:'claim'})})).json();
    db.exec("UPDATE apk_installations SET started_at='2000-01-01T00:00:00Z'");
    await connector({env,request:request({action:'catalog',packages:[]})});
    assert.equal(db.prepare('SELECT status FROM apk_installations WHERE id=?').get(task.id).status,'unknown');
    assert.equal((await(await connector({env,request:request({action:'claim'})})).json()).task,null);
  }finally{db.close();}
});

test('local executor checks hash and physical identity, respects pause, and distinguishes rejection from uncertain outcome',async()=>{
  const root=await mkdtemp(join(tmpdir(),'apk-install-test-'));
  try{
    await writeFile(join(root,'test.apk'),Buffer.from([0x50,0x4b,0x03,0x04,0x00]));
    const packages=await scanPackages([root]);assert.equal(packages.size,1);
    const p=[...packages.values()][0];const task={sha256:p.sha256,size_bytes:p.size_bytes,device_ref:deviceRef('hardware')};
    const calls=[];let outcome='Success\n';
    const adb=async(...args)=>{calls.push(args);if(args[0]==='devices')return 'stranger device\ntarget device';if(args.includes('getprop'))return args[1]==='target'?'hardware':'other';return outcome;};
    const active=async()=>[{device_ref:task.device_ref,connection_mode:'active'}];
    assert.equal((await installTask(task,packages,adb,async()=>[{device_ref:task.device_ref,connection_mode:'paused'}])).status,'failed');
    assert.equal(calls.some(c=>c.includes('install')),false);
    assert.equal((await installTask(task,packages,adb,active)).status,'succeeded');
    assert.deepEqual(calls.find(c=>c.includes('install')).slice(0,4),['-s','target','install','-r']);
    outcome='Failure [INSTALL_FAILED_USER_RESTRICTED: Install canceled by user]';
    assert.equal((await installTask(task,packages,adb,active)).status,'failed');
    outcome='device offline';assert.equal((await installTask(task,packages,adb,active)).status,'unknown');
    const before=calls.filter(c=>c.includes('install')).length;
    await writeFile(p.path,Buffer.from([0x50,0x4b,0x03,0x04,0x01]));
    assert.equal((await installTask(task,packages,adb,active)).status,'failed');
    assert.equal(calls.filter(c=>c.includes('install')).length,before);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('manual login requires authorization and explicit confirmation, deduplicates and replaces only the target device platform binding',async()=>{
  const {db,env}=await database();
  try{
    db.exec("INSERT INTO work_accounts(id,handle,phone_number)VALUES('account-a','a','111'),('account-b','b','222');");
    const data={account_id:'account-a',device_id:'phone',login_confirmed:true};
    assert.equal((await confirmLogin({env,request:request(data,true,'bad')})).status,401);
    assert.equal((await confirmLogin({env,request:request({...data,login_confirmed:false},true)})).status,400);
    assert.equal((await confirmLogin({env,request:request(data,true)})).status,201);
    assert.equal((await confirmLogin({env,request:request(data,true)})).status,200);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_device_sessions').get().n,1);
    db.exec("UPDATE devices SET connection_mode='paused'");
    assert.equal((await confirmLogin({env,request:request({...data,account_id:'account-b'},true)})).status,409);
    db.exec("UPDATE devices SET connection_mode='active'; UPDATE work_accounts SET status='disabled' WHERE id='account-b'");
    assert.equal((await confirmLogin({env,request:request({...data,account_id:'account-b'},true)})).status,409);
    db.exec("UPDATE work_accounts SET status='verification_needed' WHERE id='account-b'");
    assert.equal((await confirmLogin({env,request:request({...data,account_id:'account-b'},true)})).status,201);
    assert.equal(db.prepare("SELECT status FROM account_device_sessions WHERE account_id='account-a'").get().status,'ended');
    assert.equal(db.prepare("SELECT status FROM work_accounts WHERE id='account-b'").get().status,'active');
    const current=db.prepare("SELECT id FROM account_device_sessions WHERE status='active'").get();
    assert.equal((await changeLogin({env,params:{id:current.id},request:request({status:'ended'},true,'bad')})).status,401);
    assert.equal((await changeLogin({env,params:{id:current.id},request:request({status:'ended'},true)})).status,200);
  }finally{db.close();}
});
