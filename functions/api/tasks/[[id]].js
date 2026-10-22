import { id,json,routeId } from '../_shared.js';
import { controlAccess } from '../_installations.js';
import { taskInput,smallBody,invalidTask,statisticsSQL } from '../_tasks.js';

export async function onRequestGet({env,params}){
  const taskId=routeId(params);
  const rows=(await env.DB.prepare(`SELECT t.*,COALESCE(s.execution_count,0) execution_count,COALESCE(s.succeeded_count,0) succeeded_count,
    COALESCE(s.like_count,0) like_count,COALESCE(s.collect_count,0) collect_count,COALESCE(s.follow_count,0) follow_count,
    (SELECT status FROM task_runs WHERE task_id=t.id ORDER BY created_at DESC,id DESC LIMIT 1) latest_status
    FROM note_tasks t LEFT JOIN (${statisticsSQL('task_id')}) s ON s.owner_id=t.id ${taskId?'WHERE t.id=?':''} ORDER BY t.created_at DESC`).bind(...(taskId?[taskId]:[])).all()).results.map(t=>({...t,actions:JSON.parse(t.actions)}));
  return taskId?(rows[0]?json(rows[0]):json({error:'Task not found'},404)):json(rows);
}
export async function onRequestPost({env,request}){
  const denied=await controlAccess(request,env);if(denied)return denied;
  const data=taskInput(await smallBody(request));if(!data)return invalidTask();
  const taskId=id(),now=new Date().toISOString();
  await env.DB.prepare(`INSERT INTO note_tasks(id,name,note_url,expected_title,expected_author,actions,notes,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?,?)`).bind(taskId,data.name,data.note_url,data.expected_title,data.expected_author,JSON.stringify(data.actions),data.notes,now,now).run();
  return json({id:taskId},201);
}
export async function onRequestPatch({env,request,params}){
  const denied=await controlAccess(request,env);if(denied)return denied;
  const data=taskInput(await smallBody(request));if(!data)return invalidTask();
  const result=await env.DB.prepare(`UPDATE note_tasks SET name=?,note_url=?,expected_title=?,expected_author=?,actions=?,notes=?,updated_at=? WHERE id=?`).bind(data.name,data.note_url,data.expected_title,data.expected_author,JSON.stringify(data.actions),data.notes,new Date().toISOString(),routeId(params)).run();
  return result.meta.changes?json({ok:true}):json({error:'Task not found'},404);
}
