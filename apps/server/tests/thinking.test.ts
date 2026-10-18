import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatCompletionsAdapter } from '../src/text-adapter.ts';
import { fixture } from './helpers.ts';

test('thinking level persists per profile and is sent through the correct provider protocol', async context => {
  const studio = await fixture(context);
  const original = studio.store.settings();
  const created = await studio.call('/text-models', 'POST', { ...original, textProfileName: 'Gemini', textUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', textModel: 'gemini-3.8-flash', allowCloud: true, textReasoningEffort: 'low' });
  assert.equal(created.statusCode, 200);
  const id = created.json().activeTextProfileId;
  let request: Record<string, unknown> = {};
  context.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => { request = JSON.parse(String(options.body)); return new Response('{}'); });
  const adapter = new ChatCompletionsAdapter();
  await adapter.generate(studio.store.settings(), '', [{ role: 'user', content: 'Hello' }], true, new AbortController().signal);
  assert.deepEqual(request.extra_body, { google: { thinking_config: { thinking_level: 'low' } } });
  assert.equal(request.temperature, undefined);
  await studio.call(`/text-models/${original.activeTextProfileId}/activate`, 'POST', {});
  assert.equal(studio.store.settings().textReasoningEffort, 'default');
  await studio.call(`/text-models/${id}/activate`, 'POST', {});
  assert.equal(studio.store.settings().textReasoningEffort, 'low');
  await adapter.generate({ ...studio.store.settings(), textUrl: 'https://other.example/v1' }, '', [], false, new AbortController().signal);
  assert.equal(request.reasoning_effort, 'low');
  assert.equal(request.extra_body, undefined);
  const invalid = await studio.call('/settings', 'PUT', { ...studio.store.settings(), textReasoningEffort: 'invalid' });
  assert.equal(invalid.statusCode, 400);
});
