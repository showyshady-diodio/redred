export const STALE_SECONDS = 90;

export function effectiveDevice(row) {
  if(row?.connector_enabled===0)return {...row,connection_status:'offline'};
  if (row?.connection_mode === 'paused') {
    return { ...row, connection_status: row.control_ack_revision === row.control_revision && !row.control_error
      ? 'paused' : row.control_error ? 'attention' : 'pausing' };
  }
  if (row?.control_revision > row?.control_ack_revision) {
    return { ...row, connection_status: row.control_error ? 'attention' : 'resuming' };
  }
  if (row?.connector_id && row.connection_status !== 'offline' &&
      (!row.last_seen_at || Date.now() - Date.parse(row.last_seen_at) > STALE_SECONDS * 1000)) {
    return { ...row, connection_status: 'offline' };
  }
  return row;
}

export async function authorized(request, env) {
  return matchesSecret(request.headers.get('authorization') || '', env.DEVICE_CONNECTOR_TOKEN);
}

export async function authorizedControl(request, env) {
  return matchesSecret(`Bearer ${request.headers.get('x-device-control-token') || ''}`, env.DEVICE_CONTROL_TOKEN);
}

async function matchesSecret(value, secret) {
  if (!secret || secret.length < 32) return false;
  if (!value.startsWith('Bearer ') || value.length > 512) return false;
  const hash = async text => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  const [a, b] = await Promise.all([hash(value.slice(7)), hash(secret)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
