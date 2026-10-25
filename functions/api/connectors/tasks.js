import { id,json } from '../_shared.js';
import { authorized } from '../_telemetry.js';
import { smallBody,expireTaskRuns,actionKinds } from '../_tasks.js';
import { connectorAccess } from '../_connectors.js';

export async function onRequestPost({env,request}){
  if(!await authorized(request,env))return json({error:'Invalid connector token'},401);
  const data=await smallBody(request),connectorId=data?.connector_id;
  const denied=await connectorAccess(request,env,connectorId);if(denied)return denied;
  const now=new Date().toISOString();
  await env.DB.prepare('INSERT INTO task_workers(connector_id,last_seen_at)VALUES(?,?) ON CONFLICT(connector_id) DO UPDATE SET last_seen_at=excluded.last_seen_at').bind(connectorId,now).run();
  await expireTaskRuns(env.DB,connectorId);
  if(data.action==='heartbeat'){
    if(data.run_id&&data.lease_token)await env.DB.prepare(`UPDATE task_runs SET updated_at=? WHERE id=? AND connector_id=? AND lease_token=? AND status='running'`).bind(now,data.run_id,connectorId,data.lease_token).run();
    return json({ok:true});
  }
  if(data.action==='claim'){
    const task=await env.DB.prepare(`UPDATE task_runs SET status='running',lease_token=?,started_at=?,updated_at=? WHERE id=(
      SELECT r.id FROM task_runs r JOIN devices d ON d.id=r.device_id JOIN work_accounts a ON a.id=r.account_id
      WHERE r.connector_id=? AND d.connector_id=r.connector_id AND r.status='queued' AND d.connection_mode='active' AND d.status='available' AND d.adb_state='device' AND d.last_seen_at>?
      AND a.status='active' AND EXISTS(SELECT 1 FROM account_device_sessions s WHERE s.device_id=r.device_id AND s.account_id=r.account_id AND s.status='active')
      AND NOT EXISTS(SELECT 1 FROM task_runs busy WHERE busy.connector_id=r.connector_id AND busy.status='running')
      AND NOT EXISTS(SELECT 1 FROM apk_installations i WHERE i.device_id=r.device_id AND i.status IN ('queued','running'))
      ORDER BY r.created_at,r.id LIMIT 1) AND status='queued' RETURNING *`).bind(id(),now,now,connectorId,new Date(Date.now()-90000).toISOString()).first();
    return json({task:task?{...task,snapshot:JSON.parse(task.snapshot)}:null});
  }
  if(!['progress','finish'].includes(data.action))return json({error:'Unknown action'},400);
  const run=await env.DB.prepare('SELECT * FROM task_runs WHERE id=? AND connector_id=? AND lease_token=?').bind(data.run_id||'',connectorId,data.lease_token||'').first();
  if(!run)return json({error:'Invalid execution lease'},409);
  if(!['running','unknown'].includes(run.status))return data.action==='finish'&&run.status===data.status?json({ok:true}):json({error:'Execution is already closed'},409);
  const requested=JSON.parse(run.snapshot).actions,results=data.results||{};
  if(typeof results!=='object'||Array.isArray(results)||Object.entries(results).some(([k,v])=>!requested.includes(k)||!['performed','skipped'].includes(v)))return json({error:'Invalid action results'},400);
  if(data.action==='finish'&&(!['succeeded','failed','unknown'].includes(data.status)||typeof data.message!=='string'||data.message.length>1000))return json({error:'Invalid execution result'},400);
  const existing=(await env.DB.prepare('SELECT action,outcome FROM task_run_actions WHERE run_id=?').bind(run.id).all()).results;
  for(const [kind,outcome] of Object.entries(results))if(existing.some(x=>x.action===kind&&!['pending',outcome].includes(x.outcome)))return json({error:'Confirmed result cannot be changed'},409);
  const completed=kind=>results[kind]||existing.find(x=>x.action===kind)?.outcome;
  if(data.status==='succeeded'&&!requested.every(k=>['performed','skipped'].includes(completed(k))))return json({error:'Success requires every requested action to be confirmed'},400);
  const statements=Object.entries(results).map(([kind,outcome])=>env.DB.prepare(`UPDATE task_run_actions SET outcome=?,confirmed_at=? WHERE run_id=? AND action=? AND outcome='pending'`).bind(outcome,now,run.id,kind));
  if(data.action==='finish'){
    if(data.current_action&&!actionKinds.includes(data.current_action))return json({error:'Invalid current action'},400);
    statements.push(env.DB.prepare(`UPDATE task_run_actions SET outcome=CASE WHEN action=? THEN 'unknown' ELSE 'not_run' END WHERE run_id=? AND outcome='pending'`).bind(data.current_action||'',run.id));
    statements.push(env.DB.prepare(`UPDATE task_runs SET status=?,message=?,updated_at=?,finished_at=?,resolved_note_id=?,resolved_title=?,resolved_author=? WHERE id=?`).bind(data.status,data.message,now,now,String(data.note_id||'').slice(0,24),String(data.title||'').slice(0,500),String(data.author||'').slice(0,120),run.id));
  }else statements.push(env.DB.prepare(`UPDATE task_runs SET updated_at=? WHERE id=?`).bind(now,run.id));
  await env.DB.batch(statements);return json({ok:true});
}
