import test from 'node:test';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { fixture, mockServer, until } from './helpers.ts';

function post(address: string, headers: Record<string, string>, signal: AbortSignal): Promise<{ status: number; prompt?: string }> {
  return new Promise((resolve, reject) => {
    const req = request(new URL('/api/v1/image-prompts', address), { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, signal }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, ...JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end('{}');
  });
}

test('draft disconnect cancels upstream, rejects duplicates and releases text lock', async context => {
  const studio = await fixture(context);
  let upstreamClosed = false;
  let received = false;
  const endpoint = await mockServer(context, (_request, response, body) => {
    received = true;
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.max_tokens, 768);
    response.on('close', () => { upstreamClosed = true; });
  });
  await studio.call('/settings', 'PUT', { ...studio.store.settings(), textUrl: endpoint, textModel: 'cyber-tiel', maxTokens: 2048 });
  const address = await studio.app.listen({ host: '127.0.0.1', port: 0 });
  const controller = new AbortController();
  const pending = post(address, studio.headers, controller.signal).catch(() => null);
  await until(() => received);
  assert.equal((await studio.call('/image-prompts', 'POST', {})).statusCode, 409);
  controller.abort();
  await pending;
  await until(() => studio.provider.draftCount === 0 && upstreamClosed);
  assert.equal((await studio.call('/settings', 'PUT', studio.store.settings())).statusCode, 200);
});

test('draft response survives the ordinary 15 second idle connection timeout', async context => {
  const studio = await fixture(context);
  const endpoint = await mockServer(context, (_request, response) => {
    const timer = setTimeout(() => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: '窗边读书。' } }] })), 16000);
    response.on('close', () => clearTimeout(timer));
  });
  await studio.call('/settings', 'PUT', { ...studio.store.settings(), textUrl: endpoint, textModel: 'test' });
  const address = await studio.app.listen({ host: '127.0.0.1', port: 0 });
  const response = await post(address, studio.headers, AbortSignal.timeout(22000));
  assert.equal(response.status, 200);
  assert.equal(response.prompt, '窗边读书。');
  assert.equal(studio.provider.draftCount, 0);
});
