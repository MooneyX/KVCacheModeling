import { jobFromControls, paramsFromControls } from './params.js';
import { parseDSL } from '../../core/strategy.js';
import type { SimulationJob, SimulationParams, SimulationStrategy, StrategyMode } from '../../contracts/simulation';

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
  const data = object(input, 'Input');
  if (!('params' in data)) {
    if (!Object.keys(data).some(key => key.startsWith('p') && key !== 'params')) {
      throw new Error('Expected a job with params/strategy or an exported control-ID parameter object.');
    }
    return jobFromControls(data) as SimulationJob;
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
  const overrides = data.overrides === undefined ? {} : object(data.overrides, 'overrides');
  validateScalars(overrides, { ...defaults, nreq: 1, seed: 0, hwPreset: '' }, 'overrides');
  return { params: params as SimulationParams, strategy: strategy as SimulationStrategy, mode: mode as StrategyMode, overrides };
}
