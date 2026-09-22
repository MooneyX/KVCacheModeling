import { open } from 'node:fs/promises';
import { PassThrough, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { jobFromControls, paramsFromControls } from './params.js';
import { parseDSL } from '../../core/strategy.js';
import { parseReplayBundle, replayLimits, validateReplayOverride } from '../../core/replay.js';
import type { ReplayLimits } from '../../contracts/replay';
import type { SimulationJob, SimulationParams, SimulationStrategy, StrategyMode } from '../../contracts/simulation';

export async function loadReplayBundle(path: string, limitOverrides: Partial<ReplayLimits> = {}) {
  const limits = replayLimits(limitOverrides);
  const maxInputBytes = Math.min(Number.MAX_SAFE_INTEGER, limits.maxDecompressedBytes + 64 * 1024);
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Replay bundle must be a regular file.');
    if (info.size > maxInputBytes) throw new Error(`bundle.compressedBytes exceeds limit ${maxInputBytes}.`);
    const header = Buffer.alloc(2);
    await file.read(header, 0, 2, 0);
    const gzip = /\.gz$/i.test(path) || (header[0] === 0x1f && header[1] === 0x8b);
    let inputBytes = 0, outputBytes = 0;
    const chunks: Buffer[] = [];
    const inputLimit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        inputBytes += chunk.byteLength;
        if (inputBytes > maxInputBytes) callback(new Error(`bundle.compressedBytes exceeds limit ${maxInputBytes}.`));
        else callback(null, chunk);
      },
    });
    await pipeline(
      file.createReadStream({ start: 0, highWaterMark: 64 * 1024, autoClose: false }),
      inputLimit,
      gzip ? createGunzip() : new PassThrough(),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          outputBytes += chunk.byteLength;
          if (outputBytes > limits.maxDecompressedBytes) callback(new Error(`bundle.bytes exceeds limit ${limits.maxDecompressedBytes}.`));
          else { chunks.push(chunk); callback(); }
        },
      }),
    );
    return parseReplayBundle(Buffer.concat(chunks, outputBytes), limits);
  } finally {
    await file.close();
  }
}

function validateScalars(values: Record<string, unknown>, schema: Record<string, unknown>, label: string) {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in schema)) continue;
    if (typeof value !== typeof schema[key] || (typeof value === 'number' && !Number.isFinite(value))) {
      throw new Error(`${label}.${key} must be a finite ${typeof schema[key]} value.`);
    }
  }
  for (const key of ['nreq', 'concurrency', 'gpus', 'instances', 'layers', 'blockSize']) {
    if (key in values && (!Number.isSafeInteger(values[key]) || Number(values[key]) < 1)) {
      throw new Error(`${label}.${key} must be a positive safe integer.`);
    }
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
  return value as Record<string, unknown>;
}

export function parseJob(input: unknown): SimulationJob {
  let data = object(input, 'Input');
  if (!('params' in data)) {
    if (!Object.keys(data).some(key => key.startsWith('p') && key !== 'params')) {
      throw new Error('Expected a job with params/strategy or an exported control-ID parameter object.');
    }
    if (data._strategyMode !== undefined && data._strategyMode !== 'dsl' && data._strategyMode !== 'js') {
      throw new Error('_strategyMode must be dsl or js.');
    }
    const controls = jobFromControls(data);
    data = { ...controls, mode: data.mode ?? controls.mode, overrides: data.overrides === undefined ? {} : data.overrides };
  }
  const params = object(data.params, 'params');
  const defaults = paramsFromControls() as Record<string, unknown>;
  const required = Object.keys(defaults);
  const missing = required.filter(key => !(key in params));
  if (missing.length) throw new Error(`Normalized params are incomplete: ${missing.join(', ')}. Use exported control-ID JSON for partial inputs.`);
  validateScalars(params, defaults, 'params');
  const strategy = typeof data.strategy === 'string' ? parseDSL(data.strategy) : object(data.strategy, 'strategy');
  for (const key of ['admission', 'eviction', 'prefetch', 'placement', 'batching']) {
    object(strategy[key as keyof typeof strategy], `strategy.${key}`);
  }
  const mode = data.mode ?? 'dsl';
  if (mode !== 'dsl' && mode !== 'js') throw new Error('mode must be dsl or js.');
  const overrides = data.overrides === undefined ? {} : { ...object(data.overrides, 'overrides') };
  validateScalars(overrides, { ...defaults, nreq: 1, seed: 0, hwPreset: '' }, 'overrides');
  if ('replay' in overrides) overrides.replay = validateReplayOverride(overrides.replay);
  return { params: params as SimulationParams, strategy: strategy as SimulationStrategy, mode: mode as StrategyMode, overrides };
}
