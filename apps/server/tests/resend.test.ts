import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import type { Chat, Message } from '@tavern/contracts';
test('resend updates the same story, archives old history, and is idempotent', async t => {
 const f = await fixture(t); const character=f.store.bootstrap().characters[0];
 const chat=(await f.call('/chats','POST',{characterId:character.id})).json<Chat>();
 const now=new Date().toISOString();
 const user: Message={id:'edit-user',chatId:chat.id,role:'user',content:'old',status:'complete',createdAt:now};
 f.store.saveMessage(user); f.store.saveMessage({...user,id:'old-reply',role:'assistant',content:'future'});
 f.store.saveSettings({...f.store.settings(),textUrl:'http://127.0.0.1:9999/v1',textModel:'test',contextWindow:100000});
 let starts=0; f.provider.start=()=>{starts++;};
 const before=f.store.messages(chat.id);
 const key=crypto.randomUUID(); const body={messageId:user.id,content:'edited',expectedChatRevision:chat.revision};
 const response=await f.call(`/chats/${chat.id}/resend`,'POST',body,key); assert.equal(response.statusCode,202);
 const result=response.json(); const copied=f.store.messages(result.chat.id);
 assert.equal(result.chat.id,chat.id); assert.equal(result.chat.title,chat.title); assert.equal(f.store.list<Chat>('chats').length,1); assert.equal(result.chat.revision,chat.revision+1); const archive=f.store.db.prepare('SELECT body FROM chat_revisions WHERE chat_id=?').get(chat.id) as {body:string}; assert.deepEqual(JSON.parse(archive.body).messages,before); assert.equal(copied.at(-2)?.content,'edited'); assert.ok(!copied.some(m=>m.content==='future')); assert.ok(copied.every(m=>m.chatId===result.chat.id));
 assert.deepEqual((await f.call(`/chats/${chat.id}/resend`,'POST',body,key)).json(),result); assert.equal(starts,1);
 assert.equal((await f.call(`/chats/${chat.id}/resend`,'POST',{...body,messageId:'other',expectedChatRevision:result.chat.revision})).statusCode,400);
 assert.equal((await f.call(`/chats/${chat.id}/resend`,'POST',{...body,expectedChatRevision:99})).statusCode,409);
});

