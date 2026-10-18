<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import type { Asset, Bootstrap, Character, CharacterInput, Chat, ImageJob, Message, Settings, SceneState, StudioEvent, SystemStatus } from '@tavern/contracts';
import { api, session, ApiError } from './api.ts';
import Icon from './components/Icon.vue';
import CharacterArt from './components/CharacterArt.vue';
import CharacterModal from './components/CharacterModal.vue';
import ImagePanel from './components/ImagePanel.vue';
import SettingsView from './components/SettingsView.vue';

type View = 'chat' | 'characters' | 'gallery' | 'jobs' | 'settings';
const state = ref<Bootstrap>();
const view = ref<View>('chat');
const activeChatId = ref('');
const messages = ref<Message[]>([]);
const sourceMessage = ref<Message>();
const inferenceRequest = ref(0);
function drawMoment(message: Message) { sourceMessage.value = message; imagePanelOpen.value = true; inferenceRequest.value++; }
const composer = ref('');
const search = ref('');
const loading = ref(true);
const connectionError = ref('');
const status = ref<SystemStatus>();
const showEditor = ref(false);
const editingCharacter = ref<Character>();
const saving = ref(false);
const sending = ref(false);
const creatingChat = ref('');
const creatingImage = ref(false);
const switchingModel = ref(false);
const sidebarOpen = ref(false);
const imagePanelOpen = ref(false);
const toast = ref('');
const lightbox = ref<Asset>();
const uploadInput = ref<HTMLInputElement>();
const chatScroll = ref<HTMLElement>();
let nearBottom = true;
let eventSource: EventSource | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let statusTimer: ReturnType<typeof setInterval>;
let toastTimer: ReturnType<typeof setTimeout>;
let selectionVersion = 0;
let closed = false;
const titles: Record<View, string> = { chat: '聊天工作台', characters: '角色与故事', gallery: '灵感画廊', jobs: '创作队列', settings: '模型与设置' };
const navigation: { id: View; label: string; icon: string }[] = [{ id: 'chat', label: '聊天工作台', icon: 'chat' }, { id: 'characters', label: '角色与故事', icon: 'people' }, { id: 'gallery', label: '灵感画廊', icon: 'image' }, { id: 'jobs', label: '创作队列', icon: 'queue' }];
const activeChat = computed(() => state.value?.chats.find(chat => chat.id === activeChatId.value));
const activeCharacter = computed(() => state.value?.characters.find(character => character.id === activeChat.value?.characterId) ?? state.value?.characters[0]);
const filteredCharacters = computed(() => state.value?.characters.filter(character => `${character.name} ${character.tagline} ${character.tags.join(' ')}`.toLowerCase().includes(search.value.toLowerCase())) ?? []);
const pendingJobs = computed(() => state.value?.jobs.filter(job => !['succeeded', 'failed', 'cancelled'].includes(job.status)) ?? []);
const isStreaming = computed(() => messages.value.some(message => message.status === 'streaming'));
const textConfigured = computed(() => !!state.value?.settings.textUrl && !!state.value?.settings.textModel);
const chatAssets = computed(() => state.value?.assets.filter(asset => asset.chatId === activeChatId.value) ?? []);
const storyAssets = computed(() => [...chatAssets.value].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
const formatTime = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const characterName = (id?: string) => state.value?.characters.find(character => character.id === id)?.name ?? '自由创作';
const terminal = (job: ImageJob) => ['succeeded', 'failed', 'cancelled'].includes(job.status);

function notify(message: string) { toast.value = message; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.value = ''; }, 6500); }
function failure(error: unknown) { notify(error instanceof Error ? error.message : '操作失败，请重试'); }
function navigate(target: View) {
  view.value = target;
  sidebarOpen.value = false;
  imagePanelOpen.value = false;
  if (target === 'chat') { nearBottom = true; void scrollBottom(); }
}
function upsert<Entity extends { id: string }>(items: Entity[], entity: Entity, first = false) { const index = items.findIndex(item => item.id === entity.id); if (index >= 0) items[index] = entity; else if (first) items.unshift(entity); else items.push(entity); }
async function scrollBottom() { if (!nearBottom) return; await nextTick(); chatScroll.value?.scrollTo({ top: chatScroll.value.scrollHeight, behavior: 'instant' }); }

