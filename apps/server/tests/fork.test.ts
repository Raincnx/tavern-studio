import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import type { Chat, Message } from '@tavern/contracts';

test('fork includes selected message, preserves source and isolates future with idempotent requests', async t => {
 const f=await fixture(t); const chat=(await f.call('/chats','POST',{characterId:f.store.bootstrap().characters[0].id})).json<Chat>();
 const now=new Date().toISOString();
 for(const [id,role,content] of [['u','user','question'],['a','assistant','answer'],['future','user','future']] as const) f.store.saveMessage({id,chatId:chat.id,role,content,status:'complete',createdAt:now});
 const before=f.store.messages(chat.id); let calls=0; f.provider.start=()=>{calls++};
 const body={messageId:'a',expectedChatRevision:chat.revision},key=crypto.randomUUID();
 const response=await f.call(`/chats/${chat.id}/fork`,'POST',body,key);assert.equal(response.statusCode,200);
 const fork=response.json<{chat:Chat}>().chat;const messages=f.store.messages(fork.id);
 assert.equal(messages.at(-1)?.content,'answer');assert.ok(!messages.some(m=>m.content==='future'));assert.ok(messages.every(m=>m.chatId===fork.id&&!before.some(o=>o.id===m.id)));
 assert.deepEqual(f.store.messages(chat.id),before);assert.equal(calls,0);assert.equal(fork.forkedFrom?.messageId,'a');assert.deepEqual(f.store.worldState(fork.id)?.world,{});
 assert.deepEqual((await f.call(`/chats/${chat.id}/fork`,'POST',body,key)).json(),{chat:fork});
 const second=(await f.call(`/chats/${chat.id}/fork`,'POST',body)).json<{chat:Chat}>().chat;assert.notEqual(second.title,fork.title);
 assert.equal((await f.call(`/chats/${chat.id}/fork`,'POST',{...body,messageId:'foreign'})).statusCode,400);
 assert.equal((await f.call(`/chats/${chat.id}/fork`,'POST',{...body,expectedChatRevision:999})).statusCode,409);
 f.store.saveMessage({id:'pending',chatId:chat.id,role:'assistant',content:'partial',status:'streaming',createdAt:now} as Message);
 assert.equal((await f.call(`/chats/${chat.id}/fork`,'POST',{...body,messageId:'pending'})).statusCode,400);
});
