import { json } from '../_shared.js';
import { authorized } from '../_telemetry.js';

export async function onRequestGet({ request, env }) {
  if (!await authorized(request, env)) return json({ error: 'Invalid connector token' }, 401);
  const connectorId = env.DEVICE_CONNECTOR_ID || 'local-adb';
  const { results } = await env.DB.prepare(`SELECT device_ref, connection_mode, control_revision
    FROM devices WHERE connector_id = ? ORDER BY id`).bind(connectorId).all();
  return json({ connector_id: connectorId, controls: results });
}
