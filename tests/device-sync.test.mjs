import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { onRequestPost } from '../functions/api/connectors/heartbeat.js';
import { onRequestGet as getDevices, onRequestPatch } from '../functions/api/devices/[[id]].js';
import { onRequestGet as getConnectors } from '../functions/api/connectors/index.js';
import { collect, deviceRef, parseBattery, parseDevices } from '../connector/adb-connector.mjs';

const token = 'test-only-connector-token-0123456789';
const sample = () => ({ connector_id: 'local-adb', agent_name: 'test-agent', appium_status: 'not_configured',
  devices: [{ device_ref: deviceRef('test-serial'), name: 'Test phone', manufacturer: 'Test', model: 'Model',
    os: 'Android', os_version: '14', sdk_version: '34', battery_percent: 98, charging: true,
    screen_resolution: '720x1640', adb_state: 'device', connection_status: 'online', connection_type: 'wireless',
    adb_address: '192.0.2.1:42373', collected_at: new Date().toISOString() }] });

async function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  const prepare = sql => {
    const stmt = db.prepare(sql);
    const bound = values => ({
      first: async () => stmt.get(...values) ?? null,
      all: async () => ({ results: stmt.all(...values) }),
      run: async () => ({ meta: { changes: stmt.run(...values).changes } }),
    });
    return { ...bound([]), bind: (...values) => bound(values) };
  };
  return { db, env: { DEVICE_CONNECTOR_TOKEN: token, DB: { prepare,
    batch: async statements => { db.exec('BEGIN'); try { const r=[]; for(const s of statements)r.push(await s.run()); db.exec('COMMIT'); return r; } catch(e){db.exec('ROLLBACK');throw e;} } } } };
}

function request(payload, secret = token) {
  return new Request('https://example.test/api/connectors/heartbeat', { method:'POST',
    headers:{ authorization:`Bearer ${secret}`, 'content-type':'application/json' }, body:JSON.stringify(payload) });
}

test('authenticated sync persists, deduplicates, preserves edits and marks disconnects', async () => {
  const { db, env } = await database();
  try {
    assert.equal((await onRequestPost({request:request(sample(),'wrong'),env})).status,401);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM devices').get().n,0);
    const payload=sample();
    assert.equal((await onRequestPost({request:request(payload),env})).status,200);
    let rows=await (await getDevices({env,params:{}})).json();
    assert.equal(rows.length,1); const id=rows[0].id;
    assert.equal(rows[0].charging,1); assert.equal(rows[0].battery_percent,98);
    await onRequestPatch({env,params:{id},request:new Request('https://example.test',{method:'PATCH',body:JSON.stringify({name:'Operator name',notes:'Keep me',status:'maintenance'})})});
    payload.devices[0].adb_address='192.0.2.2:50000'; payload.devices[0].battery_percent=75;
    assert.equal((await onRequestPost({env,request:request(payload)})).status,200);
    rows=await (await getDevices({env,params:{}})).json();
    assert.equal(rows.length,1); assert.equal(rows[0].id,id); assert.equal(rows[0].name,'Operator name');
    assert.equal(rows[0].notes,'Keep me'); assert.equal(rows[0].status,'maintenance');
    assert.equal(rows[0].battery_percent,75); assert.equal(rows[0].adb_address,'192.0.2.2:50000');
    const lastSeen=rows[0].last_seen_at;
    Object.assign(payload.devices[0],{adb_state:'unauthorized',connection_status:'attention',battery_percent:null,charging:null,collected_at:null});
    await onRequestPost({env,request:request(payload)});
    rows=await (await getDevices({env,params:{}})).json();
    assert.equal(rows[0].connection_status,'attention'); assert.equal(rows[0].battery_percent,75); assert.equal(rows[0].last_seen_at,lastSeen);
    await onRequestPost({env,request:request({...payload,devices:[]})});
    rows=await (await getDevices({env,params:{}})).json(); assert.equal(rows[0].connection_status,'offline');
    Object.assign(payload.devices[0],{adb_state:'device',connection_status:'online'});
    await onRequestPost({env,request:request(payload)});
    db.prepare("UPDATE devices SET last_seen_at='2000-01-01T00:00:00Z'").run();
    rows=await (await getDevices({env,params:{}})).json(); assert.equal(rows[0].connection_status,'offline');
    assert.equal((await (await getConnectors({env})).json()).connectors.length,1);
  } finally { db.close(); }
});

