import test from 'node:test';
import assert from 'node:assert/strict';
import type { Character, Chat, Message, SceneState, SceneContext, ImageJob } from '@tavern/contracts';
import { fixture, mockServer, mockComfy } from './helpers.ts';
import { buildApp } from '../src/app.ts';
import { sceneInput, sceneVisual, inheritScene } from '../src/scene.ts';
import { compileVisualPrompt } from '../src/visual.ts';

function state(source?: string): SceneState {
  const fact = (value = '') => ({ value, basis: source ? 'explicit' as const : 'uncertain' as const, ...(source ? { sourceMessageId: source } : {}) });
  return { identity: '成年女性，灰绿色眼睛，自然匀称体型', setting: fact('书店，清晨'), camera: fact('中景'), interaction: fact('右手扶书，另一人站在门边，两人无接触'), people: [{ id: 'main', name: '主角', inFrame: true, position: fact('窗边'), action: fact('右手扶书'), expression: fact('微笑'), outfit: fact('蓝色雨衣'), wearing: fact('袖口挽起'), appearance: fact('眼镜取下，头发束起'), props: fact('书') }, { id: 'visitor', name: '来客', inFrame: true, position: fact('门边'), action: fact('站立'), expression: fact('平静'), outfit: fact('灰色大衣'), wearing: fact('扣好'), appearance: fact('短发'), props: fact('无') }] };
}

test('inheritance preserves manual corrections until a later explicit change', () => {
  const history = [{ id: 'old' }, { id: 'new' }] as Message[];
  const previous = state('old');
  previous.people[0].outfit = { value: '白衬衫', basis: 'manual', sourceMessageId: 'old' };
  const inherited = state('old'); inherited.people[0].outfit.basis = 'inherited';
  assert.equal(inheritScene(inherited, previous, history).people[0].outfit.value, '白衬衫');
  assert.equal(inheritScene(state('old'), previous, history).people[0].outfit.value, '白衬衫');
  assert.equal(inheritScene(state('new'), previous, history).people[0].outfit.value, '蓝色雨衣');
});

test('scene checkpoints batch all history, inherit outfit, replay cutoff, invalidate edits and survive restart', async t => {
  const studio = await fixture(t);
  const calls: any[] = [];
  const endpoint = await mockServer(t, (_request, response, body) => {
    const material = JSON.parse((body.messages as { content: string }[])[1].content);
    calls.push(material);
    const value = material.previousState ?? state(material.recentConversation.at(-1)?.id);
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
  });
  studio.store.saveSettings({ ...studio.store.settings(), textUrl: endpoint, textModel: 'test', contextWindow: 32768 });
  const character = studio.store.list<Character>('characters')[0];
  character.visual = { identity: '灰绿色眼睛，默认白衬衫，温暖书店', outfit: '白衬衫' }; studio.store.saveCharacter(character);
  const chat = (await studio.call('/chats', 'POST', { characterId: character.id })).json<Chat>();
  const opening = studio.store.messages(chat.id)[0];
  for (let index = 0; index < 10; index++) studio.store.saveMessage({ ...opening, id: crypto.randomUUID(), content: index === 0 ? '她换上蓝色雨衣，挽起袖子，取下眼镜。' : `继续读书 ${index}` });
  const body = { characterId: character.id, chatId: chat.id, structured: true };
  let response = await studio.call('/image-prompts', 'POST', body);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().pendingMessages, 7);
  assert.equal((await studio.call('/image-prompts', 'POST', body)).json().pendingMessages, 3);
  response = await studio.call('/image-prompts', 'POST', body);
  assert.equal(response.json().pendingMessages, 0);
  assert.equal(calls.flatMap(call => call.recentConversation).length, 11);
  assert.equal(calls[1].previousState.people[0].outfit.value, '蓝色雨衣');
  assert.equal((await studio.call('/image-prompts', 'POST', body)).statusCode, 200);
  assert.equal(calls.length, 3, 'unchanged state uses cache');
  const history = studio.store.messages(chat.id);
  const selected = await studio.call('/image-prompts', 'POST', { ...body, sourceMessageId: history[1].id });
  assert.equal(selected.statusCode, 200, selected.body);
  assert.equal(calls.at(-1).recentConversation.at(-1).id, history[1].id);
  assert.equal(calls.at(-1).previousState, undefined, 'never inherits future state');
  const stale = await studio.call('/scene-state', 'PUT', { ...body, sceneContextKey: response.json().sceneContextKey, scene: state() });
  assert.equal(stale.statusCode, 409, 'rewriting earlier checkpoint invalidates later state');
  studio.store.saveMessage({ ...history[0], content: '改写后的开场' });
  const invalidated = (await studio.call(`/scene-state?chatId=${chat.id}`)).json<SceneContext>();
  assert.equal(invalidated.state, undefined);
  assert.equal(invalidated.pendingMessages, 11);
  await studio.call('/image-prompts', 'POST', body);
  await studio.app.close();
  const restored = await buildApp({ dataDirectory: studio.directory, startWorker: false });
  try {
    const session = await restored.app.inject({ url: '/api/v1/session', headers: { host: '127.0.0.1:3000' } });
    const resumed = await restored.app.inject({ url: `/api/v1/scene-state?chatId=${chat.id}`, headers: { host: '127.0.0.1:3000', cookie: String(session.headers['set-cookie']).split(';')[0] } });
    assert.equal(resumed.json().pendingMessages, 7);
    assert.equal(resumed.json().state.people[0].outfit.value, '蓝色雨衣');
  }
  finally { await restored.app.close(); }
});

