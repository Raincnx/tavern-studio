import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Asset, Character, Chat, ImageJob, Message, VisualContext } from '@tavern/contracts';
import { fixture, mockComfy, mockServer, samplePng, workflowPath } from './helpers.ts';
import { buildApp } from '../src/app.ts';
import type { Graph } from '../src/comfy.ts';
import { AppError } from '../src/errors.ts';

async function reference(studio: Awaited<ReturnType<typeof fixture>>, character: Character) {
  const response = await studio.call(`/characters/${character.id}/references`, 'POST', { pngBase64: samplePng().toString('base64') });
  assert.equal(response.statusCode, 200);
  return response.json<Asset>();
}

test('reference editing rejects known source seeds without queuing and preserves unrelated seeds', async t => {
  const studio = await fixture(t);
  studio.store.saveSettings({ ...studio.store.settings(), researchUseConfirmed: true });
  const character = studio.store.list<Character>('characters')[0];
  const imported = await reference(studio, character);
  const generated = await reference(studio, character);
  studio.store.saveAsset({ ...generated, jobId: crypto.randomUUID(), seed: 42 });
  character.visual = { identity: '蓝眼睛', outfit: '白衬衫', faceAssetId: imported.id, bodyAssetId: generated.id };
  studio.store.saveCharacter(character);
  const payload = { characterId: character.id, prompt: '改为蓝色外套' };
  const rejected = await studio.call('/image-jobs', 'POST', { ...payload, seed: 42 });
  assert.equal(rejected.statusCode, 409);
  assert.match(rejected.body, /REFERENCE_SEED_CONFLICT/);
  assert.equal(studio.store.list<ImageJob>('image_jobs').length, 0);
  for (const seed of [0, 43, undefined]) {
    const response = await studio.call('/image-jobs', 'POST', { ...payload, ...(seed === undefined ? {} : { seed }) });
    assert.equal(response.statusCode, 202);
    const job = response.json<ImageJob>();
    assert.notEqual(job.seed, 42);
    if (seed !== undefined) assert.equal(job.seed, seed); // Imported assets' placeholder 0 is not provenance.
    const row = studio.store.db.prepare('SELECT graph FROM job_workflows WHERE job_id=?').get(job.id) as { graph: string };
    assert.equal((JSON.parse(row.graph) as Graph)['458'].inputs.seed, job.seed);
  }
  const plain = await studio.call('/image-jobs', 'POST', { prompt: '蓝色杯子', seed: 42 });
  assert.equal(plain.statusCode, 202);
  assert.equal(plain.json<ImageJob>().seed, 42);
});

test('reference uploads are cleaned, ownership is enforced and cards export portable visual text', async t => {
  const studio = await fixture(t);
  const [character, other] = studio.store.list<Character>('characters');
  const asset = await reference(studio, character);
  const png = await readFile(join(studio.directory, 'media', `${asset.id}.png`));
  assert.equal(png.includes(Buffer.from('private story')), false);
  const visual = { identity: '细长脸，灰绿色眼睛，修长体型', outfit: '棕色针织衫', faceAssetId: asset.id };
  assert.equal((await studio.call(`/characters/${other.id}`, 'PATCH', { ...other, visual })).statusCode, 400);
  const updated = (await studio.call(`/characters/${character.id}`, 'PATCH', { ...character, visual })).json<Character>();
  assert.equal(updated.visual?.faceAssetId, asset.id);
  const exported = (await studio.call(`/characters/${character.id}/export`)).json();
  assert.deepEqual(exported.data.extensions.tavern_studio.visual, { identity: visual.identity, outfit: visual.outfit });
  const imported = (await studio.call('/imports/characters', 'POST', { card: exported })).json<{ character: Character }>().character;
  assert.equal(imported.visual?.identity, visual.identity);
  assert.equal(imported.visual?.faceAssetId, undefined);
  assert.equal((await studio.call(`/characters/${character.id}/references`, 'POST', { pngBase64: Buffer.from('not an image').toString('base64') })).statusCode, 400);
});

