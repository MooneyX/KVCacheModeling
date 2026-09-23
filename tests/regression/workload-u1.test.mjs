import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createSyntheticRuntime, createReplayRequest, generateRequests } from '../../src/core/requests.js';
import { createReplayRuntime, compileReplaySession, flattenReplaySession } from '../../src/core/replay.js';
import { mulberry32 } from '../../src/core/math.js';
import { runSimulation, runWorkloadAcceptance, WORKLOAD_MODEL_VERSION } from '../../src/core/simulation.js';
import { loadLegacy } from '../fixtures/legacy-loader.mjs';
import { baseControls } from '../fixtures/scenarios.mjs';

const read = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const base = read('../fixtures/simulation-baseline.json')[0];
const { bundle } = read('../fixtures/replay/runtime-prefix.json');
const options = { durationSeconds: 0.2, warmupSeconds: 0 };
const fixed = { ...base.params, concurrency: 1, inputLen: 1000, outputLen: 100, qps: 1,
  lenDist: 'fixed', arrivalDist: 'uniform', prefixHit: 0, multiTurn: 1, singleBatch: false };
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const counted = (values = [0.2, 0.25, 0.5, 0.75]) => {
  let count = 0;
  const rng = () => { assert.ok(count < values.length, 'unexpected RNG draw'); return values[count++]; };
  return { rng, get count() { return count; } };
};
const arrive = runtime => {
  const result = [];
  runtime.drainEvents(runtime.nextTime, req => result.push(req));
  return result;
};
function assertContent(req) {
  let position = 0;
  for (const segment of req.inputContent) {
    assert.deepEqual(Object.keys(segment).sort(), ['pathId', 'position', 'tokens']);
    assert.equal(segment.position, position);
    assert.ok(segment.tokens > 0);
    assert.ok(Object.isFrozen(segment));
    position += segment.tokens;
  }
  assert.equal(position, req.inputLen);
  assert.equal(req.outputIdentity.position, req.inputLen);
  assert.equal(req.outputIdentity.tokens, req.outputLen);
  assert.ok(Array.from(req.inputContent).every(segment => segment.pathId !== req.outputIdentity.pathId));
}
function assertNoInternalFields(value, path = 'result') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^result\.(replay\.)?configuration(\.pageLayout)?$/.test(path) && key === 'outputIdentity') {
      assert.ok(['unmapped', 'session-history'].includes(child), `${path}.${key} must be a capability label, not request identity`);
    } else assert.ok(!['sessionId', 'routingKey', 'inputContent', 'outputIdentity', 'sessionInstanceKey'].includes(key), `${path}.${key}`);
    assertNoInternalFields(child, `${path}.${key}`);
  }
}

for (const lenDist of ['fixed', 'uniform', 'lognormal']) {
  test(`U1: synthetic wrapper preserves eager generation and RNG state (${lenDist})`, () => {
    const p = freeze({ ...base.params, lenDist });
    const overrides = freeze({ seed: 42, nreq: 8 });
    const aRng = mulberry32(42), bRng = mulberry32(42), aGroups = {}, bGroups = {};
    const expected = generateRequests(p, overrides, aRng, aGroups);
    const runtime = createSyntheticRuntime(p, overrides, bRng, bGroups);
    assert.deepEqual(runtime.pendingRequests(), expected.requests);
    assert.deepEqual(aGroups, bGroups);
    assert.equal(runtime.initialCount, expected.N);
    assert.equal(aRng(), bRng());
    const snapshot = runtime.pendingRequests();
    snapshot.length = 0;
    assert.equal(runtime.counts().pendingArrival, 8);
    const beforeGroups = structuredClone(bGroups);
    const arrived = [];
    runtime.drainEvents(expected.requests.at(-1).arrive, req => arrived.push(req));
    assert.deepEqual(arrived, expected.requests);
    assert.deepEqual(bGroups, beforeGroups, 'drain must not activate or modify cache groups');
    assert.equal(runtime.nextTime, Infinity);
    assert.equal(runtime.done, false);
    arrived.forEach(assertContent);
  });
}

