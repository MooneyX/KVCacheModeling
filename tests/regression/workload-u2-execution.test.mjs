import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runSimulation, runWorkloadAcceptance, WORKLOAD_MODEL_VERSION } from '../../src/core/simulation.js';
import { createSyntheticRuntime, createReplayRequest } from '../../src/core/requests.js';
import { createReplayRuntime } from '../../src/core/replay.js';

const base = JSON.parse(readFileSync(new URL('../fixtures/simulation-baseline.json', import.meta.url)))[0];
const options = { durationSeconds: 0.2, warmupSeconds: 0 };
const common = { ...base.params, blockSize: 64, instances: 1, pdMode: 0, pdSep: false,
  prefixHit: 0, prefixWarm: false, prefixWarmL2: 0, singleBatch: false,
  lenDist: 'fixed', arrivalDist: 'uniform', multiTurn: 0, prefillA: 1000, prefillB: 0 };
const origin = (input, output = 0, offsetMs = 0, blockRuns = [[0, Math.ceil(input / 64)]]) =>
  ({ in: input, out: output, blockRuns, timing: { kind: 'origin', anchorReq: null, offsetMs } });
const bundleOf = requests => ({ version: 1, blockSize: 64, sessions: [{ req: requests }] });
const close = (actual, expected, path = '') => {
  if (typeof expected === 'number') assert.ok(Math.abs(actual - expected) < 1e-10, `${path}: ${actual} != ${expected}`);
  else if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual), Object.keys(expected), path);
    for (const key of Object.keys(expected)) close(actual[key], expected[key], `${path}.${key}`);
  } else assert.deepEqual(actual, expected, path);
};

function execute(kind, templates, { twoTurn = false, hardCutoff = 8, earliestEnd = 0.2, params = {} } = {}) {
  const bundle = bundleOf(templates), before = structuredClone(bundle);
  const qps = templates.length * 2;
  const first = createReplayRuntime({ bundle, options }, { qps, seed: 42 }).nextTime;
  const p = { ...common, inputLen: templates[0].in, outputLen: 64, concurrency: twoTurn ? 1 : templates.length,
    multiTurn: twoTurn ? 1 : 0, ...params };
  const events = [], arrivals = [];
  let summary;
  const result = runWorkloadAcceptance(p, base.strategy, { seed: 42, qps, simMaxTime: hardCutoff - options.durationSeconds,
    ...(kind === 'replay' ? { replay: { bundle, options } } : {}) }, {
    window: { earliestEnd, hardCutoff },
    source(defaultSource) {
      const source = kind === 'replay' ? defaultSource : createSyntheticRuntime(p, {}, () => 0.5);
      if (kind === 'synthetic') source.pendingRequests().forEach((req, i) => { req.arrive = first + templates[i].timing.offsetMs / 1000; });
      return {
        get nextTime() { return source.nextTime; }, get done() { return source.done; },
        initialCount: source.initialCount, pendingRequests: () => source.pendingRequests?.() || [],
        takeInitialCache: () => source.takeInitialCache?.() || [], counts: () => source.counts(),
        complete: (req, time) => source.complete(req, time), fail: (req, reason, time) => source.fail(req, reason, time),
        drainEvents(now, emit) {
          source.drainEvents(now, req => {
            const template = templates[req.id];
            assert.ok(template, 'unexpected extra launch or synthetic turn');
            if (twoTurn && req.followUp) assert.equal(req.inputLen, template.in, 'actual synthetic history determines next length');
            const description = createReplayRequest(template, req.id, req.arrive, { sessionId: 'equivalent', requestIndex: req.id });
            req.inputLen = template.in; req.outputLen = template.out;
            req.inputContent = description.inputContent; req.outputIdentity = description.outputIdentity;
            arrivals.push(req); emit(req);
          });
        },
      };
    },
    observe: event => events.push(event), finish: value => { summary = value; },
  });
  assert.deepEqual(bundle, before);
  assert.equal(summary.modelVersion, WORKLOAD_MODEL_VERSION);
  assert.equal(summary.counts.arrived, summary.counts.successful + summary.counts.failed + summary.counts.arrivedUnfinished);
  assert.equal(result.hitTok.total, result.hitTok.l1 + result.hitTok.l2 + result.hitTok.l3 + result.hitTok.miss);
  assert.ok(events.every(event => event.time <= hardCutoff && event.cache.hbmBytes <= event.cache.hbmCapacityBytes));
  return { result, events, summary, arrivals, first };
}