test('outfit history survives context truncation and restart, respects message cutoff and chat isolation', async t => {
  const studio = await fixture(t);
  const character = studio.store.list<Character>('characters')[0];
  character.visual = { identity: '同一角色', outfit: '白衬衫' };
  studio.store.saveCharacter(character);
  const chat = (await studio.call('/chats', 'POST', { characterId: character.id })).json<Chat>();
  const opening = studio.store.messages(chat.id)[0];
  const messages = Array.from({ length: 20 }, (_, index): Message => ({ ...opening, id: crypto.randomUUID(), content: `剧情 ${index}` }));
  for (const message of messages) studio.store.saveMessage(message);
  const changed = await studio.call(`/chats/${chat.id}/outfits`, 'POST', { description: '蓝色长裙与白鞋', fromMessageId: messages[2].id, expectedChatRevision: chat.revision });
  assert.equal(changed.statusCode, 200);
  const context = async (sourceMessageId?: string) => (await studio.call(`/visual-context?chatId=${chat.id}${sourceMessageId ? `&sourceMessageId=${sourceMessageId}` : ''}`)).json<VisualContext>();
  assert.equal((await context(opening.id)).snapshot.outfit.description, '白衬衫');
  assert.equal((await context(messages[2].id)).snapshot.outfit.description, '蓝色长裙与白鞋');
  assert.equal((await context()).snapshot.outfit.description, '蓝色长裙与白鞋');
  const other = (await studio.call('/chats', 'POST', { characterId: character.id })).json<Chat>();
  assert.equal((await studio.call(`/chats/${other.id}/outfits`, 'POST', { description: '错误', fromMessageId: messages[2].id, expectedChatRevision: other.revision })).statusCode, 400);
  assert.equal((await studio.call(`/chats/${chat.id}/outfits`, 'POST', { description: '旧版本', expectedChatRevision: chat.revision })).statusCode, 409);
  await studio.app.close();
  const resumed = await buildApp({ dataDirectory: studio.directory, workflowPath, startWorker: false });
  try { assert.equal(resumed.store.get<Chat>('chats', chat.id)?.outfits?.at(-1)?.description, '蓝色长裙与白鞋'); }
  finally { await resumed.app.close(); }
});

test('reference workflow uploads images before submission and freezes identity, outfit and archived provenance', async t => {
  const studio = await fixture(t);
  const mock = await mockComfy(t);
  studio.store.saveSettings({ ...studio.store.settings(), comfyUrl: mock.url, researchUseConfirmed: true });
  const character = studio.store.list<Character>('characters')[0];
  const asset = await reference(studio, character);
  character.visual = { identity: '固定的灰绿色眼睛', outfit: '棕色针织衫', faceAssetId: asset.id, bodyAssetId: asset.id };
  studio.store.saveCharacter(character);
  const context = (await studio.call(`/visual-context?characterId=${character.id}`)).json<VisualContext>();
  const job = (await studio.call('/image-jobs', 'POST', { characterId: character.id, prompt: '坐在窗边读书', visualContextKey: context.key })).json<ImageJob>();
  character.visual.identity = '改变后的身份'; character.revision++;
  studio.store.saveCharacter(character);
  assert.equal((await studio.call('/image-jobs', 'POST', { characterId: character.id, prompt: '旧草稿', visualContextKey: context.key })).statusCode, 409);
  await studio.worker.tick();
  assert.equal(mock.state.uploads.length, 2);
  assert.equal(mock.state.submissions.length, 1);
  const graph = mock.state.submissions[0].prompt as Graph;
  assert.equal(graph['900'].class_type, 'LoadImage');
  assert.equal(graph['900'].inputs.image, `TavernStudio/references/${job.id}/${asset.id}.png`);
  assert.deepEqual(graph['452'].inputs['images.image_1'], ['900', 0]);
  assert.deepEqual(graph['452'].inputs.vae, ['454', 0]);
  assert.match(String(graph['452'].inputs.prompt), /固定的灰绿色眼睛/);
  assert.doesNotMatch(String(graph['452'].inputs.prompt), /改变后的身份/);
  assert.match(String(graph['452'].inputs.prompt), /棕色针织衫/);
  assert.match(String(graph['452'].inputs.prompt), /<image2>/);
  assert.equal((mock.state.uploads[0].data as Buffer).includes(Buffer.from('private story')), false);
  mock.complete(studio.store.get<ImageJob>('image_jobs', job.id)!.promptId!);
  await studio.worker.tick();
  assert.equal(studio.store.get<Asset>('assets', job.id)?.visual?.identity, '固定的灰绿色眼睛');
});

test('failed reference upload stays queued and cancellation prevents any inference submission', async t => {
  const studio = await fixture(t);
  const mock = await mockComfy(t);
  studio.store.saveSettings({ ...studio.store.settings(), comfyUrl: mock.url, researchUseConfirmed: true });
  const character = studio.store.list<Character>('characters')[0];
  const asset = await reference(studio, character);
  character.visual = { identity: '', outfit: '', bodyAssetId: asset.id }; studio.store.saveCharacter(character);
  const job = (await studio.call('/image-jobs', 'POST', { characterId: character.id, prompt: '测试' })).json<ImageJob>();
  mock.state.rejectUpload = true;
  await studio.worker.tick();
  assert.equal(studio.store.get<ImageJob>('image_jobs', job.id)?.status, 'queued');
  assert.equal(studio.store.get<ImageJob>('image_jobs', job.id)?.promptId, undefined);
  assert.equal(mock.state.submissions.length, 0);
  mock.state.rejectUpload = false;
  studio.worker.offlineUntil = 0;
  const upload = studio.comfy.uploadReference.bind(studio.comfy);
  studio.comfy.uploadReference = async (...args) => { await upload(...args); await studio.call(`/image-jobs/${job.id}/cancel`, 'POST', {}); };
  await studio.worker.tick();
  assert.equal(studio.store.get<ImageJob>('image_jobs', job.id)?.status, 'cancelled');
  assert.equal(mock.state.submissions.length, 0);
});

