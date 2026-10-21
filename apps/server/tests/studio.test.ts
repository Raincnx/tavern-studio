import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { get } from 'node:http';
import { fixture, mockComfy, mockServer, samplePng, until, workflowPath } from './helpers.ts';
import { inspectPng } from '../src/images.ts';
import { compileWorkflow, loadWorkflow } from '../src/comfy.ts';
import { assemblePrompt } from '../src/text.ts';
import { buildApp } from '../src/app.ts';
import type { Character, Chat, ImageJob, Message } from '@tavern/contracts';

test('scene inference uses recent conversation and selected-message cutoff', async context => {
  const studio = await fixture(context);
  const requests: Record<string, unknown>[] = [];
  const url = await mockServer(context, (_request, response, body) => {
    requests.push(body);
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: '窗边的成年女性手捧茶杯，雨后柔光，近景。' } }] }));
  });
  studio.store.saveSettings({ ...studio.store.settings(), textUrl: url, textModel: 'scene-test' });
  const character = studio.store.list<Character>('characters')[0];
  const chat = (await studio.call('/chats', 'POST', { characterId: character.id })).json<Chat>();
  const opening = studio.store.messages(chat.id)[0];
  const first: Message = { ...opening, id: crypto.randomUUID(), role: 'user', content: '我们离开森林，来到海边咖啡馆。', createdAt: new Date(Date.now() + 1000).toISOString() };
  const last: Message = { ...opening, id: crypto.randomUUID(), role: 'assistant', content: '我坐在窗边，捧起茶杯。', createdAt: new Date(Date.now() + 2000).toISOString() };
  studio.store.saveMessage(first);
  studio.store.saveMessage(last);
  const result = await studio.call('/image-prompts', 'POST', { chatId: chat.id });
  assert.equal(result.statusCode, 200);
  const material = JSON.parse((requests[0].messages as { content: string }[])[1].content);
  assert.equal(material.character.name, character.name);
  assert.ok(material.recentConversation.some((item: { content: string }) => item.content === first.content));
  assert.equal(material.recentConversation.at(-1).content, last.content);
  assert.equal((await studio.call('/image-prompts', 'POST', { chatId: chat.id, sourceMessageId: first.id })).statusCode, 200);
  const selected = JSON.parse((requests[1].messages as { content: string }[])[1].content);
  assert.equal(selected.recentConversation.at(-1).content, first.content);
  assert.ok(!JSON.stringify(selected).includes(last.content));
  const other = (await studio.call('/chats', 'POST', { characterId: character.id })).json<Chat>();
  assert.equal((await studio.call('/image-prompts', 'POST', { chatId: other.id, sourceMessageId: first.id })).statusCode, 400);
});

test('local session, Origin, Host and CSRF are enforced', async context => {
  const studio = await fixture(context);
  assert.equal((await studio.app.inject({ url: '/api/v1/bootstrap', headers: { host: '127.0.0.1:3000' } })).statusCode, 401);
  assert.equal((await studio.app.inject({ url: '/api/v1/session', headers: { host: 'attacker.example:3000' } })).statusCode, 403);
  assert.equal((await studio.app.inject({ url: '/api/v1/session', headers: { host: '127.0.0.1:3000', origin: 'https://attacker.example' } })).statusCode, 403);
  assert.equal((await studio.app.inject({ url: '/api/v1/settings', method: 'PUT', headers: { host: '127.0.0.1:3000', cookie: studio.headers.cookie }, payload: {} })).statusCode, 403);
  assert.equal((await studio.call('/bootstrap')).statusCode, 200);
});

test('character editing checks revision and V2 import/export preserves unknown data', async context => {
  const studio = await fixture(context);
  const character = studio.store.list<Character>('characters')[0];
  assert.equal((await studio.call(`/characters/${character.id}`, 'PATCH', { ...character, revision: 0 })).statusCode, 409);
  const edited = await studio.call(`/characters/${character.id}`, 'PATCH', { ...character, name: '测试角色', revision: 1 });
  assert.equal(edited.json<Character>().revision, 2);
  const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '导入角色', description: '测试描述', extensions: { unknown: { keep: true } }, custom_field: 'retain' } };
  const imported = await studio.call('/imports/characters', 'POST', { card });
  assert.equal(imported.statusCode, 200);
  const result = await studio.call(`/characters/${imported.json<{ character: Character }>().character.id}/export`);
  assert.equal(result.json().data.custom_field, 'retain');
  assert.deepEqual(result.json().data.extensions.unknown, { keep: true });
  assert.equal((await studio.call('/imports/characters', 'POST', { card: { spec: 'chara_card_v3', data: { name: '不支持' } } })).statusCode, 422);
});

