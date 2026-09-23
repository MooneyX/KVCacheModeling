import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createReplayMetrics } from '../../src/core/replay-metrics.js';
import { DEFAULT_REPLAY_RUN_LIMITS, validateReplayBundle } from '../../src/core/replay.js';
import { runSimulation, WORKLOAD_MODEL_VERSION } from '../../src/core/simulation.js';
import { extractSensMetrics } from '../../src/application/metrics.js';

const base = JSON.parse(readFileSync(new URL('../fixtures/simulation-baseline.json', import.meta.url)))[0];
const { bundle } = JSON.parse(readFileSync(new URL('../fixtures/replay/runtime-prefix.json', import.meta.url)));
const make = options => createReplayMetrics({ durationSeconds: 10, warmupSeconds: 2, hardCutoff: 15,
  stats: validateReplayBundle(bundle), qps: 2, lambdaSession: 2 / 3, seed: 7,
  limits: DEFAULT_REPLAY_RUN_LIMITS, ...options });
const hit = { inputTokens: 64, hitL1Tokens: 16, hitL2Tokens: 16, hitL3Tokens: 0, missTokens: 32 };
const request = (id, arrive, completeTime) => ({ id, templateIndex: 0, launchIndex: 0, requestIndex: id,
  arrive, admitTime: arrive, prefillEnd: arrive + 1, firstTokenTime: arrive + 1,
  decodeStart: arrive + 1, completeTime, inputLen: 64, outputLen: 2 });

function observedResult() {
  const metrics = make({ finiteCapacity: true });
  metrics.launch({ time: 0, templateIndex: 0, launchIndex: 0, requests: 2, inputTokens: 128, outputTokens: 4 });
  for (const req of [request(0, 1, 4), request(1, 3, 12)]) {
    metrics.arrive(req); metrics.admit(req, hit); metrics.complete(req);
  }
  const replay = metrics.finish(15, { truncated: false, terminationReason: 'drained', arrivedUnfinished: 0 });
  return { completed: 2, totalReqs: 2, simEnd: 15, truncated: false, replay,
    avgTtft: 1000, avgTpot: 2500, avgLatency: 6000, throughput: 4 / 15,
    ttftBreakdown: { queue: 100, prefillQ: 200, fetch: 300, compute: 350, xfer: 50, computeNet: 300, computeWait: 50 } };
}

test('U5: measurement arrival cohorts and completion events remain distinct from full-run metrics', () => {
  const result = observedResult(), record = extractSensMetrics(result);
  assert.equal(record.measurement_arrival_qps, 1 / 8);
  assert.equal(record.measurement_completion_qps, 1 / 8);
  assert.equal(record.measurement_ttft, 1000);
  assert.equal(record.measurement_tpot, 4000);
  assert.equal(record.measurement_latency, 9000);
  assert.equal(record.measurement_latency_p50, 9000);
  assert.equal(record.measurement_latency_p99, 9000);
  assert.equal(record.measurement_ttft_samples, 1);
  assert.equal(record.measurement_tpot_samples, 1);
  assert.equal(record.measurement_latency_samples, 1);
  assert.equal(record.measurement_hit_rate, 50);
  assert.equal(result.replay.windows.drain.completionQps, 1 / 5);
  assert.equal(record.throughput, 4 / 15);
  assert.equal(record.ttft, 1000);
  assert.equal(record.tpot, 2500);
  assert.equal(record.latency, 6000);
  assert.equal(record.ttft_queue + record.ttft_prefillq + record.ttft_fetch + record.ttft_xfer
    + record.compute_net + record.compute_wait, record.ttft);
});

test('U5: source summaries are detached and bounded while failures and cutoff never rank as best', () => {
  const result = observedResult(), record = extractSensMetrics(result);
  assert.equal(record.workload.eligibleForComparison, true);
  assert.equal(record.workload.source, 'replay');
  assert.equal('samples' in record.workload, false);
  assert.equal('series' in record.workload, false);
  assert.equal('sessions' in record.workload.bundle, false);
  assert.equal(JSON.stringify(record).length < 25000, true);
  record.workload.configuration.seed = 99;
  record.workload.windows.measurement.latency.ttft.mean = -1;
  assert.equal(result.replay.configuration.seed, 7);
  assert.equal(result.replay.windows.measurement.latency.ttft.mean, 1000);
  for (const counts of [{ failed: 1 }, { cancelled: 1 }, { arrivedUnfinished: 1 }]) {
    const invalid = structuredClone(result); Object.assign(invalid.replay.counts, counts);
    assert.equal(extractSensMetrics(invalid).workload.eligibleForComparison, false);
  }
  assert.equal(extractSensMetrics({ ...result, truncated: true }).workload.eligibleForComparison, false);
});

