import { json } from './_shared.js';

export const actionKinds=['like','collect','follow'];
export function taskInput(data){
  if(!data||typeof data.name!=='string'||!data.name.trim()||data.name.length>120)return null;
  if(typeof data.note_url!=='string'||data.note_url.length>4096)return null;
  const link=data.note_url.match(/https?:\/\/[^\s<>"'，。]+/i)?.[0];
  let url;try{url=new URL(link);}catch{return null;}
  if(!['xhslink.cn','xhslink.com','www.xiaohongshu.com','xiaohongshu.com'].includes(url.hostname)||url.username||url.password)return null;
  if(!Array.isArray(data.actions)||!data.actions.length||data.actions.length>3||new Set(data.actions).size!==data.actions.length||data.actions.some(a=>!actionKinds.includes(a)))return null;
  for(const [key,max] of [['expected_title',500],['expected_author',120],['notes',2000]])if(data[key]!=null&&(typeof data[key]!=='string'||data[key].length>max))return null;
  return {name:data.name.trim(),note_url:url.href,expected_title:data.expected_title?.trim()||'',expected_author:data.expected_author?.trim()||'',actions:actionKinds.filter(a=>data.actions.includes(a)),notes:data.notes?.trim()||''};
}

export const runSelect=`SELECT r.id,r.task_id,r.device_id,r.account_id,r.connector_id,r.snapshot,r.status,r.message,
  r.resolved_note_id,r.resolved_title,r.resolved_author,r.created_at,r.started_at,r.finished_at,
  d.name AS device_name,a.display_name AS account_name,a.phone_country_code,a.phone_number,
  (SELECT json_group_array(json_object('action',x.action,'outcome',x.outcome,'confirmed_at',x.confirmed_at)) FROM task_run_actions x WHERE x.run_id=r.id) AS action_results
  FROM task_runs r JOIN devices d ON d.id=r.device_id JOIN work_accounts a ON a.id=r.account_id`;
export function decodeRun(r){return {...r,snapshot:JSON.parse(r.snapshot),action_results:JSON.parse(r.action_results||'[]').map(x=>x.outcome==='pending'&&['unknown','failed','cancelled'].includes(r.status)?{...x,outcome:r.status==='unknown'?'unknown':'not_run'}:x)};}
export function statisticsSQL(key){
  return `SELECT r.${key} AS owner_id,COUNT(DISTINCT CASE WHEN r.started_at IS NOT NULL THEN r.id END) AS execution_count,
    COUNT(DISTINCT CASE WHEN r.status='succeeded' THEN r.id END) AS succeeded_count,
    SUM(CASE WHEN x.action='like' AND x.outcome='performed' THEN 1 ELSE 0 END) AS like_count,
    SUM(CASE WHEN x.action='collect' AND x.outcome='performed' THEN 1 ELSE 0 END) AS collect_count,
    SUM(CASE WHEN x.action='follow' AND x.outcome='performed' THEN 1 ELSE 0 END) AS follow_count
    FROM task_runs r LEFT JOIN task_run_actions x ON x.run_id=r.id GROUP BY r.${key}`;
}
export async function expireTaskRuns(db,connectorId){
  const now=new Date().toISOString();
  await db.prepare(`UPDATE task_runs SET status='unknown',message='执行器失联，结果待核实；不会自动重试。',finished_at=? WHERE connector_id=? AND status='running' AND updated_at<?`).bind(now,connectorId,new Date(Date.now()-10*60000).toISOString()).run();
  await db.prepare(`UPDATE task_runs SET status='failed',message='排队超过30分钟，未执行。',finished_at=? WHERE connector_id=? AND status='queued' AND created_at<?`).bind(now,connectorId,new Date(Date.now()-30*60000).toISOString()).run();
}
export async function smallBody(request){
  const text=await request.text();if(text.length>16384)return null;
  try{return JSON.parse(text);}catch{return null;}
}
export const invalidTask=()=>json({error:'请填写任务名称、有效的小红书分享链接和至少一个动作；请检查字段长度。'},400);