test('PNG character card imports avatar without exposing embedded card metadata', async context => {
  const studio = await fixture(context);
  const card = { spec: 'chara_card_v2', data: { name: 'PNG角色', description: 'secret-persona' } };
  const image = samplePng(`chara\0${Buffer.from(JSON.stringify(card)).toString('base64')}`);
  const response = await studio.call('/imports/characters', 'POST', { pngBase64: image.toString('base64') });
  assert.equal(response.statusCode, 200);
  const character = response.json<{ character: Character }>().character;
  assert.ok(character.avatarId);
  const media = await studio.call(`/media/${character.avatarId}`);
  assert.equal(media.statusCode, 200);
  assert.equal(media.rawPayload.includes(Buffer.from('chara')), false);
});

test('chat creation is idempotent and conflicting retries return 409', async context => {
  const studio = await fixture(context);
  const characters = studio.store.list<Character>('characters');
  const key = crypto.randomUUID();
  const original = await studio.call('/chats', 'POST', { characterId: characters[0].id }, key);
  const repeated = await studio.call('/chats', 'POST', { characterId: characters[0].id }, key);
  assert.equal(original.json<Chat>().id, repeated.json<Chat>().id);
  assert.equal(studio.store.list('chats').length, 1);
  assert.equal(studio.store.messages(original.json<Chat>().id).length, 1);
  assert.equal((await studio.call('/chats', 'POST', { characterId: characters[1].id }, key)).statusCode, 409);
});

test('unconfigured text provider does not create phantom messages', async context => {
  const studio = await fixture(context);
  const chat = (await studio.call('/chats', 'POST', { characterId: studio.store.list<Character>('characters')[0].id })).json<Chat>();
  const response = await studio.call(`/chats/${chat.id}/generations`, 'POST', { content: '你好', expectedChatRevision: chat.revision });
  assert.equal(response.statusCode, 409);
  assert.equal(studio.store.messages(chat.id).length, 1);
});

test('text SSE is decoded, persisted and replayed without duplicating a retry', async context => {
  const studio = await fixture(context);
  let requests = 0;
  const url = await mockServer(context, (request, response, body) => {
    if (request.url === '/v1/chat/completions') {
      if(!body.stream) {response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({choices:[{message:{content:'{"patches":[]}'},finish_reason:'stop'}]}));return;}
      requests++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const data = Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: '你好，旅人。' } }] })}\r\n\r\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\r\n\r\ndata: [DONE]\r\n\r\n`);
      response.write(data.subarray(0, 56)); setTimeout(() => response.end(data.subarray(56)), 40); return;
    }
    response.writeHead(404).end();
  });
  studio.store.saveSettings({ ...studio.store.settings(), textUrl: `${url}/v1`, textModel: 'test-model', contextWindow:32768 });
  const chat = (await studio.call('/chats', 'POST', { characterId: studio.store.list<Character>('characters')[0].id })).json<Chat>();
  const key = crypto.randomUUID();
  const body = { content: '你好', expectedChatRevision: chat.revision };
  assert.equal((await studio.call(`/chats/${chat.id}/generations`, 'POST', body, key)).statusCode, 202);
  await until(() => !studio.provider.running.has(chat.id));
  const assistant = studio.store.messages(chat.id).at(-1)!;
  assert.equal(assistant.content, '你好，旅人。');
  assert.equal(assistant.status, 'complete');
  assert.equal((await studio.call(`/chats/${chat.id}/generations`, 'POST', body, key)).statusCode, 200);
  assert.equal(requests, 1);
  assert.equal(studio.store.messages(chat.id).length, 3);
  assert.ok(studio.store.events(0).some(event => event.type === 'message.updated' && (event.payload as Message).status === 'complete'));
});

test('interrupted provider stream keeps the partial reply', async context => {
  const studio = await fixture(context);
  const url = await mockServer(context, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '已经收到的一段文字' } }] })}\n\n`);
    setTimeout(() => response.end(), 1500).unref();
  });
  studio.store.saveSettings({ ...studio.store.settings(), textUrl: `${url}/v1`, textModel: 'test', contextWindow:32768 });
  const chat = (await studio.call('/chats', 'POST', { characterId: studio.store.list<Character>('characters')[0].id })).json<Chat>();
  const generated=await studio.call(`/chats/${chat.id}/generations`, 'POST', { content: '继续', expectedChatRevision: 1 });
  assert.equal(generated.statusCode,202,generated.body);
  await until(() => !!studio.store.messages(chat.id).at(-1)?.content);
  await studio.call(`/chats/${chat.id}/cancel`, 'POST', {});
  await until(() => !studio.provider.running.has(chat.id));
  const message = studio.store.messages(chat.id).at(-1)!;
  assert.equal(message.status, 'interrupted');
  assert.equal(message.content, '已经收到的一段文字');
});

