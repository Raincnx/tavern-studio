import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, mockServer } from './helpers.ts';
import { buildApp } from '../src/app.ts';
import type { Settings } from '@tavern/contracts';

test('model profiles isolate credentials, route requests, retain parameters and survive restart', async context => {
  const studio = await fixture(context);
  const calls: { model: unknown; authorization: string | undefined }[] = [];
  const endpoint = await mockServer(context, (request, response, body) => {
    calls.push({ model: body.model, authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: '窗边的书桌。' } }] }));
  });
  const saved = await studio.call('/settings', 'PUT', { ...studio.store.settings(), textProfileName: 'First', textUrl: endpoint, textModel: 'model-a', apiKey: 'secret-a' });
  assert.equal(saved.statusCode, 200);
  const first = saved.json().activeTextProfileId;
  const created = await studio.call('/text-models', 'POST', { ...studio.store.settings(), textProfileName: 'Second', textUrl: endpoint, textModel: 'model-b', temperature: 0.2, apiKey: 'secret-b' });
  assert.equal(created.statusCode, 200);
  const second = created.json().activeTextProfileId;
  assert.notEqual(second, first);
  assert.equal(created.json().textProfiles.length, 2);
  assert.ok(!created.body.includes('secret-'));
  await studio.provider.imagePrompt(undefined, [], '书桌');
  assert.deepEqual(calls.pop(), { model: 'model-b', authorization: 'Bearer secret-b' });
  const stale = await studio.call('/settings', 'PUT', { ...saved.json<Settings>(), apiKey: 'wrong-key' });
  assert.equal(stale.statusCode, 409);
  assert.equal((await studio.call(`/text-models/${first}/activate`, 'POST', {})).statusCode, 200);
  await studio.provider.imagePrompt(undefined, [], '书桌');
  assert.deepEqual(calls.pop(), { model: 'model-a', authorization: 'Bearer secret-a' });
  studio.provider.draftCount = 1;
  assert.equal((await studio.call(`/text-models/${second}/activate`, 'POST', {})).statusCode, 409);
  assert.equal((await studio.call('/settings', 'PUT', studio.store.settings())).statusCode, 409);
  studio.provider.draftCount = 0;
  assert.equal((await studio.call('/settings', 'PUT', { ...studio.store.settings(), textUrl: 'https://other.example/v1', allowCloud: true })).statusCode, 400);
  await studio.call(`/text-models/${second}/activate`, 'POST', {});
  assert.equal(studio.store.settings().temperature, 0.2);
  assert.ok(!JSON.stringify(studio.store.events(0)).includes('secret-'));
  await studio.app.close();
  const restored = await buildApp({ dataDirectory: studio.directory, startWorker: false });
  try {
    assert.equal(restored.store.settings().activeTextProfileId, second);
    assert.equal(restored.provider.apiKey, 'secret-b');
    assert.equal(restored.store.textApiKey(first), 'secret-a');
  } finally { await restored.app.close(); }
});

test('legacy single-model settings migrate once without losing or sharing the key', async context => {
  const studio = await fixture(context);
  const { activeTextProfileId: _id, textProfiles: _profiles, textProfileName: _name, ...legacy } = studio.store.settings();
  studio.store.db.prepare('UPDATE settings SET body = ? WHERE key = ?').run(JSON.stringify({ ...legacy, textUrl: 'https://legacy.example/v1', textModel: 'legacy', allowCloud: true }), 'main');
  studio.store.db.exec("DELETE FROM settings WHERE key LIKE 'textProfile:%' OR key LIKE 'textApiKey:%'");
  studio.store.saveTextApiKey('legacy-secret');
  await studio.app.close();
  const restored = await buildApp({ dataDirectory: studio.directory, startWorker: false });
  try {
    assert.equal(restored.provider.apiKey, 'legacy-secret');
    assert.equal(restored.store.textProfiles()[0].textModel, 'legacy');
    assert.equal(restored.store.textProfiles().length, 1);
    assert.ok(!JSON.stringify(restored.store.bootstrap()).includes('legacy-secret'));
    assert.equal(restored.store.db.prepare('SELECT body FROM settings WHERE key = ?').get('textApiKey'), undefined);
  } finally { await restored.app.close(); }
});

test('a new local model does not inherit the current provider credential', async context => {
  const studio = await fixture(context);
  await studio.call('/settings', 'PUT', { ...studio.store.settings(), apiKey: 'private-key' });
  const result = await studio.call('/text-models', 'POST', { ...studio.store.settings(), textProfileName: 'Local', textUrl: 'http://localhost:1234/v1', textModel: 'local' });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().hasApiKey, false);
  assert.equal(studio.provider.apiKey, '');
});