test('manual states persist, previews equal submitted prompt, references do not lock old outfit and archived state is frozen', async t => {
  const studio = await fixture(t);
  const comfy = await mockComfy(t);
  studio.store.saveSettings({ ...studio.store.settings(), comfyUrl: comfy.url, researchUseConfirmed: true });
  const character = studio.store.list<Character>('characters')[0];
  const chat = (await studio.call('/chats', 'POST', { characterId: character.id })).json<Chat>();
  const current = (await studio.call(`/scene-state?chatId=${chat.id}`)).json<SceneContext>();
  const scene = state();
  scene.people[0].outfit.basis = 'manual';
  const body = { characterId: character.id, chatId: chat.id, scene, sceneContextKey: current.key, prompt: '自然光' };
  const saved = await studio.call('/scene-state', 'PUT', body);
  assert.equal(saved.statusCode, 200, saved.body);
  body.sceneContextKey = saved.json().key;
  body.scene = saved.json().state;
  assert.equal(body.scene.people[0].outfit.basis, 'manual');
  const preview = await studio.call('/image-prompts/preview', 'POST', body);
  assert.equal(preview.statusCode, 200, preview.body);
  const result = await studio.call('/image-jobs', 'POST', body);
  assert.equal(result.statusCode, 202, result.body);
  const job = result.json<ImageJob>();
  assert.equal(job.compiledPrompt, preview.json().compiledPrompt);
  assert.match(job.compiledPrompt!, /入镜 2 人/);
  assert.match(job.compiledPrompt!, /眼镜取下/);
  await studio.worker.tick(); comfy.complete(studio.store.get<ImageJob>('image_jobs', job.id)!.promptId!); await studio.worker.tick();
  assert.equal(studio.store.get<any>('assets', job.id).visual.scene.people[0].outfit.value, '蓝色雨衣');
  const visual = sceneVisual({ characterId: character.id, characterRevision: 1, identity: '身份', outfit: { id: 'outfit', description: '白衬衫', referenceAssetId: 'old', createdAt: '' }, references: [{ role: 'face', assetId: 'face' }, { role: 'body', assetId: 'body' }, { role: 'outfit', assetId: 'old' }] }, scene)!;
  assert.equal(visual.outfit.referenceAssetId, undefined);
  assert.deepEqual(visual.references.map(reference => reference.role), ['face', 'body']);
  assert.doesNotMatch(compileVisualPrompt('自然光', visual), /白衬衫/);
  scene.people[0].inFrame = false;
  assert.equal(sceneVisual(visual, scene)?.references.length, 0, 'off-screen main cannot transfer identity to visitor');
});

