import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runSimulation } from '../../src/core/simulation.js';
import { DEFAULT_REPLAY_RUN_LIMITS } from '../../src/core/replay.js';
import { visualizationCases, numericalResult } from '../fixtures/replay-visualization.mjs';

// V1 commit 9ea822b, Node 22.22.2; excludes only the three drawing arrays and legacy coverage metadata.
const baselines = {
  prefix: '886ea5985c1279296eefa1de2a82627eade534fabecc681d1fd3b47c69548c88',
  manySuccessful: 'ffb78c80710266e34bcf1da79cf681c5dc4566bde1d1dc97ab0cc84e61a94225',
  mixed: 'ad849a15432dcf7f412cccc4e70d9fa75bc0f537c1de47be984254037541e1d3',
  cutoff: '7cbbd392cc918a6c6a2c3a460941abe3c50bb235d0c9ae1ed20628bb56447925',
  manyUnfinished: '1004e788c9cf06294ebeffcba37d1b892b91bc2033f01cbb3fa9e69202e1b7ec',
  longActive: '1e6f17e8571e05b8cc71bbfc003182c303f97a2da2a7790365edebebd6431c09',
  idle: '70418b0d2cff85b487be8a29125dfe9caf4043bef8f209882432bf59c611fa46',
  zero: 'e4f307ba065a2eb2a82ad130d3058a4510f2735f0d853f399d776798736be6d2',
  futureOnly: '38c1efefc7c846a2a29cabd56912ed252b1e3ca4a185f3a216e1c2459f85d16d',
};
const execute = job => runSimulation(job.params, job.strategy, job.overrides, job.mode);
const results = new Map();
const result = name => {
  if (!results.has(name)) results.set(name, execute(visualizationCases[name]));
  return results.get(name);
};
const rowKeys = ['id', 'templateIndex', 'launchIndex', 'requestIndex', 'arrive', 'admitTime', 'prefillStart', 'prefillEnd', 'completeTime', 'state'];

function assertCoverage(r) {
  const counts = r.replay.counts;
  assert.equal(r.timeline.length, counts.successful);
  assert.equal(r.incomplete.filter(row => row.state === 'failed').length, counts.failed);
  assert.equal(r.incomplete.filter(row => row.state !== 'failed').length, counts.arrivedUnfinished);
  const rows = [...r.timeline, ...r.incomplete];
  assert.equal(rows.length, counts.arrived);
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  assert.equal(new Set(rows.map(row => `${row.launchIndex}:${row.requestIndex}`)).size, rows.length);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), [...rowKeys, ...(row.state === 'failed' ? ['failedAt', 'reason'] : [])].sort());
    const times = ['arrive', 'admitTime', 'prefillStart', 'prefillEnd', 'completeTime'].map(key => row[key]);
    let previous = 0;
    for (const time of times) {
      if (time === null) continue;
      assert.ok(Number.isFinite(time) && time >= previous && time <= r.simEnd, JSON.stringify(row));
      previous = time;
    }
    if (row.state !== 'done') assert.equal(row.completeTime, null);
    else assert.ok(row.completeTime !== null);
    if (row.state === 'failed') assert.ok(row.failedAt >= previous && row.failedAt <= r.simEnd);
  }
  assert.deepEqual(r.concTimeline[0], [0, 0, 0, 0]);
  assert.equal(r.concTimeline.at(-1)[0], r.simEnd);
  for (let i = 0; i < r.concTimeline.length; i++) {
    const point = r.concTimeline[i];
    assert.equal(point.length, 4);
    assert.ok(point.every(Number.isFinite));
    assert.ok(point.slice(1).every(value => Number.isSafeInteger(value) && value >= 0));
    assert.ok(point[0] >= 0 && point[0] <= r.simEnd);
    if (i) assert.ok(point[0] > r.concTimeline[i - 1][0]);
  }
}

for (const name of Object.keys(visualizationCases)) {
  test(`V2: ${name} preserves pre-V2 numerical results and covers every arrived request`, () => {
    const job = visualizationCases[name], before = JSON.stringify(job);
    const r = result(name);
    assert.equal(createHash('sha256').update(JSON.stringify(numericalResult(r))).digest('hex'), baselines[name]);
    assert.equal(JSON.stringify(job), before);
    assertCoverage(r);
  });
}

