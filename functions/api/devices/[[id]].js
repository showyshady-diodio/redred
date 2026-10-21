import { badRequest, body, id, json, routeId } from "../_shared.js";
import { authorizedControl, effectiveDevice } from "../_telemetry.js";

const allowed = new Set(["available", "maintenance", "disabled"]);

export async function onRequestGet({ env, params }) {
  const deviceId = routeId(params);
  if (deviceId) {
    const row = await env.DB.prepare("SELECT * FROM devices WHERE id = ?").bind(deviceId).first();
    return row ? json(effectiveDevice(row)) : json({ error: "Device not found" }, 404);
  }
  const { results } = await env.DB.prepare("SELECT * FROM devices ORDER BY updated_at DESC").all();
  return json(results.map(effectiveDevice));
}

export async function onRequestPost({ request, env }) {
  const data = await body(request);
  if (!data?.name?.trim()) return badRequest("name is required");
  const deviceId = id();
  await env.DB.prepare(
    "INSERT INTO devices (id, name, manufacturer, model, os, os_version, notes) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(deviceId, data.name.trim(), data.manufacturer?.trim() || "", data.model?.trim() || "", data.os?.trim() || "", data.os_version?.trim() || "", data.notes?.trim() || "").run();
  return json({ id: deviceId }, 201);
}

export async function onRequestPatch({ request, env, params }) {
  const deviceId = routeId(params);
  if (!deviceId) return badRequest("device id is required");
  const data = await body(request);
  if (data?.connection_action !== undefined) {
    if (!env.DEVICE_CONTROL_TOKEN || env.DEVICE_CONTROL_TOKEN.length < 32) return json({ error: 'Device control is not configured' }, 503);
    if (!await authorizedControl(request, env)) return json({ error: '设备控制码不正确或已失效，请重新授权。' }, 401);
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) return json({ error: 'Cross-origin device controls are not allowed' }, 403);
    if (!['pause', 'resume'].includes(data.connection_action) || Object.keys(data).length !== 1) {
      return badRequest('connection_action must be pause or resume and supplied alone');
    }
    const device = await env.DB.prepare('SELECT connector_id, connection_type FROM devices WHERE id = ?').bind(deviceId).first();
    if (!device) return json({ error: 'Device not found' }, 404);
    if (!device.connector_id || device.connection_type !== 'wireless') {
      return json({ error: 'Connection controls require an enrolled wireless device' }, 409);
    }
    const mode = data.connection_action === 'pause' ? 'paused' : 'active';
    await env.DB.prepare(`UPDATE devices SET connection_mode = ?, control_revision = control_revision + 1,
      control_changed_at = ?, control_error = '', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND connection_mode <> ?`).bind(mode, new Date().toISOString(), deviceId, mode).run();
    const row = await env.DB.prepare('SELECT * FROM devices WHERE id = ?').bind(deviceId).first();
    return json(effectiveDevice(row));
  }
  if (!data || (data.status !== undefined && !allowed.has(data.status)) ||
      (data.name !== undefined && (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 100)) ||
      (data.notes !== undefined && (typeof data.notes !== 'string' || data.notes.length > 2000)) ||
      !['status','name','notes'].some(key => data[key] !== undefined)) return badRequest("valid status, name or notes is required");
  const result = await env.DB.prepare(
    "UPDATE devices SET status = COALESCE(?, status), name = COALESCE(?, name), notes = COALESCE(?, notes), updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).bind(data.status ?? null, data.name?.trim() ?? null, data.notes ?? null, deviceId).run();
  return result.meta.changes ? json({ ok: true }) : json({ error: "Device not found" }, 404);
}