test('rejects invalid structured output and cross-chat evidence without saving partial state', async t => {
  const studio = await fixture(t);
  const endpoint = await mockServer(t, (_request, response) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: '{"identity":' } }] })));
  studio.store.saveSettings({ ...studio.store.settings(), textUrl: endpoint, textModel: 'test', contextWindow: 32768 });
  const character = studio.store.list<Character>('characters')[0];
  const chat = (await studio.call('/chats', 'POST', { characterId: character.id })).json<Chat>();
  const result = await studio.call('/image-prompts', 'POST', { chatId: chat.id, structured: true });
  assert.equal(result.statusCode, 502);
  assert.equal(studio.provider.draftCount, 0);
  assert.equal((await studio.call(`/scene-state?chatId=${chat.id}`)).json().state, undefined);
  assert.throws(() => sceneInput(state('other-chat-message'), studio.store.messages(chat.id)), /不属于/);
  const duplicate = state(); duplicate.people[1].id = 'main';
  assert.throws(() => sceneInput(duplicate, []), /不能重复/);
});

test('offline text service reports actionable error and releases automatic scene inference', async t => {
  const studio = await fixture(t);
  studio.store.saveSettings({ ...studio.store.settings(), textUrl: 'http://127.0.0.1:8080/v1', textModel: 'cyber-tiel', contextWindow: 32768 });
  studio.provider.adapter.generate = async () => { throw new TypeError('fetch failed'); };
  const character = studio.store.list<Character>('characters')[0];
  const chat = (await studio.call('/chats', 'POST', { characterId: character.id })).json<Chat>();
  const result = await studio.call('/image-prompts', 'POST', { chatId: chat.id, structured: true });
  assert.equal(result.statusCode, 503);
  assert.equal(result.json().code, 'TEXT_UNREACHABLE');
  assert.match(result.json().message, /启动本地文本服务/);
  assert.equal(studio.provider.draftCount, 0);
  assert.equal(studio.store.list('image_jobs').length, 0);
});

test('local scene output uses JSON mode and independent budget, rejecting truncation', async t => {
  const studio = await fixture(t);
  const endpoint = await mockServer(t, (_request, response, body) => {
    assert.equal(body.max_tokens, 4096);
    assert.equal((body.response_format as any).type, 'json_object');
    assert.ok((body.response_format as any).schema.properties.people);
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: JSON.stringify(state()) } }] }));
  });
  studio.store.saveSettings({ ...studio.store.settings(), textUrl: endpoint, textModel: 'cyber-tiel', maxTokens: 512, contextWindow: 32768 });
  const character = studio.store.list<Character>('characters')[0];
  const chat = (await studio.call('/chats', 'POST', { characterId: character.id })).json<Chat>();
  const result = await studio.call('/image-prompts', 'POST', { chatId: chat.id, structured: true });
  assert.equal(result.json().code, 'SCENE_TRUNCATED');
  assert.equal(studio.provider.draftCount, 0);
  assert.equal((await studio.call(`/scene-state?chatId=${chat.id}`)).json().state, undefined);
  assert.equal(studio.store.settings().maxTokens, 512);
});

test('image prompt renders confirmed state into visual prose without provenance or invented outfit', () => {
  const scene = state('evidence-message');
  scene.people[1].inFrame = false;
  scene.camera.value = '未知';
  const visual = { identity: scene.identity, scene, references: [], outfit: { description: '旧服装' } } as any;
  const prompt = compileVisualPrompt('按当前画面状态生成', visual);
  assert.match(prompt, /入镜 1 人/);
  assert.match(prompt, /身穿蓝色雨衣/);
  assert.match(prompt, /正在右手扶书/);
  assert.match(prompt, /来客在镜头外/);
  assert.match(prompt, /光照方向/);
  assert.match(prompt, /服装材质、褶皱/);
  assert.doesNotMatch(prompt, /evidence-message|explicit|旧服装|镜头与构图：未知|按当前画面状态生成/);
});
