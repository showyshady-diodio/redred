import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {configureNetwork,parseDevices,deviceRef,validateControls} from './adb-connector.mjs';
import {workstationInstance,controlUrl,adbExecutable} from './workstation.mjs';
import {switchAccount} from './rednote-account-switch.mjs';

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

export function parseHierarchy(xml){
  if(typeof xml!=='string'||xml.length>4*1024*1024)throw new Error('Invalid page source');
  const stack=[],elements=[];
  for(const token of xml.matchAll(/<(\/?)([\w.:-]+)\b([^<>]*?)(\/?)>/g)){
    if(token[1]){stack.pop();continue;}
    const attributes=Object.fromEntries([...token[3].matchAll(/([\w:-]+)="([^"]*)"/g)].map(a=>[a[1],decode(a[2])]));
    const element={attributes,parent:stack.at(-1)||null,children:[]};
    element.parent?.children.push(element);elements.push(element);if(!token[4])stack.push(element);
  }
  return elements;
}

export function extractNoteMetadata(xml,activity){
  if(!/NoteDetailActivity|DetailFeedActivity/.test(activity))throw new Error('Metadata discovery requires a note detail page');
  const nodes=parseNodes(xml),height=Math.max(0,...nodes.map(n=>bounds(n)?.[3]||0)),width=Math.max(0,...nodes.map(n=>bounds(n)?.[2]||0));
  if(activity.includes('DetailFeedActivity')){
    const authors=nodes.filter(n=>n['resource-id']?.endsWith('/matrixNickNameView')&&n.text?.trim());
    const captions=nodes.filter(n=>n['resource-id']?.endsWith('/noteContentText')&&n.text?.trim());
    if(authors.length!==1||captions.length!==1)throw new Error('Cannot unambiguously read video caption and author');
    return {title:captions[0].text.trim(),author:authors[0].text.trim(),source:'native_video_caption'};
  }
  const authors=nodes.filter(n=>n['resource-id']?.endsWith('/nickNameTV')&&n.text?.trim()&&n.displayed!=='false'&&(bounds(n)?.[1]??height)<height*0.25);
  if(authors.length!==1)throw new Error('Cannot unambiguously read the note author');
  const headerBottom=bounds(authors[0])?.[3]||height*0.12;
  const titles=nodes.filter(n=>{
    const b=bounds(n),text=n.text?.trim();
    return n.class==='android.widget.TextView'&&text&&text.length<=160&&n.clickable!=='true'&&n.displayed!=='false'&&b&&b[1]>headerBottom&&b[3]<height*0.92&&b[2]-b[0]>width*0.35&&
      !/^(关注|已关注|互相关注|不喜欢|共\s*\d+\s*条评论|说点什么|\d+\s*\/\s*\d+|\d{1,2}月\d{1,2}日|\d{4}[-/.]\d{1,2}|编辑于|置顶评论)/.test(text);
  }).sort((a,b)=>bounds(a)[1]-bounds(b)[1]);
  if(!titles.length)throw new Error('Cannot reliably read the note heading; provide --title and --author or inspect this app layout');
  return {title:titles[0].text.trim(),author:authors[0].text.trim(),source:'native_note_heading'};
}

export function findSearchResult(xml,title,author){
  const elements=parseHierarchy(xml),nodes=elements.filter(n=>n.attributes.package==='com.xingin.xhs');
  const height=Math.max(0,...nodes.map(n=>bounds(n.attributes)?.[3]||0)),width=Math.max(0,...nodes.map(n=>bounds(n.attributes)?.[2]||0));
  const target=normalize(title),authorText=normalize(author),candidates=new Map();
  if(!target||!authorText)throw new Error('Search requires a known title and author');
  const texts=element=>[element,...element.children.flatMap(child=>descendants(child))].map(n=>normalize(n.attributes.text||n.attributes['content-desc']||''));
  function descendants(element){return [element,...element.children.flatMap(descendants)];}
  for(const element of nodes){
    const text=normalize(element.attributes.text||element.attributes['content-desc']||'').replace(/[.…]+$/,'');
    const titleMatched=text===target||(text.length>=12&&target.startsWith(text));
    if(!titleMatched||element.attributes.class==='android.widget.EditText')continue;
    for(let card=element;card;card=card.parent){
      const n=card.attributes,b=bounds(n);if(!b||n.clickable!=='true'||n.enabled==='false')continue;
      const w=b[2]-b[0],h=b[3]-b[1];
      if(w<width*0.22||w>width*0.95||h<80||h>height*0.85)continue;
      if(!texts(card).includes(authorText))continue;
      candidates.set(n.bounds,{x:Math.round((b[0]+b[2])/2),y:Math.round((b[1]+b[3])/2),bounds:b,title,author});break;
    }
  }
  if(candidates.size>1)throw new Error('Multiple search results match this title and author; no result clicked');
  return [...candidates.values()][0]||null;
}

export function inspectNote(xml,activity,title,author){
  if(!normalize(title)||!normalize(author))throw new Error('Expected title and author are required');
  if(!/NoteDetailActivity|DetailFeedActivity/.test(activity))throw new Error('Not on a RedNote note detail page');
  const nodes=parseNodes(xml),height=Math.max(0,...nodes.map(n=>bounds(n)?.[3]||0));
  const video=activity.includes('DetailFeedActivity');
  const authorMatched=nodes.some(n=>(video?n['resource-id']?.endsWith('/matrixNickNameView'):n['resource-id']?.endsWith('/nickNameTV')&&(bounds(n)?.[1]??height)<height*0.25)&&normalize(n.text)===normalize(author));
  const titleMatched=nodes.some(n=>normalize(n.text||'').includes(normalize(title)));
  if(!titleMatched||!authorMatched)throw new Error('The note title/author does not match the requested target; no action taken');
  const action=(pattern,positive,yes,no)=>{
    const buttons=nodes.filter(n=>n.class==='android.widget.Button'&&n.clickable==='true'&&n.enabled==='true'&&n.displayed!=='false'&&pattern.test(n['content-desc']||'')&&(bounds(n)?.[1]||0)>height*0.7);
    if(buttons.length!==1)return {state:'unknown',button:null};
    const node=buttons[0],label=node['content-desc'],b=bounds(node);
    if(!b||b[2]<=b[0]||b[3]<=b[1])throw new Error('Invalid action button bounds');
    return {state:positive.test(label)||node.selected==='true'?yes:no,button:{label,x:Math.round((b[0]+b[2])/2),y:Math.round((b[1]+b[3])/2)}};
  };
  let like=action(/^((取消|已)?点赞|Unlike|Like)(?:\s|\d|$)/i,/^(取消点赞|已点赞|Unlike)/i,'liked','not_liked');
  if(video&&like.state==='unknown'){
    const labels=parseHierarchy(xml).filter(e=>e.attributes.package==='com.xingin.xhs'&&/^(点赞|已点赞|取消点赞)$/.test(e.attributes.text||'')&&(bounds(e.attributes)?.[1]||0)>height*0.85);
    if(labels.length===1){
      let parent=labels[0].parent;
      while(parent&&parent.attributes.clickable!=='true')parent=parent.parent;
      const b=parent&&bounds(parent.attributes);
      if(b&&b[2]-b[0]<240&&b[3]-b[1]<160)like={state:labels[0].attributes.text==='点赞'?'not_liked':'liked',button:{label:labels[0].attributes.text,x:Math.round((b[0]+b[2])/2),y:Math.round((b[1]+b[3])/2)}};
    }
    if(like.state==='unknown'){
      const elements=parseHierarchy(xml);
      const collects=elements.filter(e=>/^((取消|已)?收藏)(?:\s|\d|$)/.test(e.attributes['content-desc']||'')&&e.attributes.class==='android.widget.Button'&&(bounds(e.attributes)?.[1]||0)>height*0.85);
      if(collects.length===1){
        const collect=collects[0],siblings=collect.parent?.children||[],candidate=siblings[siblings.indexOf(collect)-1];
        const n=candidate?.attributes,b=n&&bounds(n),cb=bounds(collect.attributes);
        const selectedIcon=candidate?.children.some(c=>c.attributes.class==='android.widget.ImageView'&&c.attributes.selected==='true');
        if(b&&cb&&n.clickable==='true'&&selectedIcon&&b[2]===cb[0]&&b[1]===cb[1]&&b[3]===cb[3]&&b[2]-b[0]<240)like={state:'liked',button:{label:'selected_video_like_icon',x:Math.round((b[0]+b[2])/2),y:Math.round((b[1]+b[3])/2)}};
      }
    }
  }
  const collect=action(/^((取消|已)?收藏|Unsave|Save|Uncollect|Collect|Unfavorite|Favorite)(?:\s|\d|$)/i,/^(取消收藏|已收藏|Unsave|Uncollect|Unfavorite)/i,'collected','not_collected');
  const followNodes=nodes.filter(n=>n.enabled!=='false'&&n.displayed!=='false'&&/^(关注|已关注|互相关注|回关|Follow|Following)$/i.test((n.text||n['content-desc']||'').trim())&&(video? n.class==='android.widget.Button' : (bounds(n)?.[1]??height)<height*0.25));
  const followCandidates=new Map(followNodes.map(n=>[n.bounds,n]));
  let follow={state:'unknown',button:null};
  if(followCandidates.size===1){
    const n=[...followCandidates.values()][0],b=bounds(n),label=(n.text||n['content-desc']).trim();
    if(b&&b[2]>b[0]&&b[3]>b[1])follow={state:/^(已关注|互相关注|Following)$/i.test(label)?'followed':'not_followed',button:{label,x:Math.round((b[0]+b[2])/2),y:Math.round((b[1]+b[3])/2)}};
  }
  return {title_matched:true,author_matched:true,like_state:like.state,like_button:like.button,collect_state:collect.state,collect_button:collect.button,follow_state:follow.state,follow_button:follow.button};
}

export async function ensureAction(kind,inspect,click,checkReady,delay=sleep){
  if(!['like','collect','follow'].includes(kind))throw new Error('Unsupported action');
  const expected={like:'liked',collect:'collected',follow:'followed'}[kind],stateKey=kind+'_state';
  const before=await inspect();
  if(![expected,'not_'+expected].includes(before[stateKey])||!before[kind+'_button'])throw new Error(`${kind} state is ambiguous; no click performed`);
  if(before[stateKey]===expected)return {action:'already_'+expected,before,after:before};
  await checkReady();
  await click(before[kind+'_button']);
  let after;
  for(let attempt=0;attempt<4;attempt++){
    await delay(1000);after=await inspect();
    if(after[stateKey]===expected)return {action:'clicked_once',before,after};
  }
  throw new Error(`${kind} result is not confirmed; no automatic retry`);
}

export async function appiumCall(base,path,method='GET',data){
  const response=await fetch(base+path,{method,headers:{'content-type':'application/json'},...(data!==undefined?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(120000)});
  const result=await response.json();if(!response.ok||result.value?.error)throw new Error(String(result.value?.message||'Appium request failed').slice(0,1600));return result.value;
}

export async function main(){
  const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?'':args[i+1]||'';};
  if(!option('--url'))throw new Error('Required: --url NOTE_URL; optional: --title TITLE --author AUTHOR --auto-search --like --collect --follow');
  const configPath=resolve(option('--config')||resolve(here,'connector.production.local.json'));
  const config=JSON.parse(await readFile(configPath,'utf8'));await configureNetwork(config);
  const api=new URL(config.api_url);if(api.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(api.hostname))throw new Error('Invalid API URL');
  const base=config.appium_url?.replace(/\/$/,'');if(!base||!['localhost','127.0.0.1'].includes(new URL(base).hostname))throw new Error('Configure local Appium URL first');
  const get=async path=>{const r=await fetch(new URL('/api/'+path,api),{signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error(`Backend HTTP ${r.status}`);return r.json();};
  const [devices,accounts,sessions,members]=await Promise.all([get('devices'),get('accounts'),get('sessions'),get('device-accounts')]);
  const candidates=devices.filter(d=>d.connector_id===(config.connector_id||'local-adb'));
  const device=option('--device-id')?candidates.find(d=>d.id===option('--device-id')):candidates.length===1?candidates[0]:null;
  const account=option('--account-id')?accounts.find(a=>a.id===option('--account-id')):accounts.length===1?accounts[0]:null;
  if(!device||!account)throw new Error('Specify an unambiguous device and account ID');
  if(device.connection_mode!=='active'||device.connection_status!=='online'||device.status!=='available'||account.status!=='active')throw new Error('The chosen device/account is not ready');
  const membership=members.find(m=>m.device_id===device.id&&m.account_id===account.id);
  if(!membership&&!sessions.some(s=>s.device_id===device.id&&s.account_id===account.id&&s.status==='active'))throw new Error('Confirm the selected account login on the backend before testing');
  const installs=await get(`installations?device_id=${encodeURIComponent(device.id)}`);
  if(installs.some(j=>['queued','running'].includes(j.status)))throw new Error('The device has an installation task; wait before testing');
  const adbPath=adbExecutable(configPath,config.adb_path||'../../../work/android-sdk/platform-tools/adb.exe');
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
  const instance=await workstationInstance(configPath);
  const control=await fetch(controlUrl(api,config.connector_id||'local-adb'),{headers:{authorization:`Bearer ${process.env.DEVICE_CONNECTOR_TOKEN||config.token}`,'x-connector-instance':instance},signal:AbortSignal.timeout(10000)});
  if(!control.ok||!validateControls(await control.json(),config.connector_id||'local-adb').some(c=>c.device_ref===device.device_ref&&c.connection_mode==='active'))throw new Error('Device control policy does not permit testing');
  // Appium 3 protects session discovery; inspect only this phone's automation process.
  let running='';try{running=await adb('-s',serial,'shell','pidof','io.appium.uiautomator2.server');}catch(error){if(error.code!==1)throw error;}
  if(running.trim())throw new Error('The selected phone already has an automation session; finish it first');
  const note=await resolveNoteUrl(option('--url'));
  const actions=['like','collect','follow'].filter(kind=>args.includes('--'+kind));
  let title=option('--title'),author=option('--author');
  const report={device_id:device.id,account_id:account.id,login_confirmation:'operator',note_id:note.id,expected_title:title,expected_author:author,requested_action:actions.length?'ensure_'+actions.join('_and_'):'inspect',actions:{},navigation:[],started_at:new Date().toISOString()};
  const output=option('--output-dir')?resolve(option('--output-dir')):resolve(dirname(configPath),config.work_dir||'../../../work','script-tests',new Date().toISOString().replace(/[:.]/g,'-'));
  await mkdir(output,{recursive:true});let sessionId;
  const checkpoint=async()=>{await writeFile(resolve(output,'report.tmp'),JSON.stringify(report,null,2));await rename(resolve(output,'report.tmp'),resolve(output,'report.json'));};
  report.status='running';await checkpoint();
  try{
    const session=await appiumCall(base,'/session','POST',{capabilities:{alwaysMatch:{platformName:'Android','appium:automationName':'UiAutomator2','appium:udid':serial,'appium:noReset':true,'appium:autoLaunch':false,'appium:ignoreHiddenApiPolicyError':true,'appium:skipDeviceInitialization':true,'appium:skipServerInstallation':true,'appium:skipUnlock':true,'appium:skipLogcatCapture':true,'appium:uiautomator2ServerLaunchTimeout':60000,'appium:newCommandTimeout':120},firstMatch:[{}]}});
    sessionId=session.sessionId;const path='/session/'+sessionId;
    const source=()=>appiumCall(base,path+'/source');
    const activity=()=>appiumCall(base,path+'/appium/device/current_activity');
    const inspect=async()=>inspectNote(await source(),await activity(),title,author);
    const waitForNote=async()=>{
      let lastError;const end=Date.now()+30000;
      while(Date.now()<end){try{return await inspect();}catch(error){lastError=error.message;await sleep(750);}}
      throw new Error(`The expected note did not appear within 30 seconds: ${lastError||'page unavailable'}`);
    };
    const checkReady=async()=>{
      const [current,logins,allAccounts,group]=await Promise.all([get(`devices/${device.id}`),get('sessions'),get('accounts'),get('device-accounts')]);
      const bindingValid=membership?group.some(m=>m.device_id===device.id&&m.account_id===account.id&&m.xhs_number===membership.xhs_number):logins.some(s=>s.device_id===device.id&&s.account_id===account.id&&s.status==='active');
      if(current.connector_id!==device.connector_id||current.connection_status!=='online'||current.connection_mode!=='active'||current.status!=='available'||!allAccounts.some(a=>a.id===account.id&&a.status==='active')||!bindingValid)throw new Error('Device/account policy or login binding changed; no action performed');
      if(option('--task-run-id')){
        const run=await get('task-runs/'+encodeURIComponent(option('--task-run-id')));
        if(run.status!=='running'||run.device_id!==device.id||run.account_id!==account.id||(membership&&run.snapshot.xhs_number!==membership.xhs_number))throw new Error('Task execution lease is no longer active');
      }
    };
    const settleCollection=async()=>{
      const end=Date.now()+15000;
      while(Date.now()<end){
        const nodes=parseNodes(await source()),labels=nodes.map(n=>n.text||'');
        if(labels.includes('新建专辑')&&labels.includes('取消')){
          await appiumCall(base,path+'/appium/device/press_keycode','POST',{keycode:4});
          report.navigation.push({step:'dismiss_unsaved_collection_album'});await sleep(750);continue;
        }
        if(labels.some(t=>/^(收藏成功|加入专辑)$/.test(t))){await sleep(750);continue;}
        return;
      }
      throw new Error('Collection overlay did not disappear; no next action performed');
    };
    await checkReady();
    if(membership){
      report.account_identity=await switchAccount({call:(p,m,d)=>appiumCall(base,p,m,d),path,number:membership.xhs_number,checkReady});
      await checkpoint();
      if(option('--task-run-id')){
        const lease=JSON.parse(await readFile(option('--lease-file'),'utf8'));
        const confirmed=await fetch(new URL('/api/connectors/account-confirm',api),{method:'POST',headers:{authorization:`Bearer ${process.env.DEVICE_CONNECTOR_TOKEN||config.token}`,'content-type':'application/json','x-connector-instance':instance},body:JSON.stringify({connector_id:config.connector_id||'local-adb',run_id:option('--task-run-id'),lease_token:lease.task.lease_token,xhs_number:report.account_identity.xhs_number}),signal:AbortSignal.timeout(15000)});
        if(!confirmed.ok)throw new Error('后台未接受实际账号核验，任务已停止。');
      }
    }
    await appiumCall(base,path+'/execute/sync','POST',{script:'mobile: deepLink',args:[{url:note.url,package:'com.xingin.xhs'}]});
    await settleCollection();
    report.navigation.push({step:'open_shared_note',note_id:note.id});
    if(!title||!author){
      let metadata,lastError;const end=Date.now()+20000;
      while(Date.now()<end){try{metadata=extractNoteMetadata(await source(),await activity());break;}catch(error){lastError=error.message;await sleep(750);}}
      if(!metadata)throw new Error(`Automatic metadata discovery failed: ${lastError}`);
      if(author&&normalize(author)!==normalize(metadata.author))throw new Error('Discovered author does not match the requested author');
      if(title&&!normalize(metadata.title).includes(normalize(title)))throw new Error('Discovered heading does not match the requested title');
      title||=metadata.title;author||=metadata.author;report.expected_title=title;report.expected_author=author;report.metadata=metadata;
      report.navigation.push({step:'read_note_metadata',title,author});
    }
    await waitForNote();
    if(args.includes('--auto-search')){
      await writeFile(resolve(output,'discovery.png'),Buffer.from(await appiumCall(base,path+'/screenshot'),'base64'));
      let found=false;
      const queries=[...new Set([title,Array.from(title).slice(0,30).join('')+' '+author])];
      for(const query of queries){
        await checkReady();
        await appiumCall(base,path+'/execute/sync','POST',{script:'mobile: deepLink',args:[{url:'xhsdiscover://search/result?keyword='+encodeURIComponent(query),package:'com.xingin.xhs'}]});
        report.navigation.push({step:'search',query});await sleep(1800);
        for(let screen=0;screen<4;screen++){
          let xml=await source(),candidate=findSearchResult(xml,title,author);
          if(!candidate&&screen===0){await sleep(1500);xml=await source();candidate=findSearchResult(xml,title,author);}
          if(candidate){
            await writeFile(resolve(output,'search-result.png'),Buffer.from(await appiumCall(base,path+'/screenshot'),'base64'));
            await checkReady();
            await appiumCall(base,path+'/execute/sync','POST',{script:'mobile: clickGesture',args:[{x:candidate.x,y:candidate.y}]});
            report.navigation.push({step:'open_search_result',query,screen,matched_title:title,matched_author:author,verification:'title_and_author'});found=true;break;
          }
          const nodes=parseNodes(xml),height=Math.max(0,...nodes.map(n=>bounds(n)?.[3]||0)),width=Math.max(0,...nodes.map(n=>bounds(n)?.[2]||0));
          if(width<200||height<400)throw new Error('Cannot determine search viewport');
          await checkReady();
          const more=await appiumCall(base,path+'/execute/sync','POST',{script:'mobile: scrollGesture',args:[{left:Math.round(width*0.08),top:Math.round(height*0.25),width:Math.round(width*0.84),height:Math.round(height*0.6),direction:'down',percent:0.65}]});
          await sleep(750);if(!more)break;
        }
        if(found)break;
      }
      if(!found){
        if(!args.includes('--allow-link-fallback'))throw new Error('No unique search result matched the discovered title and author; no engagement performed');
        await checkReady();
        await appiumCall(base,path+'/execute/sync','POST',{script:'mobile: deepLink',args:[{url:note.url,package:'com.xingin.xhs'}]});
        report.navigation.push({step:'search_not_found_open_shared_note',note_id:note.id,reason:'no_matching_search_result'});
      }
    }
    const page=await waitForNote();
    report.before=page;await writeFile(resolve(output,'before.png'),Buffer.from(await appiumCall(base,path+'/screenshot'),'base64'));
    for(const kind of actions){
      if(kind==='follow'){await settleCollection();await waitForNote();}
      report.current_action=kind;
      await checkpoint();
      report.actions[kind]=await ensureAction(kind,inspect,button=>appiumCall(base,path+'/execute/sync','POST',{script:'mobile: clickGesture',args:[{x:button.x,y:button.y}]}),checkReady);
      report.after=report.actions[kind].after;
      delete report.current_action;await checkpoint();
      await writeFile(resolve(output,`after-${kind}.png`),Buffer.from(await appiumCall(base,path+'/screenshot'),'base64'));
    }
    delete report.current_action;
    report.status='passed';
  }catch(error){
    report.status='failed';report.error=error.message;
    if(sessionId){
      try{
        const diagnosticPath='/session/'+sessionId;
        report.failure_activity=await appiumCall(base,diagnosticPath+'/appium/device/current_activity');
        await writeFile(resolve(output,'failure.xml'),await appiumCall(base,diagnosticPath+'/source'));
        await writeFile(resolve(output,'failure.png'),Buffer.from(await appiumCall(base,diagnosticPath+'/screenshot'),'base64'));
      }catch{ /* Keep the original failure if the diagnostic session is unavailable. */ }
    }
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
    report.finished_at=new Date().toISOString();await checkpoint();console.log(JSON.stringify({...report,artifacts:output},null,2));
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
