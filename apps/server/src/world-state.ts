import { randomUUID } from 'node:crypto';
import { AppError } from './errors.ts';
import type { StatePatch, StateValue, WorldState, WorldStateEvent, WorldStateSnapshot } from '@tavern/contracts';

export const worldRoots = ['world', 'player', 'characters', 'relationships', 'inventory', 'location', 'outfit', 'memory', 'custom'] as const;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function invalid(message = '状态值或路径无效'): never { throw new AppError(422, 'WORLD_STATE_INVALID', message); }
export function validateStateValue(value: unknown, depth = 0): void {
  if (depth > 8) invalid('状态嵌套过深');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') { if (typeof value === 'string' && value.length > 8000) invalid('状态文本过长'); return; }
  if (typeof value === 'number') { if (!Number.isFinite(value) || Math.abs(value) > 1e9) invalid(); return; }
  if (!value || typeof value !== 'object') invalid();
  if (Object.keys(value).length > 150) invalid('状态条目过多');
  for (const [key, child] of Object.entries(value)) { if (forbidden.has(key) || key.length > 100) invalid(); validateStateValue(child, depth + 1); }
}
export function worldPath(path: unknown): string[] {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('~') || path.length > 500) return invalid('状态路径格式无效');
  const parts = path.slice(1).split('/');
  if (!(worldRoots as readonly string[]).includes(parts[0])) invalid('状态路径不允许写入');
  if (parts.some(p => !p || forbidden.has(p)) || parts.length > 8) invalid('状态路径格式无效');
  return parts;
}
export const overlaps = (a: string, b: string) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
export function emptyWorldState(chatId: string): WorldState { return { chatId, revision: 0, worldType: 'auto', world: {}, player: {}, characters: {}, relationships: {}, inventory: {}, location: {}, outfit: {}, memory: { shortSummary: '', storySummaries: [], permanentFacts: [], unresolved: [], hiddenCount: 0 }, custom: {}, updatedAt: new Date().toISOString(), lockedPaths: [] }; }
export function applyWorldPatch(state: WorldState, patches: StatePatch[]): { state: WorldState; inverse: StatePatch[] } {
  if (!Array.isArray(patches) || patches.length > 100 || JSON.stringify(patches).length > 40000) invalid('状态补丁数量或大小无效');
  const next = structuredClone(state);
  for (const patch of patches) {
    if (!patch || typeof patch !== 'object') invalid();
    const parts = worldPath(patch.path);
    if (patch.value !== undefined) validateStateValue(patch.value);
    let target: any = next;
    for (const part of parts.slice(0, -1)) {
      if (Array.isArray(target)) { if (!/^(0|[1-9]\d*)$/.test(part) || Number(part) >= target.length) invalid(); }
      if (!Object.hasOwn(target, part)) { if (patch.op === 'del') invalid('状态路径不存在'); target[part] = {}; }
      if (!target[part] || typeof target[part] !== 'object') invalid('状态路径不存在');
      target = target[part];
    }
    const key = parts.at(-1)!;
    if (Array.isArray(target) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= target.length)) invalid();
    const before = target[key];
    switch (patch.op) {
      case 'set': if (patch.value === undefined) invalid(); target[key] = structuredClone(patch.value); break;
      case 'del': if (parts.length === 1) invalid(); if (Array.isArray(target)) target.splice(Number(key), 1); else delete target[key]; break;
      case 'inc': if (typeof before !== 'number' || typeof patch.value !== 'number') invalid('inc 只能用于数字字段'); target[key] = before + patch.value; break;
      case 'add': if (!patch.key || forbidden.has(patch.key) || /[\/~]/.test(patch.key) || patch.value === undefined || !before || typeof before !== 'object' || Array.isArray(before)) invalid(); if (Object.hasOwn(before, patch.key)) throw new AppError(409, 'WORLD_STATE_CONFLICT', '状态键已存在'); before[patch.key] = structuredClone(patch.value); break;
      case 'append': if (!Array.isArray(before) || patch.value === undefined) invalid(); before.push(structuredClone(patch.value)); break;
      case 'merge': if (!before || typeof before !== 'object' || Array.isArray(before) || !patch.value || typeof patch.value !== 'object' || Array.isArray(patch.value)) invalid(); Object.assign(before, structuredClone(patch.value)); break;
      default: invalid('不支持的状态操作');
    }
  }
  for (const root of worldRoots) { const value = next[root]; if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('状态分类必须是对象'); validateStateValue(value); }
  if (typeof next.memory.shortSummary !== 'string' || !Array.isArray(next.memory.storySummaries) || !Array.isArray(next.memory.permanentFacts) || !Array.isArray(next.memory.unresolved)) invalid('记忆结构无效');
  if (JSON.stringify(next).length > 40000) invalid('世界状态已满，请精简');
  const changed = [...new Set(patches.map(p => worldPath(p.path)[0]))] as (typeof worldRoots[number])[];
  const inverse: StatePatch[] = changed.map(root => ({ op: 'set', path: `/${root}`, value: structuredClone(state[root]) as StateValue }));
  next.updatedAt = new Date().toISOString(); return { state: next, inverse };
}
export function createWorldEvent(chatId: string, revision: number, patch: StatePatch[], inversePatch: StatePatch[], source: WorldStateEvent['source'], messageId?: string): WorldStateEvent { return { id: randomUUID(), chatId, messageId, revision, patch: structuredClone(patch), inversePatch: structuredClone(inversePatch), source, status: 'applied', createdAt: new Date().toISOString() }; }
export function createWorldSnapshot(chatId: string, state: WorldState, reason: WorldStateSnapshot['reason'], messageId?: string): WorldStateSnapshot { return { chatId, messageId, revision: state.revision, state: structuredClone(state), reason, createdAt: new Date().toISOString() }; }