test('U1: completion owns follow-up sampling, history and exactly-once lifecycle', () => {
  const random = counted();
  let reads = 0, handoffs = 0;
  const runtime = createSyntheticRuntime(freeze({ ...fixed }), freeze({}), random.rng, {}, {
    retainedBlocks: () => { reads++; assert.equal(random.count, 1); return ['legacy-block']; },
    onFollowUp: () => { handoffs++; assert.equal(random.count, 4); },
  });
  const pending = runtime.pendingRequests()[0];
  assert.equal(runtime.complete(pending, 2), false, 'a request must arrive before it can finish');
  assert.equal(random.count, 0);
  const [parent] = arrive(runtime);
  parent.tokensGen = 100;
  assert.equal(runtime.nextTime, Infinity);
  assert.equal(runtime.done, false, 'empty pending does not imply no future follow-up');
  assert.equal(runtime.counts().arrivedUnfinished, 1);
  assert.equal(runtime.complete(parent, 2), true);
  assert.equal(runtime.complete(parent, 2), false);
  assert.equal(runtime.fail(parent, 'abort', 2), false);
  assert.equal(random.count, 4);
  assert.equal(reads, 1); assert.equal(handoffs, 1);
  assert.equal(runtime.nextTime, 4);
  assert.equal(runtime.done, false);
  assert.equal(runtime.counts().activeSessions, 1);
  runtime.drainEvents(3.999, () => assert.fail('future arrival released early'));
  const [child] = arrive(runtime);
  assert.equal(child.id, 1); assert.equal(child.arrive, 4);
  assert.equal(child.inputLen, 1250); assert.equal(child.outputLen, 110);
  assert.equal(child.prefillTokens, 0); assert.equal(parent.prefillTokens, 1000);
  assert.equal(child.followUp, true); assert.equal(child.prevTotalTok, 1000);
  assert.equal(child.sessionId, parent.sessionId); assert.equal(child.routingKey, parent.routingKey);
  assert.equal(child.groupId, null);
  assert.deepEqual(child.retainIds, ['legacy-block']);
  assert.deepEqual(child.inputContent.slice(0, 2), [...parent.inputContent, parent.outputIdentity]);
  assert.equal(child.inputContent[2].tokens, 150);
  assert.notEqual(child.outputIdentity.pathId, parent.outputIdentity.pathId);
  assert.notStrictEqual(child.prefixBlkIds, parent.prefixBlkIds);
  assert.notStrictEqual(child.ownBlkIds, parent.ownBlkIds);
  for (const req of [parent, child]) {
    assertContent(req);
    assert.equal(req._outAllocTok, 0); assert.equal(req._outSeq, 0);
    assert.equal(req._outMerge, 1); assert.equal(req._recomputeTok, 0);
    assert.equal(req._ft0, undefined); assert.equal(req._ft1, undefined);
  }
  assert.equal(runtime.complete(child, 5), true);
  assert.equal(random.count, 4, 'follow-ups must not draw another probability');
  assert.equal(runtime.done, true);
  assert.equal(runtime.counts().planned, 2);
  assert.equal(runtime.counts().successful, 2);
  assert.equal(runtime.counts().unfinished, 0);
  assert.equal(runtime.counts().completedSessions, 1);
});

for (const spec of [
  { name: 'disabled', params: { multiTurn: 0 }, values: [], reads: 0 },
  { name: 'single batch', params: { singleBatch: true }, values: [], reads: 0 },
  { name: 'probability miss', params: { multiTurn: 0.1 }, values: [0.2], reads: 0 },
  { name: 'no retained blocks', params: {}, values: [0.2], reads: 1 },
]) {
  test(`U1: legacy follow-up RNG short-circuit (${spec.name})`, () => {
    const random = counted(spec.values);
    let reads = 0;
    const runtime = createSyntheticRuntime({ ...fixed, ...spec.params }, {}, random.rng, {}, {
      retainedBlocks: () => { reads++; return []; }, onFollowUp: () => assert.fail('unexpected follow-up'),
    });
    const [req] = arrive(runtime);
    assert.equal(runtime.complete(req, 2), true);
    assert.equal(random.count, spec.values.length); assert.equal(reads, spec.reads);
    assert.equal(runtime.counts().planned, 1); assert.equal(runtime.done, true);
  });
}

