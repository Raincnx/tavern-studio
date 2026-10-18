<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import type { Settings } from '@tavern/contracts';
import { api } from '../api.ts';
import Icon from './Icon.vue';

const props = defineProps<{ settings: Settings }>();
const emit = defineEmits<{ saved: [settings: Settings]; notify: [message: string] }>();
const draft = reactive({ ...props.settings, textReasoningEffort: props.settings.textReasoningEffort ?? 'default' });
const apiKey = ref('');
const busy = ref(false);
const models = ref<string[]>([]);
const adding = ref(false);
watch(() => props.settings, value => {
  if (!adding.value) {
    if (draft.activeTextProfileId !== value.activeTextProfileId) { apiKey.value = ''; models.value = []; }
    Object.assign(draft, value);
  }
});
function addModel() {
  adding.value = true;
  Object.assign(draft, { textReasoningEffort: 'default', textProfileName: '', textUrl: '', textModel: '', allowCloud: false, temperature: 0.8, maxTokens: 1024, contextWindow: 8192, hasApiKey: false });
  apiKey.value = ''; models.value = [];
}
function cancelAdd() { adding.value = false; Object.assign(draft, props.settings); apiKey.value = ''; models.value = []; }
async function switchModel(event: Event) {
  const select = event.target as HTMLSelectElement;
  busy.value = true;
  try {
    const result = await api<Settings>(`/text-models/${select.value}/activate`, 'POST', {});
    Object.assign(draft, result); apiKey.value = ''; models.value = []; emit('saved', result);
    emit('notify', `已切换到 ${result.textProfileName}`);
  } catch (error) { select.value = props.settings.activeTextProfileId ?? ''; emit('notify', error instanceof Error ? error.message : '切换失败'); }
  finally { busy.value = false; }
}
async function save(notify = true): Promise<boolean> {
  busy.value = true;
  try { const result = await api<Settings>(adding.value ? '/text-models' : '/settings', adding.value ? 'POST' : 'PUT', { ...draft, apiKey: apiKey.value || undefined }); adding.value = false; Object.assign(draft, result); apiKey.value = ''; emit('saved', result); if (notify) emit('notify', '设置已保存，当前模型已就绪'); return true; }
  catch (error) { emit('notify', error instanceof Error ? error.message : '保存失败'); return false; }
  finally { busy.value = false; }
}
async function test(kind: 'text' | 'comfy') {
  if (!(await save(false))) return;
  busy.value = true;
  try { const result = await api<{ models?: string[] }>(`/connections/${kind}/test`, 'POST', {}); models.value = result.models ?? []; emit('notify', kind === 'comfy' ? 'ComfyUI 已连接，所需节点可用' : `文本接口已连接，发现 ${models.value.length} 个模型`); }
  catch (error) { emit('notify', error instanceof Error ? error.message : '连接失败'); }
  finally { busy.value = false; }
}
async function clearKey() {
  busy.value = true;
  try { emit('saved', await api<Settings>('/settings', 'PUT', { ...props.settings, clearApiKey: true })); apiKey.value = ''; emit('notify', '当前配置的密钥已清除'); }
  catch (error) { emit('notify', error instanceof Error ? error.message : '清除失败'); }
  finally { busy.value = false; }
}
</script>