test('image jobs require license confirmation and are idempotent', async context => {
  const studio = await fixture(context);
  assert.equal((await studio.call('/image-jobs', 'POST', { prompt: '一片森林' })).statusCode, 409);
  studio.store.saveSettings({ ...studio.store.settings(), researchUseConfirmed: true });
  const key = crypto.randomUUID();
  const body = { prompt: '一片森林', seed: 42 };
  const first = await studio.call('/image-jobs', 'POST', body, key);
  const second = await studio.call('/image-jobs', 'POST', body, key);
  assert.equal(first.statusCode, 202);
  assert.equal(first.json<ImageJob>().id, second.json<ImageJob>().id);
  assert.equal(studio.store.list('image_jobs').length, 1);
  assert.equal((await studio.call('/image-jobs', 'POST', { prompt: '森林', seed: -1 })).statusCode, 400);
});

test('real HTTP Comfy contract generates, archives and strips private PNG metadata', async context => {
  const studio = await fixture(context);
  const mock = await mockComfy(context);
  studio.store.saveSettings({ ...studio.store.settings(), comfyUrl: mock.url, researchUseConfirmed: true });
  const job = (await studio.call('/image-jobs', 'POST', { prompt: '雨后的森林', seed: 123 })).json<ImageJob>();
  await studio.worker.tick();
  const running = studio.store.get<ImageJob>('image_jobs', job.id)!;
  assert.equal(running.status, 'running');
  assert.equal(mock.state.submissions.length, 1);
  const graph = mock.state.submissions[0].prompt as ReturnType<typeof loadWorkflow>;
  assert.equal(graph['452'].inputs.prompt, job.prompt);
  assert.equal(graph['458'].inputs.seed, 123);
  assert.equal(graph['456'].inputs.batch_size, 1);
  mock.complete(running.promptId!);
  await studio.worker.tick();
  const complete = studio.store.get<ImageJob>('image_jobs', job.id)!;
  assert.equal(complete.status, 'succeeded');
  const saved = await readFile(join(studio.directory, 'media', `${complete.assetId}.png`));
  assert.equal(saved.includes(Buffer.from('private story')), false);
  assert.equal(studio.store.list('assets').length, 1);
  await studio.worker.tick();
  assert.equal(studio.store.list('assets').length, 1);
  assert.equal(mock.state.submissions.length, 1);
});

test('uncertain submission is reconciled instead of blindly resubmitted', async context => {
  const studio = await fixture(context);
  const mock = await mockComfy(context);
  studio.store.saveSettings({ ...studio.store.settings(), comfyUrl: mock.url, researchUseConfirmed: true });
  let attempts = 0;
  studio.comfy.submit = async job => { attempts++; mock.state.pending.push([0, job.promptId]); throw new Error('response lost'); };
  const job = (await studio.call('/image-jobs', 'POST', { prompt: '测试恢复' })).json<ImageJob>();
  await studio.worker.tick();
  assert.equal(studio.store.get<ImageJob>('image_jobs', job.id)!.status, 'reconciling');
  await studio.worker.tick();
  assert.equal(studio.store.get<ImageJob>('image_jobs', job.id)!.status, 'running');
  assert.equal(attempts, 1);
});

