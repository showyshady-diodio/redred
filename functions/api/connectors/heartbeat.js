import { badRequest, body, id, json } from '../_shared.js';
import { authorized } from '../_telemetry.js';

const text = (value, max = 200) => typeof value === 'string' && value.length <= max;

export async function onRequestPost({ request, env }) {
  if (!env.DEVICE_CONNECTOR_TOKEN || env.DEVICE_CONNECTOR_TOKEN.length < 32) {
    return json({ error: 'DEVICE_CONNECTOR_TOKEN is not configured (minimum 32 characters)' }, 503);
  }
  if (!await authorized(request, env)) return json({ error: 'Invalid connector token' }, 401);
  // Bound the streamed body as Content-Length is optional and not trusted.
  const reader = request.body?.getReader();
  if (!reader) return badRequest('JSON body is required');
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65536) { await reader.cancel(); return json({ error: 'Payload too large' }, 413); }
    chunks.push(value);
  }
  const data = await body(new Response(new Blob(chunks)));
  const connectorId = env.DEVICE_CONNECTOR_ID || 'local-adb';
  if (!data || data.connector_id !== connectorId || !text(data.agent_name, 100) || !data.agent_name.trim() ||
      !Array.isArray(data.devices) || data.devices.length > 50 ||
      !text(data.adb_version || '') || !['ready', 'unavailable', 'not_configured'].includes(data.appium_status) ||
      !text(data.last_error || '', 500)) return badRequest('Invalid connector snapshot');
  const seen = new Set();
  for (const d of data.devices) {
    if (!d || !/^adb-[a-f0-9]{64}$/.test(d.device_ref) || seen.has(d.device_ref) ||
        !['online', 'attention'].includes(d.connection_status) ||
        !['usb', 'wireless', 'emulator'].includes(d.connection_type) ||
        !['device', 'offline', 'unauthorized', 'error'].includes(d.adb_state) ||
        !text(d.name, 100) || !d.name.trim() ||
        !['manufacturer', 'model', 'os', 'os_version', 'screen_resolution', 'sdk_version', 'adb_address'].every(k => text(d[k] || '')) ||
        !text(d.collection_error || '', 500) ||
        !(d.battery_percent == null || (Number.isInteger(d.battery_percent) && d.battery_percent >= 0 && d.battery_percent <= 100)) ||
        !(d.charging == null || typeof d.charging === 'boolean') ||
        !(d.collected_at == null || (text(d.collected_at, 40) && Number.isFinite(Date.parse(d.collected_at))))) {
      return badRequest('Invalid or duplicate device telemetry');
    }
    seen.add(d.device_ref);
  }
  if (seen.size) {
    const refs = [...seen];
    const { results } = await env.DB.prepare(`SELECT device_ref FROM devices WHERE device_ref IN (${refs.map(() => '?').join(',')}) AND connector_id <> ?`)
      .bind(...refs, connectorId).all();
    if (results.length) return json({ error: 'Device belongs to another connector' }, 409);
  }
  const now = new Date().toISOString();
  const statements = [env.DB.prepare(`INSERT INTO device_connectors
    (id, name, last_seen_at, device_count, adb_version, appium_status, last_error) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, last_seen_at=excluded.last_seen_at,
    device_count=excluded.device_count, adb_version=excluded.adb_version, appium_status=excluded.appium_status, last_error=excluded.last_error`)
    .bind(connectorId, data.agent_name.trim(), now, seen.size, data.adb_version || '', data.appium_status, data.last_error || ''),
    env.DB.prepare("UPDATE devices SET connection_status='offline', adb_state='offline' WHERE connector_id=? AND connection_status<>'offline'").bind(connectorId)];
  for (const d of data.devices) {
    statements.push(env.DB.prepare(`INSERT INTO devices
      (id, name, device_ref, connector_id, manufacturer, model, os, os_version, connection_status, agent_name,
       last_seen_at, battery_percent, screen_resolution, connection_type, adb_address, adb_state, charging, sdk_version, collected_at, collection_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_ref) DO UPDATE SET
        manufacturer=COALESCE(NULLIF(excluded.manufacturer,''),devices.manufacturer),
        model=COALESCE(NULLIF(excluded.model,''),devices.model),
        os=COALESCE(NULLIF(excluded.os,''),devices.os), os_version=COALESCE(NULLIF(excluded.os_version,''),devices.os_version),
        connection_status=excluded.connection_status, agent_name=excluded.agent_name,
        last_seen_at=CASE WHEN excluded.adb_state='device' THEN excluded.last_seen_at ELSE devices.last_seen_at END,
        battery_percent=CASE WHEN excluded.adb_state='device' THEN excluded.battery_percent ELSE devices.battery_percent END,
        screen_resolution=COALESCE(NULLIF(excluded.screen_resolution,''),devices.screen_resolution),
        connection_type=excluded.connection_type, adb_address=excluded.adb_address, adb_state=excluded.adb_state,
        charging=CASE WHEN excluded.adb_state='device' THEN excluded.charging ELSE devices.charging END,
        sdk_version=COALESCE(NULLIF(excluded.sdk_version,''),devices.sdk_version),
        collected_at=COALESCE(excluded.collected_at,devices.collected_at), collection_error=excluded.collection_error,
        updated_at=excluded.updated_at`)
      .bind(id(), d.name, d.device_ref, connectorId, d.manufacturer || '', d.model || '', d.os || '', d.os_version || '',
        d.connection_status, data.agent_name.trim(), d.adb_state === 'device' ? now : null, d.battery_percent ?? null,
        d.screen_resolution || '', d.connection_type, d.adb_address || '', d.adb_state,
        d.charging == null ? null : Number(d.charging), d.sdk_version || '', d.collected_at || null, d.collection_error || ''));
  }
  await env.DB.batch(statements);
  return json({ ok: true, received: seen.size, server_time: now });
}
