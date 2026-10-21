<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import type { Asset, Character, Chat, ImageJob, Message, Settings, VisualContext, SceneState, SceneContext, SceneFact } from '@tavern/contracts';
import { api } from '../api.ts';
import Icon from './Icon.vue';
import ReferencePicker from './ReferencePicker.vue';
import SceneEditor from './SceneEditor.vue';
import PersonaPanel from './PersonaPanel.vue';

const props = defineProps<{ character?: Character; chat?: Chat; chatId?: string; chatRevision?: number; inferenceRequest?: number; assets?: Asset[]; source?: Message; jobs: ImageJob[]; settings?: Settings; connected: boolean; busy: boolean; chatting?: boolean }>();
const emit = defineEmits<{ generate: [payload: { prompt: string; seed?: number; sourceMessageId?: string; characterId?: string; chatId?: string; visualContextKey?: string; scene?: SceneState; sceneContextKey?: string }, onQueued?: () => void]; notify: [message: string]; settings: []; queue: []; clearSource: []; close: []; editCharacter: []; chatSaved: [chat: Chat] }>();
const prompt = ref('');
const preparing = ref(false);
const personaBusy = ref(false);
const correctionText = ref(''), correctionError = ref(''), correctionNotice = ref('');
const correcting = ref(false), correctionOpen = ref(false);
const oneShotScene = ref<SceneState>();
const displayedScene = computed(() => oneShotScene.value ?? scene.value);
const proposal = ref<{ state: SceneState; sceneContextKey: string; question: string; changes: { label: string; before: string; after: string }[] }>();
let correctionController: AbortController | undefined;
function clearCorrection() { oneShotScene.value = undefined; proposal.value = undefined; correctionNotice.value = ''; }
async function correctScene() {
  if (correcting.value || !correctionText.value.trim()) return;
  correctionError.value = ''; proposal.value = undefined;
  if (!scene.value || pendingMessages.value) { if (!(await draft())) return; }
  const requested = selection(), baseKey = sceneKey.value;
  correcting.value = true;
  const controller = new AbortController(); correctionController = controller;
  try {
    const result = await api<NonNullable<typeof proposal.value>>('/scene-corrections', 'POST', { ...scenePayload(), instruction: correctionText.value }, controller.signal);
    if (requested === selection() && baseKey === sceneKey.value) proposal.value = result;
  } catch (e) { if (requested === selection()) correctionError.value = controller.signal.aborted ? '已取消，画面未修改' : e instanceof Error ? e.message : '修正失败'; }
  finally { correcting.value = false; correctionController = undefined; }
}
async function applyCorrection(persist: boolean) {
  const result = proposal.value;
  if (!result || result.question || result.sceneContextKey !== sceneKey.value) return;
  if (!persist) { oneShotScene.value = result.state; proposal.value = undefined; correctionNotice.value = '仅用于下一张图片，加入队列后自动清除。'; return; }
  const requested = selection(); savingScene.value = true;
  try {
    const saved = await api<SceneContext>('/scene-state', 'PUT', { ...scenePayload(), scene: result.state });
    if (requested !== selection()) return;
    scene.value = saved.state; sceneKey.value = saved.key; sceneDirty.value = false; pendingMessages.value = 0;
    clearCorrection(); correctionNotice.value = '已沿用到后续画面；剧情明确变化时仍会更新。';
  } catch (e) { correctionError.value = e instanceof Error ? e.message : '保存失败'; }
  finally { savingScene.value = false; }
}
watch(correctionText, () => { proposal.value = undefined; correctionError.value = ''; });
const draftError = ref('');
const showAdjustments = ref(false);
let automaticVersion = 0;
let draftTask: Promise<boolean> | undefined;
const scene = ref<SceneState>();
const sceneKey = ref('');
watch(sceneKey, () => { clearCorrection(); correctionController?.abort(); });
const sceneDirty = ref(false);
const pendingMessages = ref(0);
const compiledPrompt = ref('');
const previewError = ref('');
const generatingPrompt = ref(false);
const showPrompt = ref(false);
const savingScene = ref(false);
let previewTimer: ReturnType<typeof setTimeout>;
let previewVersion = 0;
const scenePayload = () => ({ characterId: props.character?.id, chatId: props.chatId, sourceMessageId: props.source?.id, scene: oneShotScene.value ?? scene.value, sceneContextKey: sceneKey.value });
async function preview() {
  const version = ++previewVersion;
  compiledPrompt.value = ''; previewError.value = '';
  if (!context.value || (!scene.value && !prompt.value.trim())) return;
  try {
    const result = await api<{ compiledPrompt: string }>('/image-prompts/preview', 'POST', { ...scenePayload(), prompt: prompt.value.trim() || '按当前画面状态生成' });
    if (version === previewVersion) compiledPrompt.value = result.compiledPrompt;
  } catch (error) { if (version === previewVersion) previewError.value = error instanceof Error ? error.message : '预览失败'; }
}
watch([scene, oneShotScene, prompt, sceneKey], () => { ++previewVersion; compiledPrompt.value = ''; clearTimeout(previewTimer); previewTimer = setTimeout(() => { void preview(); }, 300); }, { deep: true });
async function generatePrompt() {
  if (generatingPrompt.value || drafting.value || preparing.value || contextLoading.value) return;
  generatingPrompt.value = true;
  showPrompt.value = true;
  clearTimeout(previewTimer);
  try { await preview(); }
  finally { generatingPrompt.value = false; }
}
async function copyPrompt() {
  try { await navigator.clipboard.writeText(compiledPrompt.value); emit('notify', '提示词已复制'); }
  catch { emit('notify', '无法复制，请手动选择提示词'); }
}
async function saveState() {
  if (!scene.value || savingScene.value) return false;
  const requested = selection();
  savingScene.value = true;
  try {
    const result = await api<SceneContext>('/scene-state', 'PUT', { ...scenePayload(), scene: scene.value });
    if (selection() !== requested) return false;
    sceneKey.value = result.key; scene.value = result.state; sceneDirty.value = false; pendingMessages.value = 0;
    emit('notify', '画面状态已保存，后续推断将从这里继续');
    return true;
  } catch (error) { emit('notify', error instanceof Error ? error.message : '状态保存失败'); return false; }
  finally { savingScene.value = false; }
}
function manualState() {
  const fact = (value = ''): SceneFact => ({ value, basis: 'manual' });
  scene.value = { identity: context.value?.snapshot.identity || props.character?.appearance || '保持主角自然外貌', setting: fact(), camera: fact(), interaction: fact(), people: [{ id: 'main', name: props.character?.name || '主角', inFrame: true, position: fact(), action: fact(), expression: fact(), outfit: fact(context.value?.snapshot.outfit.description), wearing: fact(), appearance: fact(), props: fact() }] };
  const persona = context.value?.snapshot.userPersona;
  if (persona) scene.value.people.push({ id: 'user', name: persona.name, inFrame: context.value?.snapshot.framing === 'together', position: fact(), action: fact(), expression: fact(), outfit: fact(persona.visual.outfit), wearing: fact(), appearance: fact(), props: fact() });
  sceneDirty.value = true;
}