test('cancelling never sends an untargeted interrupt or touches an external job', async context => {
  const studio = await fixture(context);
  const mock = await mockComfy(context);
  studio.store.saveSettings({ ...studio.store.settings(), comfyUrl: mock.url, researchUseConfirmed: true });
  const job = (await studio.call('/image-jobs', 'POST', { prompt: '可取消的任务' })).json<ImageJob>();
  await studio.worker.tick();
  const promptId = studio.store.get<ImageJob>('image_jobs', job.id)!.promptId!;
  mock.state.running.push([0, promptId], [1, 'external-prompt']);
  mock.state.pending = [];
  await studio.call(`/image-jobs/${job.id}/cancel`, 'POST', {});
  await studio.worker.tick();
  await studio.worker.tick();
  assert.equal(studio.store.get<ImageJob>('image_jobs', job.id)!.status, 'cancelled');
  assert.deepEqual(mock.state.interrupts, [{ prompt_id: promptId }]);
  assert.deepEqual(mock.state.running, [[1, 'external-prompt']]);
});

test('workflow compilation is a snapshot and leaves its template unchanged', () => {
  const template = loadWorkflow(workflowPath);
  const original = JSON.stringify(template);
  const graph = compileWorkflow(template, { id: crypto.randomUUID(), prompt: '测试', seed: 7 } as ImageJob);
  assert.equal(graph['458'].inputs.seed, 7);
  assert.equal(JSON.stringify(template), original);
});

test('PNG CRC corruption is rejected and metadata is not retained', () => {
  const clean = inspectPng(samplePng());
  assert.equal(clean.width, 1);
  assert.equal(clean.height, 1);
  assert.equal(clean.clean.includes(Buffer.from('prompt')), false);
  const corrupt = samplePng(); corrupt[20] ^= 1;
  assert.throws(() => inspectPng(corrupt), /校验/);
});

test('settings restrict network targets and do not expose API keys', async context => {
  const studio = await fixture(context);
  const settings = studio.store.settings();
  assert.equal((await studio.call('/settings', 'PUT', { ...settings, comfyUrl: 'http://169.254.169.254' })).statusCode, 400);
  assert.equal((await studio.call('/settings', 'PUT', { ...settings, textUrl: 'https://example.com/v1' })).statusCode, 400);
  const saved = await studio.call('/settings', 'PUT', { ...settings, apiKey: 'secret-test-value' });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().hasApiKey, true);
  assert.equal(JSON.stringify(studio.store.settings()).includes('secret-test-value'), false);
  assert.equal(JSON.stringify((await studio.call('/bootstrap')).json()).includes('secret-test-value'), false);
});

test('prompt budgeting preserves the current user message and rejects oversized essentials', async context => {
  const studio = await fixture(context);
  const character = studio.store.list<Character>('characters')[0];
  const messages = Array.from({ length: 40 }, (_, index) => ({ id: String(index), chatId: 'test', role: 'user', content: `历史${'长'.repeat(80)}`, status: 'complete', createdAt: '' } as Message));
  messages.push({ ...messages[0], content: '必须保留的最新问题' });
  const baseSettings={...studio.store.settings(),contextWindow:100000,maxTokens:512};
  const fixedBytes=assemblePrompt(character,[],baseSettings).reduce((n,m)=>n+Buffer.byteLength(m.content,'utf8')+64,0);
  const settings = { ...baseSettings, contextWindow: fixedBytes+2048 }; 
  const result = assemblePrompt(character, messages, settings);
  assert.equal(result.at(-1)!.content, '必须保留的最新问题');
  assert.ok(result.length < messages.length);
  assert.throws(() => assemblePrompt({ ...character, description: '长'.repeat(2000) }, messages, settings), /预算/);
});

test('SSE endpoint sends persisted events and closes cleanly', async context => {
  const studio = await fixture(context);
  studio.store.publish('test.event', 'entity', { persisted: true });
  await studio.app.listen({ host: '127.0.0.1', port: 0 });
  const address = studio.app.server.address();
  if (!address || typeof address === 'string') throw new Error('address');
  const chunk = await new Promise<string>((resolveChunk, reject) => {
    const request = get({ hostname: '127.0.0.1', port: address.port, path: '/api/v1/events?after=0', headers: studio.headers }, response => {
      let content = '';
      response.on('data', data => { content += String(data); if (content.includes('test.event')) { resolveChunk(content); request.destroy(); } });
    });
    request.on('error', reject);
    request.setTimeout(3000, () => { request.destroy(); reject(new Error('SSE timeout')); });
  });
  assert.match(chunk, /persisted/);
});

