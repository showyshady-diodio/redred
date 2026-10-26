import {json,body} from './_shared.js';
import {controlAccess} from './_installations.js';

export async function onRequestGet({env}){
  return json((await env.DB.prepare(`SELECT m.*,a.display_name,d.name device_name FROM device_account_members m JOIN work_accounts a ON a.id=m.account_id JOIN devices d ON d.id=m.device_id ORDER BY m.created_at,m.account_id`).all()).results);
}
export async function onRequestPost({env,request}){
  const denied=await controlAccess(request,env);if(denied)return denied;
  const data=await body(request);
  if(!data||typeof data.account_id!=='string'||typeof data.device_id!=='string')return json({error:'请选择设备和工作账号。'},400);
  const [account,device]=await Promise.all([
    env.DB.prepare('SELECT id FROM work_accounts WHERE id=?').bind(data.account_id).first(),
    env.DB.prepare('SELECT id FROM devices WHERE id=?').bind(data.device_id).first()
  ]);
  if(!account||!device)return json({error:'账号或设备不存在。'},404);
  // A group may be configured only while its device and account are idle.
  const busy=await env.DB.prepare(`SELECT id FROM task_runs WHERE (device_id=? OR account_id=?) AND status IN ('queued','running') LIMIT 1`).bind(device.id,account.id).first();
  if(busy)return json({error:'请先完成或取消该设备、账号的任务。'},409);
  const old=await env.DB.prepare('SELECT * FROM device_account_members WHERE account_id=?').bind(account.id).first();
  if(old&&old.device_id!==device.id)return json({error:'账号已固定到其他设备；请先从原设备账号组移除。'},409);
  if(data.action==='remove'){
    try{await env.DB.prepare('DELETE FROM device_account_members WHERE account_id=? AND device_id=?').bind(account.id,device.id).run();}
    catch(error){if(/group busy/.test(error.message))return json({error:'设备或账号已有任务，请完成后再移出。'},409);throw error;}
    return json({ok:true});
  }
  if(typeof data.xhs_number!=='string'||!/^[-\w]{1,64}$/.test(data.xhs_number.trim()))return json({error:'请输入个人页显示的小红书号（不是手机号或昵称）。'},400);
  if(data.saved_login_confirmed!==true)return json({error:'请确认该账号已在此手机登录并保留在切换账号列表。'},400);
  try{
    await env.DB.prepare(`INSERT INTO device_account_members(account_id,device_id,xhs_number)VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET xhs_number=excluded.xhs_number`).bind(account.id,device.id,data.xhs_number.trim()).run();
    return json({ok:true});
  }catch(error){if(/UNIQUE/.test(error.message))return json({error:'此小红书号已被其他工作账号登记。'},409);if(/group busy/.test(error.message))return json({error:'设备或账号已有任务，请完成后再修改。'},409);throw error;}
}