const seed = ref('');
const drafting = ref(false);
let draftController: AbortController | undefined;
onUnmounted(() => { correctionController?.abort(); automaticVersion++; contextVersion++; draftController?.abort(); clearTimeout(previewTimer); ++previewVersion; });
const context = ref<VisualContext>();
const contextLoading = ref(false);
const contextError = ref('');
const outfit = ref('');
const outfitReference = ref<string>();
const changing = ref(false);
const uploading = ref(false);
const showOutfit = ref(false);
let contextVersion = 0;
const selection = () => `${props.character?.id}:${props.chatId}:${props.source?.id}`;
async function loadContext() {
  const version = ++contextVersion;
  const previousKey = context.value?.key;
  context.value = undefined; contextError.value = ''; contextLoading.value = true;
  try {
    if (!props.character) return;
    const query = new URLSearchParams({ characterId: props.character.id, ...(props.chatId ? { chatId: props.chatId } : {}), ...(props.source ? { sourceMessageId: props.source.id } : {}) });
    const result = await api<VisualContext>(`/visual-context?${query}`);
    if (version !== contextVersion) return;
    if (previousKey && previousKey !== result.key && prompt.value) { prompt.value = ''; emit('notify', '角色或服装已更新，请重新填写或推断画面'); }
    const savedScene = await api<SceneContext>(`/scene-state?${query}`);
    if (version !== contextVersion) return;
    if (sceneKey.value !== savedScene.key) { scene.value = savedScene.state; sceneKey.value = savedScene.key; sceneDirty.value = false; pendingMessages.value = savedScene.pendingMessages; }
    context.value = result; void preview(); outfit.value = result.snapshot.outfit.description; outfitReference.value = result.snapshot.outfit.referenceAssetId;
    return true;
  } catch (error) { if (version === contextVersion) contextError.value = error instanceof Error ? error.message : '无法读取角色定稿'; }
  finally { if (version === contextVersion) contextLoading.value = false; }
}
watch(() => [props.character?.id, props.character?.revision, props.chatId, props.chatRevision, props.source?.id], () => { void loadContext(); }, { immediate: true });
watch(() => [props.character?.id, props.chatId, props.source?.id], () => { automaticVersion++; clearCorrection(); correctionController?.abort(); correctionText.value = ''; correctionError.value = ''; correctionOpen.value = false; draftError.value = ''; showAdjustments.value = false; showPrompt.value = false; ++previewVersion; compiledPrompt.value = ''; draftController?.abort(); prompt.value = ''; scene.value = undefined; sceneKey.value = ''; showOutfit.value = false; });
async function saveOutfit() {
  if (!props.chatId || changing.value || uploading.value) return;
  changing.value = true;
  const requested = selection();
  try {
    const chat = await api<Chat>(`/chats/${props.chatId}/outfits`, 'POST', { expectedChatRevision: props.chatRevision, fromMessageId: props.source?.id, description: outfit.value, referenceAssetId: outfitReference.value });
    emit('chatSaved', chat);
    if (selection() === requested) { showOutfit.value = false; prompt.value = ''; await loadContext(); }
    emit('notify', '服装基准已更新，后续明确换装可继续改变；请重新推断画面');
  } catch (error) { emit('notify', error instanceof Error ? error.message : '保存换装失败'); }
  finally { changing.value = false; }
}
const active = computed(() => props.jobs.find(job => !['succeeded', 'failed', 'cancelled'].includes(job.status)));
const mainPerson = computed(() => scene.value?.people.find(person => person.id === 'main'));
watch(() => props.inferenceRequest, async () => {
  const version = ++automaticVersion;
  draftController?.abort();
  if (draftTask) await draftTask;
  if (version !== automaticVersion) return;
  if (!(await loadContext()) || version !== automaticVersion) return;
  if (props.chatting) { draftError.value = '请等待当前聊天回复完成，再读取画面。'; return; }
  await draft();
}, { flush: 'post' });
watch(() => props.chatting, value => { if (!value && !sceneDirty.value && !drafting.value && !preparing.value) void loadContext(); });
function draft(): Promise<boolean> {
  if (draftTask) return draftTask;
  draftTask = runDraft().finally(() => { draftTask = undefined; });
  return draftTask;
}