test('restart resumes an existing image job without a second submission', async context => {
  const studio = await fixture(context);
  const mock = await mockComfy(context);
  studio.store.saveSettings({ ...studio.store.settings(), comfyUrl: mock.url, researchUseConfirmed: true });
  const job = (await studio.call('/image-jobs', 'POST', { prompt: '重启恢复验证' })).json<ImageJob>();
  await studio.worker.tick();
  const clientId = studio.comfy.clientId;
  const promptId = studio.store.get<ImageJob>('image_jobs', job.id)!.promptId!;
  await studio.app.close();
  const resumed = await buildApp({ dataDirectory: studio.directory, workflowPath, startWorker: false });
  try {
    assert.equal(resumed.comfy.clientId, clientId);
    await resumed.worker.tick();
    assert.equal(mock.state.submissions.length, 1);
    mock.complete(promptId);
    await resumed.worker.tick();
    assert.equal(resumed.store.get<ImageJob>('image_jobs', job.id)!.status, 'succeeded');
  } finally { await resumed.app.close(); }
});

test('restart marks unfinished text interrupted and persists a recovery event', async context => {
  const studio = await fixture(context);
  const chat = (await studio.call('/chats', 'POST', { characterId: studio.store.list<Character>('characters')[0].id })).json<Chat>();
  const message: Message = { id: crypto.randomUUID(), chatId: chat.id, role: 'assistant', content: '已持久化的部分文字', status: 'streaming', createdAt: new Date().toISOString() };
  studio.store.saveMessage(message);
  const cursor = studio.store.cursor();
  await studio.app.close();
  const resumed = await buildApp({ dataDirectory: studio.directory, workflowPath, startWorker: false });
  try {
    assert.equal(resumed.store.get<Message>('messages', message.id)!.status, 'interrupted');
    assert.equal(resumed.store.get<Message>('messages', message.id)!.content, message.content);
    assert.ok(resumed.store.events(cursor).some(event => event.entityId === message.id));
  } finally { await resumed.app.close(); }
});

test('archive retry never resubmits a completed inference', async context => {
  const studio = await fixture(context);
  const mock = await mockComfy(context);
  studio.store.saveSettings({ ...studio.store.settings(), comfyUrl: mock.url, researchUseConfirmed: true });
  const job = (await studio.call('/image-jobs', 'POST', { prompt: '归档重试验证' })).json<ImageJob>();
  await studio.worker.tick();
  mock.complete(studio.store.get<ImageJob>('image_jobs', job.id)!.promptId!);
  const originalImage = studio.comfy.image.bind(studio.comfy);
  studio.comfy.image = async () => { throw new Error('temporary read failure'); };
  await studio.worker.tick();
  assert.equal(studio.store.get<ImageJob>('image_jobs', job.id)!.status, 'collecting');
  studio.comfy.image = originalImage;
  await studio.worker.tick();
  assert.equal(studio.store.get<ImageJob>('image_jobs', job.id)!.status, 'succeeded');
  assert.equal(mock.state.submissions.length, 1);
});

test('unacknowledged cancellation needs explicit reconciliation, not a false success', async context => {
  const studio = await fixture(context);
  const mock = await mockComfy(context);
  studio.store.saveSettings({ ...studio.store.settings(), comfyUrl: mock.url, researchUseConfirmed: true });
  studio.comfy.submit = async () => { throw new Error('lost submission'); };
  const job = (await studio.call('/image-jobs', 'POST', { prompt: '取消竞态验证' })).json<ImageJob>();
  await studio.worker.tick();
  await studio.call(`/image-jobs/${job.id}/cancel`, 'POST', {});
  await studio.worker.tick();
  const uncertain = studio.store.get<ImageJob>('image_jobs', job.id)!;
  assert.equal(uncertain.status, 'cancel_requested');
  assert.equal(uncertain.needsAttention, true);
  const resolved = await studio.call(`/image-jobs/${job.id}/resolve`, 'POST', { confirmOutcomeUnknown: true });
  assert.equal(resolved.statusCode, 200);
  assert.equal(resolved.json<ImageJob>().status, 'failed');
  assert.equal(mock.state.submissions.length, 0);
});

test('a second backend cannot acquire the same database', async context => {
  const studio = await fixture(context);
  await assert.rejects(buildApp({ dataDirectory: studio.directory, workflowPath, startWorker: false }), /locked/);
  assert.equal((await studio.call('/bootstrap')).statusCode, 200);
});
