import { json } from './_shared.js';
import { authorizedControl } from './_telemetry.js';

export async function controlAccess(request, env) {
  if (!env.DEVICE_CONTROL_TOKEN) return json({ error:'Device control is not configured' },503);
  if (!await authorizedControl(request,env)) return json({ error:'设备控制码不正确或已失效，请重新授权。' },401);
  const origin=request.headers.get('origin');
  if(origin && origin!==new URL(request.url).origin) return json({error:'Cross-origin device controls are not allowed'},403);
  return null;
}

export async function expireInstallations(db, connectorId) {
  const cutoff=new Date(Date.now()-20*60*1000).toISOString();
  await db.prepare(`UPDATE apk_installations SET status='unknown',message='安装器未在时限内回报，请检查手机后再操作；不会自动重试。',finished_at=?
    WHERE connector_id=? AND status='running' AND started_at<?`).bind(new Date().toISOString(),connectorId,cutoff).run();
  await db.prepare(`UPDATE apk_installations SET status='failed',message='排队超过20分钟，任务已失效，请重新创建。',finished_at=?
    WHERE connector_id=? AND status='queued' AND created_at<?`).bind(new Date().toISOString(),connectorId,cutoff).run();
}