test('U1: failure settles only once without sampling or creating a dependent request', () => {
  const random = counted([]);
  const runtime = createSyntheticRuntime(fixed, {}, random.rng);
  const [req] = arrive(runtime);
  assert.throws(() => runtime.complete(req, req.arrive - 1), RangeError);
  assert.equal(runtime.done, false);
  assert.equal(runtime.fail(req, 'infeasible', 2), true);
  assert.equal(runtime.fail(req, 'abort', 3), false);
  assert.equal(runtime.complete(req, 3), false);
  assert.equal(random.count, 0); assert.equal(runtime.done, true);
  const counts = runtime.counts();
  assert.equal(counts.failed, 1); assert.equal(counts.infeasible, 1);
  assert.equal(counts.arrived, counts.successful + counts.failed + counts.arrivedUnfinished);
});

test('U1: equal-time follow-ups retain completion insertion order', () => {
  const runtime = createSyntheticRuntime({ ...fixed, concurrency: 2 }, {}, () => 0.5, {}, { retainedBlocks: () => ['block'] });
  const parents = [];
  runtime.drainEvents(2, req => parents.push(req));
  runtime.complete(parents[1], 3); runtime.complete(parents[0], 3);
  const children = arrive(runtime);
  assert.deepEqual(children.map(req => req.id), [2, 3]);
  assert.deepEqual(children.map(req => req.sessionId), [parents[1].sessionId, parents[0].sessionId]);
  assert.deepEqual(children.map(req => req.arrive), [6, 6]);
  children.forEach(req => runtime.fail(req, 'abort', 7));
  assert.equal(runtime.done, true); assert.equal(runtime.counts().completedSessions, 2);
});

test('U1: actual history is clipped to new input and does not depend on retained block coverage', () => {
  for (const [inputLen, outputLen, generated, expected] of [
    [64, 200, 200, [64, 16]], [1000, 100, 7, [1000, 7, 243]],
  ]) {
    const runtime = createSyntheticRuntime({ ...fixed, inputLen, outputLen }, {}, () => 0.5, {}, { retainedBlocks: () => ['unrelated-physical-page'] });
    const [parent] = arrive(runtime);
    parent.tokensGen = generated;
    const historyBefore = structuredClone(parent.inputContent);
    runtime.complete(parent, 2);
    const [child] = arrive(runtime);
    assert.deepEqual(child.inputContent.map(segment => segment.tokens), expected);
    assert.equal(child.inputContent[1].pathId, parent.outputIdentity.pathId);
    assert.deepEqual(parent.inputContent, historyBefore);
    assertContent(child);
    assert.ok(!JSON.stringify(child.inputContent).includes('unrelated-physical-page'));
  }
});

test('U1: prefix groups describe shared content, not sessions; suffix identity includes its context', () => {
  const p = { ...fixed, concurrency: 8, prefixHit: 0.5 };
  const runtime = createSyntheticRuntime(p, {}, mulberry32(42), {}, { retainedBlocks: () => ['page'] });
  const requests = runtime.pendingRequests();
  const parent = requests.find(req => requests.some(other => other !== req && other.groupId === req.groupId));
  const other = requests.find(req => req !== parent && req.groupId === parent.groupId);
  assert.equal(parent.inputContent[0].pathId, other.inputContent[0].pathId);
  assert.notEqual(parent.sessionId, other.sessionId);
  assert.notEqual(parent.inputContent[1].pathId, other.inputContent[1].pathId);
  const changedContext = generateRequests({ ...p, prefixHit: 0.6 }, {}, mulberry32(42), {}).requests.find(req => req.id === parent.id);
  assert.equal(parent.groupId, changedContext.groupId);
  assert.notEqual(parent.inputContent[1].pathId, changedContext.inputContent[1].pathId);
  runtime.drainEvents(requests.at(-1).arrive, () => {});
  parent.tokensGen = parent.outputLen;
  runtime.complete(parent, requests.at(-1).arrive + 1);
  const [child] = arrive(runtime);
  assert.deepEqual(child.inputContent.slice(0, 2), parent.inputContent);
  assert.equal(child.inputContent[2].pathId, parent.outputIdentity.pathId);
  assert.equal(child.sessionId, parent.sessionId);
});

