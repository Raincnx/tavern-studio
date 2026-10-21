import { parseChatPreset } from './chat-preset.ts';
import { isIP } from 'node:net';
import { AppError } from './errors.ts';
import type { CharacterInput, Settings } from '@tavern/contracts';

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'INVALID_INPUT', '请求内容必须是对象');
  return value as Record<string, unknown>;
}

export function text(value: unknown, name: string, maximum = 12000, required = false): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) throw new AppError(400, 'INVALID_INPUT', `${name}为空、类型错误或超过 ${maximum} 字`);
  return value.trim();
}

export function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new AppError(400, 'INVALID_INPUT', `${name}必须是 ${minimum}～${maximum} 的整数`);
  return Number(value);
}

export function characterInput(value: unknown): CharacterInput {
  const body = object(value);
  const tags = body.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 12) throw new AppError(400, 'INVALID_INPUT', '最多允许 12 个标签');
  const color = text(body.color ?? 'sage', '配色', 20);
  if (!['sage', 'amber', 'violet', 'rose'].includes(color)) throw new AppError(400, 'INVALID_INPUT', '不支持的角色配色');
  return {
    name: text(body.name, '角色名称', 80, true),
    tagline: text(body.tagline, '一句话介绍', 160),
    description: text(body.description, '角色描述'),
    personality: text(body.personality, '性格'),
    scenario: text(body.scenario, '场景'),
    firstMessage: text(body.firstMessage, '开场白'),
    appearance: text(body.appearance, '外貌锚点', 4000),
    tags: tags.map(tag => text(tag, '标签', 30, true)),
    color,
  };
}

export function endpoint(value: unknown, localOnly: boolean): string {
  let url: URL;
  try { url = new URL(text(value, '服务地址', 500, true)); } catch { throw new AppError(400, 'INVALID_URL', '请输入完整的 HTTP 服务地址'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(hostname);
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new AppError(400, 'INVALID_URL', '地址不能包含凭据、查询参数或片段');
  if (localOnly && !loopback) throw new AppError(400, 'LOCAL_ONLY', '未开启云端访问时，只允许本机地址');
  if (!loopback && (url.protocol !== 'https:' || isIP(hostname) !== 0 || !hostname.includes('.'))) throw new AppError(400, 'INVALID_URL', '远程服务必须使用 HTTPS 域名');
  return url.toString().replace(/\/$/, '');
}

export function settingsInput(value: unknown, previous: Settings): Settings {
  const body = object(value);
  const protocol = body.textProtocol ?? previous.textProtocol ?? 'openai';
  if (!['openai', 'anthropic'].includes(String(protocol))) throw new AppError(400, 'INVALID_INPUT', '不支持的接口协议');
  const reasoning = body.textReasoningEffort ?? 'default';
  if (!['default', 'minimal', 'low', 'medium', 'high'].includes(String(reasoning))) throw new AppError(400, 'INVALID_INPUT', '不支持的思考级别');
  for (const key of ['allowCloud', 'researchUseConfirmed']) {
    if (typeof body[key] !== 'boolean') throw new AppError(400, 'INVALID_INPUT', `${key} 必须是布尔值`);
  }
  if (typeof body.temperature !== 'number' || body.temperature < 0 || body.temperature > 2) throw new AppError(400, 'INVALID_INPUT', '温度范围为 0～2');
  const maxTokens = integer(body.maxTokens, '输出长度', 64, 131072);
  const textPresetJson = body.textPresetJson ?? previous.textPresetJson ?? '';
  if (typeof textPresetJson !== 'string') throw new AppError(400, 'INVALID_INPUT', '预设 JSON 必须是文本');
  if (textPresetJson) parseChatPreset(textPresetJson);
  const contextWindow = integer(body.contextWindow, '上下文长度', 2048, 1048576);
  if (maxTokens + 512 >= contextWindow) throw new AppError(400, 'INVALID_INPUT', '上下文长度必须大于输出长度与安全余量');
  return {
    ...previous,
    textProtocol: protocol as Settings['textProtocol'],
    textPresetJson,
    textPresetName: text(body.textPresetName ?? previous.textPresetName ?? '', '聊天预设名称', 120),
    textSystemPrompt: text(body.textSystemPrompt ?? previous.textSystemPrompt ?? '', '聊天预设', 40000),
    textReasoningEffort: reasoning as Settings['textReasoningEffort'],
    comfyUrl: endpoint(body.comfyUrl, true),
    textUrl: body.textUrl ? endpoint(body.textUrl, !body.allowCloud) : '',
    textModel: text(body.textModel, '模型名称', 160),
    allowCloud: body.allowCloud as boolean,
    temperature: body.temperature,
    maxTokens,
    contextWindow,
    researchUseConfirmed: body.researchUseConfirmed as boolean,
  };
}
