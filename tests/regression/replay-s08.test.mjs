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

test('U3 metrics: disabling finite capacity preserves the complete legacy metric shape', () => {
  const run = options => {
    const m = make(options), a = req(0, 1);
    m.arrive(a); m.admit(a, hit); m.complete(a);
    m.observe(0, { activeRequests: 1, hbmBytes: 64 });
    m.observe(2, { activeRequests: 0, hbmBytes: 0 });
    return m.finish(4, { truncated: false, terminationReason: 'drained' });
  };
  const legacy = run({}), explicit = run({ finiteCapacity: false });
  assert.deepEqual(explicit, legacy);
  const keys = ['activeSessions', 'activeRequests', 'queuedRequests', 'hbmBytes', 'inputPages', 'outputPages'];
  assert.deepEqual(Object.keys(legacy.samples.timeWeightedMean), keys);
  assert.deepEqual(Object.keys(legacy.samples.peak), keys);
  for (const sample of legacy.samples.series) {
    assert.deepEqual(Object.keys(sample.mean), keys);
    assert.deepEqual(Object.keys(sample.peak), keys);
    assert.deepEqual(Object.keys(sample.last), keys);
  }
  assert.equal(legacy.state.retractCount, 0);
  assert.equal(legacy.state.supportedScope, 'single-instance/64-token/HBM-capacity-sufficient');
  assert.equal('recomputedTokens' in legacy.state, false);
  assert.equal('recomputedTokens' in legacy.cache, false);
  assert.equal('workloadModelVersion' in legacy.configuration, false);
});

test('U3 metrics: tier residency and reservations are time weighted only in finite mode', () => {
  const version = 'workload-u3-64-tiered-v1';
  const m = make({ finiteCapacity: true, configuration: { workloadModelVersion: version } });
  const occupied = { hbmBytes: 96, hbmResidentBytes: 64, hbmReservedBytes: 32,
    dramBytes: 128, dramReservedBytes: 64, ssdBytes: 256, ssdReservedBytes: 128 };
  const released = Object.fromEntries(Object.keys(occupied).map(key => [key, 0]));
  m.observe(0, occupied);
  m.observe(2, released);
  const report = m.finish(4, {});
  assert.equal(report.configuration.workloadModelVersion, version);
  assert.equal(report.state.supportedScope, 'single-instance/64-token/finite-capacity-tiered-four-configurations');
  assert.ok(report.samples.series.length <= 20000);
  for (const [key, bytes] of Object.entries(occupied)) {
    assert.ok(Math.abs(report.samples.timeWeightedMean[key] - bytes / 2) < 1e-9);
    assert.equal(report.samples.peak[key], bytes);
    assert.equal(report.samples.series[0].mean[key], bytes);
    assert.equal(report.samples.series[0].peak[key], bytes);
    assert.equal(report.samples.series[0].last[key], bytes);
    assert.equal(report.samples.series.at(-1).mean[key], 0);
    assert.equal(report.samples.series.at(-1).last[key], 0);
  }
});

test('U3 metrics: retries count events without repeating admission denominators or successful output', () => {
  const m = make({ finiteCapacity: true }), a = req(0, 1);
  m.arrive(a); m.admit(a, hit);
  a.firstTokenTime = a.prefillEnd;
  m.retract(a, 1.5);
  m.admit(a, { ...hit, hitL1Tokens: 0, missTokens: 64 });
  m.recompute(a, 64, 2);
  m.retract(a, 3);
  m.admit(a, hit);
  m.recompute(a, 128, 3.5);
  a.prefillEnd = 3.6;
  m.complete(a); m.complete(a);
  m.retract(a, 4); m.recompute(a, 64, 4);
  const report = m.finish(4, {});
  assert.equal(report.counts.arrived, 1);
  assert.equal(report.counts.admitted, 1);
  assert.equal(report.counts.successful, 1);
  assert.equal(report.counts.outputTokens, 1);
  assert.equal(report.samples.requests.length, 1);
  assert.equal(report.cache.inputTokens, 64);
  assert.equal(report.cache.hitL1Tokens, 16);
  assert.equal(report.cache.missTokens, 48);
  assert.equal(report.cache.hitRate, 0.25);
  assert.equal(report.state.retractCount, 2);
  assert.equal(report.state.recomputedTokens, 192);
  assert.equal(report.windows.measurement.retractCount, 1);
  assert.equal(report.windows.drain.retractCount, 1);
  assert.equal(report.windows.measurement.recomputedTokens, 64);
  assert.equal(report.windows.drain.recomputedTokens, 128);
  assert.equal(report.windows.full.recomputedTokens, 192);
  assert.equal(report.cache.recomputedTokens, 64);
  assert.equal(report.windows.measurement.cache.recomputedTokens, 64);
  assert.equal(report.windows.drain.cache.recomputedTokens, 128);
  assert.equal(report.windows.full.cache.recomputedTokens, 192);
  assert.equal(report.windows.full.completions, 1);
  assert.equal(report.windows.measurement.successfulArrivals, 1);
  assert.equal(report.windows.measurement.latency.ttft.count, 1);
  assert.ok(Math.abs(report.windows.measurement.latency.ttft.mean - 100) < 1e-9);
  assert.ok(Math.abs(report.windows.measurement.latency.tpot.mean - 2900) < 1e-9);
  assert.equal(report.windows.measurement.latency.endToEnd.mean, 3000);
});