test('U1: initial warm cache is a one-shot immutable content description independent of group handles', () => {
  const groups = {};
  const runtime = createSyntheticRuntime({ ...fixed, concurrency: 8, prefixHit: 0.6,
    prefixCache: 'radix', prefixWarm: true, prefixWarmL2: 0.3 }, {}, mulberry32(42), groups);
  const descriptions = runtime.takeInitialCache();
  assert.equal(descriptions.length, 4); assert.deepEqual(runtime.takeInitialCache(), []);
  for (const entry of descriptions) {
    assert.deepEqual(entry.content.map(segment => segment.tokens), [600]);
    assert.deepEqual(entry.placements, [{ tier: 'dram', position: 0, tokens: 300 }, { tier: 'ssd', position: 300, tokens: 300 }]);
    const member = runtime.pendingRequests().find(req => req.groupId === entry.groupId);
    assert.equal(entry.content[0].pathId, member.inputContent[0].pathId);
    groups[entry.groupId].blkIds.push('physical-page');
    groups[entry.groupId].prefixTokLen = 1;
    assert.equal(entry.content[0].tokens, 600);
    assert.ok(Object.isFrozen(entry)); assert.ok(Object.isFrozen(entry.content[0]));
    assert.ok(!JSON.stringify(entry).includes('physical-page'));
  }
  for (const overrides of [{ prefixWarm: false }, { prefixCache: 'none' }, { prefixHit: 0 }]) {
    const cold = createSyntheticRuntime({ ...fixed, prefixCache: 'radix', prefixHit: 0.6, prefixWarm: true, ...overrides }, {}, mulberry32(42));
    assert.deepEqual(cold.takeInitialCache(), []);
  }
});

const replayRequest = (id, kind = 'origin', anchorReq = null) => ({ in: 64, out: 0,
  blockRuns: [[id, 1]], timing: { kind, anchorReq, offsetMs: 0 } });
const replayRuntime = data => createReplayRuntime({ bundle: freeze(data), options }, { seed: 42, qps: data.sessions[0].req.length * 2 });

test('U1: Replay zero-offset arrival/completion events remain stable and lazy', () => {
  const data = { version: 1, blockSize: 64, sessions: [{ req: [replayRequest(0), replayRequest(1, 'arrival', 0),
    replayRequest(2, 'completion', 0), replayRequest(3, 'completion', 2)] }] };
  const runtime = replayRuntime(data);
  const first = arrive(runtime);
  assert.deepEqual(first.map(req => req.requestIndex), [0, 1]);
  assert.equal(runtime.nextTime, Infinity); assert.equal(runtime.done, false);
  assert.equal(runtime.counts().waitingAnchor, 2);
  assert.equal(runtime.complete(first[0], 1), true);
  assert.equal(runtime.complete(first[0], 1), false);
  const released = [];
  runtime.drainEvents(1, req => { released.push(req); assert.equal(runtime.complete(req, 1), true); });
  assert.deepEqual(released.map(req => req.requestIndex), [2, 3]);
  assert.deepEqual(released.map(req => req.arrive), [1, 1]);
  assert.equal(new Set([...first, ...released].map(req => req.sessionId)).size, 1);
  assert.equal(runtime.done, false);
  runtime.complete(first[1], 1);
  assert.equal(runtime.done, true);
});