function applyEvent(event: StudioEvent) {
  if (!state.value) return;
  if (event.type === 'snapshot.required') { void reload(); return; }
  if (event.type === 'settings.updated') settingsSaved(event.payload as Settings);
  state.value.eventCursor = event.id;
  if (event.type === 'character.updated') upsert(state.value.characters, event.payload as Character);
  if (event.type === 'chat.updated') upsert(state.value.chats, event.payload as Chat, true);
  if (event.type === 'message.updated') { const message = event.payload as Message; if (message.chatId === activeChatId.value) { upsert(messages.value, message); void scrollBottom(); } }
  if (event.type === 'job.updated') upsert(state.value.jobs, event.payload as ImageJob, true);
  if (event.type === 'asset.created') { upsert(state.value.assets, event.payload as Asset, true); void scrollBottom(); }
}

function subscribe() {
  clearTimeout(reconnectTimer);
  eventSource?.close();
  if (closed || !state.value) return;
  eventSource = new EventSource(`/api/v1/events?after=${state.value.eventCursor}`);
  eventSource.onmessage = message => { try { applyEvent(JSON.parse(message.data) as StudioEvent); } catch { notify('事件同步中断，请刷新页面'); } };
  eventSource.onerror = () => {
    eventSource?.close();
    const reconnect = async () => {
      if (closed) return;
      try { await session(); if (!closed) subscribe(); }
      catch { if (!closed) reconnectTimer = setTimeout(reconnect, 3000); }
    };
    reconnectTimer = setTimeout(reconnect, 1500);
  };
}

async function refreshStatus() { try { status.value = await api<SystemStatus>('/system/status'); } catch { status.value = undefined; } }
async function reload() {
  eventSource?.close();
  try {
    await session();
    state.value = await api<Bootstrap>('/bootstrap');
    connectionError.value = '';
    if (activeChatId.value && state.value.chats.some(chat => chat.id === activeChatId.value)) await selectChat(activeChatId.value, false);
    subscribe();
    void refreshStatus();
  } catch (error) { connectionError.value = error instanceof Error ? error.message : '无法连接本地服务'; }
  finally { loading.value = false; }
}

async function selectChat(id: string, switchView = true) {
  const version = ++selectionVersion;
  try {
    const result = await api<Message[]>(`/chats/${id}/messages`);
    if (version !== selectionVersion) return;
    activeChatId.value = id;
    messages.value = result;
    sourceMessage.value = undefined;
    nearBottom = true;
    if (switchView) navigate('chat');
    try { localStorage.setItem('tavern.activeChat', id); } catch { }
    void scrollBottom();
  } catch (error) { failure(error); }
}

async function beginChat(character: Character) {
  if (creatingChat.value) return;
  creatingChat.value = character.id;
  try { const chat = await api<Chat>('/chats', 'POST', { characterId: character.id }); upsert(state.value!.chats, chat, true); await selectChat(chat.id); }
  catch (error) { failure(error); }
  finally { creatingChat.value = ''; }
}

function editCharacter(character?: Character) { editingCharacter.value = character; showEditor.value = true; }
async function saveCharacter(input: CharacterInput) {
  saving.value = true;
  try {
    const character = editingCharacter.value ? await api<Character>(`/characters/${editingCharacter.value.id}`, 'PATCH', { ...input, revision: editingCharacter.value.revision }) : await api<Character>('/characters', 'POST', input);
    upsert(state.value!.characters, character);
    showEditor.value = false;
    notify('角色已保存，新的故事随时可以开始');
  } catch (error) { failure(error); }
  finally { saving.value = false; }
}