test('U3 metrics: a retraction is not a terminal event and does not mutate request state', () => {
  const m = make({ finiteCapacity: true }), a = req(0, 1);
  m.arrive(a); m.admit(a, hit);
  const before = structuredClone(a);
  m.retract(a, 1.5);
  assert.deepEqual(a, before);
  const pending = m.finish(2, {});
  assert.equal(pending.state.retractCount, 1);
  assert.equal(pending.counts.successful, 0);
  assert.equal(pending.counts.failed, 0);
  assert.equal(pending.counts.cancelled, 0);
  assert.equal(pending.windows.full.completions, 0);
  assert.equal(pending.windows.full.unfinishedArrivals, 1);
  assert.equal(pending.windows.full.latency.ttft.count, 0);
  assert.deepEqual(pending.samples.requests, []);
  assert.equal(pending.samples.requestCoverage.total, 0);
  m.admit(a, hit); m.recompute(a, 64, 3); m.complete(a);
  const completed = m.finish(4, {});
  assert.equal(completed.counts.successful, 1);
  assert.equal(completed.counts.admitted, 1);
  assert.equal(completed.windows.full.unfinishedArrivals, 0);
});

test('U3 metrics: retry event validation rejects invalid work without affecting counters', () => {
  const m = make({ finiteCapacity: true }), a = req(0, 1);
  m.arrive(a);
  assert.throws(() => m.retract(a, 1), /before admission/);
  assert.throws(() => m.recompute(a, 64, 1), /before admission/);
  m.admit(a, hit);
  for (const tokens of [-1, 0.5, NaN, Infinity]) assert.throws(() => m.recompute(a, tokens, 2), /token invariant/);
  for (const time of [-1, 6, NaN, Infinity]) {
    assert.throws(() => m.retract(a, time), /time invariant/);
    assert.throws(() => m.recompute(a, 64, time), /time invariant/);
  }
  const report = m.finish(4, {});
  assert.equal(report.state.retractCount, 0);
  assert.equal(report.state.recomputedTokens, 0);
  assert.equal(report.cache.inputTokens, 64);
});

test('U3 metrics: a zero first-token timestamp is retained instead of replaced by a retry prefill end', () => {
  const m = make({ finiteCapacity: true }), a = req(0, 0);
  a.firstTokenTime = 0; a.prefillEnd = 3;
  m.arrive(a); m.admit(a, hit); m.complete(a);
  assert.equal(m.finish(4, {}).windows.full.latency.ttft.mean, 0);
});

test('U4 metrics: physical P/D records each device and counts TTFT at the common first-token event', () => {
  const m = make({ finiteCapacity: true, configuration: { execution: { instances: 1, pdMode: 2 }, blockMapping: { logical: 64, physical: 32 } } });
  const a = req(0, 1, 4);
  a.prefillEnd = 1.1; a.firstTokenTime = 1.6; a.decodeStart = 1.6;
  m.arrive(a); m.admit(a, hit); m.complete(a);
  m.observe(0, { prefillHbmBytes: 64, prefillHbmCapacityBytes: 128, prefillHbmReservedBytes: 0,
    decodeHbmBytes: 64, decodeHbmCapacityBytes: 256, decodeHbmReservedBytes: 64 });
  m.observe(2, { prefillHbmBytes: 0, decodeHbmBytes: 96, decodeHbmReservedBytes: 0 });
  const result = m.finish(4, {});
  assert.ok(Math.abs(result.windows.full.latency.ttft.mean - 600) < 1e-9);
  const actual = Object.fromEntries(Object.entries(result.samples.timeWeightedMean).filter(([key]) => /^(prefill|decode)Hbm/.test(key)));
  const expected = { prefillHbmBytes: 32, prefillHbmCapacityBytes: 128, prefillHbmReservedBytes: 0,
    decodeHbmBytes: 80, decodeHbmCapacityBytes: 256, decodeHbmReservedBytes: 32 };
  assert.deepEqual(Object.keys(actual), Object.keys(expected));
  for (const [key, value] of Object.entries(expected)) assert.ok(Math.abs(actual[key] - value) < 1e-9, key);
  assert.match(result.state.supportedScope, /single-instance\/32-token\/.*physical-pd/);
});

test('U4 metrics: physical P/D cannot fall back to prefill end when first-token information is missing', () => {
  const m = make({ finiteCapacity: true, configuration: { execution: { pdMode: 2 } } }), a = req(0, 1);
  m.arrive(a); m.admit(a, hit);
  assert.throws(() => m.complete(a), /first.token/);
  assert.equal(m.finish(2, {}).counts.successful, 0);
  a.firstTokenTime = 2.5; a.decodeStart = 2.5;
  m.complete(a);
  assert.equal(m.finish(4, {}).windows.full.latency.ttft.mean, 1500);
  const empty = make({ finiteCapacity: true, configuration: { execution: { pdMode: 2 } } }), zero = req(1, 1, 1.1, 0);
  empty.arrive(zero); empty.admit(zero, hit); empty.complete(zero);
  assert.ok(Math.abs(empty.finish(2, {}).windows.full.latency.ttft.mean - 100) < 1e-9);
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
