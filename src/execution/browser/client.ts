import type { SimulationJob, SimulationResult, SensitivityMetrics } from '../../contracts/simulation';
import { terminalStatuses, type TaskInfo, type TaskKind, type TaskPoint } from '../../contracts/tasks';

let session: Promise<void> | null = null;
let engineVersion = '';
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api' + path, { ...options, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(15_000) });
  } catch { throw new ApiError(0, '服务器不可达；任务可能仍在执行，请恢复连接后查看任务列表。不会回退客户端计算。'); }
  const data = await response.json().catch(() => ({ error: '服务器返回了无效响应。' }));
  if (!response.ok) { if (response.status === 401) session = null; throw new ApiError(response.status, data.error || response.statusText); }
  return data as T;
}
async function sessionLock<T>(action: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('服务器计算需要 HTTPS（本机 localhost 除外）及支持 Web Locks 的浏览器。');
  return navigator.locks.request('simulation-session', action);
}
export async function connectService(token = '') {
  await sessionLock(async () => {
    await api('/session', { method: 'POST', body: JSON.stringify({ token }) });
  });
  session = null;
  await ensureService();
}
export function ensureService(): Promise<void> {
  if (!session) session = sessionLock(async () => {
    const health = await api<{ execution: string; engineVersion: string; authRequired: boolean }>('/health');
    if (health.execution !== 'server') throw new Error('当前地址不是服务器计算服务。');
    engineVersion = health.engineVersion;
    try { await api('/tasks'); }
    catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      if (health.authRequired) throw new Error('请输入服务器访问密钥并连接。');
      await api('/session', { method: 'POST', body: '{}' });
    }
  }).catch(error => { session = null; throw error; });
  return session;
}
export async function serverVersion() {
  await ensureService();
  const health = await api<{ engineVersion: string }>('/health');
  return engineVersion = health.engineVersion;
}
interface ExecuteOptions {
  label?: string;
  signal?: AbortSignal;
  onTask?: (task: TaskInfo) => void;
  onPoint?: (point: TaskPoint) => void;
}
export async function executeBatch(jobs: SimulationJob[], kind: TaskKind = 'batch', options: ExecuteOptions = {}) {
  if (jobs.some(job => job.mode === 'js')) throw new Error('服务器暂不执行任意 JavaScript 策略。请选择 DSL；不会回退到浏览器。');
  if (options.signal?.aborted) throw new Error('已取消提交。');
  await ensureService();
  const payload = JSON.stringify({ kind, jobs: structuredClone(jobs), label: options.label || kind, requestId: crypto.randomUUID() });
  let task: TaskInfo;
  try { task = await api<TaskInfo>('/tasks', { method: 'POST', body: payload }); }
  catch (error) {
    if (!(error instanceof ApiError) || error.status !== 0) throw error;
    task = await api<TaskInfo>('/tasks', { method: 'POST', body: payload });
  }
  window.dispatchEvent(new Event('simulation-task'));
  options.onTask?.(task);
  let cancellation: Promise<unknown> | undefined;
  const cancel = () => { cancellation = api(`/tasks/${task.id}/cancel`, { method: 'POST' }); void cancellation.catch(() => {}); };
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const results: Array<SimulationResult | SensitivityMetrics> = [];
  let next = 0;
  try {
    while (true) {
      if (cancellation) { await cancellation; throw new Error('已取消服务器任务。'); }
      const page = await api<{ task: TaskInfo; points: TaskPoint[]; next: number }>(`/tasks/${task.id}/points?after=${next}`);
      task = page.task;
      for (const point of page.points) { results[point.index] = point.result; options.onPoint?.(point); }
      next = page.next;
      options.onTask?.(task);
      if (terminalStatuses.includes(task.status) && next >= task.completed) {
        if (task.status !== 'completed') throw new Error(task.error || `任务${task.status}`);
        return results;
      }
      if (next < task.completed) continue;
      await new Promise(resolve => setTimeout(resolve, 350));
    }
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    window.dispatchEvent(new Event('simulation-task'));
  }
}
export async function executeSimulation(job: SimulationJob): Promise<SimulationResult> {
  return (await executeBatch([job], 'simulation', { label: job.strategy.name || '单次仿真' }))[0] as SimulationResult;
}