for (const [finiteCapacity, pdMode, gaugeCount, maxBuckets] of [[false, 0, 6, 20000], [true, 0, 12, 10000], [true, 2, 18, 6666]]) {
  test(`U5: ${gaugeCount} gauges preserve full-window integrals and instantaneous peaks in declared buckets`, () => {
    const metrics = make({ hardCutoff: 40, finiteCapacity, configuration: { execution: { pdMode } } });
    metrics.observe(0, { activeRequests: 2, hbmBytes: 64, dramBytes: 128 });
    metrics.observe(5, { activeRequests: 4, hbmBytes: 96 });
    metrics.observe(5, { activeRequests: 2, hbmBytes: 64 });
    metrics.observe(10, { activeRequests: 0, hbmBytes: 0, dramBytes: 0 });
    const report = metrics.finish(40, { truncated: false });
    assert.equal(report.samples.gaugeCount, gaugeCount);
    assert.equal(report.samples.maxBuckets, maxBuckets);
    assert.equal(report.samples.bucketWidth, Math.max(0.002, 40 / maxBuckets));
    assert.ok(report.samples.series.length <= maxBuckets);
    assert.deepEqual(report.samples.coverage, [0, 40]);
    assert.equal(report.samples.series[0].start, 0);
    assert.equal(report.samples.series.at(-1).end, 40);
    assert.equal(report.samples.peak.activeRequests, 4);
    assert.equal(report.samples.peak.hbmBytes, 96);
    for (const [key, mean] of [['activeRequests', 0.5], ['hbmBytes', 16], ...(finiteCapacity ? [['dramBytes', 32]] : [])]) {
      assert.ok(Math.abs(report.samples.timeWeightedMean[key] - mean) < 1e-9);
      const integral = report.samples.series.reduce((sum, bucket) => sum + (bucket.mean[key] ?? 0) * (bucket.end - bucket.start), 0);
      assert.ok(Math.abs(integral - mean * 40) < 1e-8);
    }
  });
}

test('U5: effective seed, page layout and model identity agree across saved configuration views', () => {
  const overrides = { seed: 0, qps: 6, blockSize: 32, simMaxTime: 1,
    replay: { bundle, options: { durationSeconds: 0.2, warmupSeconds: 0 } } };
  const result = runSimulation({ ...base.params, seed: 99 }, base.strategy, overrides);
  assert.equal(result.configuration, result.replay.configuration);
  assert.equal(result.configuration.seed, 0);
  assert.equal(result.configuration.execution.seed, 0);
  assert.equal(result.configuration.workloadModelVersion, WORKLOAD_MODEL_VERSION);
  assert.deepEqual(result.configuration.blockMapping, { logical: 64, physical: 32 });
  assert.equal(result.configuration.pageLayout.inputOutput, 'separately-rounded');
  assert.equal(result.configuration.outputIdentity, 'unmapped');
  assert.equal(result.completed, 3);
  assert.deepEqual(result.hitTok, { l1: 192, l2: 0, l3: 0, miss: 256, total: 448 });
  assert.equal(extractSensMetrics(result).workload.versions.workloadModel, WORKLOAD_MODEL_VERSION);
});

test('U5: a long empty Replay retains complete resident coverage and null latency samples', () => {
  const result = runSimulation(base.params, base.strategy, { seed: 0, qps: 1e-12, blockSize: 64, simMaxTime: 0,
    replay: { bundle, options: { durationSeconds: 220, warmupSeconds: 2 } } });
  const record = extractSensMetrics(result);
  assert.equal(result.completed, 0);
  assert.equal(result.simEnd, 220);
  assert.equal(record.ttft, null);
  assert.equal(record.measurement_ttft, null);
  assert.equal(record.measurement_tpot, null);
  assert.equal(record.measurement_latency, null);
  assert.equal(record.measurement_ttft_samples, 0);
  assert.equal(record.measurement_completion_qps, 0);
  assert.equal(record.throughput, 0);
  assert.equal(record.workload.eligibleForComparison, false);
  assert.deepEqual(result.concTimeline[0], [0, 0, 0, 0]);
  for (const series of [result.l2Series, result.l3Series]) {
    assert.ok(series.length <= 20000);
    assert.equal(series[0][0], 0);
    assert.equal(series.at(-1)[0], 220);
    assert.ok(series.every(point => point[1] === 0));
  }
  assert.deepEqual(result.replay.samples.coverage, [0, 220]);
});
