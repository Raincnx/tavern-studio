import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, mockServer } from './helpers.ts';
import { applyWorldPatch, emptyWorldState } from '../src/world-state.ts';
import type { Chat, Message, WorldState } from '@tavern/contracts';

test('world loop extracts facts, injects next turn, respects locks and restores branches/resends', async t=>{
 const f=await fixture(t);let extraction=0;const prompts:any[]=[];
 const url=await mockServer(t,(_req,res,body)=>{
  if(body.stream){prompts.push(body.messages);res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:'我们在书店喝茶。'}}]})+'\n\ndata: [DONE]\n\n');return;}
  extraction++;const material=JSON.parse((body.messages as any[]).at(-1).content);const last=material.messages.at(-1);
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({patches:[{op:'set',path:'/location/current',value:'书店',sourceMessageId:last.id,evidence:'我们在书店喝茶'}]})}}]}));
 });
 f.store.saveSettings({...f.store.settings(),textUrl:url,textModel:'test',contextWindow:100000,maxTokens:1024});
 let chat=(await f.call('/chats','POST',{characterId:f.store.bootstrap().characters[0].id})).json<Chat>();
 async function generate(){const r=await f.call(`/chats/${chat.id}/generations`,'POST',{content:'继续',expectedChatRevision:chat.revision});assert.equal(r.statusCode,202);chat=r.json().chat;await f.provider.running.get(chat.id)?.promise;return r.json().assistant as Message;}
 const first=await generate();const state=f.store.worldState(chat.id)!;assert.equal(state.location.current,'书店');assert.equal(state.sourceMessageId,first.id);assert.equal(state.syncStatus,'idle');
 const second=await generate();assert.ok(prompts[1].some((m:any)=>m.role==='system'&&m.content.includes('已记录的剧情事实')&&m.content.includes('书店')));assert.equal(extraction,2);
 const manual=await f.call(`/chats/${chat.id}/world-state/patch`,'POST',{expectedRevision:f.store.worldState(chat.id)!.revision,patch:[{op:'set',path:'/location/current',value:'校园'}]});assert.equal(manual.statusCode,200);assert.ok(manual.json().state.lockedPaths.includes('/location/current'));
 await generate();assert.equal(f.store.worldState(chat.id)!.location.current,'校园');
 const fork=(await f.call(`/chats/${chat.id}/fork`,'POST',{messageId:first.id,expectedChatRevision:chat.revision})).json<{chat:Chat}>().chat;
 assert.equal(f.store.worldState(fork.id)!.location.current,'书店');assert.equal(f.store.worldState(fork.id)!.chatId,fork.id);assert.notEqual(f.store.worldState(fork.id)!.sourceMessageId,first.id);
 const secondUser=f.store.messages(chat.id)[f.store.messages(chat.id).findIndex(m=>m.id===second.id)-1];
 f.provider.start=()=>{};
 const resend=await f.call(`/chats/${chat.id}/resend`,'POST',{messageId:secondUser.id,content:'改写',expectedChatRevision:chat.revision});assert.equal(resend.statusCode,202);
 assert.equal(f.store.worldState(chat.id)!.location.current,'书店');assert.ok(!f.store.worldState(chat.id)!.lockedPaths?.length);assert.equal(f.store.worldCheckpoints(chat.id).some(c=>c.messageId===second.id),false);
 assert.equal(f.store.worldState(fork.id)!.location.current,'书店');
});

