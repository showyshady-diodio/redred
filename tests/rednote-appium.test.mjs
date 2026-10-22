import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectNote,resolveNoteUrl,ensureAction,extractNoteMetadata,findSearchResult} from '../connector/rednote-appium.mjs';

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

test('automatic metadata reads header author and body heading rather than image counter or date',()=>{
  const page=`<hierarchy><android.view.View package="com.xingin.xhs" bounds="[0,0][720,1640]"/><android.widget.TextView package="com.xingin.xhs" resource-id="com.xingin.xhs:id/nickNameTV" text="Target author" bounds="[100,90][300,150]"/><android.widget.TextView package="com.xingin.xhs" class="android.widget.TextView" text="1/3" bounds="[100,300][680,350]"/><android.widget.TextView package="com.xingin.xhs" class="android.widget.TextView" text="目标笔记标题&#128557;" bounds="[30,900][690,950]"/><android.widget.TextView package="com.xingin.xhs" class="android.widget.TextView" text="9月27日 江苏" bounds="[30,990][690,1030]"/></hierarchy>`;
  assert.deepEqual(extractNoteMetadata(page,'NoteDetailActivity'),{title:'目标笔记标题😭',author:'Target author',source:'native_note_heading'});
  assert.throws(()=>extractNoteMetadata(page,'SearchActivity'));
});

const card=(left,author)=>`<android.view.View package="com.xingin.xhs" clickable="true" enabled="true" bounds="[${left},400][${left+320},1100]"><android.widget.TextView package="com.xingin.xhs" text="目标笔记标题" bounds="[${left+10},850][${left+310},900]"/><android.widget.TextView package="com.xingin.xhs" text="${author}" bounds="[${left+10},950][${left+240},990]"/></android.view.View>`;
test('search requires the matching author in the same result card and rejects duplicate matches',()=>{
  const wrap=contents=>`<hierarchy><android.view.View package="com.xingin.xhs" bounds="[0,0][720,1640]">${contents}</android.view.View></hierarchy>`;
  const result=findSearchResult(wrap(card(20,'Wrong author')+card(370,'Target author')),'目标笔记标题','Target author');
  assert.deepEqual(result.bounds,[370,400,690,1100]);
  assert.equal(findSearchResult(wrap(card(20,'Wrong author')),'目标笔记标题','Target author'),null);
  assert.throws(()=>findSearchResult(wrap(card(20,'Target author')+card(370,'Target author')),'目标笔记标题','Target author'));
});

test('header follow state is separate from note actions and repeated follow skips clicking',async()=>{
  const page=label=>xml('点赞 2').replace('</hierarchy>',`<android.widget.TextView package="com.xingin.xhs" text="${label}" enabled="true" bounds="[480,90][600,150]"/></hierarchy>`);
  assert.equal(inspectNote(page('关注'),'NoteDetailActivity','还我行李箱','Zyq').follow_state,'not_followed');
  assert.equal(inspectNote(page('已关注'),'NoteDetailActivity','还我行李箱','Zyq').follow_state,'followed');
  let clicks=0;
  const result=await ensureAction('follow',async()=>inspectNote(page('已关注'),'NoteDetailActivity','还我行李箱','Zyq'),async()=>clicks++,async()=>{},async()=>{});
  assert.equal(result.action,'already_followed');assert.equal(clicks,0);
});

test('video metadata and explicit action labels use the video layout without borrowing a different author',()=>{
  const page=`<hierarchy><node package="com.xingin.xhs" bounds="[0,0][720,1546]"/><node package="com.xingin.xhs" resource-id="com.xingin.xhs:id/matrixNickNameView" text="Zyq" bounds="[124,1311][177,1364]"/><node package="com.xingin.xhs" resource-id="com.xingin.xhs:id/noteContentText" text="#travel #heritage" bounds="[32,1390][688,1434]"/><node package="com.xingin.xhs" class="android.widget.Button" text="关注" bounds="[193,1312][293,1364]"/><node package="com.xingin.xhs" clickable="true" bounds="[244,1458][388,1546]"><node package="com.xingin.xhs" text="点赞" bounds="[312,1488][368,1528]"/></node></hierarchy>`;
  assert.deepEqual(extractNoteMetadata(page,'DetailFeedActivity'),{title:'#travel #heritage',author:'Zyq',source:'native_video_caption'});
  const state=inspectNote(page,'DetailFeedActivity','#travel #heritage','Zyq');
  assert.equal(state.like_state,'not_liked');assert.equal(state.follow_state,'not_followed');
  assert.throws(()=>inspectNote(page,'DetailFeedActivity','#travel #heritage','Other'));
  assert.equal(inspectNote(page.replace('text="点赞"','text="1"'),'DetailFeedActivity','#travel #heritage','Zyq').like_state,'unknown');
  const selected=page.replace('<node package="com.xingin.xhs" clickable="true" bounds="[244,1458][388,1546]"><node package="com.xingin.xhs" text="点赞" bounds="[312,1488][368,1528]"/></node>',`<node package="com.xingin.xhs"><node package="com.xingin.xhs" clickable="true" bounds="[284,1458][388,1546]"><node package="com.xingin.xhs" class="android.widget.ImageView" selected="true"/><node package="com.xingin.xhs" text="1"/></node><node package="com.xingin.xhs" class="android.widget.Button" content-desc="收藏0" bounds="[388,1458][538,1546]"/></node>`);
  assert.equal(inspectNote(selected,'DetailFeedActivity','#travel #heritage','Zyq').like_state,'liked');
  assert.equal(inspectNote(selected.replace('selected="true"','selected="false"'),'DetailFeedActivity','#travel #heritage','Zyq').like_state,'unknown');
});
