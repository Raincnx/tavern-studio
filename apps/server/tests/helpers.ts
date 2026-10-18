import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep, join } from 'node:path';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { crc32, deflateSync } from 'node:zlib';
import type { TestContext } from 'node:test';
import { buildApp } from '../src/app.ts';
import { loadWorkflow } from '../src/comfy.ts';
import type { ComfyHistory } from '../src/comfy.ts';
import { fileURLToPath } from 'node:url';

export const workflowPath = fileURLToPath(new URL('../../../workflows/qwen-image-2.1-standard-v1.json', import.meta.url));

export function pngChunk(type: string, data: Buffer): Buffer {
  const buffer = Buffer.alloc(data.length + 12);
  buffer.writeUInt32BE(data.length);
  buffer.write(type, 4, 4, 'ascii');
  data.copy(buffer, 8);
  buffer.writeUInt32BE(crc32(buffer.subarray(4, -4)), buffer.length - 4);
  return buffer;
}

export function samplePng(metadata = 'prompt\0private story'): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('tEXt', Buffer.from(metadata)), pngChunk('IDAT', deflateSync(Buffer.from([0, 170, 185, 140]))), pngChunk('IEND', Buffer.alloc(0))]);
}

export async function fixture(context: TestContext, directory?: string) {
  const dataDirectory = directory ?? mkdtempSync(join(tmpdir(), 'tavern-tests-'));
  const studio = await buildApp({ dataDirectory, workflowPath, startWorker: false });
  const response = await studio.app.inject({ url: '/api/v1/session', headers: { host: '127.0.0.1:3000' } });
  const cookie = String(response.headers['set-cookie']).split(';')[0];
  const csrf = response.json<{ csrfToken: string }>().csrfToken;
  const headers = { host: '127.0.0.1:3000', cookie, 'x-tavern-csrf': csrf };
  const call = (path: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' = 'GET', payload?: unknown, key = crypto.randomUUID()) => studio.app.inject({ url: `/api/v1${path}`, method, headers: { ...headers, 'idempotency-key': key }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload), headers: { ...headers, 'idempotency-key': key, 'content-type': 'application/json' } }) });
  context.after(async () => {
    await studio.app.close();
    if (!directory) {
      const target = resolve(dataDirectory);
      if (!target.startsWith(resolve(tmpdir()) + sep) || !target.split(sep).at(-1)?.startsWith('tavern-tests-')) throw new Error('拒绝清理非测试目录');
      rmSync(target, { recursive: true, force: true });
    }
  });
  return { ...studio, call, headers, directory: dataDirectory };
}

export async function mockServer(context: TestContext, handler: (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) => void) {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => { chunks.push(Buffer.from(chunk)); });
    request.on('end', async () => {
      const raw = Buffer.concat(chunks);
      let body = {};
      try {
        if (request.headers['content-type']?.startsWith('multipart/form-data')) {
          const form = await new Response(raw, { headers: { 'content-type': request.headers['content-type'] } }).formData();
          const image = form.get('image') as File;
          body = { name: image.name, subfolder: form.get('subfolder'), type: form.get('type'), data: Buffer.from(await image.arrayBuffer()) };
        } else body = raw.length ? JSON.parse(raw.toString()) : {};
      } catch { response.writeHead(400).end(); return; }
      handler(request, response, body);
    });
  });
  await new Promise<void>(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server');
  context.after(async () => { server.closeAllConnections(); await new Promise<void>(resolveClosed => server.close(() => resolveClosed())); });
  return `http://127.0.0.1:${address.port}`;
}

export async function mockComfy(context: TestContext) {
  const state = { uploads: [] as Record<string, unknown>[], rejectUpload: false, submissions: [] as Record<string, unknown>[], pending: [] as unknown[][], running: [] as unknown[][], histories: new Map<string, ComfyHistory>(), interrupts: [] as Record<string, unknown>[], image: samplePng() };
  const json = (response: ServerResponse, value: unknown) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
  const url = await mockServer(context, (request, response, body) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    if (path === '/system_stats') { json(response, { system: { comfyui_version: 'test' } }); return; }
    if (path === '/object_info') { json(response, { ...Object.fromEntries(Object.values(loadWorkflow(workflowPath)).map(node => [node.class_type, {}])), LoadImage: {} }); return; }
    if (path === '/upload/image') { state.uploads.push(body); if (state.rejectUpload) { response.writeHead(503).end(); return; } json(response, { name: body.name, subfolder: body.subfolder, type: body.type }); return; }
    if (path === '/prompt') { state.submissions.push(body); state.pending.push([0, body.prompt_id]); json(response, { prompt_id: body.prompt_id }); return; }
    if (path.startsWith('/history/')) { const id = path.split('/').at(-1)!; const history = state.histories.get(id); json(response, history ? { [id]: history } : {}); return; }
    if (path === '/queue' && request.method === 'GET') { json(response, { queue_running: state.running, queue_pending: state.pending }); return; }
    if (path === '/queue' && request.method === 'POST') { state.pending = state.pending.filter(item => !(body.delete as string[]).includes(String(item[1]))); json(response, {}); return; }
    if (path === '/interrupt') { state.interrupts.push(body); if (state.running.some(item => item[1] === body.prompt_id)) { state.running = state.running.filter(item => item[1] !== body.prompt_id); state.histories.set(String(body.prompt_id), { status: { status_str: 'error', completed: true } }); } json(response, {}); return; }
    if (path === '/view') { response.writeHead(200, { 'content-type': 'image/png' }).end(state.image); return; }
    response.writeHead(404).end();
  });
  function complete(id: string) { state.pending = state.pending.filter(item => item[1] !== id); state.running = state.running.filter(item => item[1] !== id); state.histories.set(id, { status: { status_str: 'success', completed: true }, outputs: { '461': { images: [{ filename: 'image.png', subfolder: '', type: 'output' }] } } }); }
  return { state, url, complete };
}

export async function until(predicate: () => boolean, timeout = 4000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('等待测试条件超时'); await new Promise(resolveWait => setTimeout(resolveWait, 20)); }
}