test('invalid extraction preserves reply and prior facts, retry can recover without another reply',async t=>{
 const f=await fixture(t);let valid=false;let streams=0;
 const url=await mockServer(t,(_req,res,body)=>{if(body.stream){streams++;res.writeHead(200,{'content-type':'text/event-stream'}).end('data: '+JSON.stringify({choices:[{delta:{content:'雨停了。'}}]})+'\n\ndata: [DONE]\n\n');return;} const material=JSON.parse((body.messages as any[]).at(-1).content);res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({choices:[{message:{content:JSON.stringify({patches:[{op:'set',path:'/world/weather',value:'晴',sourceMessageId:valid?material.messages.at(-1).id:'foreign',evidence:'雨停了'}]})},finish_reason:'stop'}]}));});
 f.store.saveSettings({...f.store.settings(),textUrl:url,textModel:'test',contextWindow:100000});const chat=(await f.call('/chats','POST',{characterId:f.store.bootstrap().characters[0].id})).json<Chat>();
 await f.call(`/chats/${chat.id}/generations`,'POST',{content:'天气如何',expectedChatRevision:chat.revision});await f.provider.running.get(chat.id)?.promise;
 assert.equal(f.store.messages(chat.id).at(-1)!.status,'complete');assert.deepEqual(f.store.worldState(chat.id)!.world,{});assert.equal(f.store.worldState(chat.id)!.syncStatus,'failed');
 valid=true;await f.provider.refreshWorld(chat.id);assert.equal(f.store.worldState(chat.id)!.world.weather,'晴');assert.equal(streams,1);
});

test('truncated chat never triggers extraction and keeps received text',async t=>{
 const f=await fixture(t);let extracts=0;const url=await mockServer(t,(_req,res,body)=>{if(!body.stream){extracts++;res.end('{}');return;}res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'partial'}}]})+'\n\n');res.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'length'}]})+'\n\n');});
 f.store.saveSettings({...f.store.settings(),textUrl:url,textModel:'test',contextWindow:100000});const chat=(await f.call('/chats','POST',{characterId:f.store.bootstrap().characters[0].id})).json<Chat>();await f.call(`/chats/${chat.id}/generations`,'POST',{content:'hello',expectedChatRevision:chat.revision});await f.provider.running.get(chat.id)?.promise;assert.equal(extracts,0);assert.equal(f.store.messages(chat.id).at(-1)!.content,'partial');assert.equal(f.store.messages(chat.id).at(-1)!.status,'interrupted');
});

test('patch paths reject prototype writes; inverse fully restores merge, array append and implicit parents',()=>{
 const state=emptyWorldState('x');state.inventory={bag:[]};
 for(const path of ['/world/__proto__/polluted','/world/constructor/prototype/x','/world//x'])assert.throws(()=>applyWorldPatch(state,[{op:'set',path,value:true}]));
 assert.throws(()=>applyWorldPatch(state,[{op:'set',path:'/world/data',value:JSON.parse('{"__proto__":{"polluted":true}}')}]));
 const changed=applyWorldPatch(state,[{op:'merge',path:'/world',value:{time:'night'}},{op:'append',path:'/inventory/bag',value:'book'},{op:'set',path:'/location/room/name',value:'study'}]);
 const back=applyWorldPatch(changed.state,changed.inverse).state;assert.deepEqual(back.world,state.world);assert.deepEqual(back.inventory,state.inventory);assert.deepEqual(back.location,state.location);assert.equal(({} as any).polluted,undefined);
});

test('manual lock and state survive restart; unlock is explicit and stale revision is rejected',async t=>{
 const f=await fixture(t); const chat=(await f.call('/chats','POST',{characterId:f.store.bootstrap().characters[0].id})).json<Chat>();
 const result=await f.call(`/chats/${chat.id}/world-state/patch`,'POST',{expectedRevision:0,source:'model',patch:[{op:'set',path:'/world/time',value:'夜晚'}]});assert.equal(result.statusCode,200);
 assert.equal(f.store.worldEvents(chat.id)[0].source,'manual');
 assert.equal((await f.call(`/chats/${chat.id}/world-state/patch`,'POST',{expectedRevision:0,patch:[]})).statusCode,409);
 const {Store}=await import('../src/store.ts');await f.app.close();const store=new Store(f.directory,false);
 try{const state=store.worldState(chat.id)!;assert.equal(state.world.time,'夜晚');assert.deepEqual(state.lockedPaths,['/world/time']);assert.equal(store.worldAt(chat.id,store.messages(chat.id)).world.time,'夜晚');}finally{store.close();}
});