async function runDraft(): Promise<boolean> {
  if (sceneDirty.value && !(await saveState())) return false;
  draftError.value = '';
  if (!props.settings?.textModel) { draftError.value = '请先配置文本模型，用于读取聊天中的画面。'; return false; }
  if (scene.value && !pendingMessages.value) return true;
  const controller = new AbortController();
  draftController = controller;

  drafting.value = true;
  const requestedChat = props.chatId;
  const requestedSource = props.source?.id;
  const requestedCharacter = props.character?.id;
  try {
    do {
      const timeout = setTimeout(() => controller.abort(), 130000);
      let result: { scene: SceneState; sceneContextKey: string; visualContextKey?: string; pendingMessages: number };
      try { result = await api<typeof result>('/image-prompts', 'POST', { characterId: requestedCharacter, chatId: requestedChat, sourceMessageId: requestedSource, structured: true }, controller.signal); }
      finally { clearTimeout(timeout); }
      if (props.character?.id !== requestedCharacter || props.chatId !== requestedChat || props.source?.id !== requestedSource) return false;
      if (result.visualContextKey !== context.value?.key) { await loadContext(); throw new Error('角色或服装已变化，请重新推断画面'); }
      scene.value = result.scene; sceneKey.value = result.sceneContextKey; sceneDirty.value = false; pendingMessages.value = result.pendingMessages;
    } while (pendingMessages.value > 0 && !controller.signal.aborted);
    return !controller.signal.aborted;
  }
  catch (error) { draftError.value = controller.signal.aborted ? '已停止读取画面，已完成的进度会保留。' : error instanceof Error ? error.message : '读取画面失败，请检查文本模型连接'; return false; }
  finally { drafting.value = false; draftController = undefined; }
}
async function submit() {
  if (correcting.value || proposal.value || preparing.value || drafting.value || props.busy || props.chatting) return;
  if (!props.settings?.researchUseConfirmed) { emit('notify', '请先在设置中确认模型许可与使用用途'); emit('settings'); return; }
  if (seed.value && (!/^\d+$/.test(seed.value) || Number(seed.value) > 4294967295)) { emit('notify', 'Seed 必须为 0～4294967295 的整数，或留空随机'); return; }
  const requested = selection();
  const version = automaticVersion;
  preparing.value = true;
  try {
    if (sceneDirty.value && !(await saveState())) return;
    if (!(await loadContext()) || requested !== selection() || version !== automaticVersion) return;
    if (props.chatId && (!scene.value || pendingMessages.value > 0) && !(await draft())) return;
    if (requested !== selection() || version !== automaticVersion) return;
    if (!scene.value && !prompt.value.trim()) { draftError.value = '请选择一段聊天，或填写想画的内容。'; return; }
    const temporary = oneShotScene.value;
    emit('generate', { ...scenePayload(), prompt: prompt.value.trim() || '按当前画面状态生成', ...(seed.value ? { seed: Number(seed.value) } : {}), sourceMessageId: props.source?.id, characterId: props.character?.id, chatId: props.chatId, visualContextKey: context.value?.key }, () => { if (temporary && oneShotScene.value === temporary) clearCorrection(); });
  } finally { preparing.value = false; }
}

