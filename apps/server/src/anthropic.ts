import { AppError } from './errors.ts';
import { limitedBuffer } from './images.ts';
import type { Settings } from '@tavern/contracts';
import type { ProviderMessage } from './text-adapter.ts';

export function anthropicBase(url: string): string { const base = url.replace(/\/+$/, ''); return base.endsWith('/v1') ? base : `${base}/v1`; }
export function anthropicHeaders(key: string): Record<string, string> { return { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key, authorization: `Bearer ${key}` } : {}) }; }
export async function anthropicGenerate(settings: Settings, key: string, messages: ProviderMessage[], stream: boolean, signal: AbortSignal, jsonObject = false): Promise<Response> {
  const effort = settings.textReasoningEffort;
  const adaptive = /claude-(?:opus|sonnet)-4[.-]6/.test(settings.textModel);
  if (!jsonObject && effort && effort !== 'default' && !adaptive) throw new AppError(422, 'ANTHROPIC_THINKING_UNSUPPORTED', '当前 Claude 型号尚未接入思考级别，请选择模型默认或 Opus/Sonnet 4.6。');
  const thinking = jsonObject ? { thinking: { type: 'disabled' } } : adaptive && effort && effort !== 'default' ? { thinking: { type: 'adaptive' }, output_config: { effort: effort === 'minimal' ? 'low' : effort } } : {};
  const system = messages.filter(m => m.role === 'system').map(m => ({ type: 'text', text: m.content }));
  const response = await fetch(`${anthropicBase(settings.textUrl)}/messages`, { method: 'POST', headers: anthropicHeaders(key), body: JSON.stringify({ model: settings.textModel, system, messages: messages.filter(m => m.role !== 'system'), max_tokens: settings.maxTokens, stream, ...thinking }), signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]), redirect: 'error' });
  if (!response.ok || !response.body) return response;
  if (!stream) {
    const data = JSON.parse((await limitedBuffer(response, 2 * 1024 * 1024)).toString('utf8'));
    if (!['end_turn', 'stop_sequence'].includes(data.stop_reason)) throw new AppError(502, 'ANTHROPIC_INCOMPLETE', 'Claude 输出未完整结束，请检查输出长度或模型能力');
    return Response.json({ choices: [{ message: { content: data.content?.filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('') }, finish_reason: 'stop' }] });
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new AppError(502, 'STREAM_UNSUPPORTED', 'Claude 接口未返回 SSE 流');
  let buffer = '', stopped = false, completed = false;
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  const converted = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > 262144) throw new AppError(502, 'STREAM_INVALID', 'Claude 流事件过大');
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        const raw = event.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (!raw) continue;
        const data = JSON.parse(raw);
        if (data.type === 'error') throw new AppError(502, 'TEXT_PROVIDER_ERROR', 'Claude 服务返回生成错误');
        if (data.type === 'content_block_start' && data.content_block?.type === 'text' && data.content_block.text) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: data.content_block.text } }] })}\n\n`));
        if (data.type === 'message_delta' && ['end_turn', 'stop_sequence'].includes(data.delta?.stop_reason)) completed = true;
        if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: data.delta.text } }] })}\n\n`));
        if (data.type === 'message_delta' && data.delta?.stop_reason && !['end_turn', 'stop_sequence'].includes(data.delta.stop_reason)) throw new AppError(502, 'ANTHROPIC_INCOMPLETE', 'Claude 输出达到长度上限或需要不支持的工具操作，已保留文本');
        if (data.type === 'message_stop') { if (!completed) throw new AppError(502, 'STREAM_INTERRUPTED', 'Claude 未返回完整结束状态'); stopped = true; controller.enqueue(encoder.encode('data: [DONE]\n\n')); }
      }
    },
    flush() { if (!stopped) throw new AppError(502, 'STREAM_INTERRUPTED', 'Claude 流意外结束，已保留收到的文本'); },
  }));
  return new Response(converted, { headers: { 'content-type': 'text/event-stream' } });
}
