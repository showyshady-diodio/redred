import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile,writeFile,mkdir,rename,readdir,stat,realpath,open,unlink } from 'node:fs/promises';
import { resolve,dirname,basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { configureNetwork,parseDevices,deviceRef,validateControls } from './adb-connector.mjs';
import { workstationInstance,controlUrl,adbExecutable } from './workstation.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const exec=promisify(execFile);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

export async function sha256(path) {
  const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');
}

export async function scanPackages(roots,cache=new Map()) {
  const packages=new Map();
  for(const root of roots) {
    let base;try{base=await realpath(root);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    for(const entry of await readdir(base,{withFileTypes:true})) {
      if(!entry.isFile()||!entry.name.toLowerCase().endsWith('.apk')||entry.name.length>200)continue;
      const path=await realpath(resolve(base,entry.name));
      if(dirname(path).toLowerCase()!==base.toLowerCase())continue;
      const info=await stat(path);if(info.size<4||info.size>1024**3)continue;
      const handle=await open(path,'r');const header=Buffer.alloc(4);
      try{await handle.read(header,0,4,0);}finally{await handle.close();}
      if(!header.equals(Buffer.from([0x50,0x4b,0x03,0x04])))continue;
      const signature=`${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      let saved=cache.get(path);
      if(saved?.signature!==signature){saved={signature,sha256:await sha256(path)};cache.set(path,saved);}
      if(!packages.has(saved.sha256))packages.set(saved.sha256,{filename:entry.name,size_bytes:info.size,sha256:saved.sha256,path});
      if(packages.size>=100)return packages;
    }
  }
  return packages;
}

export async function installTask(task,packages,adb,getControls) {
  let attempted=false;
  try {
    const apk=packages.get(task.sha256);
    if(!apk||apk.size_bytes!==task.size_bytes)throw new Error('安装包已移动或发生变化，请刷新安装包列表。');
    if(await sha256(apk.path)!==task.sha256)throw new Error('安装包校验失败，未执行安装。');
    let serial;
    for(const candidate of parseDevices(await adb('devices','-l'))) {
      if(candidate.state!=='device')continue;
      const hardware=(await adb('-s',candidate.serial,'shell','getprop','ro.serialno')).trim() || (await adb('-s',candidate.serial,'shell','getprop','ro.boot.serialno')).trim();
      if(hardware && deviceRef(hardware)===task.device_ref){serial=candidate.serial;break;}
    }
    if(!serial)throw new Error('指定设备未连接；不会使用其他手机替代。');
    const controls=await getControls();
    if(!controls.some(c=>c.device_ref===task.device_ref&&c.connection_mode==='active'))throw new Error('设备已暂停或策略不可用，未执行安装。');
    attempted=true;
    const output=await adb('-s',serial,'install','-r',apk.path);
    if(!/^Success\s*$/m.test(output))throw new Error(output||'ADB 未返回安装成功。');
    return {status:'succeeded',message:'ADB 已确认安装成功，保留已有应用数据。'};
  } catch(error) {
    const output=[error.stdout,error.stderr,error.message].filter(Boolean).join('\n');
    if(/INSTALL_FAILED_USER_RESTRICTED/.test(output))return {status:'failed',message:'手机拒绝安装：请解锁手机，开启开发者选项中的 USB 安装，并允许安装确认弹窗。'};
    if(/INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(output))return {status:'failed',message:'安装包签名与已安装版本不一致；未卸载应用，请确认安装包来源。'};
    if(/INSTALL_FAILED_VERSION_DOWNGRADE/.test(output))return {status:'failed',message:'安装包版本低于手机现有版本，未强制降级。'};
    if(/Failure \[INSTALL_FAILED_/.test(output))return {status:'failed',message:output.slice(-1000)};
    return {status:attempted?'unknown':'failed',message:(attempted?'安装结果未确认，请检查手机；不会自动重试。 ':'')+String(error.message).slice(0,750)};
  }
}

export async function main() {
  const args=process.argv.slice(2),index=args.indexOf('--config');
  const configPath=resolve(index<0?resolve(here,'connector.production.local.json'):args[index+1]);
  const config=JSON.parse(await readFile(configPath,'utf8'));
  config.connector_id||='local-adb';
  const api=new URL(config.api_url);
  if(api.protocol!=='https:' && !(api.protocol==='http:'&&['localhost','127.0.0.1'].includes(api.hostname)))throw new Error('Invalid API URL');
  await configureNetwork(config);
  const token=process.env.DEVICE_CONNECTOR_TOKEN||config.token;
  const instance=await workstationInstance(configPath);
  if(!token||token.length<32)throw new Error('Connector token is not configured');
  const adbPath=adbExecutable(configPath,config.adb_path||'../../../work/android-sdk/platform-tools/adb.exe');
  const adb=async(...args)=>(await exec(adbPath,args,{timeout:args.includes('install')?600000:15000,windowsHide:true,maxBuffer:1024*1024})).stdout;
  const call=async data=>{
    const response=await fetch(new URL('/api/connectors/installations',api),{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-connector-instance':instance},body:JSON.stringify({connector_id:config.connector_id,...data}),signal:AbortSignal.timeout(15000),redirect:'error'});
    const result=await response.json();if(!response.ok)throw new Error(`Installation API HTTP ${response.status}: ${result.error||'Request failed'}`);return result;
  };
  const getControls=async()=>{
    const response=await fetch(controlUrl(api,config.connector_id),{headers:{authorization:`Bearer ${token}`,'x-connector-instance':instance},signal:AbortSignal.timeout(10000),redirect:'error'});
    if(!response.ok)throw new Error('无法读取设备控制策略，未执行安装。');
    return validateControls(await response.json(),config.connector_id);
  };
  const statePath=resolve(here,'.state',`apk-installer-${basename(configPath)}.json`);
  await mkdir(dirname(statePath),{recursive:true});
  const lockPath=statePath+'.lock';
  try {
    const pid=Number(await readFile(lockPath,'utf8'));
    try{process.kill(pid,0);throw new Error('APK installer is already running');}catch(error){if(error.code!=='ESRCH')throw error;}
    await unlink(lockPath);
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const lock=await open(lockPath,'wx');await lock.writeFile(String(process.pid));await lock.close();
  let journal={};try{journal=JSON.parse(await readFile(statePath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const item of Object.values(journal))if(!item.result)item.result={status:'unknown',message:'安装器在执行中退出，请检查手机；不会自动重试。'};
  let saving=Promise.resolve();
  const save=()=>{saving=saving.then(async()=>{await writeFile(statePath+'.tmp',JSON.stringify(journal),{mode:0o600});await rename(statePath+'.tmp',statePath);});return saving;};
  if(config.apk_roots&&(!Array.isArray(config.apk_roots)||!config.apk_roots.length||config.apk_roots.length>5||config.apk_roots.some(p=>typeof p!=='string'||!p)))throw new Error('Invalid APK directories');
  const roots=config.apk_roots?config.apk_roots.map(p=>resolve(dirname(configPath),p)):[resolve(here,'../../../..'),resolve(here,'../../../work/apks')];
  for(const root of roots)await mkdir(root,{recursive:true});
  const cache=new Map(),running=new Map();let packages=new Map(),lastCatalog=0;
  console.log(`APK installer ${config.connector_id}: ${api.origin}`);
  try {
    do {
      try {
        if(Date.now()-lastCatalog>20000){packages=await scanPackages(roots,cache);await call({action:'catalog',packages:[...packages.values()].map(({path,...p})=>p)});lastCatalog=Date.now();}
        for(const [taskId,item] of Object.entries(journal)) {
          if(!item.result||running.has(taskId))continue;
          await call({action:'finish',task_id:taskId,lease_token:item.task.lease_token,...item.result});delete journal[taskId];await save();
        }
        if(running.size<3) {
          const {task}=await call({action:'claim'});
          if(task) {
            journal[task.id]={task};await save();
            const promise=installTask(task,packages,adb,getControls).then(async result=>{
              journal[task.id].result=result;await save();console.log(`Installation ${task.id}: ${result.status}`);
            }).catch(error=>{console.error('Installation journal failed:',error.message);process.exitCode=1;}).finally(()=>running.delete(task.id));
            running.set(task.id,promise);
          }
        }
      }catch(error){console.error(error.message);if(args.includes('--once'))throw error;}
      if(args.includes('--once')){await Promise.all(running.values());break;}
      await sleep(2000);
    }while(true);
  }finally{await unlink(lockPath).catch(()=>{});}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