test('invalid snapshots do not mutate inventory',async()=>{
  const {db,env}=await database();
  try{
    for(const mutate of [p=>p.devices.push({...p.devices[0]}),p=>p.devices[0].battery_percent=101,p=>p.connector_id='other',p=>p.devices[0].charging='true',p=>p.devices[0].collected_at='bad']){
      const payload=sample();mutate(payload);assert.equal((await onRequestPost({env,request:request(payload)})).status,400);
    }
    assert.equal((await onRequestPost({env,request:new Request('https://example.test',{method:'POST',headers:{authorization:`Bearer ${token}`},body:'x'.repeat(65537)})})).status,413);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM devices').get().n,0);
    assert.equal((await onRequestPost({env:{...env,DEVICE_CONNECTOR_TOKEN:''},request:request(sample())})).status,503);
  }finally{db.close();}
});

test('ADB parser and USB/wireless deduplication use hardware identity',async()=>{
  assert.equal(parseDevices('List of devices attached\nserial device model:test\nother unauthorized\n').length,2);
  assert.deepEqual(parseBattery(' level: 40\n scale: 80\n status: 2'),{battery_percent:50,charging:true});
  assert.throws(()=>deviceRef('unknown'));
  const cache={aliases:{}};
  const adb=async(...args)=>{
    if(args[0]==='devices')return 'physical device\nadb-test._adb-tls-connect._tcp device';
    if(args[0]==='mdns')return 'adb-test _adb-tls-connect._tcp 192.0.2.1:42373';
    if(args.at(-1)==='getprop')return '[ro.serialno]: [same-hardware]\n[ro.product.model]: [Test phone]\n[ro.build.version.release]: [14]';
    if(args.at(-1)==='battery')return 'level: 98\nscale: 100\nstatus: 2';
    return 'Physical size: 720x1640';
  };
  const result=await collect({connector_id:'local-adb',agent_name:'test'},adb,cache);
  assert.equal(result.devices.length,1);assert.equal(result.devices[0].device_ref,deviceRef('same-hardware'));
  assert.equal(result.devices[0].adb_address,'192.0.2.1:42373');assert.equal(result.devices[0].screen_resolution,'720x1640');
});

test('additive migration preserves existing inventory and login relationships',async()=>{
  const {db}=await database();
  try{
    // Recreate the pre-connector devices table while retaining the current account/session schema.
    db.exec('DROP INDEX idx_devices_ref; DROP INDEX idx_devices_connector; DROP TABLE devices; DROP TABLE device_connectors;');
    db.exec(`CREATE TABLE devices (id TEXT PRIMARY KEY,name TEXT NOT NULL,manufacturer TEXT DEFAULT '',model TEXT DEFAULT '',os TEXT DEFAULT '',os_version TEXT DEFAULT '',status TEXT DEFAULT 'available',connection_status TEXT DEFAULT 'unpaired',agent_name TEXT DEFAULT '',last_seen_at TEXT,battery_percent INTEGER,screen_resolution TEXT DEFAULT '',notes TEXT DEFAULT '',created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP); INSERT INTO devices (id,name,notes) VALUES ('old','Existing','Preserve');`);
    db.exec("INSERT INTO work_accounts (id,handle,phone_number) VALUES ('account','test','test-number'); INSERT INTO account_device_sessions (id,account_id,device_id) VALUES ('session','account','old');");
    db.exec(await readFile(new URL('../migrations/0003-device-connector.sql',import.meta.url),'utf8'));
    assert.equal(db.prepare("SELECT notes FROM devices WHERE id='old'").get().notes,'Preserve');
    assert.equal(db.prepare("SELECT device_id FROM account_device_sessions WHERE id='session'").get().device_id,'old');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{db.close();}
});