function equivalent(templates, config) {
  const a = execute('synthetic', templates, config), b = execute('replay', templates, config);
  close(a.events, b.events, 'events');
  close(a.summary.cache, b.summary.cache, 'cache');
  const metrics = ['completed', 'totalReqs', 'truncated', 'simEnd', 'hitTok', 'avgTtft', 'p99Ttft', 'avgTpot',
    'avgLatency', 'throughput', 'prefillThroughput', 'prefillComputeThroughput', 'memUtilAvg', 'memUtilPeak', 'ttftBreakdown'];
  for (const key of metrics) close(a.result[key], b.result[key], key);
  return a;
}

test('U2: equivalent single requests use identical compute, output, reference and resource events', () => {
  const run = equivalent([origin(128, 65)]);
  assert.equal(run.result.completed, 1);
  assert.deepEqual(run.result.hitTok, { l1: 0, l2: 0, l3: 0, miss: 128, total: 128 });
  const last = run.events.at(-1);
  assert.deepEqual(last.pages.filter(page => page.output).map(page => page.tokens), [64, 1]);
  assert.ok(last.pages.every(page => page.references === 0));
  assert.equal(run.summary.cache.inputPages, 2); assert.equal(run.summary.cache.outputPages, 2);
});

test('U2: equivalent shared prefixes have hand-calculated 448 = 192 hit + 256 miss tokens', () => {
  const run = equivalent([origin(128), origin(192, 0, 500), origin(128, 0, 1000, [[0, 1], [3, 1]])]);
  assert.deepEqual(run.result.hitTok, { l1: 192, l2: 0, l3: 0, miss: 256, total: 448 });
  assert.equal(run.summary.cache.inputPages, 4);
  for (const req of run.arrivals) assert.ok(req.admitTime >= req.arrive);
});

test('U2: actual synthetic completion-generated second turn agrees with Replay completion dependency', () => {
  const second = { ...origin(320), timing: { kind: 'completion', anchorReq: 0, offsetMs: 3000 } };
  const run = equivalent([origin(256), second], { twoTurn: true });
  assert.equal(run.summary.counts.followUps, 1);
  assert.equal(run.arrivals[1].arrive, run.arrivals[0].completeTime + 3);
  assert.deepEqual(run.result.hitTok, { l1: 256, l2: 0, l3: 0, miss: 320, total: 576 });
  assert.equal(run.summary.cache.inputPages, 5);
});

test('U2: concurrent publication deduplicates without making unfinished KV visible', () => {
  const run = equivalent([origin(128), origin(128)]);
  assert.equal(run.result.hitTok.l1, 0); assert.equal(run.result.hitTok.miss, 256);
  assert.equal(run.summary.cache.inputPages, 2); assert.equal(run.summary.cache.deduplicatedPages, 2);
  assert.equal(Math.max(...run.events.map(event => event.cache.inputPages)), 4);
});

test('U2: zero-output prefill uses the independent 64 * 1000us oracle and removes the legacy admission tick', () => {
  const run = execute('replay', [origin(64)]);
  const req = run.arrivals[0];
  close(req.prefillEnd - req.arrive, 0.064);
  assert.equal(req.completeTime, req.prefillEnd); assert.equal(run.summary.cache.outputPages, 0);
  assert.ok(!run.events.some(event => event.type === 'decodeStart' || event.type === 'output'));
  const bundle = bundleOf([origin(64)]);
  const legacy = runSimulation(common, base.strategy, { seed: 42, qps: 2, simMaxTime: 7.8, replay: { bundle, options } });
  const admission = Math.ceil(run.first / 0.002) * 0.002;
  close(legacy.timeline[0].prefillStart, admission + 0.002);
  close(legacy.timeline[0].completeTime, Math.ceil((admission + 0.002 + 0.064) / 0.002) * 0.002);
  assert.ok(legacy.timeline[0].completeTime > req.completeTime);
});

