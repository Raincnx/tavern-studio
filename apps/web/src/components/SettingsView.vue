<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import type { Settings } from '@tavern/contracts';
import { api } from '../api.ts';
import Icon from './Icon.vue';

const props = defineProps<{ settings: Settings }>();
const emit = defineEmits<{ saved: [settings: Settings]; notify: [message: string] }>();
const draft = reactive({ ...props.settings, textProtocol: props.settings.textProtocol ?? 'openai', textReasoningEffort: props.settings.textReasoningEffort ?? 'default' });
const apiKey = ref('');
const busy = ref(false);
const models = ref<string[]>([]);
const adding = ref(false);
watch(() => props.settings, value => {
  if (!adding.value) {
    if (draft.activeTextProfileId !== value.activeTextProfileId) { apiKey.value = ''; models.value = []; }
    Object.assign(draft, value, { textProtocol: value.textProtocol ?? 'openai' });
  }
});
function addModel() {
  adding.value = true;
  Object.assign(draft, { textProtocol: 'openai', textPresetJson: '', textPresetName: '', textSystemPrompt: '', textReasoningEffort: 'default', textProfileName: '', textUrl: '', textModel: '', allowCloud: false, temperature: 0.8, maxTokens: 1024, contextWindow: 8192, hasApiKey: false });
  apiKey.value = ''; models.value = [];
}
function cancelAdd() { adding.value = false; Object.assign(draft, props.settings, { textProtocol: props.settings.textProtocol ?? 'openai' }); apiKey.value = ''; models.value = []; }
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
async function importPreset(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    if (file.size > 2000000) throw new Error('预设文件超过 2 MB');
    const raw = await file.text();
    const preset = JSON.parse(raw);
    if (!Array.isArray(preset.prompts) || !Array.isArray(preset.prompt_order)) throw new Error('需要 SillyTavern JSON 预设');
    Object.assign(draft, { textPresetJson: raw, textPresetName: file.name.replace(/\.json$/i, ''), textSystemPrompt: '', temperature: preset.temperature ?? draft.temperature, maxTokens: preset.openai_max_tokens ?? draft.maxTokens, contextWindow: preset.openai_max_context ?? draft.contextWindow, textReasoningEffort: preset.reasoning_effort ?? 'default' });
    emit('notify', `已读取 ${preset.prompts.length} 个条目，点击保存后生效；原始开关和顺序保留。`);
  } catch (error) { emit('notify', error instanceof Error ? error.message : '导入失败'); }
  finally { input.value = ''; }
}
function exportPreset() {
  const url = URL.createObjectURL(new Blob([draft.textPresetJson ?? ''], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `${draft.textPresetName || 'preset'}.json`; link.click(); URL.revokeObjectURL(url);
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
      <section class="settings-card"><header><div class="settings-icon"><Icon name="chat" /></div><div><h2>文本模型</h2><p>支持 OpenAI 兼容和 Claude 原生流式接口</p></div><span class="subtle-badge">显式连接</span></header>
        <div class="settings-actions"><label class="field">当前模型<select :value="settings.activeTextProfileId" :disabled="busy || adding" @change="switchModel"><option v-for="profile in settings.textProfiles" :key="profile.id" :value="profile.id">{{ profile.name }} · {{ profile.textModel || '未配置' }}</option></select></label><button type="button" class="button secondary" :disabled="busy || adding" @click="addModel">新增模型</button><button v-if="adding" type="button" class="text-button" :disabled="busy" @click="cancelAdd">取消新增</button></div><p class="field-hint">每套配置独立保存密钥和参数。选择后用于聊天与画面推断，已有对话会继续保留。</p><div class="form-grid"><label class="field full">接口协议<select v-model="draft.textProtocol"><option value="openai">OpenAI 兼容 · Chat Completions</option><option value="anthropic">Claude 原生 · Anthropic Messages</option></select></label><label class="field full">配置名称<input v-model="draft.textProfileName" maxlength="80" placeholder="例如：智谱日常、本地模型" /></label><label class="field full">API 基础地址<input v-model="draft.textUrl" placeholder="http://127.0.0.1:1234/v1" /><span class="field-hint">填写基础地址（例如 https://anyrouter.top/v1）；不包含 /messages 或 /chat/completions。Claude 原生使用 API Key / Auth Token，密钥按配置隔离保存。</span></label><label class="field">模型名称<input v-model="draft.textModel" list="text-models" placeholder="接口支持的完整模型 ID" /><datalist id="text-models"><option v-for="model in models" :key="model" :value="model" /></datalist></label><label class="field">API Key · 本机保存<input v-model="apiKey" type="password" autocomplete="off" :placeholder="!adding && settings.hasApiKey ? '已配置，留空保留' : '本地服务通常可留空'" /></label><label class="field">思考级别<select v-model="draft.textReasoningEffort"><option value="default">模型默认</option><option value="minimal">极低（minimal）</option><option value="low">低（low）</option><option value="medium">中（medium）</option><option value="high">高（high）</option></select><span class="field-hint">Claude Opus/Sonnet 4.6：低、中、高会开启自适应思考；极低按低处理，模型默认不主动开启。状态整理与画面提取单独关闭思考。其他型号需支持相应参数。</span></label><label class="field">最大输出 token<input v-model.number="draft.maxTokens" type="number" min="64" max="131072" /></label><label class="field">上下文长度<input v-model.number="draft.contextWindow" type="number" min="2048" max="1048576" /></label><label class="field full">回复温度 <span class="range-value">{{ draft.temperature.toFixed(1) }}</span><input v-model.number="draft.temperature" type="range" min="0" max="2" step="0.1" /></label></div>
        <details><summary>聊天预设{{ draft.textPresetName ? ' · ' + draft.textPresetName : '（未设置）' }}</summary><label class="field">预设名称<input v-model="draft.textPresetName" maxlength="120" placeholder="例如：细腻日常叙事" /></label><label class="field">导入完整 SillyTavern JSON<input type="file" accept=".json,application/json" :disabled="busy" @change="importPreset" /></label><template v-if="draft.textPresetJson"><p class="field-hint">已保存完整原始 JSON。聊天按照原始开关、顺序和变量宏编排，不使用下方精简规则。此文件不包含 MVU 插件和世界书；目前不执行 MVU 写回、脚本、群聊／续写专用操作，也不展示接口 reasoning_content。原字段保留用于导出，不代表这些功能已生效。</p><button class="button secondary" type="button" @click="exportPreset">导出完整原文件</button><button class="text-button" type="button" @click="draft.textPresetJson = ''">移除完整预设</button><label class="field">原始 JSON<textarea v-model="draft.textPresetJson" rows="12" maxlength="500000" spellcheck="false" /></label></template><label v-else class="field">叙事规则<textarea v-model="draft.textSystemPrompt" maxlength="40000" rows="12" placeholder="填写文风、视角、剧情节奏与角色行为规则。清空后恢复默认聊天。" /></label><p class="field-hint">随当前模型独立保存，只用于聊天，不影响画面状态推断。支持 <code v-pre>{{char}}</code> 和 <code v-pre>{{user}}</code> 占位符；不执行脚本或 MVU 变量写回。</p></details>
        <p class="field-hint">上下文仍按保守的 UTF-8 字节预算裁剪；设置更大窗口不等于自动获得长期记忆。DeepSeek 思考模式下温度不生效。</p>
        <label class="checkbox-field"><input v-model="draft.allowCloud" type="checkbox" /><span>允许我配置的 HTTPS 云端文本服务<small>开启后，对话和你主动生成的画面草稿素材可能发送到该服务；不自动切换供应端。</small></span></label>
        <div class="settings-actions"><button type="button" class="button secondary" :disabled="busy" @click="test('text')"><Icon name="refresh" :size="15" />保存并测试连接</button><button v-if="!adding && settings.hasApiKey" type="button" class="text-button" :disabled="busy" @click="clearKey">清除已保存密钥</button><span>密钥保存在本机，服务重启后自动恢复；留空保留已有密钥。</span></div>
      </section>
      <section class="settings-card"><header><div class="settings-icon"><Icon name="image" /></div><div><h2>本地图像模型</h2><p>复用现有 ComfyUI 与 Qwen-Image-2.1 标准工作流</p></div><span class="subtle-badge">本机推理</span></header><label class="field">ComfyUI 地址<input v-model="draft.comfyUrl" placeholder="http://127.0.0.1:8188" /><span class="field-hint">只允许 loopback 地址；应用不会自动启动服务或下载模型。</span></label><div class="config-summary"><span>1024 × 1024</span><span>25 steps</span><span>CFG 1</span><span>Euler / simple</span></div><div class="settings-actions"><button type="button" class="button secondary" :disabled="busy" @click="test('comfy')"><Icon name="refresh" :size="15" />保存并测试工作流</button><span>离线时已创建的任务会保留在队列。</span></div></section>
      <section class="settings-card license-card"><header><div class="settings-icon"><Icon name="info" /></div><div><h2>许可与数据边界</h2><p>继续之前，请确认实际使用场景。</p></div></header><p>当前 Qwen-Image-2.1 权重采用 Qwen Research 许可。不能将免费或个人使用自动视为已获授权，产品化与商用需要另行核对授权。</p><label class="checkbox-field"><input v-model="draft.researchUseConfirmed" type="checkbox" /><span>我已核对模型许可，确认本次研究/评估用途已获授权。<small>此确认不是新的模型授权，也不会替代适用许可条款。</small></span></label><p class="field-hint">首版仅支持本机单用户，不提供局域网访问与账号密码登录。聊天和提示词明文存储于本机数据库，请保护数据目录。</p></section>
      <div class="settings-bottom"><span><Icon name="check" :size="15" />不修改原酒馆配置，不触碰已有权重。</span><button class="button primary" :disabled="busy">{{ busy ? '处理中…' : adding ? '保存并使用新模型' : '保存设置' }}<Icon name="check" :size="16" /></button></div>
    </form>
  </section>
</template>
