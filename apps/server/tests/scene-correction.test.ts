import test from 'node:test';
import assert from 'node:assert/strict';
import type { Character, Chat, SceneState, ImageJob, SceneContext } from '@tavern/contracts';
import { correctionProposal } from '../src/scene-correction.ts';
import { fixture, mockServer } from './helpers.ts';

function scene(): SceneState {
  const f = (value = '') => ({ value, basis: 'manual' as const });
  return { identity: '成年人物', setting: f('书店'), camera: f('中景'), interaction: f('递书'), people: ['main', 'user'].map(id => ({ id, name: id === 'main' ? '店主' : '林舟', inFrame: true, position: f(), action: f('拿书'), outfit: f('白衬衫和深色长裤'), expression: f('微笑'), wearing: f(), appearance: f(), props: f('绿书') })) };
}
const patch = { question: '', changes: [{ personId: 'user', field: 'outfit', value: '黑外套和深色长裤' }] };
test('correction patches preserve all unrelated facts and reject identity edits, ambiguity and foreign subjects', () => {
  const original = scene(), result = correctionProposal(patch, original);
  assert.equal(result.state.people[1].outfit.value, '黑外套和深色长裤');
  assert.deepEqual(result.state.people[0], original.people[0]);
  assert.deepEqual(result.state.setting, original.setting);
  assert.equal(original.people[1].outfit.value, '白衬衫和深色长裤');
  for (const change of [{personId:'stranger',field:'outfit',value:'x'}, {personId:'user',field:'identity',value:'x'}, {personId:'user',field:'setting',value:'x'}]) assert.throws(() => correctionProposal({question:'',changes:[change]},original));
  assert.throws(() => correctionProposal({...patch, question:'你指谁？'},original));
  assert.throws(() => correctionProposal({question:'',changes:[...patch.changes,...patch.changes]},original));
  assert.deepEqual(correctionProposal({question:'你指哪位人物？',changes:[]},original).state,original);
});

test('correction inference never writes state; temporary jobs freeze it while explicit persistence changes subsequent state', async t => {
  const s = await fixture(t);
  const character = s.store.list<Character>('characters')[0];
  const chat = (await s.call('/chats','POST',{characterId:character.id})).json<Chat>();
  let material: any, reply: unknown = patch;
  const url = await mockServer(t, (_req,res,body) => { material=body;res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({choices:[{message:{content:JSON.stringify(reply)}}]})); });
  s.store.saveSettings({...s.store.settings(),textUrl:url,textModel:'test',contextWindow:32768,researchUseConfirmed:true,textSystemPrompt:'PRIVATE_PRESET_SENTINEL'});
  const target={characterId:character.id,chatId:chat.id};
  const initial=(await s.call(`/scene-state?chatId=${chat.id}`)).json<SceneContext>();
  const saved=(await s.call('/scene-state','PUT',{...target,scene:scene(),sceneContextKey:initial.key})).json<SceneContext>();
  const body={...target,scene:saved.state,sceneContextKey:saved.key,instruction:'我穿黑外套，裤子不变'};
  const response=await s.call('/scene-corrections','POST',body);
  assert.equal(response.statusCode,200,response.body);
  assert.ok(!JSON.stringify(material).includes('PRIVATE_PRESET_SENTINEL'));
  assert.deepEqual(Object.keys(JSON.parse(material.messages[1].content)).sort(),['intent','previousState']);
  const proposed=response.json();
  assert.equal((await s.call(`/scene-state?chatId=${chat.id}`)).json().state.people[1].outfit.value,'白衬衫和深色长裤');
  const job=(await s.call('/image-jobs','POST',{...target,scene:proposed.state,sceneContextKey:saved.key,prompt:'按当前画面状态生成'})).json<ImageJob>();
  assert.match(job.compiledPrompt!,/黑外套/);
  assert.equal((await s.call(`/scene-state?chatId=${chat.id}`)).json().state.people[1].outfit.value,'白衬衫和深色长裤');
  assert.equal((await s.call('/scene-state','PUT',{...target,scene:proposed.state,sceneContextKey:saved.key})).statusCode,200);
  assert.equal((await s.call(`/scene-state?chatId=${chat.id}`)).json().state.people[1].outfit.value,'黑外套和深色长裤');
  assert.equal((await s.call('/scene-corrections','POST',body)).statusCode,409,'stale proposal must fail');
  const latest=(await s.call(`/scene-state?chatId=${chat.id}`)).json<SceneContext>();
  reply={question:'请说明是哪位人物',changes:[]};
  const question=(await s.call('/scene-corrections','POST',{...body,scene:latest.state,sceneContextKey:latest.key})).json();
  assert.equal(question.question,'请说明是哪位人物');
  assert.equal((await s.call(`/scene-state?chatId=${chat.id}`)).json().key,latest.key);
});
