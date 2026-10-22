import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {configureNetwork,parseDevices,deviceRef,validateControls} from './adb-connector.mjs';

const here=dirname(fileURLToPath(import.meta.url)),exec=promisify(execFile);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const hosts=new Set(['xhslink.cn','xhslink.com','www.xiaohongshu.com','xiaohongshu.com']);

export async function resolveNoteUrl(value,fetcher=fetch){
  let url=new URL(value);
  for(let i=0;i<8;i++){
    if(!hosts.has(url.hostname)||!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('Only RedNote share links are accepted');
    url.protocol='https:';
    const redirected=url.searchParams.get('redirectPath');
    if(redirected){url=new URL(redirected);continue;}
    const note=url.pathname.match(/^\/(?:discovery\/item|explore)\/([a-f0-9]{24})\/?$/i);
    if(note&&url.hostname.endsWith('xiaohongshu.com'))return {id:note[1],url:`https://www.xiaohongshu.com/discovery/item/${note[1]}${url.search}`};
    const response=await fetcher(url,{redirect:'manual',signal:AbortSignal.timeout(20000),headers:{'user-agent':'Mozilla/5.0'}});
    const location=response.headers.get('location');
    await response.body?.cancel();
    if(!location)throw new Error(`Share link did not resolve to a note (HTTP ${response.status})`);
    url=new URL(location,url);
  }
  throw new Error('Too many share-link redirects');
}

function decode(value){return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(_,entity)=>{
  if(entity[0]==='#'){const n=entity[1].toLowerCase()==='x'?parseInt(entity.slice(2),16):Number(entity.slice(1));return n>=0&&n<=0x10ffff?String.fromCodePoint(n):'';}
  return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[entity.toLowerCase()];
});}
export function parseNodes(xml){
  if(typeof xml!=='string'||xml.length>4*1024*1024)throw new Error('Invalid page source');
  return [...xml.matchAll(/<([\w.:-]+)\b([^<>]*?)\/?\s*>/g)].map(m=>Object.fromEntries([...m[2].matchAll(/([\w:-]+)="([^"]*)"/g)].map(a=>[a[1],decode(a[2])]))).filter(n=>n.package==='com.xingin.xhs');
}
const normalize=text=>String(text).normalize('NFKC').replace(/\s+/g,'');
const bounds=node=>node.bounds?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)?.slice(1).map(Number);

export function inspectNote(xml,activity,title,author){
  if(!normalize(title)||!normalize(author))throw new Error('Expected title and author are required');
  if(!activity.includes('NoteDetailActivity'))throw new Error('Not on a RedNote note detail page');
  const nodes=parseNodes(xml),height=Math.max(0,...nodes.map(n=>bounds(n)?.[3]||0));
  const authorMatched=nodes.some(n=>n['resource-id']?.endsWith('/nickNameTV')&&normalize(n.text)===normalize(author)&&(bounds(n)?.[1]??height)<height*0.25);
  const titleMatched=nodes.some(n=>normalize(n.text||'').includes(normalize(title)));
  if(!titleMatched||!authorMatched)throw new Error('The note title/author does not match the requested target; no action taken');
  const buttons=nodes.filter(n=>n.class==='android.widget.Button'&&n.clickable==='true'&&n.enabled==='true'&&n.displayed!=='false'&&/^((取消|已)?点赞|Unlike|Like)(?:\s|\d|$)/i.test(n['content-desc']||'')&&(bounds(n)?.[1]||0)>height*0.7);
  if(buttons.length!==1)return {title_matched:true,author_matched:true,like_state:'unknown',like_button:null};
  const node=buttons[0],label=node['content-desc'];
  const liked=/^(取消点赞|已点赞|Unlike)/i.test(label)||node.selected==='true';
  const b=bounds(node);if(!b||b[2]<=b[0]||b[3]<=b[1])throw new Error('Invalid like button bounds');
  return {title_matched:true,author_matched:true,like_state:liked?'liked':'not_liked',like_button:{label,x:Math.round((b[0]+b[2])/2),y:Math.round((b[1]+b[3])/2)}};
}

export async function appiumCall(base,path,method='GET',data){
  const response=await fetch(base+path,{method,headers:{'content-type':'application/json'},...(data!==undefined?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(120000)});
  const result=await response.json();if(!response.ok||result.value?.error)throw new Error(String(result.value?.message||'Appium request failed').slice(0,1600));return result.value;
}

export async function main(){
  const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?'':args[i+1]||'';};
  if(!option('--url')||!option('--title')||!option('--author'))throw new Error('Required: --url NOTE_URL --title TITLE --author AUTHOR; optional: --like');
  const configPath=resolve(option('--config')||resolve(here,'connector.production.local.json'));
  const config=JSON.parse(await readFile(configPath,'utf8'));await configureNetwork(config);
  const api=new URL(config.api_url);if(api.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(api.hostname))throw new Error('Invalid API URL');
  const base=config.appium_url?.replace(/\/$/,'');if(!base||!['localhost','127.0.0.1'].includes(new URL(base).hostname))throw new Error('Configure local Appium URL first');
  const get=async path=>{const r=await fetch(new URL('/api/'+path,api),{signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error(`Backend HTTP ${r.status}`);return r.json();};
  const [devices,accounts,sessions]=await Promise.all([get('devices'),get('accounts'),get('sessions')]);
  const candidates=devices.filter(d=>d.connector_id===(config.connector_id||'local-adb'));
  const device=option('--device-id')?candidates.find(d=>d.id===option('--device-id')):candidates.length===1?candidates[0]:null;
  const account=option('--account-id')?accounts.find(a=>a.id===option('--account-id')):accounts.length===1?accounts[0]:null;
  if(!device||!account)throw new Error('Specify an unambiguous device and account ID');
  if(device.connection_mode!=='active'||device.connection_status!=='online'||device.status!=='available'||account.status!=='active')throw new Error('The chosen device/account is not ready');
  if(!sessions.some(s=>s.device_id===device.id&&s.account_id===account.id&&s.status==='active'))throw new Error('Confirm the selected account login on the backend before testing');
  const installs=await get(`installations?device_id=${encodeURIComponent(device.id)}`);
  if(installs.some(j=>['queued','running'].includes(j.status)))throw new Error('The device has an installation task; wait before testing');
  const adbPath=resolve(dirname(configPath),config.adb_path||'../../../work/android-sdk/platform-tools/adb.exe');
  const adb=async(...a)=>(await exec(adbPath,a,{timeout:15000,windowsHide:true})).stdout;
  let serial;
  for(const d of parseDevices(await adb('devices','-l'))){
    if(d.state!=='device')continue;
    const hardware=(await adb('-s',d.serial,'shell','getprop','ro.serialno')).trim()||(await adb('-s',d.serial,'shell','getprop','ro.boot.serialno')).trim();
    if(hardware&&deviceRef(hardware)===device.device_ref){serial=d.serial;break;}
  }
  if(!serial)throw new Error('The selected physical device is not connected');
  const power=await adb('-s',serial,'shell','dumpsys','power');
  if(/mWakefulness=(Asleep|Dozing)/.test(power))throw new Error('手机已息屏，请解锁并保持亮屏后再运行测试。');
  const control=await fetch(new URL('/api/connectors/control',api),{headers:{authorization:`Bearer ${process.env.DEVICE_CONNECTOR_TOKEN||config.token}`},signal:AbortSignal.timeout(10000)});
  if(!control.ok||!validateControls(await control.json(),config.connector_id||'local-adb').some(c=>c.device_ref===device.device_ref&&c.connection_mode==='active'))throw new Error('Device control policy does not permit testing');
  // Appium 3 protects session discovery; inspect only this phone's automation process.
  let running='';try{running=await adb('-s',serial,'shell','pidof','io.appium.uiautomator2.server');}catch(error){if(error.code!==1)throw error;}
  if(running.trim())throw new Error('The selected phone already has an automation session; finish it first');
  const note=await resolveNoteUrl(option('--url'));
  const report={device_id:device.id,account_id:account.id,login_confirmation:'operator',note_id:note.id,expected_title:option('--title'),expected_author:option('--author'),requested_action:args.includes('--like')?'ensure_liked':'inspect',started_at:new Date().toISOString()};
  const output=resolve(here,'../../../work/script-tests',new Date().toISOString().replace(/[:.]/g,'-'));
  await mkdir(output,{recursive:true});let sessionId;
  try{
    const session=await appiumCall(base,'/session','POST',{capabilities:{alwaysMatch:{platformName:'Android','appium:automationName':'UiAutomator2','appium:udid':serial,'appium:noReset':true,'appium:autoLaunch':false,'appium:ignoreHiddenApiPolicyError':true,'appium:skipDeviceInitialization':true,'appium:skipServerInstallation':true,'appium:skipUnlock':true,'appium:skipLogcatCapture':true,'appium:uiautomator2ServerLaunchTimeout':60000,'appium:newCommandTimeout':120},firstMatch:[{}]}});
    sessionId=session.sessionId;const path='/session/'+sessionId;
    const inspect=async()=>inspectNote(await appiumCall(base,path+'/source'),await appiumCall(base,path+'/appium/device/current_activity'),option('--title'),option('--author'));
    await appiumCall(base,path+'/execute/sync','POST',{script:'mobile: deepLink',args:[{url:note.url,package:'com.xingin.xhs'}]});
    let page,lastError;const deadline=Date.now()+30000;
    while(Date.now()<deadline){try{page=await inspect();break;}catch(error){lastError=error.message;await sleep(750);}}
    if(!page)throw new Error(`The expected note did not appear within 30 seconds: ${lastError||'page unavailable'}`);
    report.before=page;await writeFile(resolve(output,'before.png'),Buffer.from(await appiumCall(base,path+'/screenshot'),'base64'));
    if(args.includes('--like')){
      page=await inspect();
      if(page.like_state==='unknown')throw new Error('Like state is ambiguous; no click performed');
      if(page.like_state==='liked')report.action='already_liked';
      else{
        const current=await get(`devices/${device.id}`);if(current.connection_mode!=='active')throw new Error('Device was paused; no click performed');
        await appiumCall(base,path+'/execute/sync','POST',{script:'mobile: clickGesture',args:[{x:page.like_button.x,y:page.like_button.y}]});
        report.action='clicked_once';await sleep(1200);
      }
      report.after=await inspect();
      if(report.after.like_state!=='liked')throw new Error('Like result is not confirmed; no automatic retry');
      await writeFile(resolve(output,'after.png'),Buffer.from(await appiumCall(base,path+'/screenshot'),'base64'));
    }
    report.status='passed';
  }catch(error){
    report.status='failed';report.error=error.message;
    if(/GestureController|performGesture/.test(error.message)){
      try{
        const diagnostic=await adb('-s',serial,'logcat','-d','-t','300','InputManager:W','*:S');
        if(diagnostic.includes('android.permission.INJECT_EVENTS')){
          report.status='blocked';report.blocker='input_permission';
          report.error='手机拒绝模拟点击：需要开启开发者选项中的 USB 调试（安全设置）。如果系统要求 SIM 卡，需要先在手机完成该授权。';
          error.message=report.error;
        }
      }catch{ /* Preserve the original command error if device diagnostics are unavailable. */ }
    }
    throw error;
  }
  finally{
    if(sessionId)try{await appiumCall(base,'/session/'+sessionId,'DELETE');}catch{report.cleanup_error='Session cleanup failed';}
    report.finished_at=new Date().toISOString();await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,artifacts:output},null,2));
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
