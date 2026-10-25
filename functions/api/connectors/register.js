import { id,json } from '../_shared.js';
import { controlAccess } from '../_installations.js';
import { smallBody } from '../_tasks.js';

export async function onRequestPost({env,request}){
  const denied=await controlAccess(request,env);if(denied)return denied;
  const data=await smallBody(request);
  if(typeof data?.name!=='string'||!data.name.trim()||data.name.length>100)return json({error:'请填写100字以内的电脑名称。'},400);
  if(!env.DEVICE_CONNECTOR_TOKEN||env.DEVICE_CONNECTOR_TOKEN.length<32)return json({error:'Connector token is not configured'},503);
  if(data.request_id&&!/^[a-f0-9-]{36}$/i.test(data.request_id))return json({error:'Invalid request ID'},400);
  const connectorId='test-'+(data.request_id||id());
  const prior=await env.DB.prepare('SELECT name FROM device_connectors WHERE id=?').bind(connectorId).first();
  if(prior&&prior.name!==data.name.trim())return json({error:'Request ID is already used'},409);
  await env.DB.prepare(`INSERT OR IGNORE INTO device_connectors(id,name,last_seen_at)VALUES(?,?,'1970-01-01T00:00:00Z')`).bind(connectorId,data.name.trim()).run();
  return json({connector_id:connectorId,config:{api_url:new URL(request.url).origin,connector_id:connectorId,agent_name:data.name.trim(),adb_path:'adb',appium_url:'http://127.0.0.1:4723',interval_seconds:20,apk_roots:['./apks'],work_dir:'./work',token:env.DEVICE_CONNECTOR_TOKEN}},201);
}