test('world context respects complete preset ordering and does not forward preset to extractor',async t=>{
 const f=await fixture(t);const character=f.store.bootstrap().characters[0];const chat=(await f.call('/chats','POST',{characterId:character.id})).json<Chat>();
 const raw=JSON.stringify({prompts:[{identifier:'main',role:'system',content:'PRIVATE_PRESET_SENTINEL'},{identifier:'chatHistory',marker:true},{identifier:'post',role:'system',content:'POST_HISTORY'}],prompt_order:[{character_id:100001,order:[{identifier:'main',enabled:true},{identifier:'chatHistory',enabled:true},{identifier:'post',enabled:true}]}]});
 const settings={...f.store.settings(),textPresetJson:raw,contextWindow:100000,maxTokens:1024};const world={...emptyWorldState(chat.id),revision:1,location:{current:'书店'}};f.store.saveWorldState(world);
 const messages=f.provider.prompt(chat.id,character,[{id:'u',chatId:chat.id,role:'user',content:'hello',status:'complete',createdAt:new Date().toISOString()}],settings);
 assert.equal(messages.at(-1)!.content,'POST_HISTORY');assert.ok(messages.some(m=>m.content==='PRIVATE_PRESET_SENTINEL'));assert.ok(messages[0].content.includes('书店'));
 const {syncWorld}=await import('../src/world-engine.ts');f.store.saveSettings(settings);
 await syncWorld(f.store,chat.id,settings,async(_s,material)=>{assert.ok(!JSON.stringify(material).includes('PRIVATE_PRESET_SENTINEL'));return Response.json({choices:[{finish_reason:'stop',message:{content:'{"patches":[]}'}}]});},new AbortController().signal);
});

test('cancelled extraction preserves previous state and blocks manual writes while running',async t=>{
 const f=await fixture(t);const chat=(await f.call('/chats','POST',{characterId:f.store.bootstrap().characters[0].id})).json<Chat>();
 f.store.saveSettings({...f.store.settings(),textUrl:'http://127.0.0.1:9999/v1',textModel:'test',contextWindow:100000});
 let release!:()=>void; const waiting=new Promise<void>(r=>{release=r;});
 f.provider.request=async()=>{await waiting;return Response.json({choices:[{finish_reason:'stop',message:{content:'{"patches":[]}'}}]});};
 const task=f.provider.refreshWorld(chat.id);
 assert.equal(f.store.worldState(chat.id)!.syncStatus,'updating');
 assert.equal((await f.call(`/chats/${chat.id}/world-state/patch`,'POST',{expectedRevision:0,patch:[]})).statusCode,409);
 f.provider.cancel(chat.id);release();await task;assert.equal(f.store.worldState(chat.id)!.revision,0);assert.equal(f.store.worldState(chat.id)!.syncStatus,'failed');assert.equal(f.provider.running.size,0);
});


test('world validation retries once without accepting invented evidence; exposes specific failure',async t=>{
 const f=await fixture(t);const chat=(await f.call('/chats','POST',{characterId:f.store.bootstrap().characters[0].id})).json<Chat>();
 const {syncWorld}=await import('../src/world-engine.ts');let calls=0;
 await syncWorld(f.store,chat.id,{...f.store.settings(),contextWindow:100000},async()=>{calls++;return Response.json({choices:[{message:{content:'not json'},finish_reason:'stop'}]});},new AbortController().signal);
 assert.equal(calls,2);assert.match(f.store.worldState(chat.id)!.syncError!,/JSON/);assert.equal(f.store.worldState(chat.id)!.revision,0);
 calls=0;
 await syncWorld(f.store,chat.id,{...f.store.settings(),contextWindow:100000},async(_s,m)=>{calls++;if(calls===1)return Response.json({choices:[{message:{content:'bad json'}}]});assert.match(m[0].content,/上次输出/);return Response.json({choices:[{message:{content:'{"patches":[]}'},finish_reason:'stop'}]});},new AbortController().signal);
 assert.equal(calls,2);assert.equal(f.store.worldState(chat.id)!.syncStatus,'idle');
});
