import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import { buildApp } from '../src/app.ts';

test('credentials survive restart, stay private, and explicit clearing persists', async context => {
  const studio = await fixture(context);
  const secret = 'test-only-persistent-secret';
  const settings = studio.store.settings();
  const saved = await studio.call('/settings', 'PUT', { ...settings, apiKey: secret });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().hasApiKey, true);
  assert.ok(!saved.body.includes(secret));
  const kept = await studio.call('/settings', 'PUT', { ...settings, apiKey: '' });
  assert.equal(kept.json().hasApiKey, true);
  assert.ok(!(await studio.call('/bootstrap')).body.includes(secret));
  await studio.app.close();
  const restarted = await buildApp({ dataDirectory: studio.directory, startWorker: false });
  try {
    assert.equal(restarted.provider.apiKey, secret);
    const session = await restarted.app.inject({ url: '/api/v1/session', headers: { host: '127.0.0.1:3000' } });
    const cleared = await restarted.app.inject({ url: '/api/v1/settings', method: 'PUT', headers: { host: '127.0.0.1:3000', cookie: String(session.headers['set-cookie']).split(';')[0], 'x-tavern-csrf': session.json().csrfToken }, payload: { ...settings, clearApiKey: true } });
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.json().hasApiKey, false);
  } finally { await restarted.app.close(); }
  const clearedRestart = await buildApp({ dataDirectory: studio.directory, startWorker: false });
  try { assert.equal(clearedRestart.provider.apiKey, ''); } finally { await clearedRestart.app.close(); }
});
