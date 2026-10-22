import { badRequest, body, id, json, routeId } from "../_shared.js";
import { controlAccess } from '../_installations.js';
import { effectiveDevice } from '../_telemetry.js';

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    `SELECT s.*, CASE WHEN a.phone_number <> '' THEN a.phone_country_code || ' ' || a.phone_number ELSE a.handle END AS account_handle, d.name AS device_name
     FROM account_device_sessions s
     JOIN work_accounts a ON a.id = s.account_id
     JOIN devices d ON d.id = s.device_id
     ORDER BY s.login_confirmed_at DESC`
  ).all();
  return json(results);
}

export async function onRequestPost({ request, env }) {
  const denied=await controlAccess(request,env);if(denied)return denied;
  const data = await body(request);
  if (!data?.account_id || !data?.device_id) return badRequest("account_id and device_id are required");
  if(data.login_confirmed!==true)return badRequest('请先在指定手机完成登录，并勾选已核对登录账号。');
  if(typeof data.note!=='undefined' && (typeof data.note!=='string'||data.note.length>2000))return badRequest('Invalid login note');
  const [account, device] = await Promise.all([
    env.DB.prepare("SELECT id,platform,status FROM work_accounts WHERE id = ?").bind(data.account_id).first(),
    env.DB.prepare("SELECT * FROM devices WHERE id = ?").bind(data.device_id).first(),
  ]);
  if (!account || !device) return json({ error: "Account or device not found" }, 404);
  if(!['active','verification_needed'].includes(account.status))return json({error:'该工作账号已暂停或停用。'},409);
  if(device.status!=='available'||device.connection_mode!=='active'||effectiveDevice(device).connection_status!=='online')return json({error:'请先恢复设备连接，确认设备在线且可用。'},409);
  const sessionId = id();
  await env.DB.batch([
    env.DB.prepare(`UPDATE account_device_sessions SET status='ended',ended_at=CURRENT_TIMESTAMP
      WHERE device_id=? AND status='active' AND account_id<>? AND account_id IN (SELECT id FROM work_accounts WHERE platform=?)`)
      .bind(device.id,account.id,account.platform),
    env.DB.prepare(`INSERT INTO account_device_sessions(id,account_id,device_id,status,note)
      SELECT ?,?,?,'active',? WHERE NOT EXISTS(SELECT 1 FROM account_device_sessions WHERE account_id=? AND device_id=? AND status='active')`)
      .bind(sessionId,account.id,device.id,data.note?.trim()||'运营人员已在手机核对账号并手工确认登录。',account.id,device.id),
    env.DB.prepare("UPDATE work_accounts SET status='active',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='verification_needed'").bind(account.id),
  ]);
  const session=await env.DB.prepare("SELECT id FROM account_device_sessions WHERE account_id=? AND device_id=? AND status='active' ORDER BY login_confirmed_at DESC LIMIT 1").bind(account.id,device.id).first();
  return json({id:session.id,confirmation_method:'manual'},session.id===sessionId?201:200);
}

export async function onRequestPatch({ request, env, params }) {
  const denied=await controlAccess(request,env);if(denied)return denied;
  const sessionId = routeId(params);
  if (!sessionId) return badRequest("session id is required");
  const data = await body(request);
  if (data?.status !== "ended" && data?.status !== "verification_needed") return badRequest("status must be ended or verification_needed");
  const result = await env.DB.prepare(
    "UPDATE account_device_sessions SET status = ?, ended_at = CASE WHEN ? = 'ended' THEN CURRENT_TIMESTAMP ELSE ended_at END WHERE id = ? AND status = 'active'"
  ).bind(data.status, data.status, sessionId).run();
  return result.meta.changes ? json({ ok: true }) : json({ error: "Active session not found" }, 404);
}
