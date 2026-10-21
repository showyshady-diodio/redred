export const STALE_SECONDS = 90;

export function effectiveDevice(row) {
  if (row?.connector_id && row.connection_status !== 'offline' &&
      (!row.last_seen_at || Date.now() - Date.parse(row.last_seen_at) > STALE_SECONDS * 1000)) {
    return { ...row, connection_status: 'offline' };
  }
  return row;
}

export async function authorized(request, env) {
  if (!env.DEVICE_CONNECTOR_TOKEN || env.DEVICE_CONNECTOR_TOKEN.length < 32) return false;
  const value = request.headers.get('authorization') || '';
  if (!value.startsWith('Bearer ') || value.length > 512) return false;
  const hash = async text => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  const [a, b] = await Promise.all([hash(value.slice(7)), hash(env.DEVICE_CONNECTOR_TOKEN)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
