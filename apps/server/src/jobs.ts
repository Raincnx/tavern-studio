import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from './store.ts';
import { ComfyAdapter } from './comfy.ts';
import type { Graph } from './comfy.ts';
import { AppError, errorMessage } from './errors.ts';
import { savePng } from './images.ts';
import type { Asset, ImageJob } from '@tavern/contracts';

export const terminal = new Set(['succeeded', 'failed', 'cancelled']);

export class JobWorker {
  store: Store;
  comfy: ComfyAdapter;
  timer?: ReturnType<typeof setInterval>;
  stopped = false;
  busy = false;
  offlineUntil = 0;
  pending?: Promise<void>;
  canRun: () => boolean = () => true;

  constructor(store: Store, comfy: ComfyAdapter) {
    this.store = store;
    this.comfy = comfy;
    comfy.onProgress = (promptId, progress) => {
      const job = store.list<ImageJob>('image_jobs').find(item => item.promptId === promptId && item.status === 'running');
      if (job && job.progress !== progress) store.updateJob(job.id, { phase: '正在采样', progress });
    };
  }

  start(): void {
    const schedule = () => { this.pending = this.tick().catch(() => { this.offlineUntil = Date.now() + 5000; process.stderr.write('任务调度暂时失败，5 秒后重试。请检查磁盘和服务状态。\n'); }); };
    this.timer = setInterval(schedule, 1000);
    this.timer.unref();
    schedule();
  }

  async tick(): Promise<void> {
    if (this.stopped || this.busy || Date.now() < this.offlineUntil) return;
    this.busy = true;
    try {
      const jobs = this.store.list<ImageJob>('image_jobs');
      const active = jobs.find(job => job.status !== 'queued' && !terminal.has(job.status));
      if (active) { await this.inspect(active); return; }
      const queued = jobs.find(job => job.status === 'queued');
      if (!queued) return;
      if (!this.canRun()) { if (queued.phase !== '等待文本生成结束') this.store.updateJob(queued.id, { phase: '等待文本生成结束' }); return; }
      if (!(await this.comfy.health())) {
        if (queued.phase !== '等待 ComfyUI 上线') this.store.updateJob(queued.id, { phase: '等待 ComfyUI 上线' });
        this.offlineUntil = Date.now() + 10000;
        return;
      }
      const snapshot = this.store.db.prepare('SELECT graph FROM job_workflows WHERE job_id=?').get(queued.id) as { graph: string } | undefined;
      const graph = snapshot ? JSON.parse(snapshot.graph) as Graph : undefined;
      try {
        await this.comfy.validate(graph);
        for (const reference of queued.visual?.references ?? []) {
          if (this.stopped || this.store.get<ImageJob>('image_jobs', queued.id)?.status !== 'queued') return;
          await this.comfy.uploadReference(queued.id, reference.assetId, await readFile(join(this.store.directory, 'media', `${reference.assetId}.png`)));
        }
      }
      catch (error) {
        if (this.stopped || this.store.get<ImageJob>('image_jobs', queued.id)?.status !== 'queued') return;
        if (error instanceof AppError && error.code === 'WORKFLOW_INVALID') this.store.updateJob(queued.id, { status: 'failed', phase: '工作流不可用', error: error.message });
        else { this.offlineUntil = Date.now() + 5000; if (!this.stopped && this.store.get<ImageJob>('image_jobs', queued.id)?.status === 'queued') this.store.updateJob(queued.id, { phase: '准备参考图失败，稍后重试', error: errorMessage(error) }); }
        return;
      }
      const current = this.store.get<ImageJob>('image_jobs', queued.id)!;
      if (this.stopped || current.status !== 'queued' || !this.canRun()) return;
      const submitting = this.store.updateJob(queued.id, { status: 'submitting', phase: '提交工作流', promptId: randomUUID(), submittedAt: new Date().toISOString() });
      try {
        await this.comfy.submit(submitting, graph);
        const afterSubmit = this.store.get<ImageJob>('image_jobs', queued.id)!;
        this.store.updateJob(queued.id, { submissionAcknowledged: true, ...(afterSubmit.status !== 'cancel_requested' ? { status: 'running', phase: '已入队，等待模型执行' } : {}) });
      } catch (error) {
        if (this.stopped) return;
        const cancelled = this.store.get<ImageJob>('image_jobs', queued.id)?.status === 'cancel_requested';
        if (error instanceof AppError && error.code === 'WORKFLOW_INVALID') this.store.updateJob(queued.id, { status: cancelled ? 'cancelled' : 'failed', phase: '工作流被拒绝', error: error.message });
        else this.store.updateJob(queued.id, { status: cancelled ? 'cancel_requested' : 'reconciling', phase: '提交结果待确认，请勿重复提交', error: errorMessage(error) });
      }
    } finally { this.busy = false; }
  }

