import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectNote,resolveNoteUrl} from '../connector/rednote-appium.mjs';

const xml=label=>`<hierarchy><android.view.View package="com.xingin.xhs" bounds="[0,0][720,1640]"/><android.widget.TextView package="com.xingin.xhs" resource-id="com.xingin.xhs:id/nickNameTV" text="Zyq" bounds="[180,103][229,144]"/><android.widget.TextView package="com.xingin.xhs" text="还我行李箱&#128557;"/><android.widget.Button package="com.xingin.xhs" class="android.widget.Button" content-desc="${label}" clickable="true" enabled="true" selected="false" bounds="[336,1434][456,1546]"/></hierarchy>`;
test('note inspection checks author/title and distinguishes like from unlike without guessing other buttons',()=>{
  assert.equal(inspectNote(xml('点赞 2'),'NoteDetailActivity','还我行李箱','Zyq').like_state,'not_liked');
  assert.equal(inspectNote(xml('取消点赞 3'),'NoteDetailActivity','还我行李箱','Zyq').like_state,'liked');
  assert.equal(inspectNote(xml('收藏 0'),'NoteDetailActivity','还我行李箱','Zyq').like_state,'unknown');
  assert.throws(()=>inspectNote(xml('点赞 2'),'NoteDetailActivity','还我行李箱','Other'));
  assert.throws(()=>inspectNote(xml('点赞 2'),'LoginActivity','还我行李箱','Zyq'));
});
test('share resolver follows only supported hosts and extracts note links from login redirects',async()=>{
  const note='https://www.xiaohongshu.com/discovery/item/6ab8fa30000000001a025203?xsec_token=test';
  let calls=0;const fetcher=async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://www.xiaohongshu.com/login?redirectPath='+encodeURIComponent(note)}});};
  assert.equal((await resolveNoteUrl('https://xhslink.cn/o/test',fetcher)).url,note);assert.equal(calls,1);
  await assert.rejects(resolveNoteUrl('https://example.test/note',fetcher));
  await assert.rejects(resolveNoteUrl('https://user:password@xhslink.cn/o/test',fetcher));
});
