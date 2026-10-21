import test from 'node:test';
import assert from 'node:assert/strict';
import { compileChatPreset, parseChatPreset } from '../src/chat-preset.ts';
import { assemblePrompt } from '../src/text.ts';
import { fixture, mockServer } from './helpers.ts';
import { buildApp } from '../src/app.ts';
import type { Character, Message, Settings } from '@tavern/contracts';

const raw = JSON.stringify({
  temperature: 1, top_p: 0.9, frequency_penalty: 0, presence_penalty: 0, custom_future_field: { preserved: true },
  prompts: [
    { identifier: 'init', role: 'system', content: '{{setvar::style::old}}{{setvar::unused::}}' },
    { identifier: 'off', role: 'system', content: '{{setvar::style::wrong}}' },
    { identifier: 'style', role: 'system', content: '{{setvar::style::new}}{{addvar::style:: plus}}' },
    { identifier: 'charDescription', marker: true }, { identifier: 'chatHistory', marker: true },
    { identifier: 'end', role: 'system', content: '{{getvar::style}}: {{char}} / {{user}} / {{lastUserMessage}}{{trim}}' },
  ],
  prompt_order: [{ character_id: 100001, order: ['init', 'off', 'style', 'charDescription', 'chatHistory', 'end'].map(identifier => ({ identifier, enabled: identifier !== 'off' })) }],
});

test('full preset honors enabled order, data macros and post-history instructions without rewriting source', async t => {
  const studio = await fixture(t);
  const character = studio.store.list<Character>('characters')[0];
  const history = [{ role: 'user', content: 'latest', status: 'complete' }] as Message[];
  const messages = compileChatPreset(raw, character, history);
  assert.equal(messages.at(-2)?.content, 'latest');
  assert.equal(messages.at(-1)?.content, `new plus: ${character.name} / 旅人 / latest`);
  assert.ok(!JSON.stringify(messages).includes('wrong'));
  assert.equal(parseChatPreset(raw).custom_future_field && true, true);
  assert.throws(() => compileChatPreset(raw.replace('{{getvar::style}}', '{{unsupported}}'), character, history), /不支持/);
  assert.throws(() => assemblePrompt(character, history, { ...studio.store.settings(), textPresetJson: raw, contextWindow: 300, maxTokens: 64 }), /预算/);
});

test('raw JSON and original output limit persist across model switching and server restart', async t => {
  const studio = await fixture(t);
  const initial = studio.store.settings();
  const response = await studio.call('/text-models', 'POST', { ...initial, textPresetJson: raw, textProfileName: 'Full', textUrl: 'http://localhost:8080/v1', textModel: 'test', contextWindow: 1000000, maxTokens: 100000 });
  assert.equal(response.statusCode, 200);
  const saved = response.json<Settings>();
  assert.equal(saved.textPresetJson, raw);
  const next = await studio.call('/text-models', 'POST', { ...initial, textProfileName: 'Other', textUrl: 'http://localhost:8080/v1', textModel: 'other' });
  assert.equal(next.json<Settings>().textPresetJson, '');
  await studio.call(`/text-models/${saved.activeTextProfileId}/activate`, 'POST', {});
  assert.equal(studio.store.settings().textPresetJson, raw);
  await studio.app.close();
  const restored = await buildApp({ dataDirectory: studio.directory, startWorker: false });
  try { assert.equal(restored.store.settings().textPresetJson, raw); assert.equal(restored.store.settings().maxTokens, 100000); }
  finally { await restored.app.close(); }
});

test('full chat preset is not sent during image-state inference', async t => {
  const studio = await fixture(t);
  let outgoing = '';
  const url = await mockServer(t, (_request, response, body) => {
    outgoing = JSON.stringify(body);
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: '杯子放在桌上。' } }] }));
  });
  studio.store.saveSettings({ ...studio.store.settings(), textPresetJson: raw, textUrl: url, textModel: 'test' });
  await studio.provider.imagePrompt(undefined, [], '杯子');
  assert.ok(!outgoing.includes('custom_future_field'));
  assert.ok(!outgoing.includes('new plus'));
});