  async inspect(original: ImageJob): Promise<void> {
    if (!original.promptId) return;
    try {
      const history = await this.comfy.history(original.promptId);
      if (this.stopped) return;
      let job = this.store.get<ImageJob>('image_jobs', original.id)!;
      if (terminal.has(job.status)) return;
      if (history?.status?.status_str === 'success' && history.status.completed) {
        this.store.updateJob(job.id, { status: 'collecting', phase: '归档图片', progress: 100, error: undefined });
        try {
          const existing = this.store.list<Asset>('assets').find(asset => asset.jobId === job.id);
          if (existing) { this.store.updateJob(job.id, { status: 'succeeded', phase: '已完成', assetId: existing.id }); return; }
          const image = await savePng(this.store.directory, job.id, await this.comfy.image(history));
          if (this.stopped) return;
          const asset: Asset = { id: job.id, jobId: job.id, characterId: job.characterId, chatId: job.chatId, sourceMessageId: job.sourceMessageId, visual: job.visual, prompt: job.prompt, seed: job.seed, width: image.width, height: image.height, bytes: image.clean.length, createdAt: new Date().toISOString() };
          this.store.transaction(() => {
            this.store.saveAsset(asset);
            this.store.saveJob({ ...this.store.get<ImageJob>('image_jobs', job.id)!, status: 'succeeded', phase: '已完成', assetId: asset.id, progress: 100, error: undefined, updatedAt: new Date().toISOString() });
          });
          this.store.publish('asset.created', asset.id, asset);
          this.store.publish('job.updated', job.id, this.store.get('image_jobs', job.id));
        } catch (error) {
          if (!this.stopped) this.store.updateJob(job.id, { status: 'collecting', phase: '图片已生成，归档失败后将重试', error: errorMessage(error) });
        }
        return;
      }
      if (history?.status?.completed || history?.status?.status_str === 'error') {
        const cancelled = job.status === 'cancel_requested';
        this.store.updateJob(job.id, { status: cancelled ? 'cancelled' : 'failed', phase: cancelled ? '已取消' : '推理失败', error: cancelled ? undefined : 'ComfyUI 执行失败，请检查模型、显存和服务日志。' });
        return;
      }
      const queue = await this.comfy.queue();
      const present = [...queue.queue_running, ...queue.queue_pending].some(item => item[1] === job.promptId);
      const running = queue.queue_running.some(item => item[1] === job.promptId);
      job = this.store.get<ImageJob>('image_jobs', original.id)!;
      if (terminal.has(job.status)) return;
      if (job.status === 'cancel_requested') {
        if (present) { await this.comfy.cancel(job.promptId!); if (!job.submissionAcknowledged) this.store.updateJob(job.id, { submissionAcknowledged: true }); }
        else if (!job.submissionAcknowledged) {
          if (!job.needsAttention) this.store.updateJob(job.id, { phase: '取消结果待确认', needsAttention: true, error: '原提交是否入队尚不明确，不能把断开连接视为已取消。请确认服务中无此任务后手动释放。' });
        } else {
          const latest = await this.comfy.history(job.promptId!);
          if (!latest) this.store.updateJob(job.id, { status: 'cancelled', phase: '已从队列取消', error: undefined });
        }
      } else if (present) {
        this.comfy.connect();
        const phase = running ? '模型执行中' : 'ComfyUI 队列等待中';
        if (job.status !== 'running' || !job.submissionAcknowledged || (!job.progress && job.phase !== phase)) this.store.updateJob(job.id, { status: 'running', phase, submissionAcknowledged: true, needsAttention: false, error: undefined });
      } else if (!job.submittedAt || Date.now() - Date.parse(job.submittedAt) > 30000) {
        if (!job.needsAttention) this.store.updateJob(job.id, { status: 'reconciling', phase: '结果不明，需要确认', needsAttention: true, error: '服务中已找不到此任务。为避免重复推理，系统不会自动重发。' });
      }
    } catch (error) {
      if (!this.stopped) {
        const current = this.store.get<ImageJob>('image_jobs', original.id)!;
        if (terminal.has(current.status)) return;
        if (current.phase !== '连接中断，等待恢复核对') this.store.updateJob(original.id, { status: current.status === 'cancel_requested' ? 'cancel_requested' : 'reconciling', phase: '连接中断，等待恢复核对', needsAttention: true, error: '生图服务无法连接。可以检查连接，或停止追踪此任务；停止追踪不等于取消远端推理。服务恢复后可按原参数重试。' });
        this.offlineUntil = Date.now() + 5000;
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.comfy.close();
    while (this.busy) await new Promise(resolve => setTimeout(resolve, 20));
  }
}