test('U2: same-time completion successors see published pages before admission', () => {
  const child = { ...origin(128), timing: { kind: 'completion', anchorReq: 0, offsetMs: 0 } };
  const run = execute('replay', [origin(64), child]);
  const complete = run.events.findIndex(event => event.type === 'complete' && event.id === 0);
  const arrive = run.events.findIndex(event => event.type === 'arrive' && event.id === 1);
  const admit = run.events.find(event => event.type === 'admit' && event.id === 1);
  assert.ok(complete < arrive); assert.equal(run.events[complete].time, run.events[arrive].time);
  assert.equal(admit.hit.hitL1Tokens, 64); assert.equal(run.result.completed, 2);
});

test('U2: future arrivals are not executed early and waiting anchors are not mistaken for drain', () => {
  const child = { ...origin(64), timing: { kind: 'completion', anchorReq: 0, offsetMs: 0 } };
  const run = execute('replay', [origin(128), child, origin(64, 0, 1000)], { hardCutoff: 0.2 });
  assert.equal(run.result.truncated, true); assert.equal(run.result.completed, 0);
  assert.equal(run.summary.counts.arrivedUnfinished, 1);
  assert.equal(run.summary.counts.waitingAnchor, 1); assert.equal(run.summary.counts.pendingArrival, 1);
  assert.ok(run.events.every(event => event.id === null || event.id === 0));
});

test('U2: fractional cutoff settles no future prefill or output work', () => {
  const run = equivalent([origin(64, 65)], { hardCutoff: 0.200123 });
  assert.equal(run.result.simEnd, 0.200123); assert.equal(run.result.truncated, true);
  assert.equal(run.summary.cache.outputPages, 0);
  assert.ok(run.arrivals[0].tokensGen >= 0 && run.arrivals[0].tokensGen < 1);
  assert.equal(run.arrivals[0]._outAllocTok, 0);
  const output = run.events.filter(event => event.type === 'output');
  assert.ok(output.length > 0); assert.equal(output.at(-1).time, 0.200123);
});

test('U2: cutoff before arrival creates no pages, and a zero window admits nothing', () => {
  const future = execute('replay', [origin(64, 0, 5000)], { hardCutoff: 0.2 });
  assert.equal(future.arrivals.length, 0); assert.equal(future.summary.cache.hbmBytes, 0);
  const zero = execute('synthetic', [origin(64)], { hardCutoff: 0, earliestEnd: 0 });
  assert.equal(zero.arrivals.length, 0); assert.equal(zero.summary.cache.hbmBytes, 0);
});

test('U2: an arrival exactly at the deadline is recorded but cannot start positive-duration work', () => {
  const templates = [origin(64, 0, 500)];
  const first = createReplayRuntime({ bundle: bundleOf(templates), options }, { qps: 2, seed: 42 }).nextTime;
  const run = equivalent(templates, { hardCutoff: first + 0.5 });
  assert.equal(run.arrivals.length, 1);
  assert.equal(run.summary.counts.arrivedUnfinished, 1);
  assert.equal(run.summary.cache.hbmBytes, 0);
  assert.ok(!run.events.some(event => ['admit', 'prefillStart', 'output'].includes(event.type)));
});

test('U2: unresolved dependencies without executable work or future events fail explicitly', () => {
  assert.throws(() => runWorkloadAcceptance(common, base.strategy, {}, {
    source: () => ({ nextTime: Infinity, done: false, initialCount: 0, pendingRequests: () => [],
      counts: () => ({ planned: 1 }), drainEvents() {} }),
  }), /unresolved anchors/);
});

test('U2: restricted development scope rejects unsupported topology and does not change the production entry', () => {
  for (const overrides of [{ blockSize: 32 }, { instances: 2 }, { pdMode: 2 }, { pdSep: true }]) {
    assert.throws(() => runWorkloadAcceptance(common, base.strategy, overrides), /U2 acceptance requires/);
  }
  const overrides = { nreq: 1, inputLen: 64, outputLen: 64, prefixHit: 0, prefixWarm: false };
  const ordinary = runSimulation(common, base.strategy, overrides);
  const attempted = runSimulation(common, base.strategy, { ...overrides,
    unified: true, acceptance: { window: { hardCutoff: 0 } }, workloadModelVersion: WORKLOAD_MODEL_VERSION });
  assert.deepEqual(attempted, ordinary);
});
