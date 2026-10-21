import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isIP } from 'node:net';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseWindowsProxy(enabled, server) {
  if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enabled)) return '';
  const value = server.match(/ProxyServer\s+REG_SZ\s+(.+)/i)?.[1]?.trim() || '';
  const entries = Object.fromEntries(value.split(';').filter(x => x.includes('=')).map(x => x.split('=')));
  const address = entries.https || entries.http || (!value.includes('=') ? value : '');
  if (!address) return '';
  const url = new URL(address.includes('://') ? address : `http://${address}`);
  if (!['http:', 'https:'].includes(url.protocol)) return '';
  return url.href;
}

async function configureNetwork(config) {
  let proxy = config.proxy_url || '';
  const envProxy = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
  if (!proxy && !envProxy && process.platform === 'win32' && config.use_system_proxy !== false) {
    const registry = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    try {
      const options = { timeout: 3000, windowsHide: true };
      const enabled = (await exec('reg.exe', ['query', registry, '/v', 'ProxyEnable'], options)).stdout;
      const server = (await exec('reg.exe', ['query', registry, '/v', 'ProxyServer'], options)).stdout;
      proxy = parseWindowsProxy(enabled, server);
    } catch { /* Missing per-user proxy settings means direct networking. */ }
  }
  if (!proxy && !envProxy) return;
  if (typeof http.setGlobalProxyFromEnv !== 'function') throw new Error('Proxy support requires Node.js 24.14 or newer');
  http.setGlobalProxyFromEnv({ ...process.env,
    http_proxy: proxy || process.env.http_proxy || process.env.HTTP_PROXY || envProxy,
    https_proxy: proxy || process.env.https_proxy || process.env.HTTPS_PROXY || envProxy,
    no_proxy: [process.env.no_proxy || process.env.NO_PROXY || '', 'localhost', '127.0.0.1', '::1'].join(','),
  });
  console.log('Cloud sync uses the configured proxy; local ADB/Appium bypass it.');
}

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

export function parseServices(output) {
  return new Map(output.split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .filter(parts => parts[1] === '_adb-tls-connect._tcp' && validEndpoint(parts[2]))
    .map(parts => [key(parts[0]), parts[2]]));
}

function validEndpoint(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
  return Boolean(match && isIP(match[1].replace(/^\[|\]$/g, '')) && Number(match[2]) > 0 && Number(match[2]) <= 65535);
}

function knownServiceRef(service, cache) {
  if (cache.aliases[service]) return cache.aliases[service];
  // Android may change the service suffix after restarting wireless debugging.
  const serial = service.match(/^adb-(.+)-[^-]+$/)?.[1];
  if (!serial) return null;
  try {
    const ref = deviceRef(serial);
    return Object.values(cache.aliases).includes(ref) || cache.controls?.some(c => c.device_ref === ref) ? ref : null;
  } catch { return null; }
}

export async function reconnectWireless(adb, cache, devices, addresses, now = Date.now(), paused = new Set()) {
  cache.wireless ||= {};
  const active = new Set(devices.filter(d => d.state === 'device').map(d => cache.aliases[key(d.serial)]).filter(Boolean));
  for (const [service, endpoint] of addresses) {
    const ref = knownServiceRef(service, cache);
    if (!ref) continue;
    const previous = cache.wireless[ref];
    cache.wireless[ref] = { service, endpoint, retry_after: previous?.endpoint === endpoint ? previous.retry_after || 0 : 0 };
  }
  const errors = [];
  let attempted = 0;
  for (const [ref, target] of Object.entries(cache.wireless)) {
    if (paused.has(ref)) continue;
    if (active.has(ref) || !validEndpoint(target.endpoint) || now < (target.retry_after || 0)) continue;
    if (attempted >= 3) break;
    attempted++;
    target.retry_after = now + 30000;
    try {
      const result = await adb('connect', target.endpoint);
      if (!/^(?:already )?connected to /m.test(result)) errors.push(`Wireless reconnect pending: ${target.endpoint}`);
    } catch { errors.push(`Wireless reconnect failed: ${target.endpoint}`); }
  }
  return { attempted, errors };
}

