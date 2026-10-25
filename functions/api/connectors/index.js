import { json } from '../_shared.js';
import { STALE_SECONDS } from '../_telemetry.js';

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare('SELECT c.*,w.last_seen_at AS task_worker_last_seen_at FROM device_connectors c LEFT JOIN task_workers w ON w.connector_id=c.id ORDER BY c.name').all();
  return json({ configured: Boolean(env.DEVICE_CONNECTOR_TOKEN?.length >= 32), stale_seconds: STALE_SECONDS,
    connectors: results.map(({instance_id,instance_seen_at,...row}) => ({ ...row,role:row.id===(env.DEVICE_CONNECTOR_ID||'local-adb')?'primary':'test',task_worker_online:Boolean(row.enabled&&row.task_worker_last_seen_at&&Date.now()-Date.parse(row.task_worker_last_seen_at)<=90000),
      status: !row.enabled?'disabled':Date.now() - Date.parse(row.last_seen_at) <= STALE_SECONDS * 1000 ? 'online' : 'offline' })) });
}
