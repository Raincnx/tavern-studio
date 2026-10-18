<script setup lang="ts">
import type { SceneFact, SceneState } from '@tavern/contracts';
const state = defineModel<SceneState>({ required: true });
const emit = defineEmits<{ change: [] }>();
const fields = [{ key: 'position', label: '位置与朝向' }, { key: 'action', label: '动作与姿势' }, { key: 'expression', label: '表情' }, { key: 'outfit', label: '服装款式' }, { key: 'wearing', label: '穿着状态' }, { key: 'appearance', label: '发型、妆容与配饰状态' }, { key: 'props', label: '手持道具' }] as const;
const globalFields = [{ key: 'setting', label: '时间、地点与光线' }, { key: 'camera', label: '景别与视角' }, { key: 'interaction', label: '接触与遮挡关系' }] as const;
const labels = { explicit: '剧情明确', inherited: '沿用此前', uncertain: '待确认', manual: '手动指定' };
function edited(fact: SceneFact) { fact.basis = 'manual'; delete fact.sourceMessageId; emit('change'); }
const empty = (): SceneFact => ({ value: '', basis: 'manual' });
function addPerson() {
  state.value.people.push({ id: crypto.randomUUID(), name: '另一位人物', inFrame: true, position: empty(), action: empty(), expression: empty(), outfit: empty(), wearing: empty(), appearance: empty(), props: empty() });
  emit('change');
}
</script>

<template>
  <section class="scene-editor">
    <h3>当前画面状态</h3>
    <p>入镜 {{ state.people.filter(person => person.inFrame).length }} 人。可逐项修改；旧参考图不锁定表情、动作和穿着状态。</p>
    <details><summary>稳定身份</summary><label class="field">仅保留五官与自然身体特征<textarea v-model="state.identity" rows="3" maxlength="1600" @input="emit('change')" /></label></details>
    <label v-for="field in globalFields" :key="field.key" class="field">{{ field.label }}<small>{{ labels[state[field.key].basis] }}</small><textarea v-model="state[field.key].value" rows="2" maxlength="800" @input="edited(state[field.key])" /></label>
    <details v-for="person in state.people" :key="person.id" open>
      <summary>{{ person.name }} · {{ person.inFrame ? '入镜' : '镜头外' }}</summary>
      <label class="field">称呼<input v-model="person.name" maxlength="80" @input="emit('change')" /></label>
      <label><input v-model="person.inFrame" type="checkbox" @change="emit('change')" /> 出现在镜头内</label>
      <label v-for="field in fields" :key="field.key" class="field">{{ field.label }}<small :title="person[field.key].sourceMessageId ? `来源消息：${person[field.key].sourceMessageId}` : '无明确剧情来源'">{{ labels[person[field.key].basis] }}</small><textarea v-model="person[field.key].value" rows="2" maxlength="800" @input="edited(person[field.key])" /></label>
      <button v-if="person.id !== 'main'" class="text-button" @click="state.people = state.people.filter(item => item.id !== person.id); emit('change')">移除此人物</button>
    </details>
    <button v-if="state.people.length < 4" class="text-button" @click="addPerson">添加人物</button>
  </section>
</template>

<style scoped>
.scene-editor { margin: 16px 0; padding: 12px; border: 1px solid var(--line); border-radius: 8px; }
h3 { font-size: 13px; margin: 0 0 8px; }
p, small { color: var(--muted); font-size: 11px; line-height: 1.6; }
details { margin: 12px 0; } summary { cursor: pointer; font-size: 12px; margin-bottom: 10px; }
.field { margin-top: 10px; } textarea { width: 100%; min-height: 48px; resize: vertical; }
</style>