export function validateControls(data, connectorId) {
  if (!data || data.connector_id !== connectorId || !Array.isArray(data.controls) || data.controls.length > 50) {
    throw new Error('Invalid device control policy');
  }
  const seen = new Set();
  return data.controls.map(control => {
    if (!control || !/^adb-[a-f0-9]{64}$/.test(control.device_ref) || seen.has(control.device_ref) ||
        !['active', 'paused'].includes(control.connection_mode) ||
        !Number.isSafeInteger(control.control_revision) || control.control_revision < 0) throw new Error('Invalid device control policy');
    seen.add(control.device_ref);
    return { device_ref: control.device_ref, connection_mode: control.connection_mode, control_revision: control.control_revision };
  });
}

function transportRef(serial, cache, addresses) {
  const direct = cache.aliases[key(serial)] || knownServiceRef(key(serial), cache);
  if (direct) return direct;
  const service = [...addresses].find(([, address]) => address === serial)?.[0];
  if (service) return knownServiceRef(service, cache);
  if (kind(serial) === 'usb') {
    try {
      const ref = deviceRef(serial);
      if (cache.controls?.some(c => c.device_ref === ref)) return ref;
    } catch { /* Unknown transport cannot be associated without a prior reference. */ }
  }
  return null;
}

export async function enforcePaused(adb, cache, devices, addresses) {
  const paused = (cache.controls || []).filter(c => c.connection_mode === 'paused');
  const refs = new Set(paused.map(c => c.device_ref));
  const failures = new Map();
  let attempted = false;
  for (const device of devices) {
    const ref = transportRef(device.serial, cache, addresses);
    if (!refs.has(ref)) continue;
    if (kind(device.serial) === 'usb') { failures.set(ref, 'USB is still attached; unplug USB to fully disconnect'); continue; }
    attempted = true;
    try { await adb('disconnect', device.serial); }
    catch { failures.set(ref, 'ADB disconnect failed; retrying'); }
  }
  if (attempted) devices = parseDevices(await adb('devices', '-l'));
  for (const device of devices) {
    const ref = transportRef(device.serial, cache, addresses);
    if (refs.has(ref)) failures.set(ref, failures.get(ref) || 'Device is still connected; retrying disconnect');
  }
  return { devices, results: paused.map(c => ({ device_ref: c.device_ref, revision: c.control_revision, mode: 'paused',
    status: failures.has(c.device_ref) ? 'error' : 'applied', error: failures.get(c.device_ref) || '' })) };
}

