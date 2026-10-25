import { randomUUID } from 'node:crypto';
import { readFile,mkdir,open } from 'node:fs/promises';
import { resolve,dirname,isAbsolute } from 'node:path';

export function adbExecutable(configPath,value='adb'){
  return isAbsolute(value)?value:/[\\/]/.test(value)?resolve(dirname(configPath),value):value;
}
export function controlUrl(api,connectorId){
  const url=new URL('/api/connectors/control',api);url.searchParams.set('connector_id',connectorId);return url;
}
export async function workstationInstance(configPath){
  const path=resolve(dirname(configPath),'.state','workstation-instance.json');
  await mkdir(dirname(path),{recursive:true});
  try{
    const file=await open(path,'wx',0o600);
    const value=randomUUID();try{await file.writeFile(JSON.stringify({instance_id:value}));}finally{await file.close();}return value;
  }catch(error){if(error.code!=='EEXIST')throw error;}
  // Collector, installer and worker can start together while the first one writes its identity.
  for(let i=0;i<10;i++){
    try{const value=JSON.parse(await readFile(path,'utf8')).instance_id;if(!/^[a-f0-9-]{36}$/i.test(value))throw new Error('Invalid workstation identity');return value;}
    catch(error){if(!(error instanceof SyntaxError)||i===9)throw error;await new Promise(r=>setTimeout(r,50));}
  }
}
