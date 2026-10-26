import {json} from './_shared.js';
import {controlAccess} from './_installations.js';
export async function onRequestGet({env}){
  return json((await env.DB.prepare(`SELECT m.*,a.display_name,d.name device_name FROM device_account_members m JOIN work_accounts a ON a.id=m.account_id JOIN devices d ON d.id=m.device_id ORDER BY m.created_at,m.account_id`).all()).results);
}
export async function onRequestPost({env,request}){
  const denied=await controlAccess(request,env);if(denied)return denied;
  return json({error:'请刷新页面：先在工作账号中编组，再到设备绑定账号组或单个账号。'},410);
}
