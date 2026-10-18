<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import type { Asset, Character, CharacterInput, VisualProfile } from '@tavern/contracts';
import Icon from './Icon.vue';
import ReferencePicker from './ReferencePicker.vue';

const props = defineProps<{ character?: Character; saving: boolean; assets?: Asset[] }>();
const emit = defineEmits<{ close: []; save: [input: CharacterInput] }>();
const draft = reactive<CharacterInput>({ name: '', tagline: '', description: '', personality: '', scenario: '', firstMessage: '', appearance: '', tags: [], color: 'sage', ...(props.character ?? {}) });
const tags = ref(draft.tags.join('，'));
const visual = reactive<VisualProfile>({ identity: props.character?.appearance ?? '', outfit: '', ...props.character?.visual });
const uploads = ref(0);
const dialog = ref<HTMLElement>();
const previousFocus = document.activeElement as HTMLElement | null;
onMounted(() => dialog.value?.querySelector<HTMLInputElement>('input')?.focus());
onUnmounted(() => previousFocus?.focus());
function submit() { if (uploads.value) return; emit('save', { ...draft, visual: { ...visual }, tags: tags.value.split(/[，,]/).map(tag => tag.trim()).filter(Boolean) }); }
function trap(event: KeyboardEvent) {
  if (event.key !== 'Tab') return;
  const elements = [...dialog.value!.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea')];
  const first = elements[0];
  const last = elements[elements.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="!saving && emit('close')" @keydown.esc="!saving && emit('close')">
    <section ref="dialog" class="modal character-modal" role="dialog" aria-modal="true" aria-labelledby="character-dialog-title" @keydown="trap">
      <header class="modal-header"><div><span class="eyebrow">CHARACTER STUDIO</span><h2 id="character-dialog-title">{{ character ? '编辑故事伙伴' : '创造一个新角色' }}</h2></div><button class="icon-button" :disabled="saving" aria-label="关闭角色编辑" @click="emit('close')"><Icon name="close" /></button></header>
      <form @submit.prevent="submit">
        <div class="form-grid">
          <label class="field">角色名称 <input v-model="draft.name" maxlength="80" required placeholder="每个故事，从一个名字开始" /></label>
          <label class="field">标签 <input v-model="tags" placeholder="自然，日常，慢叙事" /></label>
          <label class="field full">一句话介绍 <input v-model="draft.tagline" maxlength="160" placeholder="用一句话，让人想走进这个角色的世界" /></label>
          <label class="field full">角色描述 <textarea v-model="draft.description" rows="3" maxlength="12000" placeholder="身份、背景，以及 TA 相信的事……" /></label>
          <label class="field">性格 <textarea v-model="draft.personality" rows="3" maxlength="12000" placeholder="TA 如何思考、说话和回应？" /></label>
          <label class="field">故事场景 <textarea v-model="draft.scenario" rows="3" maxlength="12000" placeholder="你们第一次相遇的地方" /></label>
          <label class="field full">开场白 <textarea v-model="draft.firstMessage" rows="3" maxlength="12000" placeholder="新对话中，TA 对你说的第一句话" /></label>
          <label class="field full">原始外貌描述 <textarea v-model="draft.appearance" rows="2" maxlength="4000" placeholder="保留角色卡中的外貌信息" /></label>
          <label class="field full">固定身份与体型 <textarea v-model="visual.identity" rows="3" maxlength="2000" placeholder="脸型、五官、肤色、体型比例与稳定辨识特征。服装填写在下方。" /></label>
          <label class="field full">默认服装 <textarea v-model="visual.outfit" rows="2" maxlength="2000" placeholder="款式、颜色、材质、鞋子及配饰；新会话沿用这套服装。" /><span class="field-hint">已有会话的服装在生图面板确认换装，不会被默认服装修改覆盖。</span></label>
          <div class="field full"><span>角色定妆参考 · 保存角色后生效</span><div class="reference-grid"><ReferencePicker v-for="slot in (['face', 'body', 'outfit'] as const)" :key="slot" v-model="visual[`${slot}AssetId`]" :character-id="character?.id" :assets="assets" :label="{ face: '面部参考', body: '全身参考', outfit: '默认服装参考' }[slot]" @busy="uploads += $event ? 1 : -1" /></div><span class="field-hint">使用同一人物、同一种画风。全身图少遮挡；参考图不自动替换为后续生成图。支持非交错 PNG，最大 8MB、4096 像素边长。</span></div>
          <div class="field full">角色配色<div class="color-picker"><button v-for="color in ['sage', 'amber', 'violet', 'rose']" :key="color" type="button" class="color-swatch" :class="[color, { selected: draft.color === color }]" :aria-label="`选择 ${color} 配色`" :aria-pressed="draft.color === color" @click="draft.color = color"><Icon v-if="draft.color === color" name="check" :size="16" /></button></div></div>
        </div>
        <footer class="modal-footer"><span>角色数据仅保存在本机</span><button type="button" class="button ghost" :disabled="saving" @click="emit('close')">取消</button><button class="button primary" :disabled="saving || uploads > 0">{{ saving ? '保存中…' : uploads ? '等待图片上传…' : '保存角色' }}<Icon name="check" :size="16" /></button></footer>
      </form>
    </section>
  </div>
</template>
