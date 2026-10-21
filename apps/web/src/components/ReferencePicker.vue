<script setup lang="ts">
import { ref } from 'vue';
import type { Asset } from '@tavern/contracts';
import { api } from '../api.ts';

const props = defineProps<{ characterId?: string; personaId?: string; modelValue?: string; label: string; assets?: Asset[] }>();
const emit = defineEmits<{ 'update:modelValue': [value: string | undefined]; busy: [value: boolean] }>();
const uploading = ref(false);
const error = ref('');
async function upload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || (!props.characterId && !props.personaId)) return;
  uploading.value = true; emit('busy', true); error.value = '';
  try {
    if (file.size > 8 * 1024 * 1024) throw new Error('请选择 8MB 以内的 PNG');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    const asset = await api<Asset>(props.personaId ? `/personas/${props.personaId}/references` : `/characters/${props.characterId}/references`, 'POST', { pngBase64: btoa(binary) });
    emit('update:modelValue', asset.id);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '上传失败'; }
  finally { uploading.value = false; emit('busy', false); input.value = ''; }
}
</script>

<template>
  <div class="reference-picker">
    <strong>{{ label }}</strong>
    <img v-if="modelValue" :src="`/api/v1/media/${modelValue}`" :alt="label" />
    <div v-else class="reference-empty">尚未选择</div>
    <label class="button secondary small">{{ uploading ? '上传中…' : '上传 PNG' }}<input class="visually-hidden" type="file" accept="image/png,.png" :aria-label="`上传${label}`" :disabled="(!characterId && !personaId) || uploading" @change="upload" /></label>
    <select v-if="assets?.some(asset => asset.characterId === characterId)" :aria-label="`从图库选择${label}`" :value="modelValue ?? ''" :disabled="uploading" @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value || undefined)">
      <option value="">从本角色图库选择</option>
      <option v-if="modelValue && !assets.some(asset => asset.id === modelValue)" :value="modelValue">当前上传的参考图</option>
      <option v-for="asset in assets.filter(item => item.characterId === characterId)" :key="asset.id" :value="asset.id">{{ asset.prompt.slice(0, 35) || '角色图片' }}</option>
    </select>
    <button v-if="modelValue" type="button" class="text-button" :disabled="uploading" @click="emit('update:modelValue', undefined)">取消选用</button>
    <small v-if="!characterId && !personaId">先保存资料，再添加参考图。</small>
    <small v-if="error" role="alert">{{ error }}</small>
  </div>
</template>
