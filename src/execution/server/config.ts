import { resolve } from 'node:path';
import { availableParallelism } from 'node:os';

function integer(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer in [1, ${max}].`);
  return value;
}

export function serverConfig() {
  const host = process.env.HOST || '127.0.0.1';
  const token = process.env.SIM_ACCESS_TOKEN || '';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && token.length < 24) {
    throw new Error('Non-loopback binding requires SIM_ACCESS_TOKEN with at least 24 characters. Use HTTPS at the reverse proxy.');
  }
  return {
    host, token, port: integer('PORT', 8787, 65535),
    publicOrigin: process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).origin : '',
    secureCookie: process.env.COOKIE_SECURE === 'true',
    dataDir: resolve(process.env.SIM_DATA_DIR || '.runtime/tasks'),
    webDir: resolve(process.env.SIM_WEB_DIR || 'dist/web'),
    concurrency: integer('SIM_CONCURRENCY', Math.max(1, Math.min(2, availableParallelism() - 1)), 32),
    timeoutMs: integer('SIM_TASK_TIMEOUT_MS', 15 * 60_000),
    memoryMb: integer('SIM_WORKER_MEMORY_MB', 1024),
    maxTasks: integer('SIM_MAX_TASKS', 200),
    maxJobs: integer('SIM_MAX_BATCH_JOBS', 2000),
    maxRequests: integer('SIM_MAX_REQUESTS', 100_000),
    bodyBytes: integer('SIM_BODY_LIMIT_BYTES', 8 * 1024 * 1024),
    resultBytes: integer('SIM_RESULT_LIMIT_BYTES', 64 * 1024 * 1024),
    retentionMs: integer('SIM_RETENTION_MS', 24 * 60 * 60_000),
  };
}
export type ServerConfig = ReturnType<typeof serverConfig>;
