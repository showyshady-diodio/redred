import { spawn } from 'node:child_process';
import { readFile,writeFile,mkdir,rename,open,unlink } from 'node:fs/promises';
import { resolve,dirname,basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureNetwork } from './adb-connector.mjs';

const here=dirname(fileURLToPath(import.meta.url)),sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function executionResult(report,interrupted=false){
  const results={};
  for(const kind of ['like','collect','follow']){
    const action=report?.actions?.[kind]?.action;
    if(action==='clicked_once')results[kind]='performed';
    else if(action==='already_'+({like:'liked',collect:'collected',follow:'followed'}[kind]))results[kind]='skipped';
  }
  return {results,status:interrupted?'unknown':report?.status==='passed'?'succeeded':report?.current_action?'unknown':'failed',
    message:(interrupted?'执行器中断，保留已确认动作；不会自动重试。':report?.status==='passed'?'执行完成；已完成的动作跳过，不重复计数。':report?.error||'脚本未完成，未自动重试。').slice(0,1000),
    current_action:report?.current_action||'',note_id:report?.note_id||'',title:report?.expected_title||'',author:report?.expected_author||''};
}

export async function main(){
  const args=process.argv.slice(2),index=args.indexOf('--config');
  const configPath=resolve(index<0?resolve(here,'connector.production.local.json'):args[index+1]);
  const config=JSON.parse(await readFile(configPath,'utf8'));config.connector_id||='local-adb';
  const api=new URL(config.api_url);if(api.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(api.hostname))throw new Error('Invalid API URL');
  await configureNetwork(config);
  const call=async data=>{
    const response=await fetch(new URL('/api/connectors/tasks',api),{method:'POST',headers:{authorization:`Bearer ${process.env.DEVICE_CONNECTOR_TOKEN||config.token}`,'content-type':'application/json'},body:JSON.stringify({connector_id:config.connector_id,...data}),signal:AbortSignal.timeout(15000),redirect:'error'});
    const result=await response.json();if(!response.ok)throw new Error(`Task API HTTP ${response.status}: ${result.error||'Request failed'}`);return result;
  };
  const statePath=resolve(here,'.state',`task-worker-${basename(configPath)}.json`),lockPath=statePath+'.lock';
  await mkdir(dirname(statePath),{recursive:true});
  try{
    const pid=Number(await readFile(lockPath,'utf8'));
    try{process.kill(pid,0);throw new Error('Task worker is already running');}catch(error){if(error.code!=='ESRCH')throw error;}
    await unlink(lockPath);
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const lock=await open(lockPath,'wx');await lock.writeFile(String(process.pid));await lock.close();
  let journal=null;
  try{journal=JSON.parse(await readFile(statePath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const save=async()=>{await writeFile(statePath+'.tmp',JSON.stringify(journal),{mode:0o600});await rename(statePath+'.tmp',statePath);};
  const reportAt=async output=>{try{return JSON.parse(await readFile(resolve(output,'report.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;return null;}};
  console.log(`Task worker ${config.connector_id}: ${api.origin}`);
  try{
    for(;;){
      try{
        if(journal){
          journal.result||=executionResult(await reportAt(journal.output),true);await save();
          await call({action:'finish',run_id:journal.task.id,lease_token:journal.task.lease_token,...journal.result});
          journal=null;await save();
        }
        await call({action:'heartbeat'});
        const {task}=await call({action:'claim'});
        if(task){
          const output=resolve(here,'../../../work/task-runs',task.id);
          journal={task,output};await save();await mkdir(output,{recursive:true});
          const snapshot=task.snapshot;
          const childArgs=[resolve(here,'rednote-appium.mjs'),'--config',configPath,'--url',snapshot.note_url,'--device-id',task.device_id,'--account-id',task.account_id,'--task-run-id',task.id,'--output-dir',output];
          if(snapshot.expected_title)childArgs.push('--title',snapshot.expected_title);
          if(snapshot.expected_author)childArgs.push('--author',snapshot.expected_author);
          childArgs.push(...snapshot.actions.map(a=>'--'+a));
          const child=spawn(process.execPath,childArgs,{windowsHide:true,stdio:['ignore','pipe','pipe']});
          let diagnostics='';
          child.stdout.on('data',()=>{});child.stderr.on('data',chunk=>{diagnostics=(diagnostics+chunk.toString()).slice(-2000);});
          let timedOut=false;
          const timer=setTimeout(()=>{timedOut=true;child.kill();},7*60000);
          let updating=false;
          const heartbeat=setInterval(async()=>{
            if(updating)return;updating=true;
            try{
              await call({action:'heartbeat',run_id:task.id,lease_token:task.lease_token});
              const report=await reportAt(output);if(report)await call({action:'progress',run_id:task.id,lease_token:task.lease_token,results:executionResult(report).results});
            }catch(error){console.error(error.message);}finally{updating=false;}
          },10000);
          let spawnError;
          try{await new Promise(resolve=>{child.once('error',error=>{spawnError=error;resolve();});child.once('close',resolve);});}
          finally{clearTimeout(timer);clearInterval(heartbeat);while(updating)await sleep(50);}
          const report=await reportAt(output);
          journal.result=executionResult(report,timedOut);
          if(!report)journal.result.message=String(spawnError?.message||diagnostics||'脚本启动失败，未执行。').slice(-1000);
          await save();
          await call({action:'finish',run_id:task.id,lease_token:task.lease_token,...journal.result});
          console.log(`Execution ${task.id}: ${journal.result.status}`);journal=null;await save();
        }
      }catch(error){console.error(error.message);if(args.includes('--once'))throw error;}
      if(args.includes('--once'))break;
      await sleep(3000);
    }
  }finally{await unlink(lockPath).catch(()=>{});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