test('U1: Replay failure cancels a dependent subtree but not independently released arrival work', () => {
  const data = { version: 1, blockSize: 64, sessions: [{ req: [replayRequest(0), replayRequest(1, 'arrival', 0),
    replayRequest(2, 'completion', 0), replayRequest(3, 'arrival', 2), replayRequest(4, 'completion', 3)] }] };
  const before = JSON.stringify(data);
  const runtime = replayRuntime(data);
  const [parent, independent] = arrive(runtime);
  assert.equal(runtime.fail(parent, 'infeasible', 1), true);
  assert.equal(runtime.fail(parent, 'abort', 1), false);
  assert.equal(runtime.complete(parent, 1), false);
  assert.equal(runtime.counts().cancelled, 3); assert.equal(runtime.counts().anchor_unavailable, 3);
  assert.equal(runtime.done, false); assert.equal(runtime.nextTime, Infinity);
  runtime.complete(independent, 2);
  assert.equal(runtime.done, true);
  const counts = runtime.counts();
  assert.equal(counts.arrived, counts.successful + counts.failed + counts.arrivedUnfinished);
  assert.equal(JSON.stringify(data), before);
});

test('U1: Replay keeps bundle path IDs, ordered runs, tails and per-launch namespaces', () => {
  const raw = { id: 'paths', models: ['test'], block_size: 64, hash_id_scope: 'local', requests: [[1, 9], [2, 9], [1, 9]].map((path, i) =>
    ({ type: 'n', t: i, api_time: 0, model: 'test', in: 128, out: 1, hash_ids: path })) };
  const { session } = compileReplaySession(flattenReplaySession(raw));
  const requests = session.req.map((template, id) => createReplayRequest(freeze(template), id, id, { sessionInstanceKey: 'same-launch', requestIndex: id }));
  const contents = requests.map(req => Array.from(req.inputContent));
  assert.notEqual(contents[0][1].pathId, contents[1][1].pathId);
  assert.deepEqual(contents[0], contents[2]);
  assert.notEqual(requests[0].outputIdentity.pathId, requests[2].outputIdentity.pathId);
  const tail = createReplayRequest({ in: 129, out: 0, blockRuns: [[7, 2], [2, 1]] }, 0, 0, { sessionInstanceKey: 'tail' });
  assert.deepEqual(Array.from(tail.inputContent, segment => [JSON.parse(segment.pathId).at(-1), segment.position, segment.tokens]), [[7, 0, 64], [8, 64, 64], [2, 128, 1]]);
  [tail, ...requests].forEach(assertContent);
  const runtime = createReplayRuntime({ bundle, options }, { seed: 42, qps: 60 });
  const launches = [];
  runtime.drainEvents(0.2, req => launches.push(req));
  assert.ok(launches.length > 1);
  assert.equal(new Set(launches.map(req => req.routingKey)).size, launches.length);
  assert.equal(new Set(launches.map(req => req.inputContent[Symbol.iterator]().next().value.pathId)).size, launches.length);
});

test('U1: long Replay RLE remains lazy before infeasible admission and snapshots template content', () => {
  const pages = 2_000_000;
  const template = { in: pages * 64, out: 0, blockRuns: [[0, pages]], timing: { kind: 'origin', anchorReq: null, offsetMs: 0 } };
  const req = createReplayRequest(template, 0, 0, { sessionInstanceKey: 'large' });
  assert.equal(Array.isArray(req.inputContent), false);
  assert.ok(Object.isFrozen(req.inputContent));
  assert.deepEqual(Object.keys(req.inputContent), []);
  const cursor = req.inputContent[Symbol.iterator]();
  assert.deepEqual(cursor.next().value, { pathId: JSON.stringify(['replay', 'large', 'input', 0]), position: 0, tokens: 64 });
  template.blockRuns[0][0] = 99;
  template.in = 1;
  assert.equal(JSON.parse(cursor.next().value.pathId).at(-1), 1);
  cursor.return();
  assert.equal(req.inputContent[Symbol.iterator]().next().value.tokens, 64);
  const data = freeze({ version: 1, blockSize: 64, sessions: [{ req: [{ ...template, in: pages * 64, blockRuns: [[0, pages]] }] }] });
  const result = runSimulation(base.params, base.strategy, { seed: 42, qps: 2, blockSize: 64, simMaxTime: 5, replay: { bundle: data, options } });
  assert.equal(result.replay.counts.infeasible, 1);
  assert.equal(result.replay.counts.arrived, 1);
  assert.equal(result.truncated, false);
  assertNoInternalFields(result);
});

