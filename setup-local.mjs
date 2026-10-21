import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const varsPath = resolve(root,'.dev.vars');
let vars='';
try { vars=await readFile(varsPath,'utf8'); } catch(error){if(error.code!=='ENOENT')throw error;}
let token=vars.match(/^DEVICE_CONNECTOR_TOKEN="?([A-Za-z0-9_-]{32,})"?\s*$/m)?.[1];
if(!token){
  if(vars.includes('DEVICE_CONNECTOR_TOKEN'))throw new Error('Existing token configuration needs review');
  token=randomBytes(32).toString('hex');
  vars += `\nDEVICE_CONNECTOR_TOKEN="${token}"\n`;
}
let controlToken=vars.match(/^DEVICE_CONTROL_TOKEN="?([A-Za-z0-9_-]{32,})"?\s*$/m)?.[1];
if(!controlToken){
  if(vars.includes('DEVICE_CONTROL_TOKEN'))throw new Error('Existing device control configuration needs review');
  controlToken=randomBytes(32).toString('hex');
  vars += `\nDEVICE_CONTROL_TOKEN="${controlToken}"\n`;
}
await writeFile(varsPath,vars,{mode:0o600});
await writeFile(resolve(root,'connector/device-control.dev.local.json'),JSON.stringify({control_code:controlToken},null,2)+'\n',{mode:0o600});
const configPath=resolve(root,'connector/connector.local.json');
let config=JSON.parse(await readFile(resolve(root,'connector/connector.example.json'),'utf8'));
try { config=JSON.parse(await readFile(configPath,'utf8')); } catch(error){if(error.code!=='ENOENT')throw error;}
config.api_url='http://127.0.0.1:8788';config.token=token;
await writeFile(configPath,JSON.stringify(config,null,2)+'\n',{mode:0o600});
console.log('Local connector token configured. Credential files are ignored by Git and excluded from deployment.');
