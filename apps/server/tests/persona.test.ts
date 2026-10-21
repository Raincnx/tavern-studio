import test from 'node:test';
import assert from 'node:assert/strict';
import type { Asset, Character, Chat, ImageJob, SceneFact, SceneState, UserPersona, VisualContext } from '@tavern/contracts';
import { fixture, mockServer, samplePng } from './helpers.ts';
import { buildApp } from '../src/app.ts';
import { applyParticipants, inheritScene, sceneVisual } from '../src/scene.ts';
import { compileVisualPrompt, visualContext } from '../src/visual.ts';
import { compileChatPreset } from '../src/chat-preset.ts';

const input = { name: '林舟', description: '成年旅行者', visual: { identity: '成年男性，黑色短发', outfit: '白衬衫' } };
test('one-step introduction, atomic edits and remembered identity preserve other chats', async t => {
  const s = await fixture(t);
  const character = s.store.list<Character>('characters')[0];
  let chat = (await s.call('/chats', 'POST', { characterId: character.id })).json<Chat>();
  const endpoint = `/chats/${chat.id}/participants`;
  const invalid = await s.call(endpoint, 'PUT', { expectedChatRevision: chat.revision, persona: input, framing: 'invalid' });
  assert.equal(invalid.statusCode, 400);
  assert.equal(s.store.list('personas').length, 0);
  chat = (await s.call(endpoint, 'PUT', { expectedChatRevision: chat.revision, persona: input, framing: 'together' })).json<Chat>();
  assert.equal(chat.userPersona?.name, '林舟');
  const next = (await s.call('/chats', 'POST', { characterId: character.id })).json<Chat>();
  assert.equal(next.userPersona?.id, chat.userPersona?.id);
  assert.equal(next.framing, 'together');
  const edit = { personaId: chat.userPersona!.id, expectedChatRevision: chat.revision, expectedPersonaRevision: 1, persona: { ...input, name: '林舟新称呼' }, framing: 'pov' };
  assert.equal((await s.call(endpoint, 'PUT', { ...edit, expectedPersonaRevision: 0 })).statusCode, 409);
  const updated = (await s.call(endpoint, 'PUT', edit)).json<Chat>();
  assert.equal(updated.userPersona?.name, '林舟新称呼');
  assert.equal(s.store.get<Chat>('chats', next.id)?.userPersona?.name, '林舟');
  const third = (await s.call('/chats', 'POST', { characterId: character.id })).json<Chat>();
  assert.equal(third.userPersona?.name, '林舟新称呼');
  assert.equal(third.framing, 'pov');
  const switched = (await s.call(endpoint, 'PUT', { expectedChatRevision: updated.revision, persona: { ...input, name: '另一身份' }, switchIdentity: true })).json<Chat>();
  assert.notEqual(switched.userPersona?.id, updated.userPersona?.id);
  assert.equal(switched.userPersona?.name, '另一身份');
  assert.equal(s.store.get<Chat>('chats', third.id)?.userPersona?.name, '林舟新称呼');
});
function scene(): SceneState {
  const f = (value = ''): SceneFact => ({ value, basis: 'uncertain' });
  return { identity: '成年女性，红色长发', setting: f('书店'), camera: f('中景'), interaction: f('user 将绿书递给 main'), people: ['main', 'user'].map(id => ({ id, name: id, inFrame: true, position: f(id === 'main' ? '左侧' : '右侧'), action: f(id === 'main' ? '接书' : '递书'), expression: f('微笑'), outfit: f(id === 'main' ? '蓝裙' : '白衬衫'), wearing: f(), appearance: f(), props: f() })) };
}

