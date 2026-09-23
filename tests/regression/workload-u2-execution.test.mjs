import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runSimulation, runWorkloadAcceptance, WORKLOAD_MODEL_VERSION } from '../../src/core/simulation.js';
import { createSyntheticRuntime, createReplayRequest } from '../../src/core/requests.js';
import { createReplayRuntime } from '../../src/core/replay.js';
import { calcAll, estimatePrefillParams } from '../../src/core/calculations.js';

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

function execute(kind, templates, { twoTurn = false, hardCutoff = 8, earliestEnd = 0.2, params = {},
  strategy = base.strategy, warm = [] } = {}) {
  const bundle = bundleOf(templates), before = structuredClone(bundle);
  const qps = templates.length * 2;
  const first = createReplayRuntime({ bundle, options }, { qps, seed: 42 }).nextTime;
  const p = { ...common, inputLen: templates[0].in, outputLen: 64, concurrency: twoTurn ? 1 : templates.length,
    multiTurn: twoTurn ? 1 : 0, ...params };
  const events = [], arrivals = [];
  let summary;
  const result = runWorkloadAcceptance(p, strategy, { seed: 42, qps, simMaxTime: hardCutoff - options.durationSeconds,
    ...(kind === 'replay' ? { replay: { bundle, options } } : {}) }, {
    window: { earliestEnd, hardCutoff },
    source(defaultSource) {
      const source = kind === 'replay' ? defaultSource : createSyntheticRuntime(p, {}, () => 0.5);
      if (kind === 'synthetic') source.pendingRequests().forEach((req, i) => { req.arrive = first + templates[i].timing.offsetMs / 1000; });
      return {
        get nextTime() { return source.nextTime; }, get done() { return source.done; },
        initialCount: source.initialCount, pendingRequests: () => source.pendingRequests?.() || [],
        takeInitialCache: () => warm.length ? structuredClone(warm) : source.takeInitialCache?.() || [], counts: () => source.counts(),
        complete: (req, time) => source.complete(req, time), fail: (req, reason, time) => source.fail(req, reason, time),
        drainEvents(now, emit) {
          source.drainEvents(now, req => {
            const template = templates[req.id];
            assert.ok(template, 'unexpected extra launch or synthetic turn');
            if (twoTurn && req.followUp) assert.equal(req.inputLen, template.in, 'actual synthetic history determines next length');
            const description = createReplayRequest(template, req.id, req.arrive, { sessionId: 'equivalent', requestIndex: req.id });
            req.inputLen = template.in; req.outputLen = template.out;
            req.inputContent = description.inputContent; req.outputIdentity = description.outputIdentity;
            req.routingKey = description.routingKey;
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

for (const blockSize of [16, 32, 64, 128]) {
  test(`U4.1: equivalent sources use B=${blockSize} across RLE boundaries, input tails and output growth`, () => {
    const runs = [[0, 1], [7, 2]];
    const run = equivalent([origin(129, blockSize + 1, 0, runs), origin(129, 0, 2000, runs)], { params: { blockSize } });
    assert.equal(run.result.completed, 2);
    assert.deepEqual(run.result.hitTok, { l1: 129, l2: 0, l3: 0, miss: 129, total: 258 });
    assert.equal(run.summary.cache.inputPages, Math.ceil(129 / blockSize));
    assert.equal(run.summary.cache.outputPages, 2);
    const pages = run.events.at(-1).pages;
    assert.deepEqual(pages.filter(page => page.output).map(page => page.tokens), [blockSize, 1]);
    assert.ok(pages.every(page => page.references === 0));
    close(run.summary.cache.hbmBytes, (Math.ceil(129 / blockSize) + 2) * blockSize * 163840);
  });
}

for (const prefixAffinity of [false, true]) {
  test(`U4.2: private instance caches conserve pages and hits with prefixAffinity=${prefixAffinity}`, () => {
    const run = equivalent([0, 500, 1000, 1500].map(offset => origin(129, 1, offset)), {
      params: { instances: 2, prefixAffinity, blockSize: 32 },
      strategy: { ...base.strategy, routing: { type: 'round_robin' } },
    });
    assert.equal(run.result.completed, 4);
    assert.deepEqual(run.arrivals.map(req => req.instId), [0, 1, 0, 1]);
    assert.deepEqual(run.result.hitTok, { l1: 258, l2: 0, l3: 0, miss: 258, total: 516 });
    assert.equal(run.summary.cache.inputPages, 10);
    assert.equal(run.summary.cache.outputPages, 4);
    for (const event of run.events) {
      close(event.cache.hbmBytes, event.resources.reduce((sum, resource) => sum + resource.cache.hbmBytes, 0));
      for (const resource of event.resources) {
        assert.ok(resource.cache.hbmBytes <= resource.cache.hbmCapacityBytes);
        assert.ok(resource.pages.every(page => page.resourceId === resource.resourceId));
      }
    }
    const last = run.events.at(-1);
    assert.ok(last.pages.every(page => page.references === 0));
    assert.equal(new Set(last.pages.map(page => page.id)).size, last.pages.length);
  });
}

test('U4.2: delayed completion releases only its owner while the other instance continues', () => {
  const run = equivalent([origin(64, 129), origin(64, 1, 0, [[8, 1]])], {
    params: { instances: 2 }, strategy: { ...base.strategy, routing: { type: 'round_robin' } }, hardCutoff: 30,
  });
  assert.equal(run.result.completed, 2);
  const complete = run.events.filter(event => event.type === 'complete');
  assert.deepEqual(complete.map(event => event.id), [1, 0]);
  assert.ok(complete[0].resources[0].pages.some(page => page.references > 0));
  assert.ok(complete[0].resources[1].pages.every(page => page.references === 0));
  assert.ok(complete[1].pages.every(page => page.references === 0));
  assert.equal(run.result.decodeTokensTotal, 130);
  for (const req of run.arrivals) {
    assert.ok(req.decodeStart >= req.prefillEnd);
    assert.ok(req.completeTime > req.decodeStart);
    assert.equal(req.tokensGen, req.outputLen);
  }
});

test('U4.2: shared clock agrees with isolated devices even when their completion boundaries differ', () => {
  const templates = [origin(64, 1, 500), origin(192, 1, 500, [[8, 3]])];
  const together = equivalent(templates, { params: { instances: 2 },
    strategy: { ...base.strategy, routing: { type: 'round_robin' } } });
  const params = { ...common, gpus: 4, tpSize: 4, epSize: 1 };
  const estimate = estimatePrefillParams(params);
  for (const [i, template] of templates.entries()) {
    const alone = execute('replay', [template], { params: { ...params, prefillA: estimate.a,
      prefillB: estimate.b, prefillBIdx: estimate.bIdx } });
    const req = together.arrivals[i], isolated = alone.arrivals[0];
    close(req.prefillEnd - req.arrive, isolated.prefillEnd - isolated.arrive);
    close(req.completeTime - req.arrive, isolated.completeTime - isolated.arrive);
  }
  const cutoff = together.arrivals[0].completeTime;
  const cut = equivalent(templates, { params: { instances: 2 }, hardCutoff: cutoff,
    strategy: { ...base.strategy, routing: { type: 'round_robin' } } });
  assert.equal(cut.result.completed, 1);
  assert.ok(cut.arrivals[1].tokensGen < 1);
});

const pdParams = { pdMode: 2, pdSep: true, pdPrefillGpus: 4, pdLinkBW: 0.1, pdLinkUtil: 0.5, pdKvComp: true };
const pdCapacity = pages => ({ ...pdParams, pdPrefillGpus: 5, tieredKv: false,
  hbmPerGpu: (70.54819328 * 1.02 + 18 + (pages + 0.01) * 0.01048576) / 3 });

for (const blockSize of [32, 128]) {
  test(`U4.3: B=${blockSize} P/D handoff obeys byte/time oracles and grows output only on D`, () => {
    const run = equivalent([origin(129, 65, 500, [[0, 1], [7, 2]])], { params: { ...pdParams, blockSize } });
    const req = run.arrivals[0], bytes = 129 * 163840, duration = bytes / 50_000_000;
    assert.equal(run.result.completed, 1);
    close(req._kvXferEnd - req.prefillEnd, duration);
    close(req.firstTokenTime, req._kvXferEnd);
    assert.ok(req.decodeStart >= req._kvXferEnd);
    close(run.result.avgTtft, (req.firstTokenTime - req.arrive) * 1000);
    const during = run.events.find(event => event.cache.decodeHbmReservedBytes > 0);
    assert.ok(during, 'D capacity must be reserved before KV is ready');
    assert.equal(during.cache.prefillHbmBytes, Math.ceil(129 / blockSize) * blockSize * 163840);
    assert.equal(during.cache.decodeHbmReservedBytes, Math.ceil(129 / blockSize) * blockSize * 163840);
    const start = run.events.find(event => event.type === 'decodeStart');
    assert.equal(start.cache.decodeHbmReservedBytes, 0);
    assert.ok(start.resources.filter(resource => resource.resourceId.includes('prefill')).flatMap(resource => resource.pages).every(page => page.references === 0));
    const last = run.events.at(-1);
    const device = calcAll({ ...common, ...pdParams, blockSize, gpus: 4, tpSize: 4, epSize: 1 });
    assert.equal(last.cache.prefillHbmCapacityBytes, device.availHbm);
    assert.equal(last.cache.decodeHbmCapacityBytes, device.availHbm);
    assert.equal(last.resources.filter(resource => resource.resourceId.includes('prefill')).length, 1);
    assert.equal(last.resources.filter(resource => resource.resourceId.includes('decode')).length, 1);
    assert.equal(last.cache.prefillHbmBytes, Math.ceil(129 / blockSize) * blockSize * 163840);
    assert.equal(last.cache.decodeHbmBytes, (Math.ceil(129 / blockSize) + Math.ceil(65 / blockSize)) * blockSize * 163840);
    assert.ok(last.pages.filter(page => page.output).every(page => page.resourceId.includes('decode')));
    assert.ok(last.pages.every(page => page.references === 0));
    for (const event of run.events) {
      assert.ok(event.cache.prefillHbmBytes <= event.cache.prefillHbmCapacityBytes);
      assert.ok(event.cache.decodeHbmBytes <= event.cache.decodeHbmCapacityBytes);
      close(event.cache.hbmBytes, event.cache.prefillHbmBytes + event.cache.decodeHbmBytes);
    }
    const replay = execute('replay', [origin(129, 65, 500, [[0, 1], [7, 2]])], { params: { ...pdParams, blockSize } });
    close(replay.result.replay.windows.full.latency.ttft.mean, replay.result.avgTtft);
  });
}

for (const pdPrefillGpus of [3, 5]) {
  test(`U4.3: ${pdPrefillGpus === 3 ? 'P' : 'D'} capacity cannot borrow the other side's spare memory`, () => {
    const params = { ...pdCapacity(2), pdPrefillGpus };
    const run = equivalent([origin(192, 1), origin(64, 1, 0, [[8, 1]])], { params, hardCutoff: 30 });
    assert.equal(run.result.completed, 1);
    assert.equal(run.summary.counts.failed, 1);
    assert.ok(run.events.some(event => event.type === 'fail' && event.id === 0));
    assert.ok(!run.events.some(event => event.type === 'decodeStart' && event.id === 0));
    const small = pdPrefillGpus === 3 ? 'prefill' : 'decode';
    assert.ok(run.events.every(event => event.cache[`${small}HbmBytes`] <= event.cache[`${small}HbmCapacityBytes`]));
  });
}

test('U4.3: waiting for D capacity retains P ownership and resumes after a decoder completes', () => {
  const run = equivalent([origin(192, 1), origin(192, 1, 0, [[8, 3]])], { params: pdCapacity(4), hardCutoff: 30 });
  assert.equal(run.result.completed, 2);
  const [first, second] = run.arrivals;
  assert.ok(second._kvX0 >= first.completeTime);
  assert.equal(run.summary.counts.failed, 0);
  assert.ok(run.events.every(event => event.cache.decodeHbmBytes <= event.cache.decodeHbmCapacityBytes));
  assert.ok(run.events.at(-1).pages.every(page => page.references === 0));
});

test('U4.3: a fractional hard cutoff cannot decode or complete before P/D handoff finishes', () => {
  const template = origin(64, 1, 500);
  const full = execute('replay', [template], { params: pdParams });
  const req = full.arrivals[0], cutoff = req.prefillEnd + (req._kvXferEnd - req.prefillEnd) / 2;
  const run = equivalent([template], { params: pdParams, hardCutoff: cutoff });
  assert.equal(run.result.completed, 0);
  assert.equal(run.summary.counts.arrivedUnfinished, 1);
  assert.equal(run.arrivals[0].tokensGen, 0);
  assert.ok(!run.events.some(event => event.type === 'decodeStart' || event.type === 'output'));
  close(run.arrivals[0]._kvXferSent / (64 * 163840), 0.5);
});

test('U4.3: zero-output work completes on P without transferring KV or allocating D pages', () => {
  const run = equivalent([origin(64)], { params: pdParams });
  assert.equal(run.result.completed, 1);
  assert.equal(run.arrivals[0].completeTime, run.arrivals[0].prefillEnd);
  assert.equal(run.summary.cache.decodeHbmBytes, 0);
  assert.ok(!run.events.some(event => event.type === 'decodeStart'));
});

test('U4.3: simultaneous handoffs share one PD link without duplicating bandwidth', () => {
  const run = equivalent([origin(128, 1), origin(128, 1, 0, [[8, 2]])], { params: pdParams });
  assert.equal(run.result.completed, 2);
  const [a, b] = run.arrivals;
  close(a.prefillEnd, b.prefillEnd);
  close(Math.max(a._kvXferEnd, b._kvXferEnd) - a.prefillEnd, 2 * 128 * 163840 / 50_000_000);
  for (const req of run.arrivals) {
    assert.ok(req._kvXferEnd - req.prefillEnd >= 128 * 163840 / 50_000_000 - 1e-10);
    close(req._kvXferSent, 128 * 163840);
    assert.ok(req.decodeStart >= req._kvXferEnd);
  }
});

test('U4.3: independent P computation does not stop an already-ready D decoder', () => {
  const run = equivalent([origin(64, 65), origin(4096, 0, 500, [[8, 64]])], { params: pdParams, hardCutoff: 30 });
  assert.equal(run.result.completed, 2);
  const prefill = run.arrivals[1];
  assert.ok(run.events.some(event => event.id === 0 && event.type === 'output'
    && event.time > prefill.prefillStart && event.time < prefill.prefillEnd));
});

test('U4.3: exact handoff cutoff settles ownership but produces no future output', () => {
  const template = origin(64, 1, 500), params = pdParams;
  const full = execute('replay', [template], { params });
  const cutoff = full.arrivals[0]._kvXferEnd;
  for (const delta of [-1e-8, 0, 1e-8]) {
    const run = equivalent([template], { params, hardCutoff: cutoff + delta });
    assert.equal(run.result.completed, 0);
    const transfers = run.events.filter(event => event.type === 'pdTransferComplete');
    assert.equal(transfers.length, delta < 0 ? 0 : 1);
    if (delta === 0) {
      close(transfers[0].time, cutoff);
      assert.equal(run.arrivals[0].tokensGen, 0);
      assert.equal(run.summary.cache.decodeHbmReservedBytes, 0);
      assert.ok(!run.events.some(event => event.type === 'output'));
    }
  }
});

test('U4.3: D output pressure retracts and re-handoffs generated history without duplicate completion', () => {
  const child = { ...origin(64), timing: { kind: 'completion', anchorReq: 0, offsetMs: 0 } };
  const run = execute('replay', [origin(64, 129), origin(64, 129, 0, [[8, 1]]), child], {
    params: pdCapacity(5), hardCutoff: 30,
  });
  assert.equal(run.result.completed, 3);
  assert.ok(run.summary.retractCount > 0);
  assert.equal(run.result.decodeTokensTotal, 258);
  assert.equal(run.result.hitTok.total, 192);
  assert.equal(run.result.replay.counts.admitted, 3);
  assert.equal(run.events.filter(event => event.type === 'arrive' && event.id === 2).length, 1);
  for (const req of run.arrivals) {
    assert.equal(run.events.filter(event => event.type === 'complete' && event.id === req.id).length, 1);
    if (req.outputLen) {
      close(req.firstTokenTime, run.events.find(event => event.type === 'pdTransferComplete' && event.id === req.id).time);
      assert.equal(req.tokensGen, req.outputLen);
    }
  }
  const retried = run.events.filter(event => event.type === 'pdTransferStart' && event.total > 64 * 163840);
  assert.ok(retried.length > 0, 're-handoff must include already-generated output KV');
  assert.ok(run.events.at(-1).pages.every(page => page.references === 0 && !page.transferLocked));
  for (const event of run.events) {
    assert.ok(event.cache.prefillHbmBytes <= event.cache.prefillHbmCapacityBytes);
    assert.ok(event.cache.decodeHbmBytes <= event.cache.decodeHbmCapacityBytes);
  }
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
  const production = runSimulation(common, base.strategy, { seed: 42, qps: 2, simMaxTime: 7.8, replay: { bundle, options } });
  assert.deepEqual(production, run.result);
  close(production.timeline[0].prefillStart, run.first);
  close(production.timeline[0].completeTime, run.first + 0.064);
  const legacyAdmission = Math.ceil(run.first / 0.002) * 0.002;
  const legacyPrefillStart = legacyAdmission + 0.002;
  const legacyCompleteTime = Math.ceil((legacyPrefillStart + 0.064) / 0.002) * 0.002;
  assert.ok(legacyPrefillStart > production.timeline[0].prefillStart);
  assert.ok(legacyCompleteTime > req.completeTime, 'U5 removes the independently calculated legacy admission/settlement ticks');
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

test('U5: production accepts validated topology and shares unsupported-configuration guards with acceptance', () => {
  for (const execute of [runSimulation, runWorkloadAcceptance]) {
    assert.throws(() => execute(common, base.strategy, { blockSize: 48 }), /blockSize|physical|64/);
    for (const overrides of [{ instances: 0 }, { instances: 1.5 }, { instances: common.gpus + 1 }]) {
      assert.throws(() => execute(common, base.strategy, overrides), /U4\.2 acceptance requires/);
    }
    for (const overrides of [{ ...pdParams, pdPrefillGpus: 0 }, { ...pdParams, pdPrefillGpus: common.gpus },
      { ...pdParams, pdLinkBW: 0 }, { ...pdParams, pdLinkUtil: 2 }]) {
      assert.throws(() => execute(common, base.strategy, overrides), /U4\.3 acceptance/);
    }
    for (const pdMode of [-1, 3]) assert.throws(() => execute(common, base.strategy, { pdMode }), /supported P\/D mode/);
    assert.throws(() => execute(common, base.strategy, { instances: 2, ...pdParams }), /Multiple instances.*P\/D/);
  }
  const overrides = { nreq: 1, inputLen: 64, outputLen: 64, prefixHit: 0, prefixWarm: false };
  for (const topology of [{ pdSep: true }, { pdMode: 1 }, { blockSize: 16 }, { blockSize: 32 }, { blockSize: 128 }, { instances: 2 }, pdParams]) {
    const applied = { ...overrides, ...topology };
    const production = runSimulation(common, base.strategy, applied);
    assert.deepEqual(production, runWorkloadAcceptance(common, base.strategy, applied));
    assert.equal(production.completed, 1); assert.equal(production.decodeTokensTotal, 64);
    assert.deepEqual(production.hitTok, { l1: 0, l2: 0, l3: 0, miss: 64, total: 64 });
  }
  const ordinary = runSimulation(common, base.strategy, overrides);
  const attempted = runSimulation(common, base.strategy, { ...overrides,
    unified: true, acceptance: { window: { hardCutoff: 0 } }, workloadModelVersion: WORKLOAD_MODEL_VERSION });
  assert.deepEqual(attempted, ordinary);
});

const capacityParams = pages => ({
  hbmPerGpu: (70.54819328 * 1.02 + 48 + (pages + 0.01) * 0.01048576) / 8,
  tieredKv: false,
});
const warmPrefix = (template, tiers) => [{
  content: [...createReplayRequest(template, 0, 0, { sessionId: 'equivalent', requestIndex: 0 }).inputContent],
  placements: tiers.map((tier, i) => ({ tier, position: i * 64, tokens: 64 })),
}];

test('U4.3: unrelated P-side slow fetch cannot block D output retraction and progress', () => {
  const slow = origin(64, 0, 1000, [[16, 1]]);
  const run = equivalent([origin(64, 129), origin(64, 129, 0, [[8, 1]]), slow], {
    params: { ...pdCapacity(5), tieredKv: true, ssdBW: 0.00001 },
    warm: warmPrefix(slow, ['ssd']), hardCutoff: 30,
  });
  assert.equal(run.result.completed, 2);
  assert.equal(run.summary.counts.failed, 0);
  assert.equal(run.summary.counts.arrivedUnfinished, 1);
  assert.ok(run.events.some(event => event.type === 'retract'));
  assert.ok(run.events.some(event => event.type === 'transfer-start' && event.from === 'ssd'));
  assert.ok(!run.events.some(event => event.type === 'transfer-complete' && event.from === 'ssd'));
  assert.equal(run.result.decodeTokensTotal, 258);
});

test('U3: physical input pages queue without changing logical denominators', () => {
  const run = equivalent([origin(128, 1), origin(128, 1, 0, [[8, 2]])], { params: capacityParams(3) });
  assert.equal(run.result.completed, 2);
  assert.equal(run.result.hitTok.total, 256);
  assert.ok(run.events.some(event => event.type === 'wait'));
  assert.equal(run.summary.retractCount, 0);
  assert.equal(run.result.activeEvictions, 0);
  assert.ok(run.events.every(event => event.cache.hbmBytes <= event.cache.hbmCapacityBytes));
});

test('U3: output pressure retracts and restores generated history without duplicate tokens or first times', () => {
  const templates = [origin(64, 129), origin(64, 129, 0, [[8, 1]])];
  const run = equivalent(templates, { params: capacityParams(5), hardCutoff: 30 });
  assert.equal(run.result.completed, 2);
  assert.ok(run.summary.retractCount > 0);
  assert.ok(run.summary.recomputedTokens > 0);
  assert.equal(run.result.hitTok.total, 128);
  assert.equal(run.result.prefillTokensTotal, 128);
  assert.equal(run.result.prefillReqDone, 2);
  assert.equal(run.result.decodeTokensTotal, 258);
  for (const req of run.arrivals) {
    const events = run.events.filter(event => event.id === req.id);
    assert.equal(events.filter(event => event.type === 'complete').length, 1);
    assert.equal(req.admitTime, events.find(event => event.type === 'admit').time);
    assert.equal(req.prefillEnd, events.find(event => event.type === 'prefillEnd').time);
    assert.equal(req.decodeStart, events.find(event => event.type === 'decodeStart').time);
    let last = 0;
    for (const event of events.filter(event => event.type === 'output')) {
      assert.ok(event.tokens >= last && event.tokens <= 129);
      last = event.tokens;
    }
    assert.equal(last, 129);
    assert.equal(req.tokensGen, 129);
  }
  const replay = execute('replay', templates, { params: capacityParams(5), hardCutoff: 30 });
  assert.equal(replay.result.replay.counts.admitted, 2);
  assert.equal(replay.result.replay.state.retractCount, replay.summary.retractCount);
  assert.equal(replay.result.replay.state.recomputedTokens, replay.summary.recomputedTokens);
  assert.equal(replay.result.replay.windows.full.cache.recomputedTokens, 64);
  assert.equal(replay.result.replay.windows.measurement.cache.recomputedTokens, 0);
});

test('U4.2: warm caches are real instance-private copies limited by each local tier capacity', () => {
  const request = origin(64);
  for (const dram of [0.015, 0.03]) {
    const run = equivalent([request, request], { params: { instances: 2, dram },
      warm: warmPrefix(request, ['dram']), strategy: { ...base.strategy, routing: { type: 'round_robin' } } });
    assert.equal(run.result.completed, 2);
    const initial = run.events[0], expected = dram === 0.015 ? 0 : 2 * 10485760;
    assert.equal(initial.cache.dramBytes, expected);
    assert.equal(run.result.hitTok.l2, expected ? 128 : 0);
    const ids = initial.resources.flatMap(resource => resource.pages.map(page => page.id));
    assert.equal(new Set(ids).size, ids.length);
    for (const event of run.events) for (const resource of event.resources) {
      assert.ok(resource.cache.dramBytes <= resource.cache.dramCapacityBytes);
    }
  }
});

test('U4.2: the physical reference budget remains global across instance copies', () => {
  const bundle = bundleOf([origin(64), origin(64, 0, 0, [[8, 1]])]);
  assert.throws(() => runWorkloadAcceptance({ ...common, instances: 2, blockSize: 32 },
    { ...base.strategy, routing: { type: 'round_robin' } }, {
      seed: 42, qps: 4, simMaxTime: 5,
      replay: { bundle, options: { ...options, limits: { maxBlockReferences: 2 } } },
    }), /physical block resource limit/);
});

test('U3: infeasible input fails while independently arrived work continues', () => {
  const run = equivalent([origin(256), origin(64, 0, 0, [[8, 1]])], { params: capacityParams(3) });
  assert.equal(run.summary.counts.failed, 1);
  assert.equal(run.result.completed, 1);
  assert.equal(run.result.hitTok.total, 64);
  assert.ok(run.events.some(event => event.id === 0 && event.type === 'fail' && event.reason === 'infeasible'));
});

test('U3: final request abort cancels only completion descendants and never ghost-completes', () => {
  const child = { ...origin(64), timing: { kind: 'completion', anchorReq: 0, offsetMs: 0 } };
  const run = execute('replay', [origin(128, 65), child, origin(64, 0, 0, [[8, 1]])], {
    params: capacityParams(3), hardCutoff: 30,
  });
  assert.equal(run.summary.counts.aborted, 1);
  assert.equal(run.summary.counts.cancelled, 1);
  assert.equal(run.result.completed, 1);
  assert.ok(!run.events.some(event => event.type === 'complete' && event.id === 0));
  assert.ok(!run.events.some(event => event.type === 'arrive' && event.id === 1));
  assert.equal(run.events.filter(event => event.type === 'fail').length, 1);
});

for (const type of ['none', 'best_effort', 'timeout', 'race']) {
  test(`U3: ${type} uses real mixed-tier pages identically for both sources`, () => {
    const request = origin(256, 1);
    const run = equivalent([request], {
      warm: warmPrefix(request, ['dram', 'ssd', 'dram', 'ssd']),
      strategy: { ...base.strategy, prefetch: { type } },
      params: { ssdBW: 0.02, fetchFixedUs: 1000, chunkSize: 64, maxPrefillTok: 64,
        pfTimeoutBase: 0.01, pfTimeoutPerPage: 0 }, hardCutoff: 30,
    });
    assert.equal(run.result.completed, 1);
    assert.deepEqual(run.result.hitTok, { l1: 0, l2: 128, l3: 128, miss: 0, total: 256 });
    assert.ok(run.events.some(event => event.type === 'transfer-start'));
    if (type === 'none') {
      assert.equal(run.result.prefillComputeTokensTotal, 0);
      assert.ok(run.result.transferGB > 0);
      assert.ok(run.events.some(event => event.type === 'transfer-complete'));
    } else {
      assert.ok(run.result.prefillComputeTokensTotal > 0);
      assert.ok(run.events.some(event => event.type === 'transfer-cancel'));
    }
    for (const event of run.events) {
      for (const tier of ['hbm', 'dram', 'ssd']) {
        assert.ok(event.cache[`${tier}Bytes`] <= event.cache[`${tier}CapacityBytes`]);
      }
    }
  });
}

test('U3: slow-tier load-back has an independent two-link time and byte oracle', () => {
  const request = origin(64);
  const run = equivalent([request], { warm: warmPrefix(request, ['ssd']),
    params: { ssdBW: 0.01, pcieBW: 1, dramBW: 400, fetchFixedUs: 500 }, hardCutoff: 30 });
  const pageBytes = 10485760;
  const expected = 0.0005 + pageBytes / (0.01 * 1e9 * 0.9) + pageBytes / 1e9;
  close(run.arrivals[0].prefillEnd - run.arrivals[0].arrive, expected);
  close(run.result.transferGB, 2 * pageBytes / 1e9);
  assert.equal(run.result.prefillComputeTokensTotal, 0);
});

test('U3: shared running input survives a sibling retraction', () => {
  const run = equivalent([origin(64, 129), origin(64, 129)], { params: capacityParams(4), hardCutoff: 30 });
  assert.equal(run.result.completed, 2);
  assert.equal(run.result.hitTok.total, 128);
  assert.ok(run.summary.retractCount > 0);
  const retracted = run.events.find(event => event.type === 'retract');
  assert.ok(retracted.pages.some(page => !page.output && page.references === 1 && page.ready));
  assert.ok(run.events.filter(event => event.type === 'readmit').every(event => event.hit.hitL1Tokens === 64));
  assert.equal(run.result.activeEvictions, 0);
});

test('U3: retraction releases completion successors exactly once, only after successful recovery', () => {
  const child = { ...origin(64), timing: { kind: 'completion', anchorReq: 0, offsetMs: 0 } };
  const run = execute('replay', [origin(64, 129), origin(64, 129, 0, [[8, 1]]), child], {
    params: capacityParams(5), hardCutoff: 30,
  });
  assert.equal(run.result.completed, 3);
  assert.ok(run.events.some(event => event.type === 'retract' && event.id === 0));
  const parent = run.events.filter(event => event.type === 'complete' && event.id === 0);
  const arrivals = run.events.filter(event => event.type === 'arrive' && event.id === 2);
  assert.equal(parent.length, 1); assert.equal(arrivals.length, 1);
  assert.equal(parent[0].time, arrivals[0].time);
  assert.equal(run.result.replay.counts.admitted, 3);
  assert.equal(run.result.replay.state.aborted, 0);
});

test('U3: eviction retains the HBM source until transfer completes and admission waits for that event', () => {
  const run = equivalent([origin(128), origin(128, 0, 500, [[8, 2]])], {
    params: { ...capacityParams(2), tieredKv: true, dram: 0.03, ssd: 0.0001, pcieBW: 0.1 }, hardCutoff: 30,
  });
  assert.equal(run.result.completed, 2);
  assert.equal(run.summary.retractCount, 0);
  const wait = run.events.find(event => event.type === 'wait' && event.id === 1);
  const admit = run.events.find(event => event.type === 'admit' && event.id === 1);
  assert.ok(wait && admit.time > wait.time);
  assert.ok(run.events.some(event => event.type === 'transfer-complete' && event.from === 'hbm' && event.time <= admit.time));
  assert.ok(run.result.transferGB > 0);
  assert.equal(run.result.activeEvictions, 0);
});

test('U3: a fractional deadline charges only elapsed transfer bytes and never makes the target ready', () => {
  const request = origin(64, 0, 500), bundle = bundleOf([request]);
  const first = createReplayRuntime({ bundle, options }, { qps: 2, seed: 42 }).nextTime;
  const run = equivalent([request], { warm: warmPrefix(request, ['ssd']),
    params: { ssdBW: 0.01, fetchFixedUs: 0 }, hardCutoff: first + 0.55 });
  assert.equal(run.result.completed, 0);
  assert.equal(run.result.truncated, true);
  close(run.result.transferGB, 0.05 * 0.01 * 0.9);
  assert.ok(!run.events.some(event => event.type === 'transfer-complete' || event.type === 'prefillEnd'));
  assert.equal(run.summary.counts.arrivedUnfinished, 1);
});

test('U3: a first-hop completion at the hard cutoff cannot schedule a future second hop', () => {
  const request = origin(64, 0, 500), bundle = bundleOf([request]);
  const first = createReplayRuntime({ bundle, options }, { qps: 2, seed: 42 }).nextTime;
  const cutoff = first + 0.5 + 10485760 / (0.01 * 1e9 * 0.9);
  const run = equivalent([request], { warm: warmPrefix(request, ['ssd']),
    params: { ssdBW: 0.01, fetchFixedUs: 0 }, hardCutoff: cutoff });
  assert.equal(run.result.completed, 0);
  assert.ok(run.events.some(event => event.type === 'transfer-complete' && event.to === 'dram'));
  assert.ok(!run.events.some(event => event.type === 'transfer-start' && event.to === 'hbm'));
  close(run.result.transferGB, 10485760 / 1e9);
});

test('U3: race joins a computed head with a physically fetched tail without double-counting work', () => {
  const request = origin(256);
  const run = equivalent([request], { warm: warmPrefix(request, ['ssd', 'ssd', 'ssd', 'ssd']),
    strategy: { ...base.strategy, prefetch: { type: 'race' } },
    params: { ssdBW: 1, fetchFixedUs: 0, chunkSize: 64, maxPrefillTok: 64 } });
  assert.equal(run.result.completed, 1);
  assert.equal(run.result.prefillComputeTokensTotal, 64);
  assert.equal(run.events.filter(event => event.type === 'transfer-complete' && event.to === 'hbm').length, 3);
  close(run.arrivals[0].prefillEnd - run.arrivals[0].arrive, 0.064);
  close(run.result.transferGB, 6 * 10485760 / 1e9);
  assert.equal(run.result.ttftBreakdown.fetch, 0);
});

for (const type of ['best_effort', 'timeout']) {
  test(`U3: ${type} retains completed mixed-tier pages and recomputes only the missing ranges`, () => {
    const blocker = origin(64, 0, 0, [[8, 1]]), request = origin(256);
    const run = equivalent([blocker, request], { warm: warmPrefix(request, ['dram', 'ssd', 'dram', 'ssd']),
      strategy: { ...base.strategy, prefetch: { type } },
      params: { ssdBW: 0.02, fetchFixedUs: 0, chunkSize: 64, maxPrefillTok: 64,
        pfTimeoutBase: 0.002, pfTimeoutPerPage: 0 } });
    assert.equal(run.result.completed, 2);
    const chunks = run.events.filter(event => event.id === 1 && event.type === 'prefillChunk');
    const positions = type === 'best_effort' ? [64, 128, 192] : [64, 192];
    assert.deepEqual(chunks.flatMap(event => event.ranges), positions.map(position => ({ position, tokens: 64 })));
    assert.equal(run.result.prefillComputeTokensTotal, 64 + positions.length * 64);
    assert.ok(run.result.fetchGB > 0);
    assert.ok(run.events.some(event => event.type === 'transfer-cancel'));
  });
}

test('U3: explicit group pulling deduplicates intervals rather than whole sessions', () => {
  const request = origin(128), warm = warmPrefix(request, ['ssd', 'ssd']);
  const run = coalesce => equivalent([request, request], { warm,
    params: { fetchCoalesce: coalesce, ssdBW: 1, fetchFixedUs: 0 } });
  const independent = run(false), shared = run(true);
  assert.equal(independent.result.completed, 2); assert.equal(shared.result.completed, 2);
  close(independent.result.transferGB, 8 * 10485760 / 1e9);
  close(shared.result.transferGB, 4 * 10485760 / 1e9);
  assert.deepEqual(independent.result.hitTok, shared.result.hitTok);
  assert.equal(independent.result.prefillComputeTokensTotal, 0);
  assert.equal(shared.result.prefillComputeTokensTotal, 0);
});

test('U3: final load-back at the hard cutoff settles zero-output success before releasing successors', () => {
  const request = origin(64, 0, 500);
  const child = { ...origin(128), timing: { kind: 'completion', anchorReq: 0, offsetMs: 0 } };
  const params = { ssdBW: 0.01, pcieBW: 1, fetchFixedUs: 500 };
  const baseline = execute('replay', [request, child], { warm: warmPrefix(request, ['ssd']), params });
  const cutoff = baseline.arrivals[0].completeTime;
  for (const delta of [-1e-8, 0, 1e-8]) {
    const run = execute('replay', [request, child], { warm: warmPrefix(request, ['ssd']), params, hardCutoff: cutoff + delta });
    assert.equal(run.result.completed, delta < 0 ? 0 : 1);
    assert.equal(run.summary.counts.successful, delta < 0 ? 0 : 1);
    if (delta >= 0) close(run.arrivals[0].completeTime, cutoff);
    if (delta === 0) {
      assert.equal(run.arrivals.length, 2);
      assert.equal(run.arrivals[1].arrive, cutoff);
      assert.ok(!run.events.some(event => event.id === 1 && event.type === 'admit'));
      assert.equal(run.result.prefillComputeTokensTotal, 0);
    }
  }
});

test('U3: decodeWait remains active in last samples and exact time-weighted request counts', () => {
  const run = execute('replay', [origin(64, 64), origin(64, 64)], {
    strategy: { ...base.strategy, batching: { type: 'continuous', max_batch_size: 1 } },
  });
  assert.equal(run.result.completed, 2);
  const [first, second] = run.arrivals;
  assert.ok(second.decodeStart > second.prefillEnd);
  const duringWait = run.result.replay.samples.series.filter(bucket => bucket.start > first.prefillEnd && bucket.end < first.completeTime);
  assert.ok(duringWait.length > 0);
  for (const bucket of duringWait) {
    assert.equal(bucket.last.activeRequests, 2);
    close(bucket.mean.activeRequests, 2);
    assert.equal(bucket.last.queuedRequests, 0);
  }
  const integral = run.arrivals.reduce((sum, req) => sum + req.completeTime - req.arrive, 0);
  close(run.result.replay.samples.timeWeightedMean.activeRequests, integral / run.result.simEnd);
});

test('U4.2: all routing algorithms leave synthetic source RNG and follow-up session identity unchanged', () => {
  const runs = ['round_robin', 'random', 'power_of_two', 'hash_prefix'].map(type => {
    const arrivals = [];
    const result = runWorkloadAcceptance({ ...common, instances: 2, inputLen: 64, outputLen: 64,
      concurrency: 1, multiTurn: 1, qps: 2 }, { ...base.strategy, routing: { type } }, { seed: 42, nreq: 1 }, {
      window: { earliestEnd: 0, hardCutoff: 30 },
      source(source) {
        const drain = source.drainEvents;
        source.drainEvents = (now, emit) => drain(now, req => { arrivals.push(req); emit(req); });
        return source;
      },
    });
    assert.equal(result.completed, 2);
    const [parent, child] = arrivals;
    assert.equal(child.sessionId, parent.sessionId);
    assert.equal(child.routingKey, parent.routingKey);
    if (type === 'hash_prefix') assert.equal(child.instId, parent.instId);
    return { arrive: parent.arrive, input: parent.inputLen, output: parent.outputLen,
      childInput: child.inputLen, childOutput: child.outputLen, thinkTime: child.arrive - parent.completeTime };
  });
  for (const run of runs.slice(1)) close(run, runs[0]);
});

for (const type of ['round_robin', 'random', 'power_of_two', 'hash_prefix']) {
  test(`U4.2: ${type} produces repeatable Replay routes without disturbing session launches`, () => {
    const run = () => {
      const arrivals = [];
      const result = runWorkloadAcceptance({ ...common, instances: 2 }, { ...base.strategy, routing: { type } }, {
        seed: 42, qps: 60, simMaxTime: 5, replay: { bundle: bundleOf([origin(64, 1)]), options },
      }, {
        source(source) {
          const drain = source.drainEvents;
          source.drainEvents = (now, emit) => drain(now, req => { arrivals.push(req); emit(req); });
          return source;
        },
      });
      assert.equal(result.completed, arrivals.length);
      assert.ok(arrivals.length > 2);
      return arrivals.map(req => ({ id: req.id, routingKey: req.routingKey, arrive: req.arrive,
        instance: req.instId, input: req.inputLen, output: req.outputLen }));
    };
    assert.deepEqual(run(), run());
  });
}

for (const input of [64, 128]) {
  test(`U3: a waiting ${input}-token prefetch cannot force an independently feasible decoder to abort`, () => {
    const first = origin(64, 1, 0, [[8, 1]]), waiting = origin(input, 0, 65);
    const run = equivalent([first, waiting], { warm: warmPrefix(waiting, ['dram']),
      params: { ...capacityParams(2), tieredKv: true, pcieBW: 0.01 }, hardCutoff: 30 });
    assert.equal(run.result.completed, 2);
    assert.equal(run.summary.counts.failed, 0);
    assert.equal(run.result.activeEvictions, 0);
  });
}
