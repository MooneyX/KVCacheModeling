import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createReplayMetrics } from '../../src/core/replay-metrics.js';
import { DEFAULT_REPLAY_RUN_LIMITS, validateReplayBundle } from '../../src/core/replay.js';
import { runSimulation } from '../../src/core/simulation.js';

const { bundle } = JSON.parse(readFileSync(new URL('../fixtures/replay/runtime-prefix.json', import.meta.url)));
const base = JSON.parse(readFileSync(new URL('../fixtures/simulation-baseline.json', import.meta.url)))[0];
const make = (options = {}) => createReplayMetrics({ durationSeconds: 3, warmupSeconds: 1, hardCutoff: 5,
  stats: validateReplayBundle(bundle), qps: 2, lambdaSession: 2 / 3, seed: 42, limits: DEFAULT_REPLAY_RUN_LIMITS, ...options });
const req = (id, arrive, completeTime = 4, out = 1) => ({ id, templateIndex: 0, launchIndex: 0, requestIndex: id,
  arrive, admitTime: arrive, prefillEnd: arrive + 0.1, decodeStart: arrive + 0.1, completeTime, inputLen: 64, outputLen: out });
const hit = { inputTokens: 64, hitL1Tokens: 16, hitL2Tokens: 0, hitL3Tokens: 0, missTokens: 48 };

test('S08: exact window boundaries, separate arrival/completion QPS and drain-completed latencies', () => {
  const m = make();
  m.launch({ time: 0, templateIndex: 0, launchIndex: 0, requests: 4, inputTokens: 256, outputTokens: 3 });
  const a = req(0, 0, 0.5), b = req(1, 1, 3.5), c = req(2, 3, 4, 0), failed = req(3, 2, 2.1);
  for (const r of [a, b, c, failed]) { m.arrive(r); m.admit(r, hit); }
  for (const r of [a, b, c]) m.complete(r);
  m.fail(failed, 'aborted');
  const result = m.finish(4, { truncated: false, terminationReason: 'drained' });
  const { warmup, measurement, drain, full } = result.windows;
  assert.equal(warmup.arrivals, 1); assert.equal(measurement.arrivals, 2); assert.equal(drain.arrivals, 1);
  assert.equal(measurement.arrivalQps, 1); assert.equal(measurement.completionQps, 0);
  assert.equal(drain.completionQps, 2); assert.equal(full.completionQps, 0.75);
  assert.equal(measurement.latency.endToEnd.count, 1); assert.equal(measurement.latency.endToEnd.mean, 2500);
  assert.equal(measurement.failureFraction, 0.5); assert.equal(measurement.unfinishedFraction, 0);
  assert.equal(drain.latency.tpot.count, 0); assert.equal(drain.latency.tpot.mean, null);
  assert.equal(result.cache.inputTokens, 128); assert.equal(result.cache.hitL1Tokens, 32);
});

test('S08: token accounting is first-admission only, and unknown ratios are null', () => {
  const m = make(), a = req(0, 1);
  m.arrive(a); m.admit(a, hit); m.admit(a, hit);
  assert.throws(() => m.admit(req(1, 1), hit), /before arrival/);
  const b = req(2, 1); m.arrive(b);
  assert.throws(() => m.admit(b, { ...hit, missTokens: 0 }), /conservation/);
  const report = m.finish(3, {});
  assert.equal(report.cache.inputTokens, 64);
  assert.equal(report.windows.measurement.unadmitted, 1);
  assert.equal(report.windows.measurement.latency.ttft.mean, null);
  assert.equal(report.windows.warmup.cache.hitRate, null);
  assert.equal(report.windows.drain.completionQps, null);
});

test('S08: time-weighted sampling integrates idle skips and respects 20000-bucket cap', () => {
  const m = make({ hardCutoff: 100000 });
  m.observe(0, { activeRequests: 2, activeSessions: 1, hbmBytes: 64 });
  m.observe(10, { activeRequests: 0, activeSessions: 0, hbmBytes: 128 });
  const r = m.finish(100000, {});
  assert.ok(r.samples.series.length <= 20000);
  assert.ok(Math.abs(r.samples.timeWeightedMean.activeRequests - 20 / 100000) < 1e-12);
  assert.ok(Math.abs(r.samples.timeWeightedMean.hbmBytes - (640 + 99990 * 128) / 100000) < 1e-9);
  assert.equal(r.samples.peak.activeRequests, 2);
  assert.equal(r.samples.series.at(-1).end, 100000);
  assert.deepEqual(r.samples.coverage, [0, 100000]);
});

test('S08: completion summaries are bounded and preserve no KV/template references', () => {
  const m = make();
  for (let i = 0; i < 400; i++) { const r = req(i, 1); m.arrive(r); m.admit(r, hit); m.complete(r); }
  const result = m.finish(4, {});
  assert.equal(result.samples.requests.length, 320);
  assert.equal(result.samples.requestCoverage.complete, false);
  assert.equal(result.counts.successful, 400);
  assert.ok(result.samples.requests.every(r => !('replayTemplate' in r) && !('ownBlkIds' in r)));
});

test('S08: real engine reports coherent bounded windows and content-derived configuration', () => {
  const run = opts => runSimulation(base.params, base.strategy, { seed: 42, qps: 6, blockSize: 64, simMaxTime: 5,
    replay: { bundle, options: { durationSeconds: 0.2, warmupSeconds: 0.1, ...opts } } });
  const result = run({});
  assert.equal(result.replay.windows.full.arrivals, 3);
  assert.equal(result.replay.windows.full.cache.inputTokens, 448);
  assert.equal(result.replay.windows.full.cache.hitL1Tokens, 192);
  assert.equal(result.replay.configuration.bundleDigest.length, 64);
  assert.equal(result.replay.configuration.outputIdentity, 'unmapped');
  assert.equal(result.replay.state.mainWindow, 'measurement');
  assert.ok(result.replay.samples.series.length <= 20000);
  const sum = result.replay.samples.series.reduce((n, b) => n + b.arrivals, 0);
  assert.equal(sum, result.replay.counts.arrived);
  assert.throws(() => run({ limits: { maxResultBytes: 100 } }), /result.*limit/);
});

test('S08: hard cutoff cannot grant future decode work at the prefill completion instant', () => {
  const data = structuredClone(bundle); data.sessions[0].req = [{ ...data.sessions[0].req[0], out: 1 }];
  const run = drain => runSimulation(base.params, base.strategy, { seed: 42, qps: 2, blockSize: 64, simMaxTime: drain,
    replay: { bundle: data, options: { durationSeconds: 0.13, warmupSeconds: 0 } } });
  const completed = run(5);
  const prefillEnd = completed.timeline[0].prefillEnd;
  const cut = run(prefillEnd - 0.13);
  assert.equal(cut.simEnd, prefillEnd);
  assert.equal(cut.completed, 0);
  assert.equal(cut.truncated, true);
  assert.equal(cut.replay.counts.arrivedUnfinished, 1);
  assert.equal(cut.replay.cache.outputPages, 0);
});
