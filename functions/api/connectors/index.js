import { json } from '../_shared.js';
import { STALE_SECONDS } from '../_telemetry.js';

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare('SELECT * FROM device_connectors ORDER BY name').all();
  return json({ configured: Boolean(env.DEVICE_CONNECTOR_TOKEN?.length >= 32), stale_seconds: STALE_SECONDS,
    connectors: results.map(row => ({ ...row,
      status: Date.now() - Date.parse(row.last_seen_at) <= STALE_SECONDS * 1000 ? 'online' : 'offline' })) });
}