</script>

<template>
  <aside class="image-panel">
    <div class="panel-heading"><div class="panel-title"><Icon name="spark" :size="18" /><h2>让故事有画面</h2></div><span class="beta-label">LOCAL</span><button class="icon-button mobile-panel-close" aria-label="关闭生图面板" @click="emit('close')"><Icon name="close" :size="17" /></button></div>
    <p class="panel-intro">把文字里的那一刻，留在画面里。</p>
    <div class="model-chip"><span class="model-glyph">Q</span><div><strong>Qwen-Image-2.1</strong><small>本地模型 · 标准版 INT8</small></div><span class="status-dot" :class="connected ? 'online' : 'offline'" :title="connected ? '服务已连接' : 'ComfyUI 未启动'" /></div>
    <div v-if="source" class="source-chip"><Icon name="chat" :size="14" /><span>来自选中的剧情消息</span><button class="icon-button" aria-label="取消来源消息" @click="emit('clearSource')"><Icon name="close" :size="13" /></button></div>
    <PersonaPanel v-if="chat" :key="chat.id" :chat="chat" :disabled="correcting || savingScene || drafting || preparing || chatting || busy" @saved="emit('chatSaved', $event)" @busy="personaBusy = $event" />
    <section class="scene-summary" aria-live="polite">
      <div class="field-row"><strong>{{ source ? '这一刻的画面' : '当前聊天画面' }}</strong><button v-if="chatId" class="text-button" :disabled="correcting || !!oneShotScene || !!proposal || drafting || preparing || chatting || contextLoading" @click="draft">刷新画面</button></div>
      <p v-if="drafting">正在读取剧情中的服装、动作和场景…<span v-if="pendingMessages">剩余 {{ pendingMessages }} 条</span></p>
      <p v-else-if="!scene || pendingMessages">{{ chatId ? '生成时自动读取聊天，跟随剧情中的换装、表情和动作，无需填写。' : '选择一个故事，即可从聊天生成画面。' }}</p>
      <template v-if="displayedScene && !pendingMessages">
        <p>{{ displayedScene.people.filter(person => person.inFrame).map(person => person.name).join('与') }} · {{ displayedScene.setting.value || '沿用剧情场景' }}<br />{{ displayedScene.interaction.value || displayedScene.people.filter(person => person.inFrame).map(person => person.action.value).filter(Boolean).join('；') }}</p>
        <button class="text-button" @click="correctionOpen = !correctionOpen">一句话修改</button>
      </template>
      <button v-if="drafting" class="text-button" @click="draftController?.abort()">停止读取画面</button>
      <div v-if="draftError" role="alert"><p>{{ draftError }}</p><button class="text-button" :disabled="drafting || preparing || chatting" @click="draft">重新读取</button> <button class="text-button" @click="emit('settings')">文本模型设置</button></div>
      <p v-if="contextError" role="alert">{{ contextError }} <button class="text-button" @click="loadContext">重试</button></p>
    </section>
    <section v-if="chatId" class="correction-panel">
      <button v-if="!correctionOpen && (!scene || pendingMessages)" class="text-button" @click="correctionOpen = true">一句话修改画面</button>
      <template v-if="correctionOpen">
        <label class="field">想改哪里？<textarea v-model="correctionText" rows="2" maxlength="1000" :disabled="correcting || savingScene" placeholder="例如：我穿黑色外套；递书的是我，不是她。" /></label>
        <button class="button secondary small" :disabled="!correctionText.trim() || correcting || drafting || preparing || savingScene || chatting || personaBusy || busy || contextLoading" @click="correctScene">{{ correcting ? '正在理解修改…' : '理解这句话' }}</button>
        <button v-if="correcting" class="text-button" @click="correctionController?.abort()">取消</button>
        <div v-if="proposal" aria-live="polite">
          <p v-if="proposal.question">{{ proposal.question }}</p>
          <template v-else><p v-for="(change, i) in proposal.changes" :key="i"><strong>{{ change.label }}</strong>：{{ change.before || '未指定' }} → {{ change.after || '清除' }}</p>
          <button class="button secondary small" :disabled="savingScene || chatting || busy" @click="applyCorrection(false)">仅这张</button>
          <button class="button secondary small" :disabled="savingScene || chatting || busy" @click="applyCorrection(true)">后续沿用</button></template>
          <button class="text-button" @click="proposal = undefined">放弃修改</button>
        </div>
        <p v-if="correctionError" role="alert">{{ correctionError }}</p>
      </template>
      <p v-if="correctionNotice" role="status">{{ correctionNotice }} <button v-if="oneShotScene" class="text-button" @click="clearCorrection">撤销临时修正</button></p>
    </section>
    <div class="field prompt-field"><label for="image-prompt">{{ chatId ? '补充要求（可选）' : '想画什么' }}</label><textarea id="image-prompt" v-model="prompt" rows="3" maxlength="4000" placeholder="例如：近景、柔和的窗边光线。人物衣着与状态自动跟随聊天。" /><span class="field-hint">{{ source ? '只读取截至选中消息的剧情，不使用后续内容。' : '直接生成即可，也可以展开下方选项纠正画面。' }}</span></div>
    <details class="scene-adjustments" :open="showAdjustments" @toggle="showAdjustments = ($event.target as HTMLDetailsElement).open"><summary>调整画面（可选）</summary>
    <section v-if="character" class="visual-anchor">
      <div class="field-row"><strong>角色定稿</strong><button class="text-button" @click="emit('editCharacter')">编辑参考</button></div>
      <p v-if="contextLoading">正在读取参考与服装…</p>
      <p v-else-if="contextError" role="alert">{{ contextError }} <button class="text-button" @click="loadContext">重试</button></p>
      <template v-else-if="context">
        <div v-if="context.snapshot.references.length" class="anchor-thumbnails"><figure v-for="reference in context.snapshot.references" :key="`${reference.personId ?? 'main'}:${reference.role}`"><img :src="`/api/v1/media/${reference.assetId}`" :alt="{ face: '面部参考', body: '全身参考', outfit: '服装参考' }[reference.role]" /><figcaption>{{ reference.personId === 'user' ? '我的' : '角色' }}{{ { face: '面部', body: '体型', outfit: '服装' }[reference.role] }}</figcaption></figure></div>
        <p v-else>目前仅使用文字约束。添加面部与全身参考，可帮助保持同一角色。</p>
        <p class="outfit-summary"><strong>{{ source ? '该消息的服装基准' : '服装基准' }}</strong><br />{{ context.snapshot.outfit.description || '沿用参考图或原始外貌描述中的服装' }}</p>
        <button v-if="chatId" class="text-button" :disabled="drafting || busy" @click="showOutfit = !showOutfit">{{ showOutfit ? '收起换装' : '确认换装' }}</button>
      </template>
      <div v-if="showOutfit" class="outfit-editor"><label class="field">新服装<textarea v-model="outfit" maxlength="2000" rows="3" placeholder="描述衣服、鞋子和配饰" /></label><ReferencePicker v-model="outfitReference" :character-id="character.id" :assets="assets" label="新服装参考（可选）" @busy="uploading = $event" /><p>{{ source ? '从选中的消息起生效。' : '从当前最后一条消息起生效。' }} 作为此处的服装基准，后续明确换装会更新状态。</p><button class="button secondary small" :disabled="changing || uploading || !outfit.trim() || chatting" @click="saveOutfit">{{ changing ? '保存中…' : '保存这套服装' }}</button></div>
    </section>
      <fieldset v-if="scene" class="scene-controls" :disabled="correcting || !!oneShotScene || !!proposal || drafting || preparing || savingScene || chatting"><SceneEditor v-model="scene" @change="sceneDirty = true" /></fieldset>
      <button v-if="scene && sceneDirty" class="text-button" :disabled="savingScene || drafting" @click="saveState">{{ savingScene ? '保存中…' : '保存修正' }}</button>
      <button v-if="!scene && context" class="text-button" :disabled="drafting || chatting" @click="manualState">手动指定画面</button>

      <label class="field seed-field">Seed <span class="muted">可选</span><input v-model="seed" inputmode="numeric" maxlength="10" placeholder="留空，让每次都有新意" /></label>
      <p v-if="context?.snapshot.references.length" class="field-hint">使用参考图时建议留空；重复原图的 Seed 可能导致过锐化或忽略编辑要求。</p>
    </details>
    <div class="generation-presets"><div><span>画幅</span><strong>1:1 <span class="preset-square"></span></strong><small>1024 × 1024</small></div><div><span>采样</span><strong>25 <em>步</em></strong><small>Euler · CFG 1</small></div></div>
    <section class="prompt-preview">
      <button class="button secondary" :disabled="generatingPrompt || drafting || preparing || savingScene || contextLoading || !!contextError || (!scene && !prompt.trim())" @click="generatePrompt">{{ generatingPrompt ? '正在生成提示词…' : '根据当前画面生成提示词' }}</button>
      <p class="field-hint">包含尚未保存的画面编辑和补充要求，无需启动文本模型，不会提交生图。</p>
      <details :open="showPrompt" @toggle="showPrompt = ($event.target as HTMLDetailsElement).open">
        <summary>实际生图提示词</summary>
        <p v-if="previewError" role="alert">{{ previewError }}</p>
        <template v-else><pre>{{ compiledPrompt || '编辑画面后，点击上方按钮生成提示词' }}</pre><button v-if="compiledPrompt" class="text-button" @click="copyPrompt">复制提示词</button></template>
      </details>
    </section>
    <button class="button primary generate-button" :disabled="correcting || !!proposal || personaBusy || busy || preparing || drafting || chatting || savingScene || contextLoading || !!contextError || showOutfit" @click="submit"><Icon name="spark" :size="17" />{{ drafting ? '正在理解剧情…' : preparing ? '准备画面…' : busy ? '加入队列中…' : '生成这一刻' }}<span>↗</span></button>
    <p class="local-note"><span class="status-dot" :class="connected ? 'online' : 'offline'" />{{ connected ? '图像在你的电脑上生成' : 'ComfyUI 未连接 · 任务可排队等待' }}</p>
    <div class="panel-divider"></div>
    <div class="queue-preview-heading"><span><Icon name="queue" :size="16" />创作队列</span><button class="text-button" @click="emit('queue')">查看全部 <Icon name="chevron" :size="13" /></button></div>
    <div v-if="active" class="mini-job"><div class="mini-job-art"><Icon name="image" :size="20" /></div><div><strong>{{ active.phase }}</strong><small>{{ active.prompt.slice(0, 34) }}</small><div class="progress-track"><span :style="{ width: `${active.progress ?? 8}%` }" /></div></div></div>
    <div v-else class="queue-quiet"><Icon name="leaf" :size="17" /><span>没有排队的灵感，随时开始。</span></div>
    <div class="panel-footnote"><Icon name="info" :size="15" /><p>参考图、服装与画面状态随任务保存，不会自动改用上一张生成图。参考可帮助保持身份，但仍需检查面部、体型和服饰细节。</p></div>
  </aside>
</template>

<style scoped>
.scene-summary { margin: 14px 0; padding: 12px; border: 1px solid var(--line); border-radius: 8px; font-size: 12px; line-height: 1.7; } .scene-summary p { margin: 8px 0; } .scene-summary strong { color: var(--muted); } .scene-summary span { display: block; } .scene-adjustments { margin: 14px 0; font-size: 12px; } .scene-adjustments > summary { cursor: pointer; }
.correction-panel { font-size: 12px; line-height: 1.7; } .correction-panel button { margin: 4px 6px 4px 0; }
.scene-controls { border: 0; padding: 0; margin: 0; min-width: 0; }
.prompt-preview { margin: 12px 0; font-size: 12px; } .prompt-preview pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 300px; overflow: auto; font: inherit; line-height: 1.7; }
</style>