<template>
  <section class="settings-view page-content">
    <div class="page-intro"><span class="eyebrow">MAKE IT YOURS</span><h1>给灵感，接上引擎。</h1><p>连接你选择的模型。数据的去向，始终由你决定。</p></div>
    <form class="settings-form" @submit.prevent="save()">
      <section class="settings-card"><header><div class="settings-icon"><Icon name="chat" /></div><div><h2>文本模型</h2><p>支持 SSE 流式回复的 Chat Completions 兼容接口</p></div><span class="subtle-badge">显式连接</span></header>
        <div class="settings-actions"><label class="field">当前模型<select :value="settings.activeTextProfileId" :disabled="busy || adding" @change="switchModel"><option v-for="profile in settings.textProfiles" :key="profile.id" :value="profile.id">{{ profile.name }} · {{ profile.textModel || '未配置' }}</option></select></label><button type="button" class="button secondary" :disabled="busy || adding" @click="addModel">新增模型</button><button v-if="adding" type="button" class="text-button" :disabled="busy" @click="cancelAdd">取消新增</button></div><p class="field-hint">每套配置独立保存密钥和参数。选择后用于聊天与画面推断，已有对话会继续保留。</p><div class="form-grid"><label class="field full">配置名称<input v-model="draft.textProfileName" maxlength="80" placeholder="例如：智谱日常、本地模型" /></label><label class="field full">API 基础地址<input v-model="draft.textUrl" placeholder="http://127.0.0.1:1234/v1" /><span class="field-hint">填写供应商提供的 Chat Completions 基础地址，不包含 /chat/completions。</span></label><label class="field">模型名称<input v-model="draft.textModel" list="text-models" placeholder="接口支持的完整模型 ID" /><datalist id="text-models"><option v-for="model in models" :key="model" :value="model" /></datalist></label><label class="field">API Key · 本机保存<input v-model="apiKey" type="password" autocomplete="off" :placeholder="!adding && settings.hasApiKey ? '已配置，留空保留' : '本地服务通常可留空'" /></label><label class="field">思考级别<select v-model="draft.textReasoningEffort"><option value="default">模型默认</option><option value="minimal">极低（minimal）</option><option value="low">低（low）</option><option value="medium">中（medium）</option><option value="high">高（high）</option></select><span class="field-hint">需模型支持；Gemini 3.8 Flash 最低为 low。</span></label><label class="field">最大输出 token<input v-model.number="draft.maxTokens" type="number" min="64" max="4096" /></label><label class="field">上下文长度<input v-model.number="draft.contextWindow" type="number" min="2048" max="131072" /></label><label class="field full">回复温度 <span class="range-value">{{ draft.temperature.toFixed(1) }}</span><input v-model.number="draft.temperature" type="range" min="0" max="2" step="0.1" /></label></div>
        <label class="checkbox-field"><input v-model="draft.allowCloud" type="checkbox" /><span>允许我配置的 HTTPS 云端文本服务<small>开启后，对话和你主动生成的画面草稿素材可能发送到该服务；不自动切换供应端。</small></span></label>
        <div class="settings-actions"><button type="button" class="button secondary" :disabled="busy" @click="test('text')"><Icon name="refresh" :size="15" />保存并测试连接</button><button v-if="!adding && settings.hasApiKey" type="button" class="text-button" :disabled="busy" @click="clearKey">清除已保存密钥</button><span>密钥保存在本机，服务重启后自动恢复；留空保留已有密钥。</span></div>
      </section>
      <section class="settings-card"><header><div class="settings-icon"><Icon name="image" /></div><div><h2>本地图像模型</h2><p>复用现有 ComfyUI 与 Qwen-Image-2.1 标准工作流</p></div><span class="subtle-badge">本机推理</span></header><label class="field">ComfyUI 地址<input v-model="draft.comfyUrl" placeholder="http://127.0.0.1:8188" /><span class="field-hint">只允许 loopback 地址；应用不会自动启动服务或下载模型。</span></label><div class="config-summary"><span>1024 × 1024</span><span>25 steps</span><span>CFG 1</span><span>Euler / simple</span></div><div class="settings-actions"><button type="button" class="button secondary" :disabled="busy" @click="test('comfy')"><Icon name="refresh" :size="15" />保存并测试工作流</button><span>离线时已创建的任务会保留在队列。</span></div></section>
      <section class="settings-card license-card"><header><div class="settings-icon"><Icon name="info" /></div><div><h2>许可与数据边界</h2><p>继续之前，请确认实际使用场景。</p></div></header><p>当前 Qwen-Image-2.1 权重采用 Qwen Research 许可。不能将免费或个人使用自动视为已获授权，产品化与商用需要另行核对授权。</p><label class="checkbox-field"><input v-model="draft.researchUseConfirmed" type="checkbox" /><span>我已核对模型许可，确认本次研究/评估用途已获授权。<small>此确认不是新的模型授权，也不会替代适用许可条款。</small></span></label><p class="field-hint">首版仅支持本机单用户，不提供局域网访问与账号密码登录。聊天和提示词明文存储于本机数据库，请保护数据目录。</p></section>
      <div class="settings-bottom"><span><Icon name="check" :size="15" />不修改原酒馆配置，不触碰已有权重。</span><button class="button primary" :disabled="busy">{{ busy ? '处理中…' : adding ? '保存并使用新模型' : '保存设置' }}<Icon name="check" :size="16" /></button></div>
    </form>
  </section>
</template>
