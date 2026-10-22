import { badRequest, body, id, json, routeId } from "../_shared.js";
import { statisticsSQL } from '../_tasks.js';

const allowed = new Set(["active", "paused", "verification_needed", "disabled"]);

export async function onRequestGet({ request, env, params }) {
  const accountId = routeId(params);
  if (accountId) {
    const row = await env.DB.prepare("SELECT * FROM work_accounts WHERE id = ?").bind(accountId).first();
    return row ? json(row) : json({ error: "Account not found" }, 404);
  }
  const { results } = await env.DB.prepare(`SELECT a.*,COALESCE(s.execution_count,0) execution_count,COALESCE(s.succeeded_count,0) succeeded_count,
    COALESCE(s.like_count,0) like_count,COALESCE(s.collect_count,0) collect_count,COALESCE(s.follow_count,0) follow_count
    FROM work_accounts a LEFT JOIN (${statisticsSQL('account_id')}) s ON s.owner_id=a.id ORDER BY a.updated_at DESC`).all();
  return json(results);
}

export async function onRequestPost({ request, env }) {
  const data = await body(request);
  if (!data?.phone_country_code?.trim() || !data?.phone_number?.trim()) return badRequest("country code and phone number are required");
  const accountId = id();
  const countryCode = data.phone_country_code.trim();
  const phoneNumber = data.phone_number.trim();
  const handle = `${countryCode}:${phoneNumber}`;
  try {
    await env.DB.prepare(
      "INSERT INTO work_accounts (id, platform, handle, phone_country_code, phone_number, display_name, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(accountId, "xiaohongshu", handle, countryCode, phoneNumber, data.display_name?.trim() || "", "active", data.notes?.trim() || "").run();
    return json({ id: accountId }, 201);
  } catch (error) {
    if (String(error?.message || error).includes("UNIQUE constraint failed")) {
      return json({ error: "该国家号和手机号已登记" }, 409);
    }
    console.error("Failed to create work account", error);
    const response = { error: "工作账号保存失败" };
    const hostname = new URL(request.url).hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      response.detail = String(error?.message || error).slice(0, 400);
    }
    return json(response, 500);
  }
}

export async function onRequestPatch({ request, env, params }) {
  const accountId = routeId(params);
  if (!accountId) return badRequest("account id is required");
  const data = await body(request);
  if (!data) return badRequest("request body is required");
  if (typeof data.display_name === "string") {
    const result = await env.DB.prepare(
      "UPDATE work_accounts SET display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).bind(data.display_name.trim(), accountId).run();
    if (result.meta.changes) return json({ ok: true });
    const existing = await env.DB.prepare("SELECT id FROM work_accounts WHERE id = ?").bind(accountId).first();
    return existing ? json({ ok: true }) : json({ error: "Account not found" }, 404);
  }
  if (!allowed.has(data.status)) return badRequest("valid status is required");
  const result = await env.DB.prepare("UPDATE work_accounts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(data.status, accountId).run();
  return result.meta.changes ? json({ ok: true }) : json({ error: "Account not found" }, 404);
}
