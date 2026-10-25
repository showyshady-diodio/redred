import { body,json } from './_shared.js';
import { effectiveDevice } from './_telemetry.js';
import { controlAccess,expireInstallations } from './_installations.js';

export async function onRequestGet({env,request}) {
  const deviceId=new URL(request.url).searchParams.get('device_id');
  const query=`SELECT id,device_id,filename,sha256,size_bytes,status,message,created_at,started_at,finished_at FROM apk_installations`;
  const statement=deviceId?env.DB.prepare(query+' WHERE device_id=? ORDER BY created_at DESC LIMIT 30').bind(deviceId):env.DB.prepare(query+' ORDER BY created_at DESC LIMIT 50');
  return json((await statement.all()).results);
}

export async function onRequestPost({env,request}) {
  const denied=await controlAccess(request,env);if(denied)return denied;
  if(Number(request.headers.get('content-length'))>4096)return json({error:'Payload too large'},413);
  const data=await body(request);
  if(!data || !/^[a-zA-Z0-9-]{1,100}$/.test(data.device_id||'') || !/^[a-zA-Z0-9-]{1,100}$/.test(data.package_id||'') || !/^[a-zA-Z0-9-]{16,100}$/.test(data.request_id||''))return json({error:'Invalid installation request'},400);
  const prior=await env.DB.prepare('SELECT id,device_id,package_id,status FROM apk_installations WHERE id=?').bind(data.request_id).first();
  if(prior)return prior.device_id===data.device_id && prior.package_id===data.package_id?json(prior):json({error:'Request ID is already used'},409);
  const device=effectiveDevice(await env.DB.prepare('SELECT * FROM devices WHERE id=?').bind(data.device_id).first());
  if(!device)return json({error:'Device not found'},404);
  if(device.connection_mode!=='active' || device.connection_status!=='online' || device.status!=='available')return json({error:'请先恢复设备连接，并确认设备在线且处于可用状态。'},409);
  const apk=await env.DB.prepare(`SELECT p.*,i.last_seen_at FROM apk_packages p JOIN apk_installers i ON i.connector_id=p.connector_id WHERE p.id=? AND p.available=1`).bind(data.package_id).first();
  const computer=await env.DB.prepare('SELECT enabled FROM device_connectors WHERE id=?').bind(device.connector_id).first();
  if(!computer?.enabled||!apk || apk.connector_id!==device.connector_id || Date.now()-Date.parse(apk.last_seen_at)>90000)return json({error:'电脑已停用、安装器未在线，或该安装包不属于这台设备的电脑。'},409);
  await expireInstallations(env.DB,device.connector_id);
  try {
    const now=new Date().toISOString();
    const result=await env.DB.prepare(`INSERT INTO apk_installations(id,device_id,connector_id,device_ref,package_id,filename,sha256,size_bytes,status,created_at)
      SELECT ?,id,connector_id,device_ref,?,?,?,?, 'queued',? FROM devices WHERE id=? AND connection_mode='active' AND status='available'`)
      .bind(data.request_id,apk.id,apk.filename,apk.sha256,apk.size_bytes,now,device.id).run();
    if(!result.meta.changes)return json({error:'设备状态已改变，请刷新后重试。'},409);
  } catch(error) {
    if(/UNIQUE|constraint|device has|device owner/i.test(error.message))return json({error:'该设备已有安装或笔记执行任务，或设备归属已改变，请刷新后重试。'},409);
    throw error;
  }
  return json({id:data.request_id,status:'queued'},201);
}
