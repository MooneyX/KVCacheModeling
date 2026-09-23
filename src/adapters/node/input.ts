import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PassThrough, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { jobFromControls, paramsFromControls } from './params.js';
import { parseDSL } from '../../core/strategy.js';
import { parseReplayBundle, replayLimits, validateReplayOverride } from '../../core/replay.js';
import { validatePhysicalBlockSize } from '../../core/requests.js';
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
  if (data.workload !== undefined) {
    const workload = object(data.workload, 'workload');
    if (!['synthetic', 'replay'].includes(String(workload.source))) throw new Error('workload.source must be synthetic or replay.');
    if (workload.source === 'replay') {
      const supplied = data.overrides === undefined ? {} : object(data.overrides, 'overrides');
      if (!supplied.replay) throw new Error('Replay configuration contains only a summary; reselect and verify the bundle before execution.');
      const replay = object(supplied.replay, 'overrides.replay');
      const summary = object(workload.bundleSummary, 'workload.bundleSummary');
      if (typeof summary.digest !== 'string' || !/^[a-f0-9]{64}$/.test(summary.digest)) throw new Error('Invalid Replay bundle summary digest.');
      const options = object(workload.options, 'workload.options');
      const { qps, seed, simMaxTime, ...replayOptions } = options;
      if (typeof qps !== 'number' || !Number.isFinite(qps) || qps <= 0
        || typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff
        || typeof simMaxTime !== 'number' || !Number.isFinite(simMaxTime) || simMaxTime < 0) throw new Error('Invalid Replay workload QPS, seed or drain.');
      if (replayOptions.arrivalModel !== 'closed' || replayOptions.superblocks !== false) throw new Error('Replay workload requires closed arrivals without superblocks.');
      validateReplayOverride({ bundle: replay.bundle, options: replayOptions });
      const digest = createHash('sha256').update(JSON.stringify(replay.bundle)).digest('hex');
      if (digest !== summary.digest) throw new Error('Replay bundle digest does not match the imported configuration.');
      data = { ...data, overrides: { qps, seed, simMaxTime, ...supplied,
        replay: { ...replay, options: { ...replayOptions, ...object(replay.options ?? {}, 'replay.options') } },
      } };
    }
  }
  if (!('params' in data)) {
    if (!Object.keys(data).some(key => key.startsWith('p') && key !== 'params')) {
      throw new Error('Expected a job with params/strategy or an exported control-ID parameter object.');
    }
    if (data._strategyMode !== undefined && data._strategyMode !== 'dsl' && data._strategyMode !== 'js') {
      throw new Error('_strategyMode must be dsl or js.');
    }
    if ('pBlockSize' in data) {
      const override = data.overrides === undefined ? {} : object(data.overrides, 'overrides');
      validatePhysicalBlockSize(Number(override.blockSize ?? data.pBlockSize));
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
  validatePhysicalBlockSize(overrides.blockSize ?? params.blockSize);
  if (Number(overrides.instances ?? params.instances) > 1 && (overrides.pdMode ?? params.pdMode) === 2) {
    throw new Error('Multiple instances cannot be combined with physical P/D separation.');
  }
  if ('replay' in overrides) {
    overrides.replay = validateReplayOverride(overrides.replay);
    if (mode !== 'dsl') throw new Error('Replay execution accepts DSL only.');
    for (const key of ['nreq', 'concurrency', 'inputLen', 'outputLen', 'lenDist', 'arrivalDist', 'multiTurn', 'prefixHit', 'prefixWarm', 'prefixWarmL2', 'singleBatch']) {
      if (key in overrides) throw new Error(`Replay does not support synthetic generation override: ${key}.`);
    }
    const effective = { ...params, ...overrides };
    if (!Number.isFinite(effective.qps) || Number(effective.qps) <= 0) throw new Error('Replay QPS must be a finite positive number.');
    if (!Number.isInteger(effective.seed) || Number(effective.seed) < 0 || Number(effective.seed) > 0xffffffff) throw new Error('Replay seed must be a uint32 integer.');
    if (!Number.isFinite(effective.simMaxTime) || Number(effective.simMaxTime) < 0) throw new Error('Replay simMaxTime must be finite nonnegative drain seconds.');
  }
  return { params: params as SimulationParams, strategy: strategy as SimulationStrategy, mode: mode as StrategyMode, overrides };
}
