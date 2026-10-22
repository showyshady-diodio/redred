import { body,id,json } from '../_shared.js';
import { authorized } from '../_telemetry.js';
import { expireInstallations } from '../_installations.js';

export async function onRequestPost({env,request}) {
  if(!await authorized(request,env))return json({error:'Invalid connector token'},401);
  const text=await request.text();if(text.length>65536)return json({error:'Payload too large'},413);
  const data=await body(new Response(text));
  const connectorId=env.DEVICE_CONNECTOR_ID||'local-adb';
  if(!data || data.connector_id!==connectorId)return json({error:'Invalid connector'},400);
  const now=new Date().toISOString();
  if(data.action==='catalog') {
    if(!Array.isArray(data.packages)||data.packages.length>100)return json({error:'Invalid package catalog'},400);
    const hashes=new Set();
    for(const p of data.packages) {
      if(!p || !/^[a-f0-9]{64}$/.test(p.sha256)||hashes.has(p.sha256)||typeof p.filename!=='string'||p.filename.length>200||!p.filename.toLowerCase().endsWith('.apk')||/[\\/\x00-\x1f]/.test(p.filename)||!Number.isSafeInteger(p.size_bytes)||p.size_bytes<4||p.size_bytes>1024**3)return json({error:'Invalid APK metadata'},400);
      hashes.add(p.sha256);
    }
    const statements=[env.DB.prepare(`INSERT INTO apk_installers(connector_id,last_seen_at) VALUES(?,?) ON CONFLICT(connector_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`).bind(connectorId,now),env.DB.prepare('UPDATE apk_packages SET available=0 WHERE connector_id=?').bind(connectorId)];
    for(const p of data.packages)statements.push(env.DB.prepare(`INSERT INTO apk_packages(id,connector_id,filename,sha256,size_bytes,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(connector_id,sha256) DO UPDATE SET filename=excluded.filename,size_bytes=excluded.size_bytes,available=1,updated_at=excluded.updated_at`).bind(id(),connectorId,p.filename,p.sha256,p.size_bytes,now));
    await env.DB.batch(statements);
    await expireInstallations(env.DB,connectorId);
    return json({ok:true});
  }
  if(data.action==='claim') {
    const lease=id();
    const task=await env.DB.prepare(`UPDATE apk_installations SET status='running',lease_token=?,started_at=? WHERE id=(
      SELECT j.id FROM apk_installations j JOIN devices d ON d.id=j.device_id JOIN apk_packages p ON p.id=j.package_id
      WHERE j.connector_id=? AND j.status='queued' AND d.connection_mode='active' AND d.status='available'
      AND d.adb_state='device' AND d.connection_status='online' AND d.last_seen_at>? AND p.available=1
      ORDER BY j.created_at LIMIT 1) AND status='queued' RETURNING *`).bind(lease,now,connectorId,new Date(Date.now()-90000).toISOString()).first();
    return json({task:task||null});
  }
  if(data.action==='finish') {
    if(!['succeeded','failed','unknown'].includes(data.status)||typeof data.message!=='string'||data.message.length>1000)return json({error:'Invalid result'},400);
    const result=await env.DB.prepare(`UPDATE apk_installations SET status=?,message=?,finished_at=?
      WHERE id=? AND connector_id=? AND lease_token=? AND status IN ('running','unknown')`)
      .bind(data.status,data.message,now,data.task_id||'',connectorId,data.lease_token||'').run();
    if(!result.meta.changes) {
      const prior=await env.DB.prepare('SELECT status FROM apk_installations WHERE id=? AND connector_id=? AND lease_token=?').bind(data.task_id||'',connectorId,data.lease_token||'').first();
      if(!prior || prior.status!==data.status)return json({error:'Task lease is invalid'},409);
    }
    return json({ok:true});
  }
  return json({error:'Unknown action'},400);
}
