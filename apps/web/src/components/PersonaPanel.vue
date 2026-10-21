<script setup lang="ts">
import { ref, watch } from 'vue';
import type { Chat, FramingMode, UserPersona } from '@tavern/contracts';
import { api } from '../api.ts';
import ReferencePicker from './ReferencePicker.vue';
const props = defineProps<{ chat: Chat; disabled?: boolean }>();
const emit = defineEmits<{ saved: [chat: Chat]; busy: [value: boolean] }>();
const personas = ref<UserPersona[]>([]), selected = ref('');
const draft = ref({ name: '', description: '', visual: { identity: '', outfit: '', faceAssetId: undefined as string | undefined, bodyAssetId: undefined as string | undefined } });
const framing = ref<FramingMode>('together');
const busy = ref(false), uploading = ref(false), editing = ref(false), error = ref(''), notice = ref('');
watch(() => props.chat.framing, value => { framing.value = value ?? 'together'; }, { immediate: true });
watch([busy, uploading], () => emit('busy', busy.value || uploading.value));
function select() {
  const p = props.chat.userPersona?.id === selected.value ? props.chat.userPersona : personas.value.find(p => p.id === selected.value);
  draft.value = { name: p?.name ?? '', description: p?.description ?? '', visual: { identity: p?.visual.identity ?? '', outfit: p?.visual.outfit ?? '', faceAssetId: p?.visual.faceAssetId, bodyAssetId: p?.visual.bodyAssetId } };
}
async function load() {
  try { personas.value = await api<UserPersona[]>('/personas'); selected.value = props.chat.userPersona?.id ?? ''; select(); error.value = ''; }
  catch (e) { error.value = e instanceof Error ? e.message : '读取失败'; }
}
async function save(edit = false) {
  if (busy.value || props.disabled) return;
  if ((!selected.value || edit) && !draft.value.name.trim()) { error.value = '请填写故事里的称呼'; return; }
  busy.value = true; error.value = ''; notice.value = '';
  try {
    const old = personas.value.find(p => p.id === selected.value);
    const chat = await api<Chat>(`/chats/${props.chat.id}/participants`, 'PUT', {
      switchIdentity: selected.value !== props.chat.userPersona?.id, expectedChatRevision: props.chat.revision, personaId: selected.value || undefined, framing: framing.value,
      ...(!selected.value || edit ? { persona: draft.value, expectedPersonaRevision: old?.revision } : {})
    });
    selected.value = chat.userPersona!.id;
    personas.value = [...personas.value.filter(p => p.id !== selected.value), chat.userPersona!];
    emit('saved', chat); notice.value = '已保存';
    if (!props.chat.userPersona) editing.value = false;
  } catch (e) { error.value = e instanceof Error ? e.message : '未保存，请重试'; }
  finally { busy.value = false; }
}
function autoSave() {
  const old = props.chat.userPersona;
  if (!old || selected.value !== old.id) return;
  const changed = draft.value.name !== old.name || draft.value.description !== old.description || Object.entries(draft.value.visual).some(([key, value]) => value !== old.visual[key as keyof typeof old.visual]);
  if (changed) void save(true);
}
function referenceChanged(role: 'faceAssetId' | 'bodyAssetId', value?: string) { draft.value.visual[role] = value; autoSave(); }
void load();
</script>

<template>
  <section class="persona-panel">
    <fieldset :disabled="disabled || busy || uploading">
      <template v-if="chat.userPersona">
        <div class="identity-row"><strong>故事里的你 · {{ chat.userPersona.name }}</strong><button class="text-button" @click="editing = !editing">{{ editing ? '收起资料' : '修改资料' }}</button></div>
        <label class="field">镜头<select v-model="framing" @change="save()"><option value="auto">跟随剧情</option><option value="together">双人同框</option><option value="pov">我的视角</option></select></label>
      </template>
      <template v-else>
        <button v-if="!editing" class="button secondary small" @click="editing = true">让故事里的我入镜</button>
        <p v-if="!editing">只需介绍一次自己，以后的故事会记住。</p>
        <template v-if="editing">
          <strong>故事里的你是谁？</strong>
          <label v-if="personas.length" class="field">使用身份<select v-model="selected" @change="select"><option value="">介绍一个新身份</option><option v-for="p in personas" :key="p.id" :value="p.id">{{ p.name }}</option></select></label>
        </template>
      </template>
      <div v-if="editing">
        <label v-if="chat.userPersona" class="field">使用身份<select v-model="selected" @change="select"><option value="">介绍一个新身份</option><option v-for="p in personas" :key="p.id" :value="p.id">{{ p.name }}</option></select></label>
        <template v-if="selected === chat.userPersona?.id || !selected">
          <label class="field">称呼<input v-model="draft.name" maxlength="80" @blur="autoSave" /></label>
          <label class="field">简单介绍自己<textarea v-model="draft.description" maxlength="4000" rows="2" placeholder="例如：成年旅行者，喜欢读书，与店主是旧识" @blur="autoSave" /></label>
          <details><summary>外貌与参考图（可选）</summary>
            <label class="field">稳定外貌<textarea v-model="draft.visual.identity" maxlength="2000" rows="2" @blur="autoSave" /></label>
            <label class="field">初始服装<textarea v-model="draft.visual.outfit" maxlength="2000" rows="2" @blur="autoSave" /></label>
            <template v-if="chat.userPersona && selected === chat.userPersona.id">
              <ReferencePicker :model-value="draft.visual.faceAssetId" :persona-id="selected" label="我的面部参考" @update:model-value="referenceChanged('faceAssetId', $event)" @busy="uploading = $event" />
              <ReferencePicker :model-value="draft.visual.bodyAssetId" :persona-id="selected" label="我的全身参考" @update:model-value="referenceChanged('bodyAssetId', $event)" @busy="uploading = $event" />
            </template>
            <p v-else>开始后可随时添加参考照片。</p>
          </details>
        </template>
        <p v-if="chat.userPersona && selected === chat.userPersona.id">离开输入框后自动保存，影响后续聊天与生图；历史图片保持原样。新故事沿用此身份和镜头。</p>
        <template v-else><p v-if="chat.userPersona">更换身份只影响后续对话和画面，历史记录不会改写。</p><button class="button secondary small" @click="save()">{{ chat.userPersona ? '从现在起使用这个身份' : '以这个身份开始' }}</button></template>
      </div>
    </fieldset>
    <p v-if="busy" role="status">正在保存…</p><p v-else-if="error" role="alert">未保存：{{ error }} <button class="text-button" @click="save(!!chat.userPersona)">重试</button> <button class="text-button" @click="load">重新载入</button></p><p v-else-if="notice" role="status">{{ notice }}</p>
  </section>
</template>
<style scoped>
.persona-panel { margin: 12px 0; padding: 12px; border: 1px solid var(--line); border-radius: 8px; }
fieldset { border: 0; padding: 0; min-width: 0; } .identity-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 13px; }
p { font-size: 12px; line-height: 1.7; color: var(--muted); } .field { margin-top: 12px; } select, input, textarea { width: 100%; } summary { margin-top: 12px; cursor: pointer; font-size: 12px; }
</style>

