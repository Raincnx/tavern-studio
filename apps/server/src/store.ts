import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Asset, Bootstrap, Character, Chat, ImageJob, Message, Settings, StudioEvent, TextModelProfile } from '@tavern/contracts';

type Table = 'characters' | 'chats' | 'messages' | 'image_jobs' | 'assets';

export class Store {
  db: DatabaseSync;
  directory: string;
  listeners = new Set<(event: StudioEvent) => void>();

  constructor(directory: string, seed = true) {
    this.directory = directory;
    mkdirSync(join(directory, 'media'), { recursive: true });
    this.db = new DatabaseSync(join(directory, 'app.sqlite'));
    try {
    this.db.exec('PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version > 1) throw new Error('数据库版本较新，请勿使用旧版本启动');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS characters (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, character_id TEXT NOT NULL REFERENCES characters(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id);
      CREATE TABLE IF NOT EXISTS image_jobs (id TEXT PRIMARY KEY, character_id TEXT REFERENCES characters(id), chat_id TEXT REFERENCES chats(id), status TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_status ON image_jobs(status);
      CREATE TABLE IF NOT EXISTS job_workflows (job_id TEXT PRIMARY KEY REFERENCES image_jobs(id), graph TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scene_states (chat_id TEXT NOT NULL REFERENCES chats(id), source_id TEXT NOT NULL, history_hash TEXT NOT NULL, context_key TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(chat_id, source_id));
      CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, job_id TEXT UNIQUE REFERENCES image_jobs(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, hash TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, entity_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      PRAGMA user_version=1;
    `);
    if (!this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get('main')) this.saveSettings({ comfyUrl: 'http://127.0.0.1:8188', textUrl: '', textModel: '', allowCloud: false, temperature: 0.8, maxTokens: 1024, contextWindow: 8192, researchUseConfirmed: false, hasApiKey: false });
    if (!this.settings().activeTextProfileId) {
      this.transaction(() => {
        const settings = this.settings();
        const legacyKey = this.textApiKey() ?? process.env.TAVERN_TEXT_API_KEY ?? '';
        this.saveSettings({ ...settings, activeTextProfileId: 'default', textProfileName: settings.textModel || '默认文本模型' });
        this.saveTextApiKey(legacyKey);
        this.db.prepare('DELETE FROM settings WHERE key = ?').run('textApiKey');
      });
    }
    if (seed && this.list<Character>('characters').length === 0) this.seed();
    for (const message of this.list<Message>('messages').filter(item => item.status === 'streaming')) {
      const recovered: Message = { ...message, status: 'interrupted', error: '服务已重启，已保留生成内容，请重新发送或继续对话。' };
      this.saveMessage(recovered);
      this.publish('message.updated', recovered.id, recovered);
    }
    } catch (error) { this.db.close(); throw error; }
  }

  transaction<Result>(operation: () => Result): Result {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  list<Entity>(table: Table): Entity[] {
    return (this.db.prepare(`SELECT body FROM ${table} ORDER BY rowid`).all() as { body: string }[]).map(row => JSON.parse(row.body) as Entity);
  }

  get<Entity>(table: Table, id: string): Entity | undefined {
    const row = this.db.prepare(`SELECT body FROM ${table} WHERE id = ?`).get(id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) as Entity : undefined;
  }

  saveCharacter(character: Character): void {
    this.db.prepare('INSERT INTO characters(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(character.id, JSON.stringify(character));
  }

  saveChat(chat: Chat): void {
    this.db.prepare('INSERT INTO chats(id,character_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(chat.id, chat.characterId, JSON.stringify(chat));
  }

  saveMessage(message: Message): void {
    this.db.prepare('INSERT INTO messages(id,chat_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(message.id, message.chatId, JSON.stringify(message));
  }

  messages(chatId: string): Message[] {
    return (this.db.prepare('SELECT body FROM messages WHERE chat_id = ? ORDER BY rowid').all(chatId) as { body: string }[]).map(row => JSON.parse(row.body) as Message);
  }

  saveJob(job: ImageJob): void {
    this.db.prepare('INSERT INTO image_jobs(id,character_id,chat_id,status,body) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body').run(job.id, job.characterId ?? null, job.chatId ?? null, job.status, JSON.stringify(job));
  }

  updateJob(id: string, update: Partial<ImageJob>): ImageJob {
    const existing = this.get<ImageJob>('image_jobs', id);
    if (!existing) throw new Error('任务不存在');
    const job = { ...existing, ...update, updatedAt: new Date().toISOString() };
    this.saveJob(job);
    this.publish('job.updated', id, job);
    return job;
  }

  saveAsset(asset: Asset): void {
    this.db.prepare('INSERT INTO assets(id,job_id,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(asset.id, asset.jobId ?? null, JSON.stringify(asset));
  }

  settings(): Settings {
    const row = this.db.prepare('SELECT body FROM settings WHERE key = ?').get('main') as { body: string };
    return { textReasoningEffort: 'default', ...JSON.parse(row.body), hasApiKey: false, textProfiles: this.textProfiles() } as Settings;
  }

  textProfiles(): TextModelProfile[] {
    const rows = this.db.prepare("SELECT body FROM settings WHERE key LIKE 'textProfile:%' ORDER BY rowid").all() as { body: string }[];
    return rows.map(row => { const profile = JSON.parse(row.body) as TextModelProfile; return { ...profile, hasApiKey: !!this.textApiKey(profile.id) }; });
  }

  textApiKey(profileId?: string): string | undefined {
    const main = this.db.prepare('SELECT body FROM settings WHERE key = ?').get('main') as { body: string };
    const id = profileId ?? (JSON.parse(main.body) as Settings).activeTextProfileId;
    const row = this.db.prepare('SELECT body FROM settings WHERE key = ?').get(id ? `textApiKey:${id}` : 'textApiKey') as { body: string } | undefined;
    return row ? JSON.parse(row.body) as string : undefined;
  }

  saveTextApiKey(key: string): void {
    const id = this.settings().activeTextProfileId;
    this.db.prepare('INSERT INTO settings(key,body) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run(id ? `textApiKey:${id}` : 'textApiKey', JSON.stringify(key));
  }

  saveSettings(settings: Settings): void {
    const { textProfiles: _profiles, ...main } = settings;
    this.db.prepare('INSERT INTO settings(key,body) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run('main', JSON.stringify({ ...main, hasApiKey: false }));
    if (settings.activeTextProfileId) {
      const { textUrl, textModel, allowCloud, temperature, maxTokens, contextWindow, textReasoningEffort = 'default' } = settings;
      const profile = { id: settings.activeTextProfileId, name: settings.textProfileName || textModel || '文本模型', textUrl, textModel, allowCloud, temperature, maxTokens, contextWindow, textReasoningEffort };
      this.db.prepare('INSERT INTO settings(key,body) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run(`textProfile:${profile.id}`, JSON.stringify(profile));
    }
  }

  cursor(): number {
    return Number((this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM events').get() as { id: number }).id);
  }

  publish(type: string, entityId: string, payload: unknown): void {
    const createdAt = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO events(type,entity_id,payload,created_at) VALUES(?,?,?,?)').run(type, entityId, JSON.stringify(payload), createdAt);
    const event = { id: Number(result.lastInsertRowid), type, entityId, payload, createdAt };
    if (event.id % 100 === 0) this.db.prepare('DELETE FROM events WHERE id < ?').run(event.id - 2000);
    for (const listener of this.listeners) { try { listener(event); } catch { this.listeners.delete(listener); } }
  }

  events(after: number): StudioEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT 2001').all(after) as { id: number; type: string; entity_id: string; payload: string; created_at: string }[];
    return rows.map(row => ({ id: row.id, type: row.type, entityId: row.entity_id, payload: JSON.parse(row.payload), createdAt: row.created_at }));
  }

  bootstrap(): Bootstrap {
    return { characters: this.list('characters'), chats: this.list<Chat>('chats').reverse(), jobs: this.list<ImageJob>('image_jobs').reverse().slice(0, 100), assets: this.list<Asset>('assets').filter(asset => asset.jobId).reverse().slice(0, 200), settings: this.settings(), eventCursor: this.cursor() };
  }

  seed(): void {
    const examples = [
      { name: '莉娅·林', tagline: '在万物生长的地方，收藏未被讲述的故事。', description: '你是莉娅，一位居住在深林边缘的自然观测者。你沉静而富有好奇心，擅长用细腻的语言描述自然。', personality: '温柔、敏锐，有一点俏皮，对未知抱有耐心。', scenario: '雨后的森林观测站，窗台上摆着植物标本与一本摊开的手绘笔记。', firstMessage: '你来得正好。雨刚停，窗外的蕨叶上还挂着光。\n\n我刚在笔记里留了一页空白——也许，今天的故事该由你开始。', appearance: '成年女性，深棕色短发，灰绿色眼睛，亚麻色外套，随身携带植物手绘笔记，森林自然光。', tags: ['自然', '日常', '慢叙事'], color: 'sage' },
      { name: '沈知微', tagline: '夜深了，书店为你留着最后一盏灯。', description: '你是沈知微，一家旧书店的成年店主。你善于倾听，喜欢从旧书和生活的微小细节开启交谈。', personality: '从容、知性，幽默而不咄咄逼人。', scenario: '城市小巷里的深夜书店，雨水轻敲玻璃，茶刚刚泡好。', firstMessage: '门没有锁，进来坐吧。\n\n这杯茶还热着。你是来找一本书，还是想暂时躲一躲外面的雨？', appearance: '成年女性，黑色长发，细框眼镜，暖棕色针织衫，旧书店与暖色台灯。', tags: ['都市', '书店', '治愈'], color: 'amber' },
      { name: 'NO. 07', tagline: '星图的空白处，总有下一次相遇。', description: '你是代号 NO.07 的成年星际领航员。你以冷静判断和偶尔的黑色幽默与伙伴共同探索未知星域。', personality: '冷静、可靠，面对未知仍保有浪漫。', scenario: '轨道空间站的观景舷窗前，即将启程前往一片尚未命名的星云。', firstMessage: '导航已经就绪，燃料也够。\n\n不过在启航之前，我想问你一个问题：我们是要寻找答案，还是寻找一个值得提问的地方？', appearance: '成年星际领航员，银灰色短发，深蓝色航行服，琥珀色眼睛，空间站舷窗与遥远星云。', tags: ['科幻', '探索', '星际'], color: 'violet' },
    ];
    for (const example of examples) {
      const now = new Date().toISOString();
      this.saveCharacter({ ...example, id: randomUUID(), revision: 1, createdAt: now, updatedAt: now });
    }
  }

  close(): void { this.db.close(); }
}
