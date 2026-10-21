// Local synthetic benchmark. Records node boundaries and GPU samples, never chats.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const run = promisify(execFile);
const base = process.env.COMFY_BENCH_URL || 'http://127.0.0.1:8188';
const output = path.resolve(process.argv[2] || 'temp/gpu-benchmark-cpu.json');
const workflowFile = process.argv.includes('--configured') ? 'qwen-image-2.1-standard-v1.json' : 'qwen-image-2.1-gguf-cpu.json';
const workflow = JSON.parse(await readFile(new URL(`../../workflows/${workflowFile}`, import.meta.url), 'utf8'));
workflow['452'].inputs.prompt = 'A ceramic white teacup on a wooden table, soft daylight, still life photograph.';
workflow['458'].inputs.seed = 314159;
workflow['461'].inputs.filename_prefix = 'TavernBenchmark/cpu-baseline';
if (process.argv.includes('--reference')) {
  workflow['490'] = { class_type: 'LoadImage', inputs: { image: 'tavern-gguf-test-cup.png' } };
  workflow['452'].inputs['images.image_1'] = ['490', 0];
  workflow['452'].inputs.vae = ['454', 0];
  workflow['452'].inputs.prompt = 'Keep the blue ceramic cup from image 1. Place it on a pale linen tablecloth beside a closed green book, soft daylight, still life photograph.';
  workflow['458'].inputs.latent_image = ['452', 2];
  workflow['461'].inputs.filename_prefix = 'TavernBenchmark/cpu-reference';
}
if (process.argv.includes('--staged')) {
  if (new URL(base).port !== '8189') throw new Error('Staged experiment requires isolated port 8189');
  workflow['452'].class_type = 'TavernQwen21TextEncodeStaged';
  workflow['453'].inputs.execution_device = 'cuda';
  workflow['461'].inputs.filename_prefix = 'TavernBenchmark/gpu-staged';
}
if (process.argv.includes('--configured')) workflow['461'].inputs.filename_prefix = 'TavernBenchmark/configured';
const variant = Number(process.env.COMFY_BENCH_VARIANT || 0);
if (!Number.isInteger(variant) || variant < 0 || variant > 10) throw new Error('Invalid benchmark variant');
workflow['452'].inputs.prompt += '\n'.repeat(variant);
const queue = await (await fetch(`${base}/queue`)).json();
if (queue.queue_running.length || queue.queue_pending.length) throw new Error('Queue is busy; benchmark not submitted');
const clientId = randomUUID();
const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?clientId=${clientId}`);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const start = performance.now();
const result = { startedAt: new Date().toISOString(), variant, executionDevice: workflow['453'].inputs.execution_device || 'cpu', encodingNode: workflow['452'].class_type, nodes: [], samples: [], cached: [], status: 'running' };
let current;
let sampling = false;
const sample = async () => {
  if (sampling) return;
  sampling = true;
  try {
    const { stdout } = await run('nvidia-smi', ['--query-gpu=memory.used,utilization.gpu,power.draw', '--format=csv,noheader,nounits']);
    const [memoryMiB, utilizationPercent, powerW] = stdout.trim().split(',').map(Number);
    result.samples.push({ seconds: (performance.now() - start) / 1000, memoryMiB, utilizationPercent, powerW });
  } finally { sampling = false; }
};
try { await sample(); } catch (error) { ws.close(); throw error; }
const timer = setInterval(() => sample().catch(error => { result.samplingError = error.message; }), 1000);
const closeNode = () => {
  if (current) { current.seconds = (performance.now() - current.start) / 1000; delete current.start; result.nodes.push(current); current = undefined; }
};
let promptId;
const done = new Promise((resolve, reject) => {
  ws.onmessage = event => {
    if (typeof event.data !== 'string') return;
    const { type, data } = JSON.parse(event.data);
    if (data.prompt_id && promptId && data.prompt_id !== promptId) return;
    if (type === 'execution_cached') result.cached = data.nodes;
    if (type === 'executing') {
      closeNode();
      if (data.node) current = { id: data.node, classType: workflow[data.node]?.class_type, startSeconds: (performance.now() - start) / 1000, start: performance.now() };
      else { result.status = 'success'; resolve(); }
    }
    if (type === 'execution_error' || type === 'execution_interrupted') {
      result.status = type; result.error = { nodeId: data.node_id, exceptionType: data.exception_type }; reject(new Error(type));
    }
  };
  ws.onclose = () => { if (result.status === 'running') reject(new Error('ComfyUI disconnected')); };
});
try {
  const response = await fetch(`${base}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: clientId, prompt: workflow }) });
  if (!response.ok) throw new Error(`Prompt rejected: ${response.status}`);
  promptId = (await response.json()).prompt_id;
  console.log(JSON.stringify({ promptId, output }));
  await done;
  const history = await (await fetch(`${base}/history/${promptId}`)).json();
  result.images = history[promptId]?.outputs?.['461']?.images;
} catch (error) { result.status = result.status === 'running' ? 'failed' : result.status; result.failure = error.message; process.exitCode = 1; }
finally {
  closeNode(); clearInterval(timer); ws.close();
  result.totalSeconds = (performance.now() - start) / 1000;
  result.peakMemoryMiB = result.samples.length ? Math.max(...result.samples.map(s => s.memoryMiB)) : null;
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, samples: `${result.samples.length} samples` }));
}