test('scene drafting receives persistent outfit separately and only requests scene changes', async t => {
  const studio = await fixture(t);
  let request: Record<string, unknown> = {};
  const url = await mockServer(t, (_req, response, body) => { request = body; response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: '坐在窗边读书，柔和光线' } }] })); });
  studio.store.saveSettings({ ...studio.store.settings(), textUrl: url, textModel: 'test' });
  const character = studio.store.list<Character>('characters')[0];
  character.visual = { identity: '固定身份', outfit: '白衬衫' }; studio.store.saveCharacter(character);
  const response = await studio.call('/image-prompts', 'POST', { characterId: character.id });
  assert.equal(response.statusCode, 200);
  assert.ok(response.json().visualContextKey);
  const messages = request.messages as { content: string }[];
  assert.equal(JSON.parse(messages[1].content).confirmedOutfit, '白衬衫');
  assert.match(messages[0].content, /不重新设计面部/);
});

test('default outfit retains original full-body reference after character references change', async t => {
  const studio = await fixture(t);
  const character = studio.store.list<Character>('characters')[0];
  const original = await reference(studio, character);
  const replacement = await reference(studio, character);
  character.visual = { identity: '固定身份', outfit: '', bodyAssetId: original.id }; studio.store.saveCharacter(character);
  const chat = (await studio.call('/chats', 'POST', { characterId: character.id })).json<Chat>();
  character.visual.bodyAssetId = replacement.id; character.revision++; studio.store.saveCharacter(character);
  const context = (await studio.call(`/visual-context?chatId=${chat.id}`)).json<VisualContext>();
  assert.equal(context.snapshot.outfit.referenceAssetId, original.id);
  assert.deepEqual(context.snapshot.references, [{ role: 'body', assetId: replacement.id }, { role: 'outfit', assetId: original.id }]);
});

test('reference preparation cannot overwrite a concurrent queued cancellation with failure', async t => {
  const studio = await fixture(t);
  const mock = await mockComfy(t);
  studio.store.saveSettings({ ...studio.store.settings(), comfyUrl: mock.url, researchUseConfirmed: true });
  const job = (await studio.call('/image-jobs', 'POST', { prompt: '取消测试' })).json<ImageJob>();
  studio.comfy.validate = async () => { await studio.call(`/image-jobs/${job.id}/cancel`, 'POST', {}); throw new AppError(422, 'WORKFLOW_INVALID', '缺少节点'); };
  await studio.worker.tick();
  assert.equal(studio.store.get<ImageJob>('image_jobs', job.id)?.status, 'cancelled');
  assert.equal(mock.state.submissions.length, 0);
});

test('queued reference jobs restart with the original workflow and no-reference jobs remain text-to-image', async t => {
  const studio = await fixture(t);
  const mock = await mockComfy(t);
  studio.store.saveSettings({ ...studio.store.settings(), comfyUrl: mock.url, researchUseConfirmed: true });
  const character = studio.store.list<Character>('characters')[0];
  const asset = await reference(studio, character);
  character.visual = { identity: '重启前身份', outfit: '白衬衫', bodyAssetId: asset.id }; studio.store.saveCharacter(character);
  const job = (await studio.call('/image-jobs', 'POST', { characterId: character.id, prompt: '重启后生成' })).json<ImageJob>();
  const plain = (await studio.call('/image-jobs', 'POST', { prompt: '没有角色的森林' })).json<ImageJob>();
  const row = studio.store.db.prepare('SELECT graph FROM job_workflows WHERE job_id=?').get(plain.id) as { graph: string };
  const graph = JSON.parse(row.graph) as Graph;
  assert.equal(graph['452'].inputs['images.image_1'], undefined);
  assert.equal(graph['452'].inputs.vae, undefined);
  character.visual.identity = '重启后身份'; studio.store.saveCharacter(character);
  await studio.app.close();
  const resumed = await buildApp({ dataDirectory: studio.directory, workflowPath, startWorker: false });
  try {
    await resumed.worker.tick();
    assert.equal(mock.state.submissions.length, 1);
    assert.equal(mock.state.uploads.length, 1);
    assert.match(String((mock.state.submissions[0].prompt as Graph)['452'].inputs.prompt), /重启前身份/);
    assert.equal(resumed.store.get<ImageJob>('image_jobs', job.id)?.status, 'running');
  } finally { await resumed.app.close(); }
});