test('persona ownership, revisions and immutable chat snapshots survive restart', async t => {
  const s = await fixture(t);
  const persona = (await s.call('/personas', 'POST', input)).json<UserPersona>();
  const other = (await s.call('/personas', 'POST', { ...input, name: '另一人物' })).json<UserPersona>();
  const uploaded = (await s.call(`/personas/${persona.id}/references`, 'POST', { pngBase64: samplePng().toString('base64') })).json<Asset>();
  assert.equal(uploaded.personaId, persona.id);
  const updated = await s.call(`/personas/${persona.id}`, 'PUT', { ...input, visual: { ...input.visual, faceAssetId: uploaded.id }, expectedRevision: 1 });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal((await s.call(`/personas/${other.id}`, 'PUT', { ...input, visual: { ...input.visual, faceAssetId: uploaded.id }, expectedRevision: 1 })).statusCode, 400);
  assert.equal((await s.call(`/personas/${persona.id}`, 'PUT', { ...input, expectedRevision: 1 })).statusCode, 409);
  const character = s.store.list<Character>('characters')[0];
  let chat = (await s.call('/chats', 'POST', { characterId: character.id })).json<Chat>();
  chat = (await s.call(`/chats/${chat.id}/participants`, 'PUT', { personaId: persona.id, framing: 'together', expectedChatRevision: chat.revision })).json<Chat>();
  assert.equal(chat.userPersona?.revision, 2);
  const before = visualContext(s.store, character, chat).key;
  await s.call(`/personas/${persona.id}`, 'PUT', { ...input, name: '改名', expectedRevision: 2 });
  assert.equal(visualContext(s.store, character, s.store.get<Chat>('chats', chat.id)).key, before);
  assert.equal((await s.call(`/chats/${chat.id}/participants`, 'PUT', { personaId: other.id, expectedChatRevision: chat.revision })).statusCode, 409);
  assert.equal((await s.call(`/chats/${chat.id}/participants`, 'PUT', { personaId: persona.id, expectedChatRevision: 1 })).statusCode, 409);
  await s.app.close();
  const restored = await buildApp({ dataDirectory: s.directory, startWorker: false });
  try {
    assert.equal(restored.store.get<UserPersona>('personas', persona.id)?.name, '改名');
    assert.equal(restored.store.get<Chat>('chats', chat.id)?.userPersona?.name, '林舟');
    assert.equal(restored.store.get<Chat>('chats', chat.id)?.userPersona?.visual.faceAssetId, uploaded.id);
  } finally { await restored.app.close(); }
});

test('two identities keep separate outfits and reference numbering, POV removes only user references', async t => {
  const s = await fixture(t);
  const character = s.store.list<Character>('characters')[0];
  const persona = (await s.call('/personas', 'POST', input)).json<UserPersona>();
  const mainRef = (await s.call(`/characters/${character.id}/references`, 'POST', { pngBase64: samplePng().toString('base64') })).json<Asset>();
  const userRef = (await s.call(`/personas/${persona.id}/references`, 'POST', { pngBase64: samplePng().toString('base64') })).json<Asset>();
  character.visual = { identity: '成年女性，红色长发', outfit: '蓝裙', faceAssetId: mainRef.id };
  persona.visual.faceAssetId = userRef.id;
  const chat = { id: 'test', userPersona: persona, framing: 'together' } as Chat;
  const visual = visualContext(s.store, character, chat).snapshot;
  assert.throws(() => sceneVisual(visual), /双方画面状态/);
  const previous = scene(), next = scene();
  next.people[0].outfit = { value: '', basis: 'inherited' };
  next.people[1].outfit = { value: '绿色夹克', basis: 'explicit', sourceMessageId: 'new' };
  const state = inheritScene(next, previous, []);
  assert.equal(state.people[0].outfit.value, '蓝裙');
  assert.equal(state.people[1].outfit.value, '绿色夹克');
  const frozen = sceneVisual(visual, state)!;
  const prompt = compileVisualPrompt('', frozen);
  assert.match(prompt, /<image1> 仅用于主角 main/);
  assert.match(prompt, /<image2> 仅用于用户人物 user（林舟）/);
  assert.match(prompt, /绿色夹克/);
  assert.deepEqual(frozen.references.map(r => r.assetId), [mainRef.id, userRef.id]);
  const pov = sceneVisual({ ...visual, framing: 'pov' }, state)!;
  assert.deepEqual(pov.references.map(r => r.assetId), [mainRef.id]);
  assert.equal(pov.scene?.people.find(p => p.id === 'user')?.inFrame, false);
  assert.equal(state.people[1].inFrame, true, 'preview must not mutate source state');
  const missing = scene(); missing.people.pop();
  assert.throws(() => applyParticipants(missing, visual), /main 和 user/);
  const auto = scene(); auto.people[1].inFrame = false;
  assert.equal(applyParticipants(auto, { ...visual, framing: 'auto' }).people[1].inFrame, false);
});

