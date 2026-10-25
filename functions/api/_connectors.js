import { json } from './_shared.js';

export const validConnectorId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(value);
export async function connectorAccess(request,env,connectorId){
  if(!validConnectorId(connectorId))return json({error:'Invalid connector ID'},400);
  const primary=env.DEVICE_CONNECTOR_ID||'local-adb';
  let row=await env.DB.prepare('SELECT * FROM device_connectors WHERE id=?').bind(connectorId).first();
  if(!row&&connectorId===primary){
    await env.DB.prepare(`INSERT OR IGNORE INTO device_connectors(id,name,last_seen_at)VALUES(?,?,'1970-01-01T00:00:00Z')`).bind(connectorId,connectorId).run();
    row=await env.DB.prepare('SELECT * FROM device_connectors WHERE id=?').bind(connectorId).first();
  }
  if(!row)return json({error:'请先在后台接入此电脑，使用下载配置中的连接器编号。'},400);
  if(!row.enabled)return json({error:'此电脑已停用，请在后台恢复接入。'},403);
  const instance=request.headers.get('x-connector-instance')||'';
  // The original primary connector remains compatible until the updated clients first claim it.
  if(!instance)return connectorId===primary&&!row.instance_id?null:json({error:'请更新并重启本机连接器；缺少电脑实例编号。'},409);
  if(!/^[a-f0-9-]{36}$/i.test(instance))return json({error:'Invalid computer instance'},400);
  const now=new Date().toISOString();
  const changed=await env.DB.prepare(`UPDATE device_connectors SET instance_id=?,instance_seen_at=? WHERE id=? AND enabled=1
    AND (instance_id='' OR instance_id=? OR instance_seen_at IS NULL OR instance_seen_at<?)`)
    .bind(instance,now,connectorId,instance,new Date(Date.now()-90000).toISOString()).run();
  return changed.meta.changes?null:json({error:'此连接器编号正在另一台电脑使用，请为测试电脑下载独立配置，勿复制主电脑配置。'},409);
}
