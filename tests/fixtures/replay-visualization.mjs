import { readFileSync } from 'node:fs';
import { calcAll } from '../../src/core/calculations.js';

const base = JSON.parse(readFileSync(new URL('./simulation-baseline.json', import.meta.url)))[0];
const { bundle: prefix } = JSON.parse(readFileSync(new URL('./replay/runtime-prefix.json', import.meta.url)));
const request = (input, id, kind = 'origin', anchorReq = null, offsetMs = 0, output = 0) => ({
  in: input, out: output, blockRuns: [[id, Math.ceil(input / 64)]], timing: { kind, anchorReq, offsetMs },
});
const bundle = req => ({ version: 1, blockSize: 64, sessions: [{ req }] });
const hardware = calcAll({ ...base.params, blockSize: 64 });
const infeasiblePages = Math.floor(hardware.availHbm / hardware.blockBytes) + 1;
const job = (data, overrides = {}, options = {}) => ({
  params: base.params, strategy: base.strategy, mode: 'dsl',
  overrides: { seed: 42, qps: data.sessions[0].req.length * 2, blockSize: 64, simMaxTime: 5, ...overrides,
    replay: { bundle: data, options: { durationSeconds: 0.2, warmupSeconds: 0, ...options } } },
});

export const visualizationCases = {
  prefix: job(prefix),
  manySuccessful: job(bundle(Array.from({ length: 400 }, (_, i) => request(64, i))), {}, { durationSeconds: 0.13 }),
  mixed: job(bundle([
    request(infeasiblePages * 64, 0), request(64, infeasiblePages, 'completion', 0),
    request(64, infeasiblePages + 1, 'arrival', 0),
  ])),
  cutoff: job(bundle([
    request(128, 0), request(64, 2, 'arrival', 0, 10_000), request(64, 3, 'completion', 0),
  ]), { simMaxTime: 0 }, { durationSeconds: 0.13 }),
  manyUnfinished: job(bundle(Array.from({ length: 400 }, (_, i) => request(128, i * 2))), { simMaxTime: 0 }, { durationSeconds: 0.13 }),
  longActive: job(bundle([request(64, 0, 'origin', null, 0, 100_000)]), { simMaxTime: 205.701 }, { durationSeconds: 0.13 }),
  idle: job(bundle([request(64, 0)]), { qps: 0.1 }, { durationSeconds: 60 }),
  zero: job(prefix, { qps: 1e-12 }),
  futureOnly: job(bundle([request(64, 0, 'origin', null, 10_000)]), { simMaxTime: 0.3 }),
};

export function numericalResult(result) {
  const copy = structuredClone(result);
  delete copy.timeline;
  delete copy.incomplete;
  delete copy.concTimeline;
  delete copy.replay.samples.legacy;
  return copy;
}