test('bound persona reaches extraction, missing user is rejected, task snapshots ignore later mode edits', async t => {
  const s = await fixture(t);
  const character = s.store.list<Character>('characters')[0];
  const persona = (await s.call('/personas', 'POST', input)).json<UserPersona>();
  let chat = (await s.call('/chats', 'POST', { characterId: character.id })).json<Chat>();
  chat = (await s.call(`/chats/${chat.id}/participants`, 'PUT', { personaId: persona.id, framing: 'together', expectedChatRevision: chat.revision })).json<Chat>();
  let omitUser = true;
  let material: any;
  const url = await mockServer(t, (_req, res, body) => {
    material = JSON.parse((body.messages as { content: string }[])[1].content);
    const value = scene(); if (omitUser) value.people.pop();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
  });
  s.store.saveSettings({ ...s.store.settings(), textUrl: url, textModel: 'test', contextWindow: 32768, researchUseConfirmed: true });
  const body = { characterId: character.id, chatId: chat.id, structured: true };
  assert.equal((await s.call('/image-prompts', 'POST', body)).statusCode, 422);
  assert.equal(material.userPersona.name, '林舟'); assert.equal(material.framing, 'together');
  assert.equal((await s.call(`/scene-state?chatId=${chat.id}`)).json().state, undefined);
  omitUser = false;
  const inferred = (await s.call('/image-prompts', 'POST', body)).json();
  const context = (await s.call(`/visual-context?chatId=${chat.id}`)).json<VisualContext>();
  const queued = await s.call('/image-jobs', 'POST', { ...body, prompt: '按当前画面状态生成', scene: inferred.scene, sceneContextKey: inferred.sceneContextKey, visualContextKey: context.key });
  assert.equal(queued.statusCode, 202, queued.body);
  const job = queued.json<ImageJob>();
  assert.equal(job.visual?.userPersona?.name, '林舟');
  assert.equal(job.visual?.framing, 'together');
  assert.match(job.compiledPrompt!, /入镜 2 人/);
  await s.call(`/chats/${chat.id}/participants`, 'PUT', { personaId: persona.id, framing: 'pov', expectedChatRevision: chat.revision });
  assert.equal(s.store.get<ImageJob>('image_jobs', job.id)?.visual?.framing, 'together');
  assert.equal((await s.call('/image-prompts/preview', 'POST', { ...body, prompt: 'test', scene: inferred.scene, sceneContextKey: inferred.sceneContextKey })).statusCode, 409);
});

test('normal and full presets use the bound persona without rewriting preset JSON', async t => {
  const s = await fixture(t);
  const character = s.store.list<Character>('characters')[0];
  const persona = (await s.call('/personas', 'POST', input)).json<UserPersona>();
  const raw = JSON.stringify({ prompts: [{ identifier: 'greet', role: 'system', content: '{{char}}和{{user}}聊天' }, { identifier: 'personaDescription', marker: true }], prompt_order: [{ character_id: 100001, order: [{ identifier: 'greet', enabled: true }, { identifier: 'personaDescription', enabled: true }] }] });
  s.store.saveSettings({...s.store.settings(),contextWindow:32768});
  const compiled = compileChatPreset(raw, character, [], persona);
  assert.match(compiled[0].content, /林舟/);
  assert.match(compiled[1].content, /成年旅行者/);
  assert.equal(JSON.parse(raw).prompts[0].content, '{{char}}和{{user}}聊天');
  const chat=(await s.call('/chats','POST',{characterId:character.id})).json<Chat>();
  assert.ok(!s.provider.prompt(chat.id,character,[],s.store.settings()).some(m=>m.content.includes('林舟')));
  assert.equal((await s.call(`/chats/${chat.id}/participants`,'PUT',{personaId:persona.id,framing:'together',expectedChatRevision:chat.revision})).statusCode,200);
  assert.match(s.provider.prompt(chat.id,character,[],s.store.settings()).map(m=>m.content).join('\n'),/林舟/);
});
