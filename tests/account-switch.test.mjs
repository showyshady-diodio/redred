import test from 'node:test';
import assert from 'node:assert/strict';
import {profileIdentity,savedAccountTarget,switchAccount} from '../connector/rednote-account-switch.mjs';
const node=(text,desc='',b='[10,20][100,60]')=>`<node package="com.xingin.xhs" text="${text}" content-desc="${desc}" bounds="${b}" />`;
const profile=n=>node('编辑主页')+node('','我')+node('小红书号：'+n);
test('identity requires own profile and a unique platform number, never a display name',()=>{
  assert.equal(profileIdentity(profile('SSS78978944')),'SSS78978944');
  assert.equal(profileIdentity(profile('123').replaceAll('<node','<android.widget.TextView')),'123');
  assert.equal(profileIdentity(node('小红书号：123')),null);
  assert.equal(profileIdentity(profile('123')+node('小红书号：456')),null);
  const list=node('切换账号')+node('添加或注册新账号')+node('小红书号：123');
  assert.ok(savedAccountTarget(list,'123'));
  assert.throws(()=>savedAccountTarget(list,'12'));
  assert.throws(()=>savedAccountTarget(list+node('小红书号：123'),'123'));
});
test('already selected identity makes no switch and wrong identity after switching fails closed',async()=>{
  let taps=0;
  const same=await switchAccount({number:'123',path:'/session/test',delay:async()=>{},call:async(p)=>p.endsWith('/source')?profile('123'):null});
  assert.equal(same.switched,false);assert.equal(same.verified,true);
  let page=0;
  const sources=[profile('old')+node('','菜单'),node('设置'),node('切换账号'),node('切换账号')+node('添加或注册新账号')+node('小红书号：123'),profile('wrong')];
  await assert.rejects(switchAccount({number:'123',path:'/session/test',delay:async()=>{},call:async(p,m,d)=>{
    if(p.endsWith('/source'))return sources[page];
    if(d?.script==='mobile: clickGesture'){taps++;page++;}
  }}),/不一致/);
  assert.equal(taps,4);
});
