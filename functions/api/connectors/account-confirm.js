import {json,id,body} from '../_shared.js';
import {authorized} from '../_telemetry.js';
import {connectorAccess} from '../_connectors.js';
export async function onRequestPost({env,request}){
  if(!await authorized(request,env))return json({error:'Invalid connector token'},401);
  const data=await body(request);
  const denied=await connectorAccess(request,env,data?.connector_id);if(denied)return denied;
  const run=await env.DB.prepare(`SELECT r.*,m.xhs_number FROM task_runs r JOIN devices d ON d.id=r.device_id JOIN device_account_members m ON m.device_id=r.device_id AND m.account_id=r.account_id JOIN work_accounts a ON a.id=r.account_id WHERE r.id=? AND r.connector_id=? AND d.connector_id=r.connector_id AND r.status='running' AND r.lease_token=? AND d.connection_mode='active' AND a.status='active'`).bind(data.run_id||'',data.connector_id,data.lease_token||'').first();
  if(!run||typeof data.xhs_number!=='string'||run.xhs_number.toLowerCase()!==data.xhs_number.toLowerCase()||JSON.parse(run.snapshot).xhs_number!==run.xhs_number)return json({error:'账号核验与当前执行任务不一致。'},409);
  await env.DB.batch([
    env.DB.prepare(`UPDATE account_device_sessions SET status='ended',ended_at=CURRENT_TIMESTAMP WHERE device_id=? AND status='active' AND account_id<>?`).bind(run.device_id,run.account_id),
    env.DB.prepare(`INSERT INTO account_device_sessions(id,account_id,device_id,note) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM account_device_sessions WHERE account_id=? AND device_id=? AND status='active')`).bind(id(),run.account_id,run.device_id,'执行器已读取个人页并核对小红书号：'+run.xhs_number,run.account_id,run.device_id)
  ]);
  return json({ok:true});
}
