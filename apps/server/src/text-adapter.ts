import { sceneOutputSchema } from './scene.ts';
import type { Settings } from '@tavern/contracts';

export interface ProviderMessage { role: 'system' | 'user' | 'assistant'; content: string }

/** Transport for providers implementing the Chat Completions protocol. */
export class ChatCompletionsAdapter {
  async generate(settings: Settings, apiKey: string, messages: ProviderMessage[], stream: boolean, signal: AbortSignal, jsonObject = false): Promise<Response> {
    const google = new URL(settings.textUrl).hostname === 'generativelanguage.googleapis.com';
    const effort = settings.textReasoningEffort;
    const localDraft = !stream && settings.textModel === 'cyber-tiel' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(settings.textUrl).hostname);
    const thinking = effort && effort !== 'default'
      ? google ? { extra_body: { google: { thinking_config: { thinking_level: effort } } } } : { reasoning_effort: effort }
      : {};
    return fetch(`${settings.textUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model: settings.textModel, messages, stream, ...(jsonObject && localDraft ? { response_format: { type: 'json_object', schema: sceneOutputSchema } } : {}), ...(!(google && settings.textModel.startsWith('gemini-3')) ? { temperature: settings.temperature } : {}), max_tokens: settings.maxTokens, ...thinking, ...(localDraft ? { chat_template_kwargs: { enable_thinking: false } } : {}), ...(!stream && new URL(settings.textUrl).hostname === 'api.z.ai' && settings.textModel.startsWith('glm-') && (!effort || effort === 'default') ? { thinking: { type: 'disabled' } } : {}) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]), redirect: 'error',
    });
  }

  async models(settings: Settings, apiKey: string): Promise<Response> {
    return fetch(`${settings.textUrl}/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(10000), redirect: 'error' });
  }
}
