import { json } from '../_shared.js';
import { controlAccess } from '../_installations.js';
import { smallBody,expireTaskRuns } from '../_tasks.js';
import { validConnectorId } from '../_connectors.js';

export async function onRequestPost({env,request}){
  const denied=await controlAccess(request,env);if(denied)return denied;
  const data=await smallBody(request);
  if(!validConnectorId(data?.connector_id)||typeof data.enabled!=='boolean')return json({error:'Invalid connector change'},400);
  await expireTaskRuns(env.DB,data.connector_id);
  const change=await env.DB.prepare(`UPDATE device_connectors SET enabled=? WHERE id=? AND (?=1 OR (
    NOT EXISTS(SELECT 1 FROM task_runs WHERE connector_id=? AND status IN ('queued','running')) AND
    NOT EXISTS(SELECT 1 FROM apk_installations WHERE connector_id=? AND status IN ('queued','running'))))`)
    .bind(Number(data.enabled),data.connector_id,Number(data.enabled),data.connector_id,data.connector_id).run();
  if(!change.meta.changes)return json({error:'电脑不存在，或仍有排队 / 执行中的任务；请先完成或取消任务。'},409);
  return json({ok:true});
}
