export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function body(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function id() {
  return crypto.randomUUID();
}

export function routeId(params) {
  const value = params?.id;
  if (Array.isArray(value)) return value.join("/");
  return typeof value === "string" ? value : "";
}

export function badRequest(message) {
  return json({ error: message }, 400);
}
