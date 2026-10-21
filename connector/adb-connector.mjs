import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseDevices(output) {
  return output.split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && ['device', 'offline', 'unauthorized'].includes(state))
    .map(([serial, state]) => ({ serial, state }));
}

export function parseProperties(output) {
  return Object.fromEntries(output.split(/\r?\n/).map(line => line.match(/^\[([^\]]+)\]: \[(.*)\]$/))
    .filter(Boolean).map(match => [match[1], match[2]]));
}

export function parseBattery(output) {
  const level = output.match(/^\s*level:\s*(\d+)/m);
  const scale = output.match(/^\s*scale:\s*(\d+)/m);
  return {
    battery_percent: level && scale && Number(scale[1]) > 0
      ? Math.max(0, Math.min(100, Math.round(Number(level[1]) * 100 / Number(scale[1])))) : null,
    charging: /status:\s*(2|5)\b/.test(output) ? true : /status:\s*[134]\b/.test(output) ? false : null,
  };
}

export function deviceRef(serial) {
  if (!serial || /^(unknown|null|0+)$/i.test(serial)) throw new Error('Stable device serial is unavailable; device was not imported');
  return `adb-${createHash('sha256').update(`android-serial:${serial}`).digest('hex')}`;
}

const key = serial => serial.replace(/\._adb-tls-connect\._tcp\.?$/, '');
const kind = serial => serial.startsWith('emulator-') ? 'emulator' :
  /_adb-tls|:\d+$/.test(serial) ? 'wireless' : 'usb';

export async function collect(config, adb, cache) {
  const devices = parseDevices(await adb('devices', '-l'));
  let services = '';
  try { services = await adb('mdns', 'services'); } catch { /* Discovery is optional for USB. */ }
  const addresses = new Map(services.split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .filter(parts => parts[1] === '_adb-tls-connect._tcp').map(parts => [parts[0], parts[2]]));
  const snapshots = new Map();
  const errors = [];
  for (const { serial, state } of devices) {
    const connection_type = kind(serial);
    const common = { connection_type, adb_address: connection_type === 'usb' ? '' : addresses.get(key(serial)) || serial,
      adb_state: state, connection_status: state === 'device' ? 'online' : 'attention',
      battery_percent: null, charging: null, collected_at: null, collection_error: '' };
    let ref = cache.aliases[key(serial)];
    try {
      if (state !== 'device') throw new Error(`ADB ${state}; unlock and authorize or reconnect the device`);
      const props = parseProperties(await adb('-s', serial, 'shell', 'getprop'));
      ref = deviceRef(props['ro.serialno'] || props['ro.boot.serialno'] || (connection_type === 'usb' ? serial : ''));
      cache.aliases[key(serial)] = ref;
      const snapshot = { ...common, device_ref: ref,
        name: props['ro.product.model'] || 'Android device', manufacturer: props['ro.product.manufacturer'] || '',
        model: props['ro.product.model'] || '', os: 'Android', os_version: props['ro.build.version.release'] || '',
        sdk_version: props['ro.build.version.sdk'] || '' };
      const partialErrors = [];
      try { Object.assign(snapshot, parseBattery(await adb('-s', serial, 'shell', 'dumpsys', 'battery'))); }
      catch { partialErrors.push('Battery read failed'); }
      try {
        const size = await adb('-s', serial, 'shell', 'wm', 'size');
        snapshot.screen_resolution = (size.match(/Override size:\s*(\d+x\d+)/) || size.match(/Physical size:\s*(\d+x\d+)/))?.[1] || '';
        if (!snapshot.screen_resolution) partialErrors.push('Screen size is unavailable');
      } catch { partialErrors.push('Screen size read failed'); }
      snapshot.collected_at = new Date().toISOString();
      snapshot.collection_error = partialErrors.join('; ');
      if (partialErrors.length) snapshot.connection_status = 'attention';
      snapshots.set(ref, snapshot);
    } catch (error) {
      errors.push(error.message);
      if (ref && !snapshots.has(ref)) snapshots.set(ref, { ...common, adb_state: state === 'device' ? 'error' : state,
        device_ref: ref, name: 'Android device', connection_status: 'attention', collection_error: error.message.slice(0, 500) });
    }
  }
  let appium_status = 'not_configured';
  if (config.appium_url) {
    try {
      const response = await fetch(`${config.appium_url.replace(/\/$/, '')}/status`, { signal: AbortSignal.timeout(3000) });
      const result = await response.json();
      appium_status = response.ok && result.value?.ready === true ? 'ready' : 'unavailable';
    } catch { appium_status = 'unavailable'; }
  }
  return { connector_id: config.connector_id, agent_name: config.agent_name, devices: [...snapshots.values()],
    appium_status, last_error: errors.join('; ').slice(0, 500) };
}

export async function main() {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf('--config');
  const configPath = resolve(configIndex < 0 ? resolve(here, 'connector.local.json') : args[configIndex + 1]);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.adb_path = resolve(dirname(configPath), config.adb_path || '../../../work/android-sdk/platform-tools/adb.exe');
  config.connector_id ||= 'local-adb';
  config.agent_name ||= hostname();
  const api = new URL(config.api_url);
  if (api.protocol !== 'https:' && !(api.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(api.hostname))) {
    throw new Error('api_url must use HTTPS (HTTP is allowed only on localhost)');
  }
  if (config.appium_url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.appium_url).hostname)) {
    throw new Error('appium_url must point to the local Appium server');
  }
  const token = process.env.DEVICE_CONNECTOR_TOKEN || config.token;
  if (!args.includes('--dry-run') && (!token || token.length < 32)) throw new Error('Configure a connector token of at least 32 characters');
  const cachePath = resolve(dirname(configPath), '.state', `${config.connector_id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  let cache;
  try { cache = JSON.parse(await readFile(cachePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; cache = { aliases: {} }; }
  const adb = async (...args) => (await exec(config.adb_path, args, { timeout: 15000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })).stdout;
  const adb_version = (await adb('version')).split(/\r?\n/).slice(0, 2).join(' ');
  const interval = Math.max(10, Math.min(25, Number(config.interval_seconds) || 20));
  console.log(`Connector ${config.connector_id}: ${args.includes('--dry-run') ? 'local inspection' : api.origin}, interval ${interval}s`);
  do {
    const cycleStart = Date.now();
    try {
      const payload = { ...await collect(config, adb, cache), adb_version };
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(`${cachePath}.tmp`, JSON.stringify(cache), { mode: 0o600 });
      await rename(`${cachePath}.tmp`, cachePath);
      if (args.includes('--dry-run')) console.log(JSON.stringify(payload, null, 2));
      else {
        const response = await fetch(new URL('/api/connectors/heartbeat', api), {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(15000), redirect: 'error',
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(`Heartbeat HTTP ${response.status}: ${result.error || 'Request failed'}`);
        console.log(`${result.server_time}: saved ${result.received} device(s)${payload.last_error ? `; ${payload.last_error}` : ''}`);
      }
    } catch (error) {
      console.error(`Sync failed: ${error.message}`);
      if (args.includes('--once') || args.includes('--dry-run')) throw error;
    }
    if (args.includes('--once') || args.includes('--dry-run')) break;
    await delay(Math.max(1000, interval * 1000 - (Date.now() - cycleStart)));
  } while (true);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
