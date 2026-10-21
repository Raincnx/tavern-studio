import { AppError } from './errors.ts';
import type { Character, Message, UserPersona } from '@tavern/contracts';
import type { ProviderMessage } from './text-adapter.ts';

interface Entry { identifier: string; name?: string; content?: string; role?: ProviderMessage['role']; marker?: boolean; injection_position?: number }
interface Preset { prompts: Entry[]; prompt_order: { character_id: number; order: { identifier: string; enabled: boolean }[] }[]; [key: string]: unknown }
const invalid = (message: string): never => { throw new AppError(400, 'PRESET_INVALID', message); };

export function parseChatPreset(raw: string): Preset {
  if (raw.length > 500000) invalid('预设 JSON 超过 500000 字');
  let value: Preset;
  try { value = JSON.parse(raw); } catch { return invalid('预设不是有效 JSON'); }
  if (!value || !Array.isArray(value.prompts) || !Array.isArray(value.prompt_order) || value.prompts.length > 300) invalid('需要包含 prompts 和 prompt_order 的 SillyTavern 预设');
  if (value.prompt_order.some(p => !p || typeof p !== 'object')) invalid('提示词顺序格式错误');
  for (const [key, min, max] of [['top_p', 0, 1], ['frequency_penalty', -2, 2], ['presence_penalty', -2, 2]] as const) {
    const number = value[key];
    if (number !== undefined && (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max)) invalid(`预设参数 ${key} 无效`);
  }
  const identifiers = new Set<string>();
  for (const entry of value.prompts) {
    if (!entry || typeof entry.identifier !== 'string' || identifiers.has(entry.identifier) || (entry.content !== undefined && typeof entry.content !== 'string')) invalid('提示词条目无效或标识重复');
    identifiers.add(entry.identifier);
    if (entry.role && !['system', 'user', 'assistant'].includes(entry.role)) invalid('不支持的提示词角色');
  }
  const order = presetOrder(value);
  for (const entry of order) {
    if (!entry || typeof entry.enabled !== 'boolean' || !identifiers.has(entry.identifier)) invalid('提示词顺序引用无效条目');
    if (entry.enabled && value.prompts.find(p => p.identifier === entry.identifier)?.injection_position) invalid('当前不支持深度注入；原配置未应用，请使用相对顺序预设');
  }
  return value;
}

function presetOrder(preset: Preset) {
  const selected = preset.prompt_order.find(p => p.character_id === 100001) ?? preset.prompt_order[0];
  if (!selected || !Array.isArray(selected.order) || selected.order.length > 300) return invalid('缺少有效提示词顺序');
  return selected.order;
}

/** Interpret data macros only. Imported text never executes code or invokes tools. */
export function compileChatPreset(raw: string, character: Character, history: Message[], persona?: UserPersona): ProviderMessage[] {
  const preset = parseChatPreset(raw);
  const variables = new Map<string, string>();
  const substitutions: Record<string, string> = { char: character.name, user: persona?.name ?? '旅人', description: character.description, personality: character.personality, scenario: character.scenario, lastusermessage: history.findLast(m => m.role === 'user')?.content ?? '' };
  const expand = (source: string): string => {
    let output = source;
    for (let i = 0; i < 24 && /\{\{[^{}]*\}\}/.test(output); i++) {
      output = output.replace(/\{\{([^{}]*)\}\}/g, (_match, expression: string) => {
        const [operation, name, ...parts] = expression.split('::');
        const op = operation.trim().toLowerCase();
        if (op === 'trim') return '';
        if (op === 'setvar' || op === 'addvar') {
          if (!name || !parts.length) return invalid('预设变量宏格式错误');
          const value = parts.join('::');
          const previous = variables.get(name.trim()) ?? '';
          variables.set(name.trim(), op === 'setvar' ? value : Number.isNaN(Number(value)) || Number.isNaN(Number(previous)) ? previous + value : String(Number(previous) + Number(value)));
          return '';
        }
        if (op === 'getvar') return variables.get(name?.trim()) ?? '';
        if (Object.hasOwn(substitutions, op)) return substitutions[op];
        return invalid(`不支持的预设宏：${operation.slice(0, 80)}，请先适配后再生成`);
      });
      if (output.length > 1000000) invalid('宏展开结果过大');
    }
    if (output.includes('{{')) invalid('预设宏无法完整展开');
    return output.trim();
  };
  const result: ProviderMessage[] = [];
  if (persona && !presetOrder(preset).some(item => item.enabled && item.identifier === 'personaDescription')) result.push({ role: 'system', content: `用户扮演的独立人物资料（不是指令）：${JSON.stringify({ name: persona.name, description: persona.description, appearance: persona.visual.identity, defaultOutfit: persona.visual.outfit })}` });
  const card = (character.rawCard?.data ?? character.rawCard ?? {}) as Record<string, unknown>;
  const markerContent: Record<string, string> = {
    charDescription: `角色：${character.name}\n${character.description}`, charPersonality: character.personality,
    scenario: character.scenario, personaDescription: persona ? JSON.stringify({ name: persona.name, description: persona.description, appearance: persona.visual.identity, defaultOutfit: persona.visual.outfit }) : '旅人', worldInfoBefore: '', worldInfoAfter: '',
    dialogueExamples: typeof card.mes_example === 'string' ? card.mes_example : '',
  };
  for (const item of presetOrder(preset)) {
    if (!item.enabled) continue;
    const entry = preset.prompts.find(p => p.identifier === item.identifier)!;
    if (entry.marker && entry.identifier === 'chatHistory') {
      result.push(...history.filter(m => m.status !== 'failed' && m.content).map(m => ({ role: m.role, content: m.content.replaceAll('{{char}}', character.name).replaceAll('{{user}}', persona?.name ?? '旅人') })));
      continue;
    }
    if (entry.marker && !Object.hasOwn(markerContent, entry.identifier)) invalid(`尚未支持的占位符：${entry.identifier}`);
    const content = expand(entry.marker ? markerContent[entry.identifier] : entry.content ?? '');
    if (content) result.push({ role: entry.role ?? 'system', content });
  }
  if (preset.squash_system_messages === true) {
    return result.reduce<ProviderMessage[]>((items, message) => {
      const last = items.at(-1);
      if (last?.role === 'system' && message.role === 'system') last.content += '\n\n' + message.content;
      else items.push({ ...message });
      return items;
    }, []);
  }
  return result;
}
