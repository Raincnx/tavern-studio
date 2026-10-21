import { anthropicGenerate, anthropicBase, anthropicHeaders } from './anthropic.ts';
import { parseChatPreset } from './chat-preset.ts';
import { sceneOutputSchema } from './scene.ts';
import type { Settings } from '@tavern/contracts';

export interface ProviderMessage { role: 'system' | 'user' | 'assistant'; content: string }

/** Transport for providers implementing the Chat Completions protocol. */
export class ChatCompletionsAdapter {
  async generate(settings: Settings, apiKey: string, messages: ProviderMessage[], stream: boolean, signal: AbortSignal, jsonObject = false): Promise<Response> {
    if (settings.textProtocol === 'anthropic') return anthropicGenerate(settings, apiKey, messages, stream, signal, jsonObject);
    const google = new URL(settings.textUrl).hostname === 'generativelanguage.googleapis.com';
    const deepseek = new URL(settings.textUrl).hostname === 'api.deepseek.com';
    const preset = stream && settings.textPresetJson ? parseChatPreset(settings.textPresetJson) : undefined;
    const sampling = preset && deepseek ? { top_p: preset.top_p, frequency_penalty: preset.frequency_penalty, presence_penalty: preset.presence_penalty } : {};
    const effort = settings.textReasoningEffort;
    const localDraft = !stream && settings.textModel === 'cyber-tiel' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(settings.textUrl).hostname);
    const thinking = deepseek && jsonObject && !stream ? { thinking: { type: 'disabled' } } : effort && effort !== 'default'
      ? google ? { extra_body: { google: { thinking_config: { thinking_level: effort } } } } : { reasoning_effort: effort }
      : {};
    return fetch(`${settings.textUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model: settings.textModel, messages, stream, ...sampling, ...(jsonObject && deepseek ? { response_format: { type: 'json_object' } } : {}), ...(jsonObject && localDraft ? { response_format: { type: 'json_object', schema: sceneOutputSchema } } : {}), ...(!(google && settings.textModel.startsWith('gemini-3')) ? { temperature: settings.temperature } : {}), max_tokens: settings.maxTokens, ...thinking, ...(localDraft ? { chat_template_kwargs: { enable_thinking: false } } : {}), ...(!stream && new URL(settings.textUrl).hostname === 'api.z.ai' && settings.textModel.startsWith('glm-') && (!effort || effort === 'default') ? { thinking: { type: 'disabled' } } : {}) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(deepseek ? 300000 : 120000)]), redirect: 'error',
    });
  }

  async models(settings: Settings, apiKey: string): Promise<Response> {
    if (settings.textProtocol === 'anthropic') return fetch(`${anthropicBase(settings.textUrl)}/models`, { headers: anthropicHeaders(apiKey), signal: AbortSignal.timeout(10000), redirect: 'error' });
    return fetch(`${settings.textUrl}/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(10000), redirect: 'error' });
  }
}