for (const routePolicy of ['round_robin', 'random', 'power_of_two', 'hash_prefix']) {
  test(`U5: multi-turn default matches accepted isolated routing RNG (${routePolicy})`, () => {
    const legacy = loadLegacy({ ...baseControls, pMultiTurn: '100', pInstances: '2', pRoutePolicy: routePolicy, pPrefixAffinity: true });
    try {
      const overrides = { multiTurn: 1, instances: 2, routePolicy, prefixAffinity: true };
      const historical = legacy.runSimulation(base.strategy, overrides);
      assert.deepEqual(legacy.runSimulation(base.strategy, overrides), historical);
      assert.ok(historical.totalReqs > 8);
      const result = runSimulation(base.params, base.strategy, overrides);
      assert.deepEqual(result, runWorkloadAcceptance(base.params, base.strategy, overrides));
      assert.ok(result.totalReqs > 8);
      assert.equal(result.totalReqs, 16, 'eight parents always produce one follow-up, independent of retained cache handles');
      assert.equal(result.completed, 16);
      assert.equal(result.workloadCounts.followUps, 8);
      assertNoInternalFields(result);
    } finally { legacy.close(); }
  });
}

// Complete-result fingerprints captured before replacing the simulation source boundary.
for (const [extra, hash] of [
  [{}, '7d7050506270772ce5d7d66ea953f8fd5b15265de391f2ef39faa3cb6b7ae4d2'],
  [{ qps: 60 }, 'b848a21ff6df15dbb8e78220483d7e593cd8c3d479a25e0c49a01d5615a341d9'],
  [{ simMaxTime: 0 }, 'a065f6963d4c17ccee272d0b4a1d2ca37d4699b68ebd43cc542d1816b7326b3f'],
  [{ qps: 1e-12 }, '878a1317e1983618a0835f1145e3a2b53c37442c419a3c656131d71f2717fc44'],
]) {
  test(`U5: complete Replay result migrates from U1 to the accepted model ${JSON.stringify(extra)}`, () => {
    const overrides = freeze({ seed: 42, qps: 6, blockSize: 64, simMaxTime: 5, ...extra, replay: { bundle, options } });
    const result = runSimulation(freeze(base.params), freeze(base.strategy), overrides);
    const accepted = runWorkloadAcceptance(base.params, base.strategy, overrides);
    assert.deepEqual(result, accepted);
    const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    assert.equal(fingerprint(result), fingerprint(accepted));
    assert.notEqual(fingerprint(result), hash, 'U1 fingerprints predate physical-page timing, finite capacity, and versioned U5 provenance');
    assert.equal(result.configuration.workloadModelVersion, WORKLOAD_MODEL_VERSION);
    const counts = result.replay.counts;
    assert.equal(counts.arrived, counts.successful + counts.failed + counts.arrivedUnfinished);
    if (overrides.simMaxTime > 0) {
      const source = createReplayRuntime(overrides.replay, { seed: overrides.seed, qps: overrides.qps });
      source.drainEvents(options.durationSeconds, () => {});
      const launches = source.counts().launchedSessions;
      assert.equal(counts.successful, launches * 3);
      assert.deepEqual(result.hitTok, { l1: launches * 192, l2: 0, l3: 0, miss: launches * 256, total: launches * 448 });
      assert.equal(result.replay.cache.inputPages, launches * 4);
      assert.equal(result.replay.cache.outputPages, 0);
    }
    assertNoInternalFields(result);
  });
}
