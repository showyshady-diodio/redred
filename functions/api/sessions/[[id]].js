import { badRequest, body, id, json, routeId } from "../_shared.js";

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    `SELECT s.*, CASE WHEN a.phone_number <> '' THEN a.phone_country_code || ' ' || a.phone_number ELSE a.handle END AS account_handle, d.name AS device_name
     FROM account_device_sessions s
     JOIN work_accounts a ON a.id = s.account_id
     JOIN devices d ON d.id = s.device_id
     ORDER BY s.login_confirmed_at DESC`
  ).all();
  return json(results);
}

export async function onRequestPost({ request, env }) {
  const data = await body(request);
  if (!data?.account_id || !data?.device_id) return badRequest("account_id and device_id are required");
  const [account, device] = await Promise.all([
    env.DB.prepare("SELECT id FROM work_accounts WHERE id = ?").bind(data.account_id).first(),
    env.DB.prepare("SELECT id, status FROM devices WHERE id = ?").bind(data.device_id).first(),
  ]);
  if (!account || !device) return json({ error: "Account or device not found" }, 404);
  if (device.status !== "available") return json({ error: "Device is not available" }, 409);
  const sessionId = id();
  await env.DB.prepare(
    "INSERT INTO account_device_sessions (id, account_id, device_id, status, note) VALUES (?, ?, ?, 'active', ?)"
  ).bind(sessionId, data.account_id, data.device_id, data.note?.trim() || "").run();
  return json({ id: sessionId }, 201);
}

export async function onRequestPatch({ request, env, params }) {
  const sessionId = routeId(params);
  if (!sessionId) return badRequest("session id is required");
  const data = await body(request);
  if (data?.status !== "ended" && data?.status !== "verification_needed") return badRequest("status must be ended or verification_needed");
  const result = await env.DB.prepare(
    "UPDATE account_device_sessions SET status = ?, ended_at = CASE WHEN ? = 'ended' THEN CURRENT_TIMESTAMP ELSE ended_at END WHERE id = ? AND status = 'active'"
  ).bind(data.status, data.status, sessionId).run();
  return result.meta.changes ? json({ ok: true }) : json({ error: "Active session not found" }, 404);
}
