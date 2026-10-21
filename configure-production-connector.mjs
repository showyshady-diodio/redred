import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const project = process.argv[2];
const wrangler = process.argv[3];
if (!project || !wrangler) throw new Error('Usage: node configure-production-connector.mjs <existing-project> <wrangler.js>');
const configPath = resolve(root, 'connector/connector.production.local.json');
let config = JSON.parse(await readFile(resolve(root, 'connector/connector.example.json'), 'utf8'));
try { config = JSON.parse(await readFile(configPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
config.token ||= randomBytes(32).toString('hex');
if (new URL(config.api_url).origin !== 'https://redred-1vl.pages.dev') throw new Error('Unexpected production destination');
// Preserve the generated token before uploading, so a retry can reuse it.
await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
const child = spawn(process.execPath, [wrangler, 'pages', 'secret', 'put', 'DEVICE_CONNECTOR_TOKEN', '--project-name', project], {
  cwd: root, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true,
});
child.stdin.end(config.token + '\n');
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
if (code !== 0) throw new Error(`Secret configuration failed (${code})`);
console.log('Production connector configured. No token was printed.');