test('V2: all 400 completed and all 400 cutoff requests survive the old independent 320-row caps', () => {
  const completed = result('manySuccessful'), unfinished = result('manyUnfinished');
  assert.equal(completed.timeline.length, 400);
  assert.equal(unfinished.incomplete.length, 400);
  for (const [r, rows] of [[completed, completed.timeline], [unfinished, unfinished.incomplete]]) {
    assert.deepEqual(rows.map(row => row.id).sort((a, b) => a - b), Array.from({ length: 400 }, (_, i) => i));
    assert.equal(r.replay.counts.arrived, 400);
  }
  assert.equal(completed.replay.samples.requests.length, 320);
  assert.equal(completed.replay.samples.requestCoverage.complete, false);
  assert.ok(completed.timeline.every(row => row.completeTime === row.prefillEnd && row.state === 'done'));
  assert.ok(unfinished.incomplete.some(row => row.state === 'prefilling' && row.prefillStart !== null && row.prefillEnd === null));
  assert.ok(unfinished.incomplete.some(row => row.state === 'prefillQ' && row.prefillStart === null));
  assert.equal(unfinished.concTimeline.at(-1)[3], unfinished.incomplete.filter(row => row.state === 'prefillQ').length);
});

test('V2: infeasible failures have real terminal times, while cancelled and future requests have no rows', () => {
  const mixed = result('mixed'), cutoff = result('cutoff');
  assert.deepEqual(mixed.timeline.map(row => row.id), [2]);
  assert.equal(mixed.incomplete.length, 1);
  const failed = mixed.incomplete[0];
  assert.equal(failed.id, 0);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.reason, 'infeasible');
  assert.equal(failed.failedAt, mixed.replay.samples.requests.find(row => row.state === 'failed').completeTime);
  for (const key of ['admitTime', 'prefillStart', 'prefillEnd', 'completeTime']) assert.equal(failed[key], null);
  assert.equal(mixed.replay.counts.cancelled, 1);
  assert.deepEqual(cutoff.incomplete.map(row => row.id), [0]);
  assert.equal(cutoff.replay.counts.pendingArrival, 1);
  assert.equal(cutoff.replay.counts.waitingAnchor, 1);
  assert.ok(cutoff.incomplete.every(row => row.prefillEnd === null && row.completeTime === null));
});

test('V2: active sampling continues past 20000 points at 10ms and ends at the exact fractional cutoff', () => {
  const r = result('longActive'), series = r.concTimeline;
  assert.ok(series.length > 20_000);
  assert.equal(r.simEnd, 205.831);
  assert.ok(series.some(point => point[0] > 201 && point[1] > 0));
  for (let i = 1; i < series.length; i++) {
    if (series[i - 1][0] < 0.13) continue;
    assert.ok(series[i][0] - series[i - 1][0] <= 0.010000001);
  }
  assert.equal(r.l2Series.length, 20_000);
  assert.equal(r.l3Series.length, 20_000);
  const legacy = r.replay.samples.legacy;
  assert.equal(legacy.maxTimelineSamples, undefined);
  assert.equal(legacy.maxSeriesSamples, undefined);
  assert.equal(legacy.requestCoverage, 'all-arrived-requests');
  assert.equal(legacy.concurrencySampling, 'periodic-with-idle-boundaries');
  assert.equal(legacy.concurrencySampleIntervalSeconds, 0.01);
  assert.deepEqual(legacy.concurrencyCoverage, [0, r.simEnd]);
  assert.equal(legacy.residentMaxSeriesSamples, 20_000);
  assert.equal(legacy.bandwidthSampling, 'first-20000-decode-steps');
});

test('V2: idle jumps have zero-load starts and landing boundaries, without extending old nonzero samples', () => {
  const r = result('idle'), rows = [...r.timeline].sort((a, b) => a.arrive - b.arrive);
  assert.ok(rows.length > 1);
  assert.ok(r.concTimeline.length < 100);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i], nextArrival = rows[i + 1]?.arrive ?? r.simEnd;
    const start = r.concTimeline.find(point => point[0] === row.completeTime);
    assert.deepEqual(start, [row.completeTime, 0, 0, 0]);
    const gap = r.concTimeline.filter(point => point[0] >= row.completeTime && point[0] < nextArrival);
    assert.ok(gap.every(point => point.slice(1).every(value => value === 0)));
    const atAdmission = r.concTimeline.find(point => point[0] === row.admitTime);
    assert.ok(atAdmission, 'idle landing must be recorded even off the 10ms grid');
  }
  assert.deepEqual(r.concTimeline.at(-1), [r.simEnd, 0, 0, 0]);
  for (const name of ['zero', 'futureOnly']) {
    const empty = result(name);
    assert.ok(empty.concTimeline.every(point => point.slice(1).every(value => value === 0)));
    assert.equal(empty.timeline.length + empty.incomplete.length, 0);
  }
});