export async function collect(config, adb, cache) {
  let devices = parseDevices(await adb('devices', '-l'));
  let services = '';
  let discoveryError = '';
  try { services = await adb('mdns', 'services'); } catch { discoveryError = 'Wireless discovery failed'; }
  const addresses = parseServices(services);
  const pausedRefs = new Set((cache.controls || []).filter(c => c.connection_mode === 'paused').map(c => c.device_ref));
  const pause = await enforcePaused(adb, cache, devices, addresses);
  devices = pause.devices;
  const recovery = await reconnectWireless(adb, cache, devices, addresses, Date.now(), pausedRefs);
  if (recovery.attempted) devices = parseDevices(await adb('devices', '-l'));
  const snapshots = new Map();
  const errors = discoveryError ? [discoveryError] : [];
  for (const { serial, state } of devices) {
    if (pausedRefs.has(transportRef(serial, cache, addresses))) continue;
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
      if (connection_type === 'wireless' && validEndpoint(common.adb_address)) {
        cache.wireless ||= {};
        const service = [...addresses].find(([, address]) => address === common.adb_address)?.[0] || key(serial);
        cache.aliases[service] = ref;
        cache.wireless[ref] = { service, endpoint: common.adb_address, retry_after: 0 };
      }
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
  const onlineRefs = new Set([...snapshots.values()].filter(d => d.adb_state === 'device').map(d => d.device_ref));
  if (Object.keys(cache.wireless || {}).some(ref => !pausedRefs.has(ref) && !onlineRefs.has(ref))) {
    errors.push(...recovery.errors, 'Wireless device disconnected; automatic discovery/reconnect active. Check phone Wi-Fi and wireless debugging if it persists.');
  }
  const control_results = [...pause.results];
  for (const control of cache.controls || []) {
    if (control.connection_mode === 'active' && control.control_revision > 0 && onlineRefs.has(control.device_ref)) {
      control_results.push({ device_ref: control.device_ref, revision: control.control_revision, mode: 'active', status: 'applied' });
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
    control_results, appium_status, last_error: errors.join('; ').slice(0, 500) };
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
  await configureNetwork(config);
  const token = process.env.DEVICE_CONNECTOR_TOKEN || config.token;
  if (!args.includes('--dry-run') && (!token || token.length < 32)) throw new Error('Configure a connector token of at least 32 characters');
  const cachePath = resolve(dirname(configPath), '.state', `${basename(configPath)}.state.json`);
  let cache;
  try { cache = JSON.parse(await readFile(cachePath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { cache = JSON.parse(await readFile(resolve(dirname(cachePath), `${config.connector_id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`), 'utf8')); }
    catch (legacyError) { if (legacyError.code !== 'ENOENT') throw legacyError; cache = { aliases: {} }; }
  }
  const adb = async (...args) => (await exec(config.adb_path, args, { timeout: args[0] === 'connect' ? 5000 : 15000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })).stdout;
  const adb_version = (await adb('version')).split(/\r?\n/).slice(0, 2).join(' ');
  const interval = Math.max(10, Math.min(25, Number(config.interval_seconds) || 20));
  const saveCache = async () => {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(`${cachePath}.tmp`, JSON.stringify(cache), { mode: 0o600 });
    await rename(`${cachePath}.tmp`, cachePath);
  };
  console.log(`Connector ${config.connector_id}: ${args.includes('--dry-run') ? 'local inspection' : api.origin}, interval ${interval}s`);
  do {
    const cycleStart = Date.now();
    try {
      if (!args.includes('--dry-run')) {
        const response = await fetch(new URL('/api/connectors/control', api), {
          headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000), redirect: 'error',
        });
        if (!response.ok) throw new Error(`Control sync HTTP ${response.status}; collection held until policy is available`);
        cache.controls = validateControls(await response.json(), config.connector_id);
        // Persist pause intent before disconnecting so restart/offline retries cannot resume it.
        await saveCache();
      }
      const payload = { ...await collect(config, adb, cache), adb_version };
      await saveCache();
      if (args.includes('--dry-run')) console.log(JSON.stringify(payload, null, 2));
      else {
        const response = await fetch(new URL('/api/connectors/heartbeat', api), {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(15000), redirect: 'error',
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(`Heartbeat HTTP ${response.status}: ${result.error || 'Request failed'}`);
        console.log(`${result.server_time}: saved ${result.received} device(s), paused ${payload.control_results.filter(r => r.mode === 'paused' && r.status === 'applied').length}${payload.last_error ? `; ${payload.last_error}` : ''}`);
      }
    } catch (error) {
      console.error(`Sync failed: ${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`);
      if (cache.controls?.some(c => c.connection_mode === 'paused')) {
        try { await enforcePaused(adb, cache, parseDevices(await adb('devices', '-l')), new Map()); }
        catch { console.error('Cached pause enforcement failed; collection remains held'); }
      }
      if (args.includes('--once') || args.includes('--dry-run')) throw error;
    }
    if (args.includes('--once') || args.includes('--dry-run')) break;
    await delay(Math.max(1000, interval * 1000 - (Date.now() - cycleStart)));
  } while (true);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
