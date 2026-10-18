import test from 'node:test';
import assert from 'node:assert/strict';
import { providerError } from '../src/text.ts';

test('provider errors distinguish exhausted credit from rate limits without exposing raw bodies', async () => {
  const quota = await providerError(new Response(JSON.stringify({ error: { code: '1113', message: 'private-provider-content' } }), { status: 429 }));
  assert.equal(quota.code, 'TEXT_QUOTA_EXHAUSTED');
  assert.match(quota.message, /余额不足/);
  assert.match(quota.message, /1113/);
  assert.ok(!quota.message.includes('private-provider-content'));
  const limited = await providerError(new Response('upstream unavailable', { status: 429 }));
  assert.equal(limited.code, 'TEXT_RATE_LIMITED');
  const auth = await providerError(new Response('{}', { status: 401 }));
  assert.equal(auth.code, 'TEXT_AUTH_ERROR');
});
