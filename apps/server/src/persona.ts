import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Asset, Chat, FramingMode, UserPersona } from '@tavern/contracts';
import type { Store } from './store.ts';
import { AppError } from './errors.ts';
import { object, text } from './validation.ts';
import { visualInput } from './visual.ts';
import { savePng } from './images.ts';

export function checkPersonaReference(store: Store, personaId: string, assetId?: string): void {
  if (assetId && store.get<Asset>('assets', assetId)?.personaId !== personaId) throw new AppError(400, 'REFERENCE_INVALID', '参考图必须属于这个用户人设');
}

export function defaultParticipants(store: Store): Pick<Chat, 'userPersona' | 'framing'> {
  const row = store.db.prepare('SELECT body FROM settings WHERE key=?').get('storyPreferences') as { body: string } | undefined;
  if (!row) return {};
  const preference = JSON.parse(row.body);
  const userPersona = store.get<UserPersona>('personas', preference.personaId);
  return userPersona ? { userPersona, framing: preference.framing } : {};
}

export function personaRoutes(app: FastifyInstance, store: Store, busy: () => boolean): void {
  function get(id: string): UserPersona {
    const persona = store.get<UserPersona>('personas', id);
    if (!persona) throw new AppError(404, 'NOT_FOUND', '找不到用户人设');
    return persona;
  }
  function input(value: unknown, id: string) {
    const body = object(value);
    const visual = visualInput(body.visual);
    for (const assetId of [visual.faceAssetId, visual.bodyAssetId, visual.outfitAssetId]) checkPersonaReference(store, id, assetId);
    return { name: text(body.name, '人设称呼', 80, true), description: text(body.description, '人设描述', 4000), visual };
  }
  function save(persona: UserPersona) {
    store.db.prepare('INSERT INTO personas(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(persona.id, JSON.stringify(persona));
    return persona;
  }
  app.get('/api/v1/personas', async () => store.list<UserPersona>('personas'));
  app.post('/api/v1/personas', async request => {
    const id = randomUUID(), now = new Date().toISOString();
    return save({ ...input(request.body, id), id, revision: 1, createdAt: now, updatedAt: now });
  });
  app.put<{ Params: { id: string } }>('/api/v1/personas/:id', async request => {
    const persona = get(request.params.id);
    if (object(request.body).expectedRevision !== persona.revision) throw new AppError(409, 'REVISION_CONFLICT', '人设已更新，请重新载入');
    return save({ ...persona, ...input(request.body, persona.id), revision: persona.revision + 1, updatedAt: new Date().toISOString() });
  });
  app.post<{ Params: { id: string } }>('/api/v1/personas/:id/references', async request => {
    const persona = get(request.params.id);
    const data = Buffer.from(text(object(request.body).pngBase64, 'PNG 内容', 11 * 1024 * 1024, true), 'base64');
    if (data.length > 8 * 1024 * 1024) throw new AppError(400, 'INVALID_IMAGE', '参考图最大支持 8MB');
    const id = randomUUID();
    const image = await savePng(store.directory, id, data);
    const asset: Asset = { id, personaId: persona.id, prompt: '', seed: 0, width: image.width, height: image.height, bytes: image.clean.length, createdAt: new Date().toISOString() };
    store.saveAsset(asset);
    return asset;
  });
  app.put<{ Params: { id: string } }>('/api/v1/chats/:id/participants', async request => {
    const chat = store.get<Chat>('chats', request.params.id);
    if (!chat) throw new AppError(404, 'NOT_FOUND', '找不到聊天');
    if (busy()) throw new AppError(409, 'CHAT_BUSY', '请等待聊天或画面读取完成后修改人设与镜头');
    const body = object(request.body);
    if (body.expectedChatRevision !== chat.revision) throw new AppError(409, 'REVISION_CONFLICT', '聊天已更新，请重新载入');
    const personaId = body.personaId ? text(body.personaId, '人设编号', 80, true) : randomUUID();
    if (chat.userPersona && chat.userPersona.id !== personaId && body.switchIdentity !== true) throw new AppError(409, 'PERSONA_BOUND', '这段聊天已绑定身份；更换身份请新建聊天');
    let persona = (chat.userPersona?.id === personaId ? chat.userPersona : undefined) ?? (body.persona ? undefined : get(personaId));
    if (body.persona) {
      const old = store.get<UserPersona>('personas', personaId);
      if (old && body.expectedPersonaRevision !== old.revision) throw new AppError(409, 'REVISION_CONFLICT', '资料已更新，请重新载入后修改');
      const now = new Date().toISOString();
      persona = { ...input(body.persona, personaId), id: personaId, revision: (old?.revision ?? 0) + 1, createdAt: old?.createdAt ?? now, updatedAt: now };
    }
    const framing = body.framing ?? 'auto';
    if (!['auto', 'together', 'pov'].includes(String(framing))) throw new AppError(400, 'INVALID_INPUT', '镜头模式无效');
    const updated: Chat = { ...chat, userPersona: persona, framing: framing as FramingMode, revision: chat.revision + 1, updatedAt: new Date().toISOString() };
    store.transaction(() => {
      if (body.persona) save(persona!);
      store.saveChat(updated);
      store.db.prepare('INSERT INTO settings(key,body) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run('storyPreferences', JSON.stringify({ personaId, framing }));
    });
    store.publish('chat.updated', chat.id, updated);
    return updated;
  });
}
