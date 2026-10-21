import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const project = process.argv[2];
const wrangler = process.argv[3];
if (!project || !wrangler) throw new Error('Usage: node configure-device-control.mjs <existing-project> <wrangler.js>');
const path = resolve(root, 'connector/device-control.local.json');
let config;
try { config = JSON.parse(await readFile(path, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; config = { control_code: randomBytes(32).toString('hex') }; }
if (typeof config.control_code !== 'string' || config.control_code.length < 32) throw new Error('Invalid local control code');
await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
const child = spawn(process.execPath, [wrangler, 'pages', 'secret', 'put', 'DEVICE_CONTROL_TOKEN', '--project-name', project], {
  cwd: root, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true,
});
child.stdin.end(config.control_code + '\n');
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
if (code !== 0) throw new Error(`Device control configuration failed (${code})`);
console.log('Device control configured. Authorization code remains in the ignored local file; no secret was printed.');
