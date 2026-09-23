import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runSimulation } from '../../src/core/simulation.js';
import { calcAll } from '../../src/core/calculations.js';
import { createReplayRuntime, flattenReplaySession, compileReplaySession, validateReplayOverride } from '../../src/core/replay.js';
import { createReplayRequest } from '../../src/core/requests.js';

const read = name => JSON.parse(readFileSync(new URL(name, import.meta.url)));
const base = read('../fixtures/simulation-baseline.json')[0];
const { bundle } = read('../fixtures/replay/runtime-prefix.json');
const options = { durationSeconds: 0.2, warmupSeconds: 0 };
const run = (data = bundle, overrides = {}, opts = options) => runSimulation(base.params, base.strategy, {
  seed: 42, qps: data.sessions[0].req.length * 2, blockSize: 64, simMaxTime: 5, ...overrides, replay: { bundle: data, options: opts },
});
const request = (input, id, kind = 'origin', anchorReq = null, offsetMs = 0, output = 0) => ({ in: input, out: output, blockRuns: [[id, Math.ceil(input / 64)]], timing: { kind, anchorReq, offsetMs } });

test('S06: initialized replay requests preserve exact lengths, output zero and fresh runtime arrays', () => {
  const template = request(1, 0);
  const a = createReplayRequest(template, 1, 0.2, {});
  const b = createReplayRequest(template, 2, 0.3, {});
  assert.equal(a.inputLen, 1); assert.equal(a.outputLen, 0);
  assert.equal(a._outAllocTok, 0); assert.equal(a._outMerge, 1);
  assert.equal(a._ft0, undefined); assert.equal(a._ft1, undefined);
  assert.notStrictEqual(a.prefixBlkIds, b.prefixBlkIds);
  assert.notStrictEqual(a.ownBlkIds, b.ownBlkIds);
});

test('S06: controlled original service durations reconstruct the flattened trace arrivals', () => {
  const flat = flattenReplaySession(read('../fixtures/replay/session-interleaved.json'));
  const data = { version: 1, blockSize: 64, sessions: [compileReplaySession(flat).session] };
  const runtime = createReplayRuntime({ bundle: data, options }, { seed: 42, qps: flat.requests.length * 2 });
  const origin = runtime.nextTime;
  const arrivals = [], completions = [];
  while (!runtime.done) {
    const time = Math.min(runtime.nextTime, ...completions.map(r => r.completeTime));
    assert.ok(Number.isFinite(time));
    for (let i = completions.length - 1; i >= 0; i--) if (completions[i].completeTime <= time) {
      const req = completions.splice(i, 1)[0];
      assert.equal(runtime.complete(req, time), true);
      assert.equal(runtime.complete(req, time), false);
    }
    runtime.drainEvents(time, req => {
      arrivals[req.requestIndex] = req.arrive - origin;
      req.completeTime = req.arrive + flat.requests[req.requestIndex].apiMs / 1000;
      completions.push(req);
    });
  }
  arrivals.forEach((value, i) => assert.ok(Math.abs(value - flat.requests[i].tMs / 1000) < 1e-12));
  assert.equal(runtime.counts().successful, flat.requests.length);
});

test('S06: real engine executes completion anchors, arrival anchors and out=0 without synthetic followups', () => {
  const data = { version: 1, blockSize: 64, sessions: [{ req: [request(128, 0), request(64, 2, 'arrival', 0, 10), request(64, 3, 'completion', 0, 20)] }] };
  const a = run(data);
  const b = run(data, { prefillA: base.params.prefillA * 3, prefillB: base.params.prefillB * 3 });
  for (const result of [a, b]) {
    const timeline = new Map(result.timeline.map(req => [req.id, req]));
    assert.equal(result.completed, 3); assert.equal(result.totalReqs, 3);
    assert.equal(result.decodeTokensTotal, 0); assert.equal(result.truncated, false);
    assert.ok(Math.abs(timeline.get(1).arrive - timeline.get(0).arrive - 0.01) < 1e-12);
    assert.ok(Math.abs(timeline.get(2).arrive - timeline.get(0).completeTime - 0.02) < 1e-12);
    assert.ok(result.timeline.every(q => q.completeTime === q.prefillEnd));
  }
  assert.equal(a.timeline.find(q => q.id === 0).arrive, b.timeline.find(q => q.id === 0).arrive);
  assert.notEqual(a.timeline.find(q => q.id === 2).arrive, b.timeline.find(q => q.id === 2).arrive);
});

