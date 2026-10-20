import { badRequest, body, id, json, routeId } from "../_shared.js";

const allowed = new Set(["available", "maintenance", "disabled"]);

export async function onRequestGet({ env, params }) {
  const deviceId = routeId(params);
  if (deviceId) {
    const row = await env.DB.prepare("SELECT * FROM devices WHERE id = ?").bind(deviceId).first();
    return row ? json(row) : json({ error: "Device not found" }, 404);
  }
  const { results } = await env.DB.prepare("SELECT * FROM devices ORDER BY updated_at DESC").all();
  return json(results);
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
  if (!data || !allowed.has(data.status)) return badRequest("valid status is required");
  const result = await env.DB.prepare(
    "UPDATE devices SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).bind(data.status, deviceId).run();
  return result.meta.changes ? json({ ok: true }) : json({ error: "Device not found" }, 404);
}
