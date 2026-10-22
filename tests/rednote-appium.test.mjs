import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectNote,resolveNoteUrl,ensureAction} from '../connector/rednote-appium.mjs';

const xml=label=>`<hierarchy><android.view.View package="com.xingin.xhs" bounds="[0,0][720,1640]"/><android.widget.TextView package="com.xingin.xhs" resource-id="com.xingin.xhs:id/nickNameTV" text="Zyq" bounds="[180,103][229,144]"/><android.widget.TextView package="com.xingin.xhs" text="还我行李箱&#128557;"/><android.widget.Button package="com.xingin.xhs" class="android.widget.Button" content-desc="${label}" clickable="true" enabled="true" selected="false" bounds="[336,1434][456,1546]"/></hierarchy>`;
test('note inspection checks author/title and distinguishes like from unlike without guessing other buttons',()=>{
  assert.equal(inspectNote(xml('点赞 2'),'NoteDetailActivity','还我行李箱','Zyq').like_state,'not_liked');
  assert.equal(inspectNote(xml('取消点赞 3'),'NoteDetailActivity','还我行李箱','Zyq').like_state,'liked');
  assert.equal(inspectNote(xml('收藏 0'),'NoteDetailActivity','还我行李箱','Zyq').like_state,'unknown');
  assert.equal(inspectNote(xml('收藏 0'),'NoteDetailActivity','还我行李箱','Zyq').collect_state,'not_collected');
  assert.equal(inspectNote(xml('取消收藏 1'),'NoteDetailActivity','还我行李箱','Zyq').collect_state,'collected');
  assert.throws(()=>inspectNote(xml('点赞 2'),'NoteDetailActivity','还我行李箱','Other'));
  assert.throws(()=>inspectNote(xml('点赞 2'),'LoginActivity','还我行李箱','Zyq'));
});
test('repeated ensure-like and ensure-collect skip completed actions and never toggle them off',async()=>{
  const state={like_state:'not_liked',collect_state:'not_collected',like_button:{x:1,y:1},collect_button:{x:2,y:2}};
  const calls=[];
  for(let run=0;run<2;run++)for(const kind of ['like','collect']){
    const result=await ensureAction(kind,async()=>({...state}),async()=>{calls.push(kind);state[kind+'_state']=kind==='like'?'liked':'collected';},async()=>{},async()=>{});
    assert.equal(result.action,run===0?'clicked_once':'already_'+(kind==='like'?'liked':'collected'));
  }
  assert.deepEqual(calls,['like','collect']);
  await assert.rejects(ensureAction('collect',async()=>({...state,collect_state:'unknown'}),async()=>calls.push('wrong'),async()=>{},async()=>{}));
  assert.deepEqual(calls,['like','collect']);
});
test('unconfirmed action is clicked once and read back without another click',async()=>{
  let clicks=0,reads=0;
  await assert.rejects(ensureAction('collect',async()=>{reads++;return {collect_state:'not_collected',collect_button:{x:1,y:1}};},async()=>{clicks++;},async()=>{},async()=>{}));
  assert.equal(clicks,1);assert.equal(reads,5);
});
test('share resolver follows only supported hosts and extracts note links from login redirects',async()=>{
  const note='https://www.xiaohongshu.com/discovery/item/6ab8fa30000000001a025203?xsec_token=test';
  let calls=0;const fetcher=async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://www.xiaohongshu.com/login?redirectPath='+encodeURIComponent(note)}});};
  assert.equal((await resolveNoteUrl('https://xhslink.cn/o/test',fetcher)).url,note);assert.equal(calls,1);
  await assert.rejects(resolveNoteUrl('https://example.test/note',fetcher));
  await assert.rejects(resolveNoteUrl('https://user:password@xhslink.cn/o/test',fetcher));
});
