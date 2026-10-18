import Fastify from 'fastify';
import { randomBytes, randomInt, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.ts';
import { AppError } from './errors.ts';
import { characterInput, integer, object, settingsInput, text } from './validation.ts';
import { inspectPng, savePng } from './images.ts';
import { ComfyAdapter, compileWorkflow } from './comfy.ts';
import { JobWorker, terminal } from './jobs.ts';
import { assemblePrompt, TextService } from './text.ts';
import { checkReference, compileVisualPrompt, defaultOutfit, visualContext, visualInput } from './visual.ts';
import { sceneContext, sceneInput, sceneDescription, sceneVisual, saveScene, inheritScene } from './scene.ts';
import type { Asset, Character, Chat, ImageJob, Message, StudioEvent } from '@tavern/contracts';

interface AppOptions { dataDirectory?: string; workflowPath?: string; startWorker?: boolean; seed?: boolean; development?: boolean; port?: number; logger?: boolean }

export async function buildApp(options: AppOptions = {}) {
  const dataDirectory = options.dataDirectory ?? fileURLToPath(new URL('../data/', import.meta.url));
  const workflowPath = options.workflowPath ?? fileURLToPath(new URL('../../../workflows/qwen-image-2.1-standard-v1.json', import.meta.url));
  const store = new Store(dataDirectory, options.seed ?? true);
  const comfy = new ComfyAdapter(() => store.settings().comfyUrl, workflowPath);
  const clientRow = store.db.prepare('SELECT body FROM settings WHERE key = ?').get('comfyClient') as { body: string } | undefined;
  comfy.clientId = clientRow ? JSON.parse(clientRow.body) as string : randomUUID();
  if (!clientRow) store.db.prepare('INSERT INTO settings(key,body) VALUES(?,?)').run('comfyClient', JSON.stringify(comfy.clientId));
  const worker = new JobWorker(store, comfy);
  const provider = new TextService(store);
  worker.canRun = () => provider.running.size === 0 && provider.draftCount === 0;
  const sessionToken = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(32).toString('hex');
  const allowedPorts = [options.port ?? 3000, ...(options.development ? [5173] : [])];
  const allowedHosts = new Set(allowedPorts.flatMap(port => [`127.0.0.1:${port}`, `localhost:${port}`]));
  const allowedOrigins = new Set([...allowedHosts].map(host => `http://${host}`));
  const equal = (left: string, right: string) => { const leftBytes = Buffer.from(left); const rightBytes = Buffer.from(right); return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes); };
  const streamClosers = new Set<() => void>();
  const app = Fastify({ logger: options.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie'] } : false, bodyLimit: 12 * 1024 * 1024, requestTimeout: 15000, connectionTimeout: 15000 });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer').header('x-frame-options', 'DENY').header('cache-control', 'no-store');
    reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (!allowedHosts.has(request.headers.host ?? '')) throw new AppError(403, 'HOST_FORBIDDEN', '仅接受本机访问');
    const origin = request.headers.origin;
    if ((origin && !allowedOrigins.has(origin)) || request.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, 'ORIGIN_FORBIDDEN', '不允许跨站访问');
    if (!request.url.startsWith('/api/') || request.url.split('?')[0] === '/api/v1/session') return;
    const cookie = (request.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith('tavern_session='))?.slice('tavern_session='.length) ?? '';
    if (!equal(cookie, sessionToken)) throw new AppError(401, 'SESSION_REQUIRED', '本地会话已过期，请刷新页面');
    if (!['GET', 'HEAD'].includes(request.method) && !equal(String(request.headers['x-tavern-csrf'] ?? ''), csrfToken)) throw new AppError(403, 'CSRF_REQUIRED', '安全令牌无效，请刷新页面');
  });

  app.setErrorHandler((error, request, reply) => {
    const known = error instanceof AppError;
    const fastifyError = error as { statusCode?: number; code?: string };
    const status = known ? error.statusCode : fastifyError.statusCode && fastifyError.statusCode < 500 ? fastifyError.statusCode : 500;
    if (status >= 500) request.log.error({ code: known ? error.code : 'INTERNAL_ERROR', requestId: request.id }, '请求失败');
    reply.code(status).send({ code: known ? error.code : status < 500 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR', message: known ? error.message : status < 500 ? '请求格式或大小不符合要求' : '服务处理失败，请查看本地日志', requestId: request.id });
  });

  function required<Entity>(table: 'characters' | 'chats' | 'messages' | 'image_jobs' | 'assets', id: string): Entity {
    const entity = store.get<Entity>(table, id);
    if (!entity) throw new AppError(404, 'NOT_FOUND', '找不到指定记录');
    return entity;
  }

  function deduplicate(route: string, header: unknown, body: unknown): { key: string; hash: string; existing?: unknown } {
    const key = `${route}:${text(header, '幂等键', 120, true)}`;
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const existing = store.db.prepare('SELECT hash,body FROM idempotency WHERE key=?').get(key) as { hash: string; body: string } | undefined;
    if (existing && existing.hash !== hash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '同一操作编号不能用于不同内容');
    return { key, hash, existing: existing ? JSON.parse(existing.body) : undefined };
  }

  function remember(record: { key: string; hash: string }, result: unknown): void {
    store.db.prepare('INSERT INTO idempotency(key,hash,body) VALUES(?,?,?)').run(record.key, record.hash, JSON.stringify(result));
  }

  function characterData(body: unknown, id: string) {
    const input = characterInput(body);
    const visual = object(body).visual;
    if (visual !== undefined) {
      input.visual = visualInput(visual);
      for (const assetId of [input.visual.faceAssetId, input.visual.bodyAssetId, input.visual.outfitAssetId]) checkReference(store, id, assetId);
    }
    return input;
  }

  function contextFor(body: Record<string, unknown>) {
    const source = body.sourceMessageId ? required<Message>('messages', text(body.sourceMessageId, '消息 ID', 80)) : undefined;
    const chat = body.chatId ? required<Chat>('chats', text(body.chatId, '会话 ID', 80)) : source ? required<Chat>('chats', source.chatId) : undefined;
    const characterId = body.characterId ? text(body.characterId, '角色 ID', 80) : chat?.characterId;
    if (source && source.chatId !== chat?.id || chat && characterId !== chat.characterId) throw new AppError(400, 'RELATION_MISMATCH', '角色、会话和来源消息不匹配');
    return characterId ? visualContext(store, required<Character>('characters', characterId), chat, source) : undefined;
  }

  app.get('/api/v1/visual-context', async request => contextFor(object(request.query)) ?? null);

  function sceneFor(body: Record<string, unknown>) {
    const visual = contextFor(body);
    const source = body.sourceMessageId ? required<Message>('messages', String(body.sourceMessageId)) : undefined;
    const chat = body.chatId ? required<Chat>('chats', String(body.chatId)) : source ? required<Chat>('chats', source.chatId) : undefined;
    let history = chat ? store.messages(chat.id) : [];
    if (source) history = history.slice(0, history.findIndex(message => message.id === source.id) + 1);
    return { visual, chat, history, context: sceneContext(store, chat?.id, history, visual?.key ?? '', chat ? message => visualContext(store, required<Character>('characters', chat.characterId), chat, message).key : undefined) };
  }

  app.get('/api/v1/scene-state', async request => sceneFor(object(request.query)).context);
  app.put('/api/v1/scene-state', async request => {
    const body = object(request.body);
    const current = sceneFor(body);
    if (body.sceneContextKey !== current.context.key) throw new AppError(409, 'SCENE_CHANGED', '剧情或角色已变化，请重新读取画面状态');
    const state = sceneInput(body.scene, current.history, true);
    if (current.chat) saveScene(store, current.chat.id, current.history, current.visual?.key ?? '', state);
    return { ...sceneFor(body).context, state, pendingMessages: 0, prompt: sceneDescription(state) };
  });
  app.post('/api/v1/image-prompts/preview', async request => {
    const body = object(request.body);
    const current = sceneFor(body);
    if (body.scene && body.sceneContextKey !== current.context.key) throw new AppError(409, 'SCENE_CHANGED', '剧情或角色已变化，请重新读取画面状态');
    const scene = body.scene ? sceneInput(body.scene, current.history, true) : undefined;
    const prompt = text(body.prompt, '画面描述', 4000, true);
    return { compiledPrompt: compileVisualPrompt(prompt, sceneVisual(current.visual?.snapshot, scene)) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/characters/:id/references', async request => {
    const character = required<Character>('characters', request.params.id);
    const body = object(request.body);
    const data = Buffer.from(text(body.pngBase64, 'PNG 内容', 11 * 1024 * 1024, true), 'base64');
    if (data.length > 8 * 1024 * 1024) throw new AppError(400, 'INVALID_IMAGE', '参考图最大支持 8MB');
    const id = randomUUID();
    const image = await savePng(store.directory, id, data);
    const asset: Asset = { id, characterId: character.id, prompt: '', seed: 0, width: image.width, height: image.height, bytes: image.clean.length, createdAt: new Date().toISOString() };
    store.saveAsset(asset);
    return asset;
  });

  app.post<{ Params: { id: string } }>('/api/v1/chats/:id/outfits', async request => {
    const chat = required<Chat>('chats', request.params.id);
    const body = object(request.body);
    if (body.expectedChatRevision !== chat.revision) throw new AppError(409, 'REVISION_CONFLICT', '会话已更新，请刷新后重试');
    const character = required<Character>('characters', chat.characterId);
    const history = store.messages(chat.id);
    const fromMessageId = body.fromMessageId ? text(body.fromMessageId, '起始消息', 80) : history.at(-1)?.id;
    if (fromMessageId && !history.some(message => message.id === fromMessageId)) throw new AppError(400, 'RELATION_MISMATCH', '起始消息不属于当前会话');
    const referenceAssetId = body.referenceAssetId ? text(body.referenceAssetId, '服装参考图', 80) : undefined;
    checkReference(store, character.id, referenceAssetId);
    const outfit = { id: randomUUID(), description: text(body.description, '当前服装', 2000, true), referenceAssetId, fromMessageId, createdAt: new Date().toISOString() };
    const updated = { ...chat, outfits: [...(chat.outfits ?? [defaultOutfit(character)]), outfit], revision: chat.revision + 1, updatedAt: new Date().toISOString() };
    store.saveChat(updated);
    store.publish('chat.updated', chat.id, updated);
    return updated;
  });

  app.get('/health', async () => ({ status: 'ok', application: 'tavern-studio', version: '0.1.0' }));
  app.get('/api/v1/session', async (_request, reply) => {
    reply.header('set-cookie', `tavern_session=${sessionToken}; Path=/; HttpOnly; SameSite=Strict`);
    return { csrfToken };
  });
  app.get('/api/v1/bootstrap', async () => { const bootstrap = store.bootstrap(); bootstrap.settings.hasApiKey = !!provider.apiKey; return bootstrap; });
  app.get('/api/v1/system/status', async () => ({ comfy: { online: await comfy.health(), message: 'ComfyUI · 本机图像推理' }, text: { configured: !!store.settings().textUrl && !!store.settings().textModel, model: store.settings().textModel }, version: '0.1.0' }));

  app.post('/api/v1/characters', async request => {
    const id = randomUUID();
    const input = characterData(request.body, id);
    const now = new Date().toISOString();
    const character: Character = { ...input, id, revision: 1, createdAt: now, updatedAt: now };
    store.saveCharacter(character);
    store.publish('character.updated', character.id, character);
    return character;
  });

  app.patch<{ Params: { id: string } }>('/api/v1/characters/:id', async request => {
    const current = required<Character>('characters', request.params.id);
    const body = object(request.body);
    if (body.revision !== current.revision) throw new AppError(409, 'REVISION_CONFLICT', '角色已被修改，请刷新后重试');
    const character = { ...current, ...characterData(body, current.id), revision: current.revision + 1, updatedAt: new Date().toISOString() };
    store.saveCharacter(character);
    store.publish('character.updated', character.id, character);
    return character;
  });

  app.get<{ Params: { id: string } }>('/api/v1/characters/:id/export', async (request, reply) => {
    const character = required<Character>('characters', request.params.id);
    const original = character.rawCard ?? {};
    const originalData = original.data && typeof original.data === 'object' ? original.data : {};
    reply.header('content-disposition', 'attachment; filename="character.json"');
    return { ...original, spec: 'chara_card_v2', spec_version: '2.0', data: { ...originalData, name: character.name, description: character.description, personality: character.personality, scenario: character.scenario, first_mes: character.firstMessage, tags: character.tags, extensions: { ...object((originalData as Record<string, unknown>).extensions ?? {}), tavern_studio: { appearance: character.appearance, tagline: character.tagline, color: character.color, visual: character.visual ? { identity: character.visual.identity, outfit: character.visual.outfit } : undefined } } } };
  });

  app.post('/api/v1/imports/characters', async request => {
    const body = object(request.body);
    let card = body.card;
    let image: Buffer | undefined;
    if (body.pngBase64 !== undefined) {
      image = Buffer.from(text(body.pngBase64, 'PNG 内容', 11 * 1024 * 1024, true), 'base64');
      card = inspectPng(image).card;
    }
    const original = object(card);
    if (original.spec && original.spec !== 'chara_card_v2') throw new AppError(422, 'CARD_VERSION_UNSUPPORTED', '首版支持 V2 与基础 JSON 卡片，其他版本暂不导入');
    const data = object(original.data ?? original);
    const extensions = data.extensions && typeof data.extensions === 'object' ? data.extensions as Record<string, unknown> : {};
    const studio = extensions.tavern_studio && typeof extensions.tavern_studio === 'object' ? extensions.tavern_studio as Record<string, unknown> : {};
    const input = characterInput({ name: data.name, description: data.description ?? '', personality: data.personality ?? '', scenario: data.scenario ?? '', firstMessage: data.first_mes ?? '', tags: data.tags ?? [], appearance: studio.appearance ?? '', tagline: studio.tagline ?? '从角色卡导入的故事伙伴', color: studio.color ?? 'sage' });
    if (studio.visual) { const importedVisual = visualInput(studio.visual); input.visual = { identity: importedVisual.identity, outfit: importedVisual.outfit }; }
    const now = new Date().toISOString();
    const character: Character = { ...input, id: randomUUID(), rawCard: original, revision: 1, createdAt: now, updatedAt: now };
    if (image) {
      const avatarId = randomUUID();
      const cleaned = await savePng(store.directory, avatarId, image);
      const avatar: Asset = { id: avatarId, characterId: character.id, prompt: '', seed: 0, width: cleaned.width, height: cleaned.height, bytes: cleaned.clean.length, createdAt: now };
      store.saveAsset(avatar);
      character.avatarId = avatarId;
    }
    store.saveCharacter(character);
    store.publish('character.updated', character.id, character);
    return { character, warnings: ['原始字段已保留。高级宏、示例对话、世界书、脚本和扩展行为尚未执行。'] };
  });

  app.post('/api/v1/chats', async request => {
    const body = object(request.body);
    const operation = deduplicate('chats', request.headers['idempotency-key'], body);
    if (operation.existing) return operation.existing;
    const character = required<Character>('characters', text(body.characterId, '角色 ID', 80, true));
    const now = new Date().toISOString();
    const chat: Chat = { id: randomUUID(), characterId: character.id, title: `${character.name}的故事`, revision: 1, outfits: [defaultOutfit(character)], createdAt: now, updatedAt: now };
    store.transaction(() => {
      store.saveChat(chat);
      if (character.firstMessage) store.saveMessage({ id: randomUUID(), chatId: chat.id, role: 'assistant', content: character.firstMessage.replaceAll('{{char}}', character.name).replaceAll('{{user}}', '旅人'), status: 'complete', createdAt: now });
      remember(operation, chat);
    });
    store.publish('chat.updated', chat.id, chat);
    return chat;
  });

  app.get<{ Params: { id: string } }>('/api/v1/chats/:id/messages', async request => { required<Chat>('chats', request.params.id); return store.messages(request.params.id).slice(-500); });

  app.post<{ Params: { id: string } }>('/api/v1/chats/:id/generations', async (request, reply) => {
    const body = object(request.body);
    const operation = deduplicate(`generate:${request.params.id}`, request.headers['idempotency-key'], body);
    if (operation.existing) return operation.existing;
    const chat = required<Chat>('chats', request.params.id);
    if (provider.running.has(chat.id)) throw new AppError(409, 'CHAT_BUSY', '这个会话正在生成，请等待或先停止');
    if (provider.draftCount) throw new AppError(409, 'LOCAL_RESOURCE_BUSY', '请等待画面描述生成结束后再发送消息');
    if (body.expectedChatRevision !== chat.revision) throw new AppError(409, 'REVISION_CONFLICT', '会话已更新，请刷新后重试');
    const character = required<Character>('characters', chat.characterId);
    const settings = provider.configured();
    if (store.list<ImageJob>('image_jobs').some(job => !terminal.has(job.status) && job.status !== 'queued') && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(settings.textUrl).hostname)) throw new AppError(409, 'LOCAL_RESOURCE_BUSY', '本地生图执行期间暂停本地文本请求，以避免显存争用');
    const now = new Date().toISOString();
    const user: Message = { id: randomUUID(), chatId: chat.id, role: 'user', content: text(body.content, '消息', 12000, true), status: 'complete', createdAt: now };
    const history = [...store.messages(chat.id), user];
    assemblePrompt(character, history, settings);
    const assistant: Message = { id: randomUUID(), chatId: chat.id, role: 'assistant', content: '', status: 'streaming', createdAt: now };
    const updated = { ...chat, revision: chat.revision + 1, updatedAt: now };
    const result = { chat: updated, user, assistant };
    store.transaction(() => { store.saveChat(updated); store.saveMessage(user); store.saveMessage(assistant); remember(operation, result); });
    store.publish('chat.updated', chat.id, updated);
    store.publish('message.updated', user.id, user);
    store.publish('message.updated', assistant.id, assistant);
    provider.start(chat.id, assistant.id, character, history);
    reply.code(202);
    return result;
  });

  app.post<{ Params: { id: string } }>('/api/v1/chats/:id/cancel', async request => { required<Chat>('chats', request.params.id); provider.cancel(request.params.id); return { accepted: true }; });

  app.post('/api/v1/image-prompts', async (request, reply) => {
    if (provider.draftCount || provider.running.size) throw new AppError(409, 'CHAT_BUSY', '正在生成文本或推断画面，请等待完成或取消后再试');
    request.raw.socket.setTimeout?.(135000);
    const body = object(request.body);
    const character = body.characterId ? required<Character>('characters', text(body.characterId, '角色 ID', 80)) : undefined;
    const message = body.sourceMessageId ? required<Message>('messages', text(body.sourceMessageId, '消息 ID', 80)) : undefined;
    const chat = body.chatId ? required<Chat>('chats', text(body.chatId, '对话 ID', 80)) : message ? required<Chat>('chats', message.chatId) : undefined;
    if (message && chat && message.chatId !== chat.id) throw new AppError(400, 'RELATION_MISMATCH', '来源消息不属于当前对话');
    if (character && chat && chat.characterId !== character.id) throw new AppError(400, 'RELATION_MISMATCH', '对话不属于此角色');
    if (chat && provider.running.has(chat.id)) throw new AppError(409, 'CHAT_BUSY', '请等待当前回复完成后推断画面');
    let history = chat ? store.messages(chat.id) : [];
    if (message) history = history.slice(0, history.findIndex(item => item.id === message.id) + 1);
    if (message && character && required<Chat>('chats', message.chatId).characterId !== character.id) throw new AppError(400, 'RELATION_MISMATCH', '消息不属于此角色');
    if (store.list<ImageJob>('image_jobs').some(job => !terminal.has(job.status) && job.status !== 'queued')) throw new AppError(409, 'LOCAL_RESOURCE_BUSY', '请等待当前生图完成后生成画面描述');
    const context = contextFor(body);
    const controller = new AbortController();
    const disconnected = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', disconnected);
    try {
      if (body.structured === true) {
        const current = sceneFor(body);
        const previous = current.context;
        const offset = previous.sourceMessageId ? history.findIndex(message => message.id === previous.sourceMessageId) + 1 : 0;
        const remaining = history.slice(offset).filter(message => message.status === 'complete');
        if (previous.state && !remaining.length) return { ...previous, scene: previous.state, sceneContextKey: previous.key, visualContextKey: context?.key, prompt: sceneDescription(previous.state) };
        const batch = remaining.slice(0, 4);
        const activeCharacter = character ?? (chat ? required<Character>('characters', chat.characterId) : undefined);
        let raw = '';
        for (;;) {
          const visual = current.chat && batch.length ? visualContext(store, activeCharacter!, current.chat, batch.at(-1)) : context;
          try { raw = await provider.imagePrompt(activeCharacter, batch, '提取到本批最后一条消息的画面状态', visual?.snapshot, controller.signal, { previousState: previous.state }); break; }
          catch (error) { if (error instanceof AppError && error.code === 'CONTEXT_TOO_SMALL' && batch.length > 1) batch.pop(); else throw error; }
        }
        const end = batch.at(-1);
        const prefix = end ? history.slice(0, history.findIndex(message => message.id === end.id) + 1) : history;
        const batchVisual = current.chat && end ? visualContext(store, activeCharacter!, current.chat, end) : context;
        let parsed: unknown;
        try { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
        catch { throw new AppError(502, 'SCENE_INVALID', '模型返回的画面状态不是有效 JSON，未保存本次结果，请重试'); }
        const state = inheritScene(sceneInput(parsed, prefix), previous.state, prefix);
        const confirmed = batchVisual?.snapshot.outfit;
        if (confirmed?.fromMessageId && batch.some(message => message.id === confirmed.fromMessageId)) {
          const main = state.people.find(person => person.id === 'main')!;
          if (prefix.findIndex(message => message.id === main.outfit.sourceMessageId) <= prefix.findIndex(message => message.id === confirmed.fromMessageId)) main.outfit = { value: confirmed.description, basis: 'manual', sourceMessageId: confirmed.fromMessageId };
        }
        if (sceneFor(body).context.key !== previous.key) throw new AppError(409, 'SCENE_CHANGED', '推断期间剧情或角色已变化，请重新推断');
        if (current.chat) saveScene(store, current.chat.id, prefix, batchVisual?.key ?? '', state);
        return { scene: state, sceneContextKey: sceneFor(body).context.key, visualContextKey: context?.key, prompt: sceneDescription(state), pendingMessages: remaining.length - batch.length, sourceMessageId: end?.id };
      }
      return { prompt: await provider.imagePrompt(character ?? (chat ? required<Character>('characters', chat.characterId) : undefined), history, text(body.intent ?? '根据最近对话推断当前时刻的画面', '绘图意图', 2000, true), context?.snapshot, controller.signal), visualContextKey: context?.key };
    } finally { reply.raw.off('close', disconnected); }
  });

  app.post('/api/v1/image-jobs', async (request, reply) => {
    const body = object(request.body);
    const operation = deduplicate('image-jobs', request.headers['idempotency-key'], body);
    if (operation.existing) { reply.code(202); return operation.existing; }
    if (!store.settings().researchUseConfirmed) throw new AppError(409, 'RESEARCH_USE_REQUIRED', '请先在设置中确认模型许可和研究/评估用途');
    if (provider.running.size || provider.draftCount) throw new AppError(409, 'LOCAL_RESOURCE_BUSY', '请等待文本生成结束后提交生图');
    if (store.list<ImageJob>('image_jobs').filter(job => !terminal.has(job.status)).length >= 8) throw new AppError(429, 'QUEUE_FULL', '最多允许 8 个未完成任务');
    const characterId = body.characterId ? required<Character>('characters', text(body.characterId, '角色 ID', 80)).id : undefined;
    const chat = body.chatId ? required<Chat>('chats', text(body.chatId, '会话 ID', 80)) : undefined;
    const source = body.sourceMessageId ? required<Message>('messages', text(body.sourceMessageId, '消息 ID', 80)) : undefined;
    if ((chat && chat.characterId !== characterId) || (source && source.chatId !== chat?.id)) throw new AppError(400, 'RELATION_MISMATCH', '角色、会话和来源消息不匹配');
    const now = new Date().toISOString();
    const job: ImageJob = { id: randomUUID(), characterId, chatId: chat?.id, sourceMessageId: source?.id, prompt: text(body.prompt, '画面描述', 4000, true), seed: body.seed === undefined ? randomInt(0, 2 ** 32) : integer(body.seed, 'seed', 0, 2 ** 32 - 1), workflowId: 'qwen-image-2.1-standard-v1', status: 'queued', phase: '等待调度', progress: null, createdAt: now, updatedAt: now };
    const context = contextFor(body);
    if (body.visualContextKey !== undefined && body.visualContextKey !== context?.key) throw new AppError(409, 'VISUAL_CHANGED', '角色或服装已更新，请重新确认画面与参考图');
    const sceneCurrent = sceneFor(body);
    if (body.scene && body.sceneContextKey !== sceneCurrent.context.key) throw new AppError(409, 'SCENE_CHANGED', '剧情或角色已变化，请重新确认画面');
    const scene = body.scene ? sceneInput(body.scene, sceneCurrent.history, true) : undefined;
    if (scene && !job.sourceMessageId) job.sourceMessageId = sceneCurrent.history.at(-1)?.id;
    job.visual = sceneVisual(context?.snapshot, scene);
    job.compiledPrompt = compileVisualPrompt(job.prompt, job.visual);
    if (job.visual?.references.length) job.workflowId = 'qwen-image-2.1-reference-v1';
    store.transaction(() => { store.saveJob(job); store.db.prepare('INSERT INTO job_workflows(job_id,graph) VALUES(?,?)').run(job.id, JSON.stringify(compileWorkflow(comfy.template, job))); remember(operation, job); });
    store.publish('job.updated', job.id, job);
    reply.code(202);
    return job;
  });

  app.post<{ Params: { id: string } }>('/api/v1/image-jobs/:id/cancel', async request => {
    const job = required<ImageJob>('image_jobs', request.params.id);
    if (terminal.has(job.status)) return job;
    if (job.status === 'queued') return store.updateJob(job.id, { status: 'cancelled', phase: '已取消' });
    return store.updateJob(job.id, { status: 'cancel_requested', phase: '正在确认取消' });
  });

  app.post<{ Params: { id: string } }>('/api/v1/image-jobs/:id/retry', async (request, reply) => {
    const old = required<ImageJob>('image_jobs', request.params.id);
    const operation = deduplicate('retry-image-job', request.headers['idempotency-key'], { id: old.id });
    if (operation.existing) { reply.code(202); return operation.existing; }
    if (!['failed', 'cancelled'].includes(old.status)) throw new AppError(409, 'JOB_ACTIVE', '请先停止追踪旧任务，再重新生成');
    if (!store.settings().researchUseConfirmed) throw new AppError(409, 'RESEARCH_USE_REQUIRED', '请先确认模型许可');
    if (provider.running.size || provider.draftCount) throw new AppError(409, 'LOCAL_RESOURCE_BUSY', '请等待文本生成结束');
    if (store.list<ImageJob>('image_jobs').filter(job => !terminal.has(job.status)).length >= 8) throw new AppError(429, 'QUEUE_FULL', '最多允许 8 个未完成任务');
    if (!(await comfy.health())) throw new AppError(503, 'COMFY_OFFLINE', '生图服务未连接，请先启动 ComfyUI，再点击重试');
    const frozen = store.db.prepare('SELECT graph FROM job_workflows WHERE job_id=?').get(old.id) as { graph: string } | undefined;
    if (!frozen) throw new AppError(409, 'WORKFLOW_MISSING', '原工作流不可用，请回到工作台生成');
    const now = new Date().toISOString();
    const job: ImageJob = { id: randomUUID(), characterId: old.characterId, chatId: old.chatId, sourceMessageId: old.sourceMessageId, prompt: old.prompt, compiledPrompt: old.compiledPrompt, visual: old.visual, seed: old.seed, workflowId: old.workflowId, status: 'queued', phase: '等待调度', progress: null, createdAt: now, updatedAt: now };
    const graph = JSON.parse(frozen.graph);
    graph['461'].inputs.filename_prefix = `TavernStudio/${job.id}/image`;
    for (const node of Object.values(graph) as { class_type: string; inputs: { image?: string } }[]) {
      if (node.class_type === 'LoadImage' && node.inputs.image) node.inputs.image = node.inputs.image.replace(old.id, job.id);
    }
    // Check idempotency again after the asynchronous health probe.
    const repeated = deduplicate('retry-image-job', request.headers['idempotency-key'], { id: old.id });
    if (repeated.existing) { reply.code(202); return repeated.existing; }
    store.transaction(() => { store.saveJob(job); store.db.prepare('INSERT INTO job_workflows(job_id,graph) VALUES(?,?)').run(job.id, JSON.stringify(graph)); remember(operation, job); });
    store.publish('job.updated', job.id, job);
    reply.code(202);
    return job;
  });

  app.post<{ Params: { id: string } }>('/api/v1/image-jobs/:id/resolve', async request => {
    const job = required<ImageJob>('image_jobs', request.params.id);
    if (object(request.body).confirmOutcomeUnknown !== true || !(job.needsAttention || ['reconciling', 'cancel_requested'].includes(job.status)) || terminal.has(job.status) || !job.promptId) throw new AppError(400, 'CONFIRMATION_REQUIRED', '只可手动释放结果不明的任务');
    try {
      const history = await comfy.history(job.promptId);
      const queue = await comfy.queue();
      if (history || [...queue.queue_pending, ...queue.queue_running].some(item => item[1] === job.promptId)) throw new AppError(409, 'JOB_FOUND', '服务中已找到原任务，请等待自动恢复');
    } catch (error) {
      if (error instanceof AppError && error.code === 'JOB_FOUND') throw error;
      if (object(request.body).allowOffline !== true) throw new AppError(503, 'COMFY_OFFLINE', '服务未连接，需明确确认离线停止追踪');
    }
    if (terminal.has(required<ImageJob>('image_jobs', job.id).status)) return required<ImageJob>('image_jobs', job.id);
    return store.updateJob(job.id, { status: 'failed', phase: '已确认释放，结果不明', needsAttention: false, error: 'JOB_OUTCOME_UNKNOWN：用户已确认停止追踪；重新生成将创建新任务。' });
  });

  app.get<{ Params: { id: string } }>('/api/v1/media/:id', async (request, reply) => {
    const asset = required<Asset>('assets', request.params.id);
    reply.type('image/png');
    return reply.send(await readFile(join(store.directory, 'media', `${asset.id}.png`)));
  });

  app.put('/api/v1/settings', async request => {
    const body = object(request.body);
    const previous = store.settings();
    if (body.activeTextProfileId !== undefined && body.activeTextProfileId !== previous.activeTextProfileId) throw new AppError(409, 'MODEL_CHANGED', '当前模型已切换，请刷新设置后再保存。');
    const settings = settingsInput(body, previous);
    settings.textProfileName = text(body.textProfileName ?? previous.textProfileName, '配置名称', 80, true);
    const nextApiKey = body.apiKey ? text(body.apiKey, 'API Key', 1000) : undefined;
    if (provider.running.size || provider.draftCount) throw new AppError(409, 'CHAT_BUSY', '请等待文本生成或画面推断结束后更改连接');
    if (provider.apiKey && previous.textUrl && settings.textUrl && new URL(previous.textUrl).origin !== new URL(settings.textUrl).origin && nextApiKey === undefined && body.clearApiKey !== true) throw new AppError(400, 'KEY_REQUIRED_FOR_NEW_HOST', '切换服务地址时请重新填写对应密钥，或先清除旧密钥。也可新增独立模型配置。');
    if (settings.comfyUrl !== store.settings().comfyUrl && store.list<ImageJob>('image_jobs').some(job => !terminal.has(job.status))) throw new AppError(409, 'JOBS_ACTIVE', '请先处理未完成的图片任务，再修改 ComfyUI 地址');
    const key = nextApiKey ?? (body.clearApiKey === true ? '' : provider.apiKey);
    store.transaction(() => { store.saveSettings(settings); store.saveTextApiKey(key); });
    provider.apiKey = key;
    const result = { ...store.settings(), hasApiKey: !!provider.apiKey };
    store.publish('settings.updated', 'main', result);
    return result;
  });
  app.post('/api/v1/text-models', async request => {
    if (provider.running.size || provider.draftCount) throw new AppError(409, 'CHAT_BUSY', '请等待文本生成或画面推断结束后切换模型');
    if (store.textProfiles().length >= 30) throw new AppError(400, 'MODEL_LIMIT', '最多保存 30 套模型配置');
    const body = object(request.body);
    const previous = store.settings();
    const settings = settingsInput({ ...body, comfyUrl: previous.comfyUrl, researchUseConfirmed: previous.researchUseConfirmed }, previous);
    settings.activeTextProfileId = randomUUID();
    settings.textProfileName = text(body.textProfileName, '配置名称', 80, true);
    if (!settings.textUrl || !settings.textModel) throw new AppError(400, 'TEXT_NOT_CONFIGURED', '请填写服务地址和模型名称');
    const key = text(body.apiKey, 'API Key', 1000);
    store.transaction(() => { store.saveSettings(settings); store.saveTextApiKey(key); });
    provider.apiKey = key;
    const result = { ...store.settings(), hasApiKey: !!key };
    store.publish('settings.updated', 'main', result);
    return result;
  });
  app.post<{ Params: { id: string } }>('/api/v1/text-models/:id/activate', async request => {
    if (provider.running.size || provider.draftCount) throw new AppError(409, 'CHAT_BUSY', '请等待文本生成或画面推断结束后切换模型');
    const profile = store.textProfiles().find(item => item.id === request.params.id);
    if (!profile) throw new AppError(404, 'MODEL_NOT_FOUND', '模型配置不存在');
    const { id, name, hasApiKey: _hasKey, ...connection } = profile;
    store.saveSettings({ ...store.settings(), ...connection, textReasoningEffort: connection.textReasoningEffort ?? 'default', activeTextProfileId: id, textProfileName: name });
    provider.apiKey = store.textApiKey(id) ?? '';
    const result = { ...store.settings(), hasApiKey: !!provider.apiKey };
    store.publish('settings.updated', 'main', result);
    return result;
  });
  app.post('/api/v1/connections/text/test', async () => ({ models: await provider.test() }));
  app.post('/api/v1/connections/comfy/test', async () => { if (!(await comfy.health())) throw new AppError(503, 'COMFY_UNAVAILABLE', 'ComfyUI 未连接，请先运行已有的 Start-QwenImage.cmd'); await comfy.validate(); return { connected: true }; });

  app.get('/api/v1/events', async (request, reply) => {
    request.raw.socket.setTimeout?.(0);
    if (store.listeners.size >= 8) throw new AppError(429, 'CONNECTION_LIMIT', '事件连接过多，请关闭其他标签页');
    const query = request.query as { after?: string };
    const after = Number(request.headers['last-event-id'] ?? query.after ?? store.cursor());
    if (!Number.isSafeInteger(after) || after < 0) throw new AppError(400, 'INVALID_CURSOR', '事件游标不合法');
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' });
    reply.raw.write(': connected\n\n');
    const send = (event: StudioEvent) => {
      if (reply.raw.destroyed) return;
      if (reply.raw.writableLength > 512 * 1024) { reply.raw.destroy(); return; }
      reply.raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const missed = store.events(after);
    if (after > store.cursor() || (missed[0] && missed[0].id > after + 1)) send({ id: store.cursor(), type: 'snapshot.required', entityId: '', payload: null, createdAt: new Date().toISOString() });
    else for (const event of missed) send(event);
    store.listeners.add(send);
    const timer = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n'); }, 15000);
    const dispose = () => { close(); reply.raw.end(); };
    const close = () => { clearInterval(timer); store.listeners.delete(send); streamClosers.delete(dispose); };
    streamClosers.add(dispose);
    reply.raw.on('close', close);
  });

  app.addHook('preClose', async () => { for (const close of streamClosers) close(); });

  const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  if (existsSync(join(webRoot, 'index.html'))) {
    const files = new Map<string, string>();
    const collect = (directory: string, prefix: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const key = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) collect(join(directory, entry.name), key);
        else if (entry.isFile()) files.set(key, join(directory, entry.name));
      }
    };
    collect(webRoot, '');
    const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
    app.get('/*', async (request, reply) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname.startsWith('/api/')) return reply.code(404).send({ code: 'NOT_FOUND', message: '接口不存在' });
      const file = files.get(pathname) ?? (!extname(pathname) ? files.get('/index.html') : undefined);
      if (!file) return reply.code(404).send({ code: 'NOT_FOUND', message: '文件不存在' });
      return reply.type(mime[extname(file)] ?? 'application/octet-stream').send(await readFile(file));
    });
  }
  app.addHook('onClose', async () => { await worker.stop(); await provider.close(); store.close(); });
  if (options.startWorker !== false) app.addHook('onReady', async () => worker.start());
  return { app, store, worker, comfy, provider };
}
