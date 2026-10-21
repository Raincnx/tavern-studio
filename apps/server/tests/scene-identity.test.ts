import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSceneIdentity } from '../src/scene.ts';

test('identity normalization recovers fact wrappers and preserves known identity without accepting arbitrary objects', () => {
  assert.deepEqual(normalizeSceneIdentity({ identity: { value: '黑发，棕色眼睛' }, people: [] }), { identity: '黑发，棕色眼睛', people: [] });
  for (const identity of [null, '', { wrong: 'value' }, '长'.repeat(1601)]) {
    assert.equal((normalizeSceneIdentity({ identity }, '已有身份') as { identity: string }).identity, '已有身份');
  }
  assert.match((normalizeSceneIdentity({}) as { identity: string }).identity, /未明确/);
  assert.throws(() => normalizeSceneIdentity({ identity: { wrong: 'value' } }), /格式不正确/);
  assert.throws(() => normalizeSceneIdentity({ identity: '长'.repeat(1601) }), /超过 1600/);
});