test('V2: tiny windows and all-infeasible workloads retain exact coverage without synthetic stages', () => {
  for (const durationSeconds of [0.001, 1e-8]) {
    const job = structuredClone(visualizationCases.zero);
    job.overrides.simMaxTime = 0;
    job.overrides.replay.options.durationSeconds = durationSeconds;
    const r = execute(job);
    assert.equal(r.simEnd, Math.max(durationSeconds, 1e-6));
    assertCoverage(r);
    assert.equal(r.timeline.length + r.incomplete.length, 0);
    assert.ok(r.concTimeline.every(point => point.slice(1).every(value => value === 0)));
  }
  const job = structuredClone(visualizationCases.manySuccessful);
  job.overrides.hbmPerGpu = 0;
  const r = execute(job);
  assertCoverage(r);
  assert.equal(r.incomplete.length, 400);
  assert.equal(r.replay.counts.infeasible, 400);
  assert.equal(r.timeline.length, 0);
  assert.ok(r.incomplete.every(row => row.state === 'failed' && row.reason === 'infeasible'
    && row.admitTime === null && row.prefillStart === null && row.prefillEnd === null));
});

test('V2: drain arrivals and exact-cutoff arrivals are included, future arrivals are excluded', () => {
  const job = structuredClone(visualizationCases.futureOnly);
  const origin = execute(job).replay.samples.launches[0].time;
  job.overrides.replay.bundle.sessions[0].req[0].timing.offsetMs = 100;
  job.overrides.simMaxTime = origin + 0.1 - job.overrides.replay.options.durationSeconds;
  const atCutoff = execute(job);
  assertCoverage(atCutoff);
  assert.equal(atCutoff.replay.counts.arrived, 1);
  assert.equal(atCutoff.incomplete[0].arrive, atCutoff.simEnd);
  assert.equal(atCutoff.replay.windows.drain.arrivals, 1);
  job.overrides.replay.bundle.sessions[0].req[0].timing.offsetMs = 101;
  const future = execute(job);
  assertCoverage(future);
  assert.equal(future.replay.counts.pendingArrival, 1);
  assert.equal(future.incomplete.length, 0);
});

test('V2: positive-output idle boundaries await completion settlement and queue depth excludes decodeWait', () => {
  const idleJob = structuredClone(visualizationCases.idle);
  idleJob.overrides.replay.bundle.sessions[0].req[0].out = 2;
  const idle = execute(idleJob);
  assertCoverage(idle);
  for (const row of idle.timeline) {
    assert.deepEqual(idle.concTimeline.find(point => point[0] === row.completeTime), [row.completeTime, 0, 0, 0]);
    const earlyZero = idle.concTimeline.filter(point => point[0] >= row.prefillEnd && point[0] < row.completeTime && point.slice(1).every(value => value === 0));
    // Periodic samples keep the existing queue semantics; only extra idle boundaries require settlement.
    assert.ok(earlyZero.every(point => Math.abs(point[0] / 0.01 - Math.round(point[0] / 0.01)) < 1e-8));
  }
  const job = structuredClone(visualizationCases.longActive);
  const template = job.overrides.replay.bundle.sessions[0].req[0];
  job.overrides.replay.bundle.sessions[0].req.push({ ...structuredClone(template), blockRuns: [[1, 1]] });
  job.overrides.qps = 4;
  job.overrides.simMaxTime = 0.2;
  job.strategy.batching.max_batch_size = 1;
  const r = execute(job);
  assertCoverage(r);
  assert.deepEqual(r.incomplete.map(row => row.state).sort(), ['decodeWait', 'decoding']);
  assert.deepEqual(r.concTimeline.at(-1), [r.simEnd, 1, 0, 0]);
});

test('V2: untruncated drawing data still obeys the result budget and deterministic run isolation', () => {
  const job = structuredClone(visualizationCases.manySuccessful);
  const full = result('manySuccessful');
  assert.ok(Buffer.byteLength(JSON.stringify(full)) < DEFAULT_REPLAY_RUN_LIMITS.maxResultBytes);
  job.overrides.replay.options.limits = { maxResultBytes: 1024 };
  assert.throws(() => execute(job), /replay\.result.*resource limit/);
  assert.deepEqual(execute(visualizationCases.manySuccessful), full);
  assert.deepEqual(execute(visualizationCases.prefix), result('prefix'));
});
