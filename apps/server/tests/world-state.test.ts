import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWorldPatch, emptyWorldState } from '../src/world-state.ts';

test('WorldState patches apply atomically and create inverse operations', () => {
  const state = emptyWorldState('chat-1');
  state.player = { affection: 3 };
  const result = applyWorldPatch(state, [
    { op: 'set', path: '/world/location', value: '迟灯旧书店' },
    { op: 'inc', path: '/player/affection', value: 2 },
    { op: 'add', path: '/inventory', key: '旧书', value: 1 },
  ]);
  assert.equal(result.state.world.location, '迟灯旧书店');
  assert.equal(result.state.player.affection, 5);
  assert.deepEqual(result.state.inventory, { '旧书': 1 });
  const reverted = applyWorldPatch(result.state, result.inverse);
  assert.deepEqual(reverted.state.world, {});
  assert.deepEqual(reverted.state.player, { affection: 3 });
  assert.deepEqual(reverted.state.inventory, {});
});

test('WorldState rejects writes outside approved roots and invalid increments', () => {
  const state = emptyWorldState('chat-1');
  assert.throws(() => applyWorldPatch(state, [{ op: 'set', path: '/chatId', value: 'other' }]), /状态路径不允许写入/);
  assert.throws(() => applyWorldPatch(state, [{ op: 'inc', path: '/player/affection', value: 1 }]), /只能用于数字字段/);
});
