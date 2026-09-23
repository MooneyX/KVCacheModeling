import { parseJob } from '../../adapters/node/input';
import { paramsFromControls } from '../../adapters/node/params.js';
import { DEFAULT_REPLAY_RUN_LIMITS } from '../../core/replay.js';
import type { TaskSubmission } from '../../contracts/tasks';
import type { ServerConfig } from './config';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function validateSubmission(value: unknown, config: ServerConfig): TaskSubmission {
  if (!value || typeof value !== 'object') throw new HttpError(400, 'Invalid task body.');
  const data = value as TaskSubmission;
  if (!['simulation', 'scan', 'batch'].includes(data.kind)) throw new HttpError(400, 'Invalid task kind.');
  if (typeof data.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(data.requestId)) throw new HttpError(400, 'Invalid requestId.');
  if (!Array.isArray(data.jobs) || data.jobs.length < 1 || data.jobs.length > config.maxJobs || (data.kind === 'simulation' && data.jobs.length !== 1)) {
    throw new HttpError(400, `Task must contain 1..${config.maxJobs} jobs (one for simulation).`);
  }
  const defaults = paramsFromControls() as Record<string, unknown>;
  const jobs = data.jobs.map(input => {
    try {
      const job = parseJob(input);
      if (job.mode === 'js') throw new Error('Server execution accepts DSL only; arbitrary JavaScript is disabled.');
      for (const [key, sample] of Object.entries(defaults)) {
        for (const values of [job.params, job.overrides || {}]) {
          if (!(key in values)) continue;
          const v = (values as Record<string, unknown>)[key];
          if (typeof v !== typeof sample || (typeof v === 'number' && !Number.isFinite(v))) throw new Error(`Invalid parameter: ${key}`);
        }
      }
      const p = { ...job.params, ...job.overrides };
      for (const key of ['concurrency', 'gpus', 'instances', 'layers', 'blockSize'] as const) {
        if (!Number.isSafeInteger(p[key]) || p[key] < 1) throw new Error(`${key} must be a positive integer.`);
      }
      if (p.gpus > 100_000 || p.instances > 10_000) throw new Error('Invalid workload dimensions.');
      const batch = job.strategy.batching.max_batch_size;
      if (!Number.isSafeInteger(batch) || batch < 1) throw new Error('Invalid batch size.');
      const replay = job.overrides?.replay;
      if (replay) {
        if (!Number.isFinite(p.qps) || p.qps <= 0) throw new Error('Replay QPS must be a finite positive number.');
        if (!Number.isInteger(p.seed) || p.seed < 0 || p.seed > 0xffffffff) throw new Error('Replay seed must be a uint32 integer.');
        if (!Number.isFinite(p.simMaxTime) || p.simMaxTime < 0) throw new Error('Replay simMaxTime must be finite nonnegative drain seconds.');
        const limits = {
          ...DEFAULT_REPLAY_RUN_LIMITS,
          maxRequests: Math.min(DEFAULT_REPLAY_RUN_LIMITS.maxRequests, config.maxRequests),
          maxWallTimeMs: Math.min(DEFAULT_REPLAY_RUN_LIMITS.maxWallTimeMs, config.timeoutMs),
          maxResultBytes: Math.min(DEFAULT_REPLAY_RUN_LIMITS.maxResultBytes, config.resultBytes),
        };
        for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
          limits[key] = Math.min(replay.options.limits?.[key] ?? limits[key], limits[key]);
        }
        return { ...job, mode: 'dsl' as const, overrides: { ...job.overrides,
          replay: { ...replay, options: { ...replay.options, limits } },
        } };
      }
      const n = job.overrides?.nreq ?? Math.min(p.concurrency, 256);
      if (!Number.isSafeInteger(n) || n < 1 || n > config.maxRequests) throw new Error(`Request count exceeds service limit ${config.maxRequests}.`);
      if (p.inputLen < 1 || p.outputLen < 0 || p.simMaxTime < 1) throw new Error('Invalid workload dimensions.');
      return { ...job, mode: 'dsl' as const };
    } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : String(error)); }
  });
  return { kind: data.kind, jobs, requestId: data.requestId, label: String(data.label || data.kind).slice(0, 120) };
}