async function importCard(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    if (file.size > 8 * 1024 * 1024) throw new Error('角色卡最大支持 8MB');
    let body: unknown;
    if (file.name.toLowerCase().endsWith('.png')) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      body = { pngBase64: btoa(binary) };
    } else body = { card: JSON.parse(await file.text()) };
    const result = await api<{ character: Character; warnings: string[] }>('/imports/characters', 'POST', body);
    upsert(state.value!.characters, result.character);
    navigate('characters');
    notify(`已导入 ${result.character.name}。${result.warnings.join(' ')}`);
  } catch (error) { failure(error); }
  finally { input.value = ''; }
}

async function sendMessage() {
  if (!composer.value.trim() || !activeChat.value || sending.value) return;
  sending.value = true;
  const chat = activeChat.value;
  try {
    const result = await api<{ chat: Chat; user: Message; assistant: Message }>(`/chats/${chat.id}/generations`, 'POST', { content: composer.value.trim(), expectedChatRevision: chat.revision });
    upsert(state.value!.chats, result.chat);
    if (activeChatId.value === chat.id) { upsert(messages.value, result.user); if (!messages.value.some(message => message.id === result.assistant.id)) upsert(messages.value, result.assistant); composer.value = ''; nearBottom = true; void scrollBottom(); }
  } catch (error) { failure(error); if (error instanceof ApiError && error.code === 'TEXT_NOT_CONFIGURED') navigate('settings'); }
  finally { sending.value = false; }
}

async function stopText() { try { await api(`/chats/${activeChatId.value}/cancel`, 'POST', {}); } catch (error) { failure(error); } }
function composerKey(event: KeyboardEvent) { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!isStreaming.value && textConfigured.value) void sendMessage(); } }

async function generateImage(payload: { prompt: string; seed?: number; sourceMessageId?: string; characterId?: string; chatId?: string; visualContextKey?: string; scene?: SceneState; sceneContextKey?: string }) {
  creatingImage.value = true;
  try {
    const job = await api<ImageJob>('/image-jobs', 'POST', payload);
    upsert(state.value!.jobs, job, true);
    notify(status.value?.comfy.online ? '灵感已加入队列，可以继续浏览你的故事' : '任务已保存，启动 ComfyUI 后会自动执行');
  } catch (error) { failure(error); }
  finally { creatingImage.value = false; }
}

