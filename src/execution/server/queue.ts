import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerConfig } from './config';
import { HttpError } from './input';
import { terminalStatuses, type TaskInfo, type TaskPoint, type TaskSubmission } from '../../contracts/tasks';

interface StoredTask extends TaskInfo { owner: string; requestId: string; fingerprint: string; bytes: number }
interface Active { child: ChildProcess; timer: NodeJS.Timeout }

export class TaskQueue {
  private tasks = new Map<string, StoredTask>();
  private active = new Map<string, Active>();
  private closing = false;
  private readers = new Map<string, number>();
  readonly engineVersion: string;

  constructor(private config: ServerConfig, private runnerPath: string) {
    mkdirSync(config.dataDir, { recursive: true });
    this.engineVersion = createHash('sha256').update(readFileSync(runnerPath)).digest('hex').slice(0, 16);
    for (const id of readdirSync(config.dataDir)) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      try {
        const task = JSON.parse(readFileSync(join(config.dataDir, id, 'meta.json'), 'utf8')) as StoredTask;
        if (task.id !== id) continue;
        if (!terminalStatuses.includes(task.status)) {
          task.status = 'interrupted';
          task.error = 'Server restarted; resubmit to run again. Completed points are retained.';
          this.persist(task);
        }
        this.tasks.set(id, task);
      } catch (error) { console.error('Unable to restore task', id, error instanceof Error ? error.message : error); }
    }
    this.prune();
  }

  private directory(id: string) { return join(this.config.dataDir, id); }
  private persist(task: StoredTask) {
    task.updatedAt = new Date().toISOString();
    const path = join(this.directory(task.id), 'meta.json');
    writeFileSync(path + '.tmp', JSON.stringify(task));
    renameSync(path + '.tmp', path);
  }
  private public(task: StoredTask): TaskInfo {
    const { owner, requestId, fingerprint, bytes, ...info } = task;
    return info;
  }
  private owned(id: string, owner: string) {
    const task = this.tasks.get(id);
    if (!task || task.owner !== owner) throw new HttpError(404, 'Task not found.');
    return task;
  }
  private prune() {
    for (const [id, task] of this.tasks) {
      if (!this.active.has(id) && !this.readers.has(id) && terminalStatuses.includes(task.status) && Date.now() - Date.parse(task.updatedAt) > this.config.retentionMs) {
        rmSync(this.directory(id), { recursive: true, force: true });
        this.tasks.delete(id);
      }
    }
  }
  submit(owner: string, input: TaskSubmission) {
    if (this.closing) throw new HttpError(503, 'Server is shutting down.');
    this.prune();
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const previous = [...this.tasks.values()].find(t => t.owner === owner && t.requestId === input.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new HttpError(409, 'requestId already belongs to different input.');
      return this.public(previous);
    }
    if (this.tasks.size >= this.config.maxTasks) throw new HttpError(429, 'Task capacity reached. Delete completed tasks or wait for retention expiry.');
    const now = new Date().toISOString();
    const task: StoredTask = { id: randomUUID(), owner, fingerprint, requestId: input.requestId,
      kind: input.kind, label: input.label || input.kind, status: 'queued', completed: 0,
      total: input.jobs.length, createdAt: now, updatedAt: now, bytes: 0, engineVersion: this.engineVersion };
    mkdirSync(this.directory(task.id));
    writeFileSync(join(this.directory(task.id), 'input.json'), JSON.stringify(input));
    this.persist(task);
    this.tasks.set(task.id, task);
    this.pump();
    return this.public(task);
  }
  list(owner: string) { this.prune(); return [...this.tasks.values()].filter(t => t.owner === owner).reverse().map(t => this.public(t)); }
  get(id: string, owner: string) { return this.public(this.owned(id, owner)); }
  points(id: string, owner: string, after: number, limit = 50) {
    const task = this.owned(id, owner);
    if (!Number.isSafeInteger(after) || after < 0 || after > task.completed) throw new HttpError(400, 'Invalid result cursor.');
    const points: TaskPoint[] = [];
    for (let i = after; i < Math.min(task.completed, after + limit); i++) {
      points.push(JSON.parse(readFileSync(join(this.directory(id), `${i}.json`), 'utf8')));
    }
    return { points, next: after + points.length, task: this.public(task) };
  }
  input(id: string, owner: string) {
    this.owned(id, owner);
    return JSON.parse(readFileSync(join(this.directory(id), 'input.json'), 'utf8')) as TaskSubmission;
  }
  cancel(id: string, owner: string) {
    const task = this.owned(id, owner);
    if (!terminalStatuses.includes(task.status)) this.finish(task, 'cancelled', 'Cancelled by user.');
    return this.public(task);
  }
  acquireDownload(id: string, owner: string) {
    this.owned(id, owner);
    this.readers.set(id, (this.readers.get(id) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.readers.get(id) || 1) - 1;
      if (remaining) this.readers.set(id, remaining); else this.readers.delete(id);
    };
  }
  remove(id: string, owner: string) {
    const task = this.owned(id, owner);
    if (this.readers.has(id)) throw new HttpError(409, 'Task results are being downloaded.');
    if (!terminalStatuses.includes(task.status) || this.active.has(id)) throw new HttpError(409, 'Cancel active tasks before deletion.');
    rmSync(this.directory(id), { recursive: true, force: true });
    this.tasks.delete(id);
  }
  private finish(task: StoredTask, status: TaskInfo['status'], error?: string) {
    if (terminalStatuses.includes(task.status)) return;
    task.status = status;
    if (error) task.error = error.slice(0, 1000);
    const active = this.active.get(task.id);
    if (active) { clearTimeout(active.timer); active.child.kill('SIGKILL'); }
    try { this.persist(task); }
    catch (failure) {
      task.status = 'failed';
      task.error = 'Unable to persist task state; calculation was stopped.';
      console.error('Task persistence failed', task.id, failure);
    }
    if (!active) queueMicrotask(() => this.pump());
  }
  private pump() {
    if (this.closing) return;
    for (const task of this.tasks.values()) {
      if (this.active.size >= this.config.concurrency) break;
      if (task.status !== 'queued') continue;
      let child: ChildProcess;
      try {
        task.status = 'running';
        this.persist(task);
        child = fork(this.runnerPath, [], {
          execArgv: [`--max-old-space-size=${this.config.memoryMb}`],
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'production' },
          serialization: 'json',
        });
      } catch (error) { this.finish(task, 'failed', String(error)); continue; }
      const timer = setTimeout(() => this.finish(task, 'failed', 'Task exceeded server time limit.'), this.config.timeoutMs);
      this.active.set(task.id, { child, timer });
      child.on('message', (message: { type: string; index?: number; result?: unknown; error?: string }) => {
        if (task.status !== 'running') return;
        try {
          if (message.type === 'point') {
            if (message.index !== task.completed) throw new Error('Unexpected result ordering.');
            const point = JSON.stringify({ index: message.index, result: message.result });
            task.bytes += Buffer.byteLength(point);
            if (task.bytes > this.config.resultBytes) throw new Error('Task exceeded server result-size limit.');
            writeFileSync(join(this.directory(task.id), `${task.completed}.json`), point);
            task.completed++;
            this.persist(task);
          } else if (message.type === 'done') {
            if (task.completed !== task.total) throw new Error('Task returned incomplete results.');
            this.finish(task, 'completed');
          } else if (message.type === 'failed') this.finish(task, 'failed', message.error || 'Calculation failed.');
        } catch (error) { this.finish(task, 'failed', error instanceof Error ? error.message : String(error)); }
      });
      child.on('error', error => this.finish(task, 'failed', error.message));
      child.once('close', () => {
        clearTimeout(timer);
        this.active.delete(task.id);
        if (!terminalStatuses.includes(task.status)) this.finish(task, 'failed', 'Calculation process exited unexpectedly.');
        this.pump();
      });
      try {
        const input = this.input(task.id, task.owner);
        child.send(input, error => { if (error) this.finish(task, 'failed', error.message); });
      } catch (error) { this.finish(task, 'failed', String(error)); }
    }
  }
  async close() {
    this.closing = true;
    const exits = [...this.active.values()].map(({ child }) => new Promise<void>(resolve => child.once('close', () => resolve())));
    for (const task of this.tasks.values()) {
      if (!terminalStatuses.includes(task.status)) this.finish(task, 'interrupted', 'Server stopped; resubmit to run again.');
    }
    await Promise.all(exits);
  }
}
