import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, mockServer } from './helpers.ts';
import { buildApp } from '../src/app.ts';
import { assemblePrompt } from '../src/text.ts';
import type { Character, Chat, Settings } from '@tavern/contracts';

test('chat presets are budgeted, isolated from drafts and persist per model across restart', async t => {
  const studio = await fixture(t);
  const initial = studio.store.settings();
  let draftBody: Record<string, unknown> = {};
  const url = await mockServer(t, (_request, response, body) => {
    draftBody = body;
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: '窗边的蓝色杯子。' } }] }));
  });
  const created = await studio.call('/text-models', 'POST', { ...initial, textProfileName: 'Narration', textUrl: url, textModel: 'test', textPresetName: 'Daily', textSystemPrompt: '{{char}} 与 {{user}} 自然交谈。', contextWindow: 1000000, maxTokens: 16384 });
  assert.equal(created.statusCode, 200);
  const saved = created.json<Settings>();
  const character = studio.store.list<Character>('characters')[0];
  const prompt = assemblePrompt(character, [], saved);
  assert.equal(prompt[1].content, `${character.name} 与 旅人 自然交谈。`);
  assert.throws(() => assemblePrompt(character, [], { ...saved, contextWindow: 2048, maxTokens: 512, textSystemPrompt: '长'.repeat(1000) }), /预算/);
  await studio.provider.imagePrompt(undefined, [], '杯子');
  assert.ok(!JSON.stringify(draftBody.messages).includes('自然交谈'));
  await studio.call(`/text-models/${initial.activeTextProfileId}/activate`, 'POST', {});
  assert.equal(studio.store.settings().textSystemPrompt, '');
  await studio.call(`/text-models/${saved.activeTextProfileId}/activate`, 'POST', {});
  assert.equal(studio.store.settings().textPresetName, 'Daily');
  await studio.app.close();
  const restored = await buildApp({ dataDirectory: studio.directory, startWorker: false });
  try { assert.equal(restored.store.settings().textSystemPrompt, saved.textSystemPrompt); }
  finally { await restored.app.close(); }
});

test('new profiles do not inherit a preset, and long-output settings remain bounded', async t => {
  const studio = await fixture(t);
  const settings = { ...studio.store.settings(), textSystemPrompt: 'Existing preset', textPresetName: 'Old' };
  studio.store.saveSettings(settings);
  const response = await studio.call('/text-models', 'POST', { textProfileName: 'New', textUrl: 'http://localhost:8080/v1', textModel: 'local', allowCloud: false, temperature: 1, contextWindow: 8192, maxTokens: 1024 });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json<Settings>().textSystemPrompt, '');
  for (const change of [{ contextWindow: 1048577 }, { maxTokens: 131073 }, { textSystemPrompt: 'x'.repeat(40001) }]) {
    assert.equal((await studio.call('/settings', 'PUT', { ...studio.store.settings(), ...change })).statusCode, 400);
  }
});

test('long streamed replies survive the old character limit and token truncation is explicit', async t => {
  const studio = await fixture(t);
  const url = await mockServer(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let i = 0; i < 70; i++) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x'.repeat(1000) } }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`);
  });
  studio.store.saveSettings({ ...studio.store.settings(), textUrl: url, textModel: 'test', contextWindow: 1000000, maxTokens: 16384 });
  const chat = (await studio.call('/chats', 'POST', { characterId: studio.store.list<Character>('characters')[0].id })).json<Chat>();
  assert.equal((await studio.call(`/chats/${chat.id}/generations`, 'POST', { content: '继续', expectedChatRevision: chat.revision })).statusCode, 202);
  await studio.provider.running.get(chat.id)?.promise;
  const reply = studio.store.messages(chat.id).at(-1)!;
  assert.equal(reply.content.length, 70000);
  assert.equal(reply.status, 'interrupted');
  assert.match(reply.error!, /输出长度上限/);
});
