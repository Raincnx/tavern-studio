import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflow, compileWorkflow } from '../src/comfy.ts';
import { workflowPath } from './helpers.ts';
import type { ImageJob } from '@tavern/contracts';

test('GPU GGUF requires staged encoding while legacy CPU snapshots remain valid', async context => {
  const dir = await mkdtemp(join(tmpdir(), 'tavern-gpu-workflow-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'workflow.json');
  const graph = loadWorkflow(workflowPath);
  graph['453'].class_type = 'TavernQwen21CLIPLoaderGGUF';
  graph['453'].inputs.execution_device = 'cuda';
  graph['452'].class_type = 'TextEncodeQwenImage21';
  await writeFile(file, JSON.stringify(graph));
  assert.throws(() => loadWorkflow(file), /分阶段卸载/);
  graph['452'].class_type = 'TavernQwen21TextEncodeStaged';
  await writeFile(file, JSON.stringify(graph));
  const staged = loadWorkflow(file);
  const frozen = JSON.stringify(staged);
  const compiled = compileWorkflow(staged, { id: 'test-job', seed: 314159, prompt: 'A cup', visual: {
    references: [{ assetId: 'first' }, { assetId: 'second' }],
  } } as ImageJob);
  assert.equal(compiled['452'].class_type, 'TavernQwen21TextEncodeStaged');
  assert.deepEqual(compiled['452'].inputs['images.image_1'], ['900', 0]);
  assert.deepEqual(compiled['452'].inputs['images.image_2'], ['901', 0]);
  assert.equal(compiled['453'].inputs.execution_device, 'cuda');
  assert.equal(JSON.stringify(staged), frozen);
  delete graph['453'].inputs.execution_device;
  graph['452'].class_type = 'TextEncodeQwenImage21';
  await writeFile(file, JSON.stringify(graph));
  assert.equal(loadWorkflow(file)['453'].inputs.execution_device, undefined);
});