async function cancelJob(job: ImageJob) { try { upsert(state.value!.jobs, await api<ImageJob>(`/image-jobs/${job.id}/cancel`, 'POST', {})); } catch (error) { failure(error); } }
const recoveringJob = ref('');
async function checkImageConnection() { await refreshStatus(); notify(status.value?.comfy.online ? '生图服务已连接，系统会自动核对旧任务' : '生图服务未连接，请启动 ComfyUI；也可停止追踪旧任务'); }
async function retryJob(job: ImageJob) {
  recoveringJob.value = job.id;
  try { const next = await api<ImageJob>(`/image-jobs/${job.id}/retry`, 'POST', {}); upsert(state.value!.jobs, next, true); notify('已按原提示词、参考图和 Seed 重新生成'); } catch (error) { failure(error); }
  finally { recoveringJob.value = ''; }
}
async function resolveJob(job: ImageJob) {
  if (!window.confirm('原任务的结果无法确认。此操作只停止追踪，不会终止远端推理，也不会删除可能已生成的图片。确认后才能重新提交；新提交可能产生重复图像。继续吗？')) return;
  try { upsert(state.value!.jobs, await api<ImageJob>(`/image-jobs/${job.id}/resolve`, 'POST', { confirmOutcomeUnknown: true, allowOffline: true })); } catch (error) { failure(error); }
}
function settingsSaved(settings: Settings) { state.value!.settings = settings; void refreshStatus(); }
async function switchTextModel(event: Event) {
  const select = event.target as HTMLSelectElement;
  switchingModel.value = true;
  try { const settings = await api<Settings>(`/text-models/${select.value}/activate`, 'POST', {}); settingsSaved(settings); notify(`已切换到 ${settings.textProfileName}`); }
  catch (error) { select.value = state.value?.settings.activeTextProfileId ?? ''; failure(error); }
  finally { switchingModel.value = false; }
}
async function copy(value: string) { try { await navigator.clipboard.writeText(value); notify('已复制'); } catch { notify('无法访问剪贴板，请手动选择并复制'); } }
async function download(asset: Asset) {
  try {
    const response = await fetch(`/api/v1/media/${asset.id}`);
    if (!response.ok) throw new Error('图片下载失败，请刷新后重试');
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `tavern-${asset.id}.png`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { failure(error); }
}
function onChatScroll() { const element = chatScroll.value; if (element) nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 150; }

onMounted(async () => {
  try { activeChatId.value = localStorage.getItem('tavern.activeChat') ?? ''; } catch { }
  await reload();
  statusTimer = setInterval(() => { void refreshStatus(); }, 15000);
});
onUnmounted(() => { closed = true; eventSource?.close(); clearTimeout(reconnectTimer); clearInterval(statusTimer); clearTimeout(toastTimer); });
</script>

<template>
  <div class="studio-layout" :inert="showEditor || !!lightbox ? true : undefined">
    <div v-if="sidebarOpen" class="sidebar-scrim" @click="sidebarOpen = false"></div>
    <div v-if="imagePanelOpen" class="panel-scrim" @click="imagePanelOpen = false"></div>
    <aside class="sidebar" :class="{ open: sidebarOpen }">
      <a class="brand" href="#" @click.prevent="navigate('chat')"><span class="brand-mark"><Icon name="book" :size="24" /></span><span><strong>共叙<span class="brand-period">.</span></strong><small>TAVERN STUDIO</small></span><span class="version-label">α</span></a>
      <button class="new-story-button" @click="navigate('characters')"><Icon name="plus" :size="17" /><span>开始一个新故事</span><kbd>↗</kbd></button>
      <div class="sidebar-label">工作空间 <span>WORKSPACE</span></div>
      <nav class="navigation" aria-label="主导航"><button v-for="item in navigation" :key="item.id" :class="{ active: view === item.id }" @click="navigate(item.id)"><Icon :name="item.icon" :size="18" /><span>{{ item.label }}</span><span v-if="item.id === 'jobs' && pendingJobs.length" class="nav-count">{{ pendingJobs.length }}</span><span v-else-if="view === item.id" class="nav-active-dot"></span></button></nav>
      <div class="sidebar-section-heading"><span>最近的故事</span><Icon name="clock" :size="13" /></div>
      <div class="recent-chats"><button v-for="chat in state?.chats.slice(0, 7)" :key="chat.id" :class="{ selected: activeChatId === chat.id && view === 'chat' }" @click="selectChat(chat.id)"><span class="tiny-avatar" :class="state?.characters.find(character => character.id === chat.characterId)?.color">{{ characterName(chat.characterId).slice(0, 1) }}</span><span><strong>{{ chat.title }}</strong><small>{{ formatTime(chat.updatedAt) }}</small></span></button><p v-if="!state?.chats.length" class="sidebar-empty">还没有故事。<br />一次问候，就足够开始。</p></div>
      <div class="sidebar-bottom"><div class="local-space"><span class="status-dot online"></span><div><strong>你的私人创作空间</strong><small>本机存储 · 无后台遥测</small></div><Icon name="leaf" :size="16" /></div><button class="settings-nav" :class="{ active: view === 'settings' }" @click="navigate('settings')"><Icon name="sliders" :size="18" /><span>模型与设置</span><span class="keyboard-shortcut">↗</span></button><div class="sidebar-version">Tavern Studio <span>v0.1.0 · 研究预览版</span></div></div>
    </aside>

    <div class="workspace">
      <header class="topbar"><div class="breadcrumb"><button class="icon-button mobile-menu" aria-label="展开导航" @click="sidebarOpen = !sidebarOpen"><Icon name="menu" /></button><span>工作空间</span><Icon name="chevron" :size="12" /><strong>{{ titles[view] }}</strong></div><div class="topbar-actions"><span class="connection-badge" :class="{ connected: status?.comfy.online }"><span class="status-dot" :class="status?.comfy.online ? 'online' : 'offline'" />{{ status?.comfy.online ? '图像引擎就绪' : '图像引擎离线' }}</span><button v-if="view === 'chat' || view === 'characters'" class="icon-button mobile-image-button" aria-label="打开生图面板" @click="imagePanelOpen = !imagePanelOpen"><Icon name="image" :size="18" /></button><button class="icon-button" aria-label="模型设置" @click="navigate('settings')"><Icon name="sliders" :size="18" /></button><span class="profile-avatar" title="本机单用户">我</span></div></header>
      <div v-if="loading" class="loading-state"><span class="loading-orbit"></span><p>正在打开你的故事空间…</p></div>
      <div v-else-if="connectionError" class="empty-state"><Icon name="info" :size="36" /><h2>还没有连接上本地服务</h2><p>{{ connectionError }}</p><button class="button primary" @click="reload">重新连接</button></div>
      <div v-else-if="state" class="workspace-body" :class="{ 'with-panel': view === 'chat' || view === 'characters' }">
        <main class="main-content">
          <section v-if="view === 'characters' || (view === 'chat' && !activeChat)" class="character-home page-content">
            <div class="welcome-hero"><div><div class="hero-eyebrow"><span></span>YOUR PRIVATE STORY SPACE</div><h1>在这里，<br />故事有了<span>回响。</span></h1><p>与想象中的人相遇，让文字生长，让灵感成像。<br />下一个世界，始于你的一句问候。</p><div class="hero-bottom"><span class="hero-line"></span><span>每一种想象，都值得被认真对待。</span></div></div><div class="hero-illustration" aria-hidden="true"><div class="celestial-orbit orbit-a"></div><div class="celestial-orbit orbit-b"></div><div class="celestial-center"><Icon name="spark" :size="54" /></div><span class="star star-a">✧</span><span class="star star-b">+</span><span class="star star-c">✦</span><span class="celestial-label">WORDS INTO WORLDS</span></div></div>
            <div class="section-heading"><div><h2>从一次相遇开始 <span>{{ state.characters.length }}</span></h2><p>选择一位故事伙伴，或创造独属于你的角色。</p></div><div class="section-actions"><button class="button ghost small" @click="uploadInput?.click()"><Icon name="upload" :size="15" />导入角色卡</button><button class="button secondary small" @click="editCharacter()"><Icon name="plus" :size="16" />新建角色</button></div></div>
            <label v-if="view === 'characters'" class="search-field"><Icon name="search" :size="17" /><input v-model="search" aria-label="搜索角色" placeholder="搜索角色、标签或故事…" /><kbd>{{ filteredCharacters.length }} 位伙伴</kbd></label>
            <div class="character-grid"><article v-for="character in filteredCharacters" :key="character.id" class="character-card"><div class="card-art-wrap"><CharacterArt :character="character" /><span class="card-top-label"><span class="status-dot online"></span>READY FOR A STORY</span><button class="card-edit icon-button" :aria-label="`编辑${character.name}`" @click="editCharacter(character)"><Icon name="edit" :size="15" /></button></div><div class="character-card-body"><div class="character-name-row"><h3>{{ character.name }}</h3><span class="character-index">0{{ state.characters.indexOf(character) + 1 }}</span></div><p>{{ character.tagline }}</p><div class="tag-list"><span v-for="tag in character.tags.slice(0, 3)" :key="tag">{{ tag }}</span></div><button class="start-chat-button" :disabled="!!creatingChat" @click="beginChat(character)"><span>{{ creatingChat === character.id ? '正在翻开故事…' : '开始对话' }}</span><Icon name="arrow" :size="18" /></button></div></article><button v-if="!filteredCharacters.length" class="empty-character-card" @click="editCharacter()"><Icon name="plus" :size="30" /><strong>{{ search ? '没有找到对应角色' : '第一位伙伴，由你创造' }}</strong><span>打开一段新的可能</span></button></div>
            <div class="inspiration-note"><span class="note-icon"><Icon name="leaf" :size="20" /></span><div><h3>不只是对话，也是一间灵感工作室。</h3><p>在聊天中选中一条消息，就能把那个瞬间变成画面。生成前，你始终可以修改和确认。</p></div><button class="icon-button" aria-label="打开模型设置" @click="navigate('settings')"><Icon name="arrow" :size="19" /></button></div>
            <footer class="page-footnote"><span>私密的故事，本地的归属。</span><span>DESIGNED FOR YOUR IMAGINATION <span>✧</span></span></footer>
          </section>

          <section v-else-if="view === 'chat' && activeChat && activeCharacter" class="chat-view">
            <header class="chat-header"><select class="chat-model-select" aria-label="当前文本模型" :value="state.settings.activeTextProfileId" :disabled="isStreaming || sending || switchingModel" @change="switchTextModel"><option v-for="profile in state.settings.textProfiles" :key="profile.id" :value="profile.id">{{ profile.name }}</option></select><span class="chat-avatar tiny-avatar" :class="activeCharacter.color"><img v-if="activeCharacter.avatarId" :src="`/api/v1/media/${activeCharacter.avatarId}`" :alt="activeCharacter.name" /><template v-else>{{ activeCharacter.name.slice(0, 1) }}</template></span><div><h1>{{ activeCharacter.name }}</h1><p>{{ activeCharacter.tagline }}</p></div><button class="icon-button" aria-label="编辑当前角色" @click="editCharacter(activeCharacter)"><Icon name="edit" :size="17" /></button><button class="button secondary small" @click="beginChat(activeCharacter)"><Icon name="plus" :size="15" />新对话</button></header>
            <div v-if="!textConfigured" class="setup-banner"><Icon name="info" :size="17" /><span>文字引擎尚未连接。你可以先浏览角色，或直接用右侧面板生成图片。</span><button class="text-button" @click="navigate('settings')">去设置 <Icon name="arrow" :size="14" /></button></div>
            <div ref="chatScroll" class="chat-messages" aria-live="polite" aria-relevant="additions text" @scroll="onChatScroll"><div class="conversation-start"><span></span><p>一段新的故事，从此刻开始</p><span></span></div><article v-for="message in messages" :key="message.id" class="message" :class="[message.role, { selected: sourceMessage?.id === message.id }]"><span class="message-avatar" :class="message.role === 'user' ? 'user-avatar' : activeCharacter.color">{{ message.role === 'user' ? '我' : activeCharacter.name.slice(0, 1) }}</span><div class="message-body"><div class="message-meta"><strong>{{ message.role === 'user' ? '你' : activeCharacter.name }}</strong><span>{{ formatTime(message.createdAt) }}</span><small v-if="message.status === 'streaming'" class="streaming-label">正在书写…</small><small v-else-if="message.status === 'interrupted'">已中止</small></div><p class="message-content">{{ message.content }}<span v-if="message.status === 'streaming'" class="typing-cursor">▍</span></p><p v-if="message.error" class="message-error">{{ message.error }}</p><div class="message-images"><button v-for="asset in chatAssets.filter(item => item.sourceMessageId === message.id)" :key="asset.id" @click="lightbox = asset"><img :src="`/api/v1/media/${asset.id}`" :alt="asset.prompt" loading="lazy" /></button></div><div v-if="message.content && message.status !== 'streaming'" class="message-actions"><button class="text-button" @click="copy(message.content)"><Icon name="copy" :size="13" />复制</button><button class="text-button" :class="{ 'source-selected': sourceMessage?.id === message.id }" @click="drawMoment(message)"><Icon name="image" :size="13" />绘制这一刻</button></div></div></article><div v-if="storyAssets.length" class="conversation-gallery"><span class="eyebrow">这个故事里的画面</span><div><button v-for="asset in storyAssets" :key="asset.id" @click="lightbox = asset"><img :src="`/api/v1/media/${asset.id}`" :alt="asset.prompt" /></button></div></div></div>
            <div class="composer-container"><form class="composer" @submit.prevent="sendMessage"><textarea v-model="composer" rows="2" maxlength="12000" :disabled="!textConfigured" :placeholder="textConfigured ? '说点什么，让故事继续…' : '请先在设置中连接文本模型'" aria-label="聊天消息" @keydown="composerKey" /><div class="composer-bottom"><span><Icon name="leaf" :size="14" />{{ state.settings.allowCloud ? '文本使用你配置的服务' : '文本仅允许本机接口' }}</span><button v-if="isStreaming" type="button" class="send-button stop-button" aria-label="停止生成" @click="stopText"><Icon name="stop" :size="17" /></button><button v-else class="send-button" :disabled="!composer.trim() || sending || !textConfigured" aria-label="发送消息"><Icon name="send" :size="20" /></button></div></form><div class="composer-hint">Enter 发送 · Shift + Enter 换行<span>故事由你与 AI 共同创作，请独立判断回复。</span></div></div>
          </section>

          <section v-else-if="view === 'gallery'" class="page-content gallery-view"><div class="page-intro"><span class="eyebrow">MOMENTS MADE VISIBLE</span><h1>把想象，留在这里。</h1><p>每一张图片，都连着一个值得记住的故事。</p></div><div class="section-heading"><h2>所有画面 <span>{{ state.assets.length }}</span></h2><span class="muted small-text">默认下载不含内部工作流元数据</span></div><div v-if="state.assets.length" class="gallery-grid"><article v-for="asset in state.assets" :key="asset.id" class="gallery-card"><button class="gallery-image-button" @click="lightbox = asset"><img :src="`/api/v1/media/${asset.id}`" :alt="asset.prompt" loading="lazy" /><span><Icon name="arrow" :size="20" />查看画面</span></button><div><span>{{ characterName(asset.characterId) }}</span><button class="icon-button" aria-label="下载图片" @click="download(asset)"><Icon name="download" :size="16" /></button><p>{{ asset.prompt }}</p><small>{{ formatTime(asset.createdAt) }} · {{ asset.width }} × {{ asset.height }}</small></div></article></div><div v-else class="empty-state gallery-empty"><div class="empty-visual"><Icon name="image" :size="44" /><span>✧</span></div><h2>第一幅画面，还在你的想象里。</h2><p>去工作台写下画面描述，<br />你的创作会被妥善保存在这里。</p><button class="button secondary" @click="navigate('chat')">去创作<Icon name="arrow" :size="16" /></button></div></section>

          <section v-else-if="view === 'jobs'" class="page-content jobs-view"><div class="page-intro"><span class="eyebrow">A LITTLE PATIENCE, A NEW WORLD</span><h1>灵感正在发生。</h1><p>任务在后端持续执行。切换页面，不会打断一幅画的诞生。</p></div><div class="queue-stats"><div><span class="status-dot online"></span><strong>{{ pendingJobs.length }}</strong><span>等待与执行</span></div><div><strong>{{ state.jobs.filter(job => job.status === 'succeeded').length }}</strong><span>已经成像</span></div><span>单任务执行 · 刷新可恢复</span></div><div v-if="!state.jobs.length" class="empty-state"><Icon name="queue" :size="36" /><h2>此刻，队列很安静。</h2><p>去工作台提交你的第一个创作。</p><button class="button secondary" @click="navigate('chat')">开始创作<Icon name="arrow" :size="16" /></button></div><div v-else class="job-list"><article v-for="job in state.jobs" :key="job.id" class="job-card"><div class="job-symbol" :class="job.status"><Icon :name="job.status === 'succeeded' ? 'check' : job.status === 'failed' ? 'info' : 'image'" :size="24" /></div><div class="job-details"><div class="job-top"><h3>{{ characterName(job.characterId) }}<span class="job-status" :class="job.status">{{ job.phase }}</span></h3><time>{{ formatTime(job.createdAt) }}</time></div><p>{{ job.prompt }}</p><div v-if="!terminal(job)" class="progress-track"><span :style="{ width: `${job.progress ?? 5}%` }" /></div><small>1024 × 1024 · Seed {{ job.seed }}<span v-if="job.progress !== null"> · 采样 {{ job.progress }}%</span></small><p v-if="job.error" class="job-error">{{ job.error }}</p></div><div class="job-actions"><button v-if="job.needsAttention || job.status === 'reconciling' || job.status === 'cancel_requested'" class="button secondary small" @click="checkImageConnection">检查连接</button><button v-if="!terminal(job) && (job.needsAttention || job.status === 'reconciling' || job.status === 'cancel_requested')" class="button secondary small" @click="resolveJob(job)">停止追踪</button><button v-if="job.status === 'failed' || job.status === 'cancelled'" :disabled="!!recoveringJob" class="button secondary small" @click="retryJob(job)">{{ recoveringJob === job.id ? '检查服务…' : '按原参数重试' }}</button><button v-if="!terminal(job) && job.status !== 'cancel_requested'" class="button ghost small" @click="cancelJob(job)">取消</button><button v-if="job.assetId" class="button secondary small" @click="lightbox = state.assets.find(asset => asset.id === job.assetId)">查看<Icon name="arrow" :size="14" /></button></div></article></div></section>

          <SettingsView v-else-if="view === 'settings'" :settings="state.settings" @saved="settingsSaved" @notify="notify" />
        </main>
        <ImagePanel v-if="view === 'chat' || view === 'characters'" :class="{ 'mobile-open': imagePanelOpen }" :character="activeCharacter" :chat-id="view === 'chat' ? activeChat?.id : undefined" :chat-revision="activeChat?.revision" :inference-request="inferenceRequest" :assets="state.assets" :chatting="isStreaming || sending" :source="view === 'chat' ? sourceMessage : undefined" :jobs="state.jobs" :settings="state.settings" :connected="!!status?.comfy.online" :busy="creatingImage" @generate="generateImage" @edit-character="editCharacter(activeCharacter)" @chat-saved="upsert(state.chats, $event)" @notify="notify" @settings="navigate('settings')" @queue="navigate('jobs')" @clear-source="sourceMessage = undefined" @close="imagePanelOpen = false" />
      </div>
    </div>
    <input ref="uploadInput" class="visually-hidden" type="file" accept=".json,.png" aria-label="导入角色卡文件" @change="importCard" />
  </div>
  <CharacterModal v-if="showEditor" :character="editingCharacter" :assets="state?.assets" :saving="saving" @close="showEditor = false" @save="saveCharacter" />
  <div v-if="lightbox" class="modal-backdrop" @click.self="lightbox = undefined" @keydown.esc="lightbox = undefined"><section class="modal lightbox" role="dialog" aria-modal="true" aria-label="查看生成图片" tabindex="-1"><button class="icon-button lightbox-close" aria-label="关闭图片" autofocus @click="lightbox = undefined"><Icon name="close" /></button><img :src="`/api/v1/media/${lightbox.id}`" :alt="lightbox.prompt" /><div class="lightbox-info"><span class="eyebrow">{{ characterName(lightbox.characterId) }}</span><p>{{ lightbox.prompt }}</p><div><span>{{ lightbox.width }} × {{ lightbox.height }} · Seed {{ lightbox.seed }}</span><button class="button primary small" @click="download(lightbox)"><Icon name="download" :size="15" />下载图片</button></div></div></section></div>
  <Transition name="toast"><div v-if="toast" class="toast-message" role="status"><Icon name="info" :size="18" /><span>{{ toast }}</span><button class="icon-button" aria-label="关闭提示" @click="toast = ''"><Icon name="close" :size="15" /></button></div></Transition>
</template>
