import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.ts';
import { limitedBuffer } from './images.ts';
import type { ImageJob } from '@tavern/contracts';

export type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
export interface ComfyHistory { status?: { status_str: string; completed: boolean }; outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }> }
export interface ComfyQueue { queue_running: unknown[][]; queue_pending: unknown[][] }

export function loadWorkflow(path: string): Graph {
  const graph = JSON.parse(readFileSync(path, 'utf8')) as Graph;
  const expected: Record<string, string> = { '451': 'UNETLoader', '454': 'VAELoader', '452': 'TextEncodeQwenImage21', '456': 'EmptyLatentImage', '480': 'QwenImage21Cache', '458': 'KSampler', '457': 'VAEDecode', '461': 'SaveImage' };
  for (const [node, classType] of Object.entries(expected)) if (graph[node]?.class_type !== classType) throw new Error(`工作流节点 ${node} 不匹配 ${classType}`);
  if (!['CLIPLoader', 'TavernQwen21CLIPLoaderGGUF'].includes(graph['453']?.class_type)) throw new Error('工作流文本编码器节点不受支持');
  if (graph['451'].inputs.unet_name !== 'qwen_image_2.1_int8_convrot.safetensors') throw new Error('工作流不是已确认的标准版模型');
  return graph;
}

export function compileWorkflow(template: Graph, job: ImageJob): Graph {
  const graph = structuredClone(template);
  graph['452'].inputs.prompt = job.compiledPrompt ?? job.prompt;
  graph['452'].inputs.negative_prompt = '';
  graph['452'].inputs.resolution = 1024;
  Object.assign(graph['456'].inputs, { width: 1024, height: 1024, batch_size: 1 });
  Object.assign(graph['458'].inputs, { seed: job.seed, steps: 25, cfg: 1, sampler_name: 'euler', scheduler: 'simple' });
  graph['461'].inputs.filename_prefix = `TavernStudio/${job.id}/image`;
  if (job.visual?.references.length) {
    graph['452'].inputs.vae = ['454', 0];
    job.visual.references.forEach((reference, index) => {
      const node = String(900 + index);
      graph[node] = { class_type: 'LoadImage', inputs: { image: referencePath(job.id, reference.assetId) } };
      graph['452'].inputs[`images.image_${index + 1}`] = [node, 0];
    });
  }
  return graph;
}

function referencePath(jobId: string, assetId: string): string { return `TavernStudio/references/${jobId}/${assetId}.png`; }

export class ComfyAdapter {
  baseUrl: () => string;
  template: Graph;
  clientId: string = randomUUID();
  socket?: WebSocket;
  socketUrl = '';
  abort = new AbortController();
  onProgress: (promptId: string, progress: number) => void = () => undefined;

  constructor(baseUrl: () => string, workflowPath: string) { this.baseUrl = baseUrl; this.template = loadWorkflow(workflowPath); }

  async request(path: string, body?: unknown, timeout = 5000): Promise<Response> {
    const response = await fetch(`${this.baseUrl()}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeout)]), redirect: 'error' });
    if (!response.ok) throw new AppError(response.status === 400 ? 422 : 502, response.status === 400 ? 'WORKFLOW_INVALID' : 'COMFY_ERROR', `ComfyUI 返回 HTTP ${response.status}，请检查工作流与服务日志`);
    return response;
  }

  async json<Type>(path: string, body?: unknown, timeout = 5000): Promise<Type> {
    return JSON.parse((await limitedBuffer(await this.request(path, body, timeout), 8 * 1024 * 1024)).toString('utf8')) as Type;
  }

  async health(): Promise<boolean> { try { await this.json('/system_stats'); return true; } catch { return false; } }

  connect(): void {
    const url = new URL('/ws', this.baseUrl());
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('clientId', this.clientId);
    if (this.socketUrl === url.toString() && this.socket && this.socket.readyState < 2) return;
    this.socket?.close();
    this.socketUrl = url.toString();
    this.socket = new WebSocket(url);
    this.socket.addEventListener('error', () => undefined);
    this.socket.addEventListener('message', event => {
      if (typeof event.data !== 'string') return;
      try {
        const message = JSON.parse(event.data) as { type: string; data: { prompt_id?: string; value?: number; max?: number } };
        if (message.type === 'progress' && message.data.prompt_id && message.data.max && typeof message.data.value === 'number') this.onProgress(message.data.prompt_id, Math.min(99, Math.round(message.data.value / message.data.max * 100)));
      } catch { return; }
    });
  }

  async validate(graph: Graph = this.template): Promise<void> {
    const info = await this.json<Record<string, unknown>>('/object_info');
    for (const node of Object.values(graph)) if (!(node.class_type in info)) throw new AppError(422, 'WORKFLOW_INVALID', `ComfyUI 缺少节点 ${node.class_type}`);
  }

  async uploadReference(jobId: string, assetId: string, data: Buffer): Promise<void> {
    const path = referencePath(jobId, assetId);
    const name = `${assetId}.png`;
    const subfolder = path.slice(0, -(name.length + 1));
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(data)], { type: 'image/png' }), name);
    form.append('type', 'input');
    form.append('subfolder', subfolder);
    form.append('overwrite', 'true');
    const response = await fetch(`${this.baseUrl()}/upload/image`, { method: 'POST', body: form, signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30000)]), redirect: 'error' });
    if (!response.ok) throw new AppError(502, 'REFERENCE_UPLOAD_FAILED', `参考图上传失败（HTTP ${response.status}）`);
    const result = JSON.parse((await limitedBuffer(response, 65536)).toString('utf8')) as { name?: string; subfolder?: string; type?: string };
    if (result.name !== name || result.subfolder !== subfolder || result.type !== 'input') throw new AppError(502, 'REFERENCE_UPLOAD_FAILED', 'ComfyUI 返回的参考图位置不匹配');
  }

  async submit(job: ImageJob, snapshot?: Graph): Promise<void> {
    this.connect();
    const result = await this.json<{ prompt_id: string }>('/prompt', { client_id: this.clientId, prompt_id: job.promptId, prompt: snapshot ?? compileWorkflow(this.template, job) }, 30000);
    if (result.prompt_id !== job.promptId) throw new AppError(502, 'PROMPT_ID_MISMATCH', '服务未返回预先记录的任务 ID，请核对服务版本');
  }

  async history(promptId: string): Promise<ComfyHistory | undefined> {
    return (await this.json<Record<string, ComfyHistory>>(`/history/${encodeURIComponent(promptId)}`))[promptId];
  }

  async queue(): Promise<ComfyQueue> { return this.json('/queue'); }

  async cancel(promptId: string): Promise<void> {
    await this.request('/queue', { delete: [promptId] });
    await this.request('/interrupt', { prompt_id: promptId });
  }

  async image(history: ComfyHistory): Promise<Buffer> {
    const output = history.outputs?.['461']?.images?.[0];
    if (!output || output.type !== 'output' || output.filename.includes('/') || output.filename.includes('\\') || output.subfolder.split(/[\\/]/).includes('..')) throw new AppError(502, 'ASSET_INVALID', '工作流没有返回允许的图片输出');
    const parameters = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder, type: 'output' });
    return limitedBuffer(await this.request(`/view?${parameters}`), 24 * 1024 * 1024);
  }

  close(): void { this.abort.abort(); this.socket?.close(); }
}
