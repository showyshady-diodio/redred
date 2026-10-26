const pause=ms=>new Promise(r=>setTimeout(r,ms));
const decode=s=>s.replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)));
export function accountNodes(xml){
  if(typeof xml!=='string'||xml.length>4*1024*1024)throw new Error('Invalid account page');
  return [...xml.matchAll(/<[\w.:-]+\b([^<>]*?)\/?\s*>/g)].map(m=>Object.fromEntries([...m[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map(a=>[a[1],decode(a[2])]))).filter(n=>n.package==='com.xingin.xhs');
}
export function profileIdentity(xml){
  const nodes=accountNodes(xml);
  if(!nodes.some(n=>n.text==='编辑主页')||!nodes.some(n=>n['content-desc']==='我'))return null;
  const values=nodes.map(n=>n.text?.match(/^小红书号[：:]\s*([-\w]+)$/)?.[1]).filter(Boolean);
  return values.length===1?values[0]:null;
}
export function savedAccountTarget(xml,number){
  const nodes=accountNodes(xml);
  if(!nodes.some(n=>n.text==='切换账号')||!nodes.some(n=>n.text==='添加或注册新账号'))throw new Error('未进入切换账号列表。');
  const matches=nodes.filter(n=>n.text?.replace(/^小红书号[：:]\s*/,'').toLowerCase()===number.toLowerCase());
  if(matches.length!==1)throw new Error('目标小红书号未唯一出现在已保存账号列表，请在手机手工登录后重试。');
  return matches[0];
}
export async function switchAccount({call,path,number,checkReady=async()=>{},delay=pause}){
  if(!/^[-\w]{1,64}$/.test(number))throw new Error('Invalid target RedNote account');
  const source=()=>call(path+'/source');
  const key=()=>call(path+'/appium/device/press_keycode','POST',{keycode:4});
  const tap=async node=>{
    const b=node?.bounds?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)?.slice(1).map(Number);
    if(!b||b[2]<=b[0]||b[3]<=b[1])throw new Error('账号入口不可点击。');
    await checkReady();
    await call(path+'/execute/sync','POST',{script:'mobile: clickGesture',args:[{x:Math.round((b[0]+b[2])/2),y:Math.round((b[1]+b[3])/2)}]});await delay(500);
  };
  const label=async text=>{
    const nodes=accountNodes(await source()),matches=nodes.filter(n=>n.text===text||n['content-desc']===text);
    if(!matches.length)throw new Error(`找不到账号切换入口：${text}。`);
    await tap(matches[0]);
  };
  const profile=async()=>{
    for(let i=0;i<7;i++){
      const xml=await source(),nodes=accountNodes(xml);
      if(profileIdentity(xml))return xml;
      if(nodes.some(n=>n['content-desc']==='我')){await label('我');await delay(400);const result=await source();if(profileIdentity(result))return result;}
      if(!nodes.length)throw new Error('当前未识别到小红书界面，请先解锁手机或处理系统提示。');
      await key();await delay(350);
    }
    throw new Error('无法确认个人页；如出现登录或验证码，请在手机完成验证后重新执行。');
  };
  await checkReady();
  await call(path+'/appium/device/activate_app','POST',{appId:'com.xingin.xhs'});await delay(1000);
  let identity=profileIdentity(await profile());
  if(identity.toLowerCase()===number.toLowerCase())return {xhs_number:identity,switched:false,verified:true};
  await label('菜单');await label('设置');
  let found=false;
  for(let i=0;i<4;i++){
    if(accountNodes(await source()).some(n=>n.text==='切换账号')){found=true;break;}
    await call(path+'/execute/sync','POST',{script:'mobile: scrollGesture',args:[{left:150,top:250,width:400,height:1100,direction:'down',percent:0.8}]});await delay(400);
  }
  if(!found)throw new Error('设置中没有找到切换账号入口。');
  await label('切换账号');
  await tap(savedAccountTarget(await source(),number));await delay(1500);
  identity=profileIdentity(await profile());
  if(identity.toLowerCase()!==number.toLowerCase())throw new Error('切换后的实际小红书号与指定账号不一致，已停止。');
  return {xhs_number:identity,switched:true,verified:true};
}
