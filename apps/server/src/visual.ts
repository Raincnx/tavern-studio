import { createHash } from 'node:crypto';
import type { Asset, Character, Chat, Message, OutfitState, VisualContext, VisualProfile, VisualSnapshot } from '@tavern/contracts';
import { AppError } from './errors.ts';
import { object, text } from './validation.ts';
import type { Store } from './store.ts';

export function visualInput(value: unknown): VisualProfile {
  const body = object(value);
  const result: VisualProfile = { identity: text(body.identity, '固定身份', 2000), outfit: text(body.outfit, '默认服装', 2000) };
  for (const key of ['faceAssetId', 'bodyAssetId', 'outfitAssetId'] as const) {
    if (body[key]) result[key] = text(body[key], '参考图 ID', 80, true);
  }
  return result;
}

export function checkReference(store: Store, characterId: string, assetId?: string): void {
  if (!assetId) return;
  const asset = store.get<Asset>('assets', assetId);
  if (!asset || asset.characterId !== characterId) throw new AppError(400, 'REFERENCE_INVALID', '参考图必须属于当前角色');
}

export function defaultOutfit(character: Character): OutfitState {
  return { id: `character:${character.id}:${character.revision}`, description: character.visual?.outfit ?? '', referenceAssetId: character.visual?.outfitAssetId ?? character.visual?.bodyAssetId, createdAt: character.updatedAt };
}

export function visualContext(store: Store, character: Character, chat?: Chat, source?: Message): VisualContext {
  const history = chat ? store.messages(chat.id) : [];
  const cutoff = source ? history.findIndex(item => item.id === source.id) : history.length - 1;
  let outfit = chat?.outfits?.[0] ?? defaultOutfit(character);
  let position = -1;
  for (const candidate of chat?.outfits ?? []) {
    const index = candidate.fromMessageId ? history.findIndex(item => item.id === candidate.fromMessageId) : -1;
    if (index <= cutoff && index >= position) { outfit = candidate; position = index; }
  }
  const references: VisualSnapshot['references'] = [];
  for (const [role, assetId] of [['face', character.visual?.faceAssetId], ['body', character.visual?.bodyAssetId], ['outfit', outfit.referenceAssetId]] as const) {
    if (role === 'outfit' && references.some(reference => reference.assetId === assetId)) continue;
    if (assetId) { checkReference(store, character.id, assetId); references.push({ role, assetId }); }
  }
  const snapshot: VisualSnapshot = { characterId: character.id, characterRevision: character.revision, identity: character.visual?.identity || character.appearance, outfit, references };
  return { key: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), snapshot };
}

/** Compile confirmed facts into image-facing prose without inventing story details. */
export function renderScenePrompt(visual: VisualSnapshot): string {
  const state = visual.scene;
  if (!state) return '';
  const known = (value: string) => !/^(未知|不确定|未提及|未说明|无|无明确描述|unknown|none)?[。.]?$/i.test(value.trim());
  const visible = state.people.filter(person => person.inFrame);
  const lines = [`单幅叙事画面，入镜 ${visible.length} 人。`];
  if (known(state.setting.value)) lines.push(`画面发生在${state.setting.value}。`);
  if (known(state.camera.value)) lines.push(`镜头与构图：${state.camera.value}。`);
  else lines.push('采用能够清楚交代当前动作和人物位置的景别，主体突出，构图自然，保留动作所需的画面空间。');
  for (const person of visible) {
    const details = [
      known(person.position.value) ? `位于${person.position.value}` : '',
      known(person.outfit.value) ? `身穿${person.outfit.value}` : '',
      known(person.wearing.value) ? `衣物当前状态为${person.wearing.value}` : '',
      known(person.appearance.value) ? `外观细节为${person.appearance.value}` : '',
      known(person.action.value) ? `正在${person.action.value}` : '',
      known(person.expression.value) ? `表情为${person.expression.value}` : '',
      known(person.props.value) ? `相关道具为${person.props.value}` : '',
    ].filter(Boolean);
    lines.push(`${person.name}（${person.id === 'main' ? '主角' : '独立配角'}）：${details.length ? details.join('；') : '按已确认身份呈现，不增添未经描述的动作与服装细节'}。`);
  }
  if (known(state.interaction.value)) lines.push(`空间关系与接触：${state.interaction.value}。`);
  const offscreen = state.people.filter(person => !person.inFrame);
  if (offscreen.length) lines.push(`${offscreen.map(person => person.name).join('、')}在镜头外，不绘制其身体或肢体。`);
  lines.push('在剧情已有光源与时间条件下呈现一致的光照方向、自然的明暗层次和接触阴影。人物与环境透视统一，前后景层次清楚，焦点落在当前人物及关键动作上。服装材质、褶皱和受力方向符合姿势，皮肤、头发与物体细节自然，避免过度磨皮和过锐化。保持参考图已有的视觉风格。');
  return lines.join('\n');
}

export function compileVisualPrompt(scene: string, visual?: VisualSnapshot): string {
  if (!visual) return scene;
  const roles = { face: '主角 main 的稳定五官与面部身份，不复制表情、眼镜佩戴状态或发型整理方式', body: '主角 main 的自然身体比例，不复制姿势、服装、背景或其他人物', outfit: '主角 main 当前服装的款式、颜色与材质，不复制姿势和穿着状态' };
  const refs = visual.references.map((reference, index) => `<image${index + 1}> 仅用于${roles[reference.role]}。`).join('\n');
  return [refs,
    '所有参考图只绑定主角 main，不代表画面只有一个人。其他人物有独立身份与身体，不套用主角的脸。生成一幅连贯的剧情画面，不生成拼图或人物设定表。',
    visual.scene && !visual.scene.people.find(person => person.id === 'main')?.inFrame ? '主角在镜头外，不使用主角身份约束其他人物。' : `主角稳定身份（仅采用五官、肤色、年龄段、自然身体比例与辨识特征；忽略其中的服装、姿势、表情、背景及夸张比例要求）：${visual.identity}`,
    visual.scene ? renderScenePrompt(visual) : `服装基准：${visual.outfit.description || '沿用已有服装依据'}。明确的新换装覆盖基准；穿着方式、发型状态、表情和动作按本次画面。\n本次画面：${scene}`,
    visual.scene && scene.trim() && scene.trim() !== '按当前画面状态生成' ? `画面补充（不得改变上方明确的人数、身份与状态）：${scene}` : '',
    '画面不添加字幕、水印、说明文字或多格分镜；剧情明确出现的书籍、招牌等场内文字除外。按每个人的位置分别构建自然、连贯的人体。四肢归属清楚，接触点与遮挡合理，被遮挡的部位不重复补画。不将镜头外人物的身体拼接到入镜人物身上，不夸张或重复臀胯。',
    '冲突按字段处理：五官与自然比例由稳定身份决定；服装款式由当前状态决定；穿着方式、发型整理、配饰佩戴、表情与动作由当前剧情决定；人数、位置、接触和遮挡由镜头计划决定。旧参考图不能覆盖当前状态。'
  ].filter(Boolean).join('\n');
}
