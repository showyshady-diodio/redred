import {json,body,id} from './_shared.js';
import {controlAccess} from './_installations.js';

export async function onRequestGet({env}){
  const [groups,members,bindings,identities]=await Promise.all([
    env.DB.prepare('SELECT * FROM account_groups ORDER BY created_at,id').all(),
    env.DB.prepare('SELECT * FROM account_group_members ORDER BY account_id').all(),
    env.DB.prepare('SELECT * FROM device_account_bindings').all(),
    env.DB.prepare('SELECT * FROM account_login_identities').all()
  ]);
  return json({groups:groups.results,members:members.results,bindings:bindings.results,identities:identities.results});
}
function rebuild(db,deviceId){
  return [db.prepare('DELETE FROM device_account_members WHERE device_id=?').bind(deviceId),
    db.prepare(`INSERT INTO device_account_members(account_id,device_id,xhs_number)
      SELECT a.id,b.device_id,i.xhs_number FROM device_account_bindings b
      JOIN work_accounts a ON a.id=b.account_id OR EXISTS(SELECT 1 FROM account_group_members m WHERE m.group_id=b.group_id AND m.account_id=a.id)
      JOIN account_login_identities i ON i.account_id=a.id WHERE b.device_id=?`).bind(deviceId)];
}
export async function onRequestPost({env,request}){
  const denied=await controlAccess(request,env);if(denied)return denied;
  const data=await body(request);if(!data)return json({error:'Invalid request'},400);
  const db=env.DB;
  try{
    if(data.action==='save_group'){
      if(typeof data.name!=='string'||!data.name.trim()||data.name.length>100||!Array.isArray(data.accounts)||data.accounts.length>100)return json({error:'请填写组名并选择账号。'},400);
      const groupId=data.group_id||id();
      if(typeof groupId!=='string'||!/^[\w-]{1,100}$/.test(groupId))return json({error:'Invalid group ID'},400);
      const existing=await db.prepare('SELECT id FROM account_groups WHERE id=?').bind(groupId).first();
      if(data.group_id&&!existing)return json({error:'账号组不存在。'},404);
      const selected=new Set(),statements=[];
      const binding=await db.prepare('SELECT device_id FROM device_account_bindings WHERE group_id=?').bind(groupId).first();
      for(const entry of data.accounts){
        if(!entry||typeof entry.account_id!=='string'||selected.has(entry.account_id))return json({error:'账号不能重复。'},400);
        selected.add(entry.account_id);
        const account=await db.prepare('SELECT id FROM work_accounts WHERE id=?').bind(entry.account_id).first();
        if(!account)return json({error:'工作账号不存在。'},404);
        const membership=await db.prepare('SELECT group_id FROM account_group_members WHERE account_id=?').bind(entry.account_id).first();
        if(membership&&membership.group_id!==groupId)return json({error:'所选账号已属于其他组，请先从原组移出。'},409);
        if(entry.xhs_number){
          if(typeof entry.xhs_number!=='string'||!/^[-\w]{1,64}$/.test(entry.xhs_number.trim()))return json({error:'小红书号格式不正确。'},400);
          const fixedIdentity=await db.prepare('SELECT device_id,xhs_number FROM device_account_members WHERE account_id=?').bind(entry.account_id).first();
          if(fixedIdentity&&fixedIdentity.device_id!==binding?.device_id&&fixedIdentity.xhs_number!==entry.xhs_number.trim())return json({error:'账号已单独绑定设备，请先解除绑定再修改小红书号。'},409);
          statements.push(db.prepare('INSERT INTO account_login_identities(account_id,xhs_number)VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET xhs_number=excluded.xhs_number').bind(entry.account_id,entry.xhs_number.trim()));
        }
      }
      // Clear derived device membership before editing a bound group. Busy-device
      // triggers make concurrent task dispatch and this transaction exclusive.
      const changes=binding?[db.prepare('DELETE FROM device_account_members WHERE device_id=?').bind(binding.device_id)]:[];
      changes.push(db.prepare('INSERT INTO account_groups(id,name)VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name').bind(groupId,data.name.trim()),...statements,
        db.prepare('DELETE FROM account_group_members WHERE group_id=?').bind(groupId),
        ...[...selected].map(accountId=>db.prepare('INSERT INTO account_group_members(account_id,group_id)VALUES(?,?)').bind(accountId,groupId)));
      if(binding){
        const identities=new Set((await db.prepare('SELECT account_id FROM account_login_identities').all()).results.map(i=>i.account_id));
        if(data.accounts.some(e=>!e.xhs_number&&!identities.has(e.account_id)))return json({error:'已绑定设备的账号组新增成员需要先填写小红书号，并在该手机保留登录。'},409);
        if(data.saved_login_confirmed!==true)return json({error:'账号组已绑定设备，请确认成员均已在该手机保留登录。'},400);
        changes.push(...rebuild(db,binding.device_id));
      }
      await db.batch(changes);return json({id:groupId});
    }
    if(data.action==='delete_group'){
      if(typeof data.group_id!=='string')return json({error:'请选择账号组。'},400);
      if(await db.prepare('SELECT device_id FROM device_account_bindings WHERE group_id=?').bind(data.group_id).first())return json({error:'请先解除设备对该组的绑定。'},409);
      await db.batch([db.prepare('DELETE FROM account_group_members WHERE group_id=?').bind(data.group_id),db.prepare('DELETE FROM account_groups WHERE id=?').bind(data.group_id)]);return json({ok:true});
    }
    if(data.action==='bind_device'){
      if(typeof data.device_id!=='string'||!await db.prepare('SELECT id FROM devices WHERE id=?').bind(data.device_id).first())return json({error:'请选择有效设备。'},400);
      const changes=[db.prepare('DELETE FROM device_account_members WHERE device_id=?').bind(data.device_id),db.prepare('DELETE FROM device_account_bindings WHERE device_id=?').bind(data.device_id)];
      if(data.mode!=='none'){
        if(!['group','account'].includes(data.mode)||data.saved_login_confirmed!==true)return json({error:'请选择账号组或单个账号，并确认已在手机保留登录。'},400);
        let accounts;
        if(data.mode==='group'){
          if(typeof data.group_id!=='string'||!await db.prepare('SELECT id FROM account_groups WHERE id=?').bind(data.group_id).first())return json({error:'账号组不存在。'},404);
          accounts=(await db.prepare('SELECT account_id FROM account_group_members WHERE group_id=?').bind(data.group_id).all()).results;
          changes.push(db.prepare('INSERT INTO device_account_bindings(device_id,group_id)VALUES(?,?)').bind(data.device_id,data.group_id));
        }else{
          if(typeof data.account_id!=='string'||!await db.prepare('SELECT id FROM work_accounts WHERE id=?').bind(data.account_id).first())return json({error:'工作账号不存在。'},404);
          accounts=[{account_id:data.account_id}];
          if(data.xhs_number){
            if(typeof data.xhs_number!=='string'||!/^[-\w]{1,64}$/.test(data.xhs_number.trim()))return json({error:'请输入正确的小红书号。'},400);
            changes.push(db.prepare('INSERT INTO account_login_identities(account_id,xhs_number)VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET xhs_number=excluded.xhs_number').bind(data.account_id,data.xhs_number.trim()));
          }
          changes.push(db.prepare('INSERT INTO device_account_bindings(device_id,account_id)VALUES(?,?)').bind(data.device_id,data.account_id));
        }
        if(!accounts.length)return json({error:'账号组为空，请先添加账号。'},400);
        for(const entry of accounts){
          const identity=await db.prepare('SELECT xhs_number FROM account_login_identities WHERE account_id=?').bind(entry.account_id).first();
          if(!identity&&!(data.mode==='account'&&data.xhs_number))return json({error:'请先为所有账号填写小红书号，用于自动切换核验。'},400);
        }
        changes.push(...rebuild(db,data.device_id));
      }
      await db.batch(changes);return json({ok:true});
    }
    return json({error:'Unknown action'},400);
  }catch(error){
    if(/UNIQUE/.test(error.message))return json({error:'组名、小红书号或设备绑定冲突；账号及账号组当前只能分配给一台设备。'},409);
    if(/group busy/.test(error.message))return json({error:'设备或账号有排队、执行中的任务，请先完成或取消。'},409);
    throw error;
  }
}