test('S06: oversized input fails without cancelling independently released arrival successors', () => {
  const r = calcAll({ ...base.params, blockSize: 64 });
  const pages = Math.floor(r.availHbm / r.blockBytes) + 1;
  const data = { version: 1, blockSize: 64, sessions: [{ req: [request(pages * 64, 0), request(64, pages, 'completion', 0), request(64, pages + 1, 'arrival', 0)] }] };
  const result = run(data);
  assert.equal(result.replay.counts.infeasible, 1);
  assert.equal(result.replay.counts.failed, 1);
  assert.equal(result.replay.counts.cancelled, 1);
  assert.equal(result.replay.counts.anchor_unavailable, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.latencies.length, 1);
  assert.equal(result.truncated, false);
});

test('S06: hard cutoff distinguishes arrived, future-arrival and waiting-anchor requests', () => {
  const data = { version: 1, blockSize: 64, sessions: [{ req: [request(128, 0), request(64, 2, 'arrival', 0, 10_000), request(64, 3, 'completion', 0)] }] };
  const result = run(data, { simMaxTime: 0 }, { durationSeconds: 0.13, warmupSeconds: 0 });
  assert.equal(result.simEnd, 0.13);
  assert.equal(result.truncated, true);
  assert.equal(result.replay.state.terminationReason, 'hard_cutoff');
  assert.equal(result.replay.counts.arrivedUnfinished, 1);
  assert.equal(result.replay.counts.pendingArrival, 1);
  assert.equal(result.replay.counts.waitingAnchor, 1);
  assert.equal(result.replay.counts.unfinished, 3);
});

test('S06: zero launches and future-only events finish or fast-forward without hanging', () => {
  const zero = run(bundle, { qps: 1e-12 });
  assert.equal(zero.totalReqs, 0); assert.equal(zero.truncated, false);
  assert.ok(zero.simEnd >= options.durationSeconds);
  const data = { version: 1, blockSize: 64, sessions: [{ req: [request(64, 0, 'origin', null, 10_000)] }] };
  const future = run(data, { simMaxTime: 0.3 });
  assert.equal(future.simEnd, 0.5); assert.equal(future.replay.counts.pendingArrival, 1);
  assert.equal(future.replay.counts.arrived, 0);
});

test('S06: synthetic-only knobs are bypassed, inputs immutable and successive runs isolated', () => {
  const before = JSON.stringify({ bundle, base });
  const a = run();
  const b = run(bundle, { inputLen: 8192, outputLen: 999, concurrency: 100, prefixHit: 1, prefixWarm: true, prefixWarmL2: 1, multiTurn: 1, singleBatch: true, nreq: 999, arrivalDist: 'uniform', lenDist: 'lognormal' });
  assert.deepEqual(a, b);
  assert.deepEqual(a, run());
  assert.equal(JSON.stringify({ bundle, base }), before);
});

test('U5: accepted topologies run and unsupported configurations or runtime options fail explicitly', () => {
  for (const overrides of [{ instances: 2 }, { blockSize: 32 }, { pdMode: 2 }]) {
    const result = run(bundle, overrides);
    assert.equal(result.replay.counts.successful, bundle.sessions[0].req.length);
    assert.equal(result.replay.counts.failed, 0);
  }
  for (const overrides of [{ instances: 2, pdMode: 2 }, { blockSize: 48 }, { qps: 0 }, { simMaxTime: -1 }, { blockSize: 1.5 }]) assert.throws(() => run(bundle, overrides));
  for (const opts of [{ ...options, superblocks: true }, { ...options, arrivalModel: 'open' }, { durationSeconds: 1 }, { durationSeconds: 1, warmupSeconds: 1 }, { ...options, extra: 1 }]) {
    assert.throws(() => validateReplayOverride({ bundle, options: opts }));
  }
});
