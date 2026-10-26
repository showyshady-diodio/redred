import { json,routeId } from '../_shared.js';
import { effectiveDevice } from '../_telemetry.js';
import { controlAccess } from '../_installations.js';
import { decodeRun,runSelect,smallBody,expireTaskRuns } from '../_tasks.js';

export async function onRequestGet({env,request,params}){
  for(const c of (await env.DB.prepare('SELECT id FROM device_connectors').all()).results)await expireTaskRuns(env.DB,c.id);
  const runId=routeId(params),query=new URL(request.url).searchParams;
  const task=query.get('task_id'),account=query.get('account_id');
  const rows=(await env.DB.prepare(runSelect+(runId?' WHERE r.id=?':task?' WHERE r.task_id=?':account?' WHERE r.account_id=?':'')+' ORDER BY r.created_at DESC,r.id DESC LIMIT 200').bind(...(runId?[runId]:task?[task]:account?[account]:[])).all()).results.map(decodeRun);
  return runId?(rows[0]?json(rows[0]):json({error:'Run not found'},404)):json(rows);
}
export async function onRequestPost({env,request}){
  const denied=await controlAccess(request,env);if(denied)return denied;
  const data=await smallBody(request);
  if(!data||!['request_id','task_id','device_id','account_id'].every(k=>typeof data[k]==='string'&&/^[\w-]{1,100}$/.test(data[k]))||data.request_id.length<16)return json({error:'Invalid execution request'},400);
  const prior=await env.DB.prepare('SELECT id,task_id,device_id,account_id,status FROM task_runs WHERE id=?').bind(data.request_id).first();
  if(prior)return prior.task_id===data.task_id&&prior.device_id===data.device_id&&prior.account_id===data.account_id?json(prior):json({error:'Request ID is already used'},409);
  const task=await env.DB.prepare('SELECT * FROM note_tasks WHERE id=?').bind(data.task_id).first();
  if(!task)return json({error:'Task not found'},404);
  const device=effectiveDevice(await env.DB.prepare('SELECT * FROM devices WHERE id=?').bind(data.device_id).first());
  if(!device||device.status!=='available'||device.connection_status!=='online'||device.connection_mode!=='active'||!device.connector_id)return json({error:'请选择在线、可用且未暂停的设备。'},409);
  const account=await env.DB.prepare(`SELECT a.id,m.xhs_number FROM work_accounts a LEFT JOIN device_account_members m ON m.account_id=a.id AND m.device_id=? WHERE a.id=? AND a.status='active' AND (m.account_id IS NOT NULL OR EXISTS(SELECT 1 FROM account_device_sessions s WHERE s.account_id=a.id AND s.device_id=? AND s.status='active')) LIMIT 1`).bind(device.id,data.account_id,device.id).first();
  if(!account)return json({error:'所选账号未在此设备确认登录；请先完成手工登录并绑定。'},409);
  const fixed=await env.DB.prepare('SELECT device_id FROM device_account_members WHERE account_id=?').bind(account.id).first();
  if(fixed&&fixed.device_id!==device.id)return json({error:'该账号已固定到其他设备。'},409);
  const binding=await env.DB.prepare('SELECT device_id FROM device_account_bindings WHERE device_id=?').bind(device.id).first();
  if(binding&&!fixed)return json({error:'请选择设备所绑定账号组内的账号，或所绑定的单个账号。'},409);
  await expireTaskRuns(env.DB,device.connector_id);
  const worker=await env.DB.prepare('SELECT last_seen_at FROM task_workers WHERE connector_id=?').bind(device.connector_id).first();
  const computer=await env.DB.prepare('SELECT enabled FROM device_connectors WHERE id=?').bind(device.connector_id).first();
  if(!worker||!computer?.enabled||Date.now()-Date.parse(worker.last_seen_at)>90000)return json({error:'设备所属电脑未启用或任务执行器未在线，请先启动执行器。'},409);
  const now=new Date().toISOString();
  const snapshot={name:task.name,note_url:task.note_url,expected_title:task.expected_title,expected_author:task.expected_author,actions:JSON.parse(task.actions),...(account.xhs_number?{xhs_number:account.xhs_number}:{})};
  try{
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO task_runs(id,task_id,device_id,account_id,connector_id,snapshot,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?)`).bind(data.request_id,task.id,device.id,account.id,device.connector_id,JSON.stringify(snapshot),now,now),
      ...snapshot.actions.map(a=>env.DB.prepare('INSERT INTO task_run_actions(run_id,action)VALUES(?,?)').bind(data.request_id,a))
    ]);
  }catch(error){if(/UNIQUE|constraint|device has|device owner|device account group/i.test(error.message))return json({error:'设备或账号已有待执行任务、设备正在安装 APK 或设备归属已改变，请刷新后重试。'},409);throw error;}
  return json({id:data.request_id,status:'queued'},201);
}
export async function onRequestPatch({env,request,params}){
  const denied=await controlAccess(request,env);if(denied)return denied;
  const data=await smallBody(request);if(data?.action!=='cancel')return json({error:'Only queued executions can be cancelled'},400);
  const result=await env.DB.prepare(`UPDATE task_runs SET status='cancelled',message='已取消，未执行。',finished_at=? WHERE id=? AND status='queued'`).bind(new Date().toISOString(),routeId(params)).run();
  if(result.meta.changes)await env.DB.prepare(`UPDATE task_run_actions SET outcome='not_run' WHERE run_id=? AND outcome='pending'`).bind(routeId(params)).run();
  return result.meta.changes?json({ok:true}):json({error:'仅等待中的执行可以取消，请刷新状态。'},409);
}
