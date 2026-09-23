import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runSimulation } from '../../src/core/simulation.js';
import { createReplayCache, replayPageKey } from '../../src/core/replay-cache.js';
import { createReplayRequest, createSyntheticRuntime } from '../../src/core/requests.js';
import { ReplayValidationError } from '../../src/core/replay.js';

const base = JSON.parse(readFileSync(new URL('../fixtures/simulation-baseline.json', import.meta.url)))[0];
const { bundle, expected } = JSON.parse(readFileSync(new URL('../fixtures/replay/runtime-prefix.json', import.meta.url)));
const run = (data = bundle, overrides = {}) => runSimulation(base.params, base.strategy, { seed: 42, qps: data.sessions[0].req.length * 2, blockSize: 64, simMaxTime: 5, ...overrides, replay: { bundle: data, options: { durationSeconds: 0.2, warmupSeconds: 0 } } });

function poolHarness(cap = 100 * 64) {
  const pool = { used: 0, cap, blocks: [], blockIndex: Object.create(null) };
  const cache = createReplayCache({ pool, blockBytes: 64, maxBlockReferences: 1000,
    add: (_, block) => { assert.ok(!pool.blockIndex[block.id]); pool.blockIndex[block.id] = block; pool.blocks.push(block); pool.used += block.size; },
    remove: (_, id) => { const b = pool.blockIndex[id]; delete pool.blockIndex[id]; pool.blocks.splice(pool.blocks.indexOf(b), 1); pool.used -= b.size; },
  });
  const req = (template, id = 0) => createReplayRequest(template, id, 0, { sessionInstanceKey: 'test', requestIndex: id });
  return { cache, pool, req };
}

test('S07: hand-calculated continuous-prefix hits and resident input KV agree with the real engine', () => {
  const result = run();
  assert.equal(result.completed, expected.requests);
  assert.deepEqual(result.hitTok, { l1: expected.hitL1Tokens, l2: 0, l3: 0, miss: expected.missTokens, total: expected.inputTokens });
  assert.equal(result.replay.cache.inputPages, expected.residentInputPages);
  assert.equal(result.replay.cache.outputPages, 0);
  assert.ok(result.replay.cache.hbmBytes > 0);
});

test('S07: concurrent unpublished inputs miss, then publication deduplicates without losing locks', () => {
  const h = poolHarness();
  const template = bundle.sessions[0].req[0];
  const a = h.req(template), b = h.req(template, 1);
  assert.equal(h.cache.place(a, 0).hitL1Tokens, 0);
  assert.equal(h.cache.place(b, 0).hitL1Tokens, 0);
  assert.equal(h.pool.used, 256);
  h.cache.publish(a, 1);
  h.cache.publish(b, 1);
  assert.equal(h.pool.used, 128);
  assert.equal(h.cache.snapshot().deduplicatedPages, 2);
  assert.ok(h.pool.blocks.every(b => b.ready && b.refcount === 2));
  h.cache.release(a, 2);
  assert.ok(h.pool.blocks.every(b => b.refcount === 1));
  h.cache.release(b, 2);
  assert.ok(h.pool.blocks.every(b => b.refcount === 0));
  assert.equal(a.replayTemplate, null); assert.equal(a.ownBlkIds.length, 0); assert.equal(a.prefixBlkIds.length, 0);
});

test('S07: real simultaneous arrival requests do not see uncomputed KV', () => {
  const data = structuredClone(bundle);
  data.sessions[0].req = [0, 1].map(() => structuredClone(bundle.sessions[0].req[0]));
  const result = run(data);
  assert.equal(result.hitTok.l1, 0);
  assert.equal(result.hitTok.miss, 256);
  assert.equal(result.replay.cache.inputPages, 2);
  assert.equal(result.replay.cache.deduplicatedPages, 2);
});

test('S07: missing prefix stops matching even when later pages are present', () => {
  const h = poolHarness();
  const a = h.req(bundle.sessions[0].req[0]);
  h.cache.place(a, 0); h.cache.publish(a, 1); h.cache.release(a, 1);
  delete h.pool.blockIndex[replayPageKey('test', 0)];
  const b = h.req(bundle.sessions[0].req[1], 1);
  assert.equal(h.cache.place(b, 2).hitL1Tokens, 0);
});

test('S07: tail pages count full capacity but valid tokens and extended identities differ', () => {
  const h = poolHarness();
  const a = h.req({ in: 65, out: 0, blockRuns: [[0, 2]] });
  h.cache.place(a, 0); h.cache.publish(a, 1); h.cache.release(a, 1);
  const b = h.req({ in: 128, out: 0, blockRuns: [[0, 2]] }, 1);
  const hit = h.cache.place(b, 2);
  assert.equal(hit.hitL1Tokens, 64); assert.equal(hit.missTokens, 64);
  assert.equal(h.pool.used, 192);
  assert.notEqual(replayPageKey('test', 1, 1), replayPageKey('test', 1, 64));
});

test('S07: anonymous output tail pages grow, retain capacity and never become input hits', () => {
  const h = poolHarness();
  const a = h.req({ in: 64, out: 65, blockRuns: [[0, 1]] });
  h.cache.place(a, 0); h.cache.publish(a, 1);
  for (const tokens of [1, 32, 64, 65]) h.cache.output(a, tokens, 2);
  assert.equal(h.cache.snapshot().outputPages, 2);
  assert.equal(h.pool.used, 192);
  assert.deepEqual(h.pool.blocks.filter(b => b.output).map(b => b.tokens), [64, 1]);
  h.cache.release(a, 3);
  const b = h.req({ in: 128, out: 0, blockRuns: [[0, 2]] }, 1);
  assert.equal(h.cache.place(b, 4).hitL1Tokens, 64);
  const data = structuredClone(bundle);
  data.sessions[0].req = [{ ...data.sessions[0].req[0], out: 1 }];
  assert.equal(run(data).replay.cache.outputPages, 1);
});

test('S07: cold launches, capacity and unsupported pressure are explicit', () => {
  const result = run(bundle, { qps: 30 });
  const n = result.replay.counts.launchedSessions;
  assert.ok(n > 1);
  assert.equal(result.hitTok.l1, n * 192);
  assert.equal(result.hitTok.miss, n * 256);
  const h = poolHarness(128);
  const a = h.req(bundle.sessions[0].req[0]);
  assert.equal(h.cache.place(a, 0).status, 'admitted');
  assert.deepEqual(h.cache.place(h.req(bundle.sessions[0].req[1], 1), 0), { status: 'infeasible' });
  assert.deepEqual(h.cache.place(h.req(bundle.sessions[0].req[0], 2), 0), { status: 'wait' });
  assert.equal(h.pool.used, 128);
});

// U2 public cache acceptance.
function contentRequest(parts, outputLen = 0) {
  let position = 0;
  const inputContent = parts.map(([pathId, tokens]) => {
    const segment = Object.freeze({ pathId, position, tokens });
    position += tokens;
    return segment;
  });
  return { id: 0, inputLen: position, outputLen, inputContent: Object.freeze(inputContent),
    outputIdentity: Object.freeze({ pathId: JSON.stringify(['output', parts]), position, tokens: outputLen }),
    prefixBlkIds: [], ownBlkIds: [], _outAllocTok: 0, _outSeq: 0, prefillTokens: position };
}

function contentHarness(cap = 4096, options = {}) {
  const makePool = cap => ({ cap, used: 0, blocks: [], blockIndex: Object.create(null) });
  const pools = { hbm: makePool(cap), dram: makePool(options.dramCap ?? 4096), ssd: makePool(options.ssdCap ?? 4096) };
  const ratio = options.tierRatio ?? { hbm: 1, dram: 1, ssd: 1 };
  const add = (tier, item) => {
    const p = pools[tier];
    assert.ok(!p.blockIndex[item.id], 'physical IDs must be unique');
    item.tier = tier;
    p.blockIndex[item.id] = item; p.blocks.push(item); p.used += item.size * (ratio[tier] ?? 1);
    assert.ok(p.used <= p.cap, `${tier} capacity exceeded`);
  };
  const remove = (tier, id) => {
    const p = pools[tier], item = p.blockIndex[id];
    assert.ok(item); delete p.blockIndex[id]; p.blocks.splice(p.blocks.indexOf(item), 1);
    p.used -= item.size * (ratio[tier] ?? 1);
  };
  const cache = createReplayCache({ pools, blockBytes: 64, add, remove, ...options, tierRatio: ratio });
  const snapshot = () => structuredClone({ pools, cache: cache.snapshot() });
  return { cache, pools, pool: pools.hbm, add, remove, snapshot };
}

function seedContent(h, parts) {
  const req = contentRequest(parts);
  assert.equal(h.cache.place(req, 0).status, 'admitted');
  h.cache.publish(req, 1); h.cache.release(req, 2);
  return req;
}

test('U2 cache: long segments have offset-specific pages and a missing middle page stops prefix hits', () => {
  const h = contentHarness();
  seedContent(h, [['long-path', 192]]);
  assert.equal(new Set(h.pool.blocks.map(b => b.id)).size, 3);
  h.remove('hbm', h.pool.blocks[1].id);
  assert.equal(h.cache.snapshot().inputPages, 2);
  const req = contentRequest([['long-path', 192]]);
  const before = h.snapshot(), reqBefore = structuredClone(req);
  const { slots, ...lookup } = h.cache.lookup(req, 4);
  assert.deepEqual(lookup, { status: 'admitted', inputTokens: 192,
    hitL1Tokens: 64, hitL2Tokens: 0, hitL3Tokens: 0, missTokens: 128 });
  assert.deepEqual(slots.map(({ position, tokens, hit }) => [position, tokens, hit]), [[0, 64, true], [64, 64, false], [128, 64, false]]);
  assert.equal(slots[0].key, h.pool.blocks[0].id); assert.equal(slots[2].key, h.pool.blocks[1].id);
  assert.deepEqual(h.snapshot(), before); assert.deepEqual(req, reqBefore);
  assert.equal(h.cache.place(req, 4).hitL1Tokens, 64);
  h.cache.publish(req, 5); h.cache.release(req, 6);
  assert.equal(h.pool.used, 192); assert.equal(h.cache.snapshot().deduplicatedPages, 1);
});

for (const [name, change] of [
  ['unavailable', b => { b.available = false; }],
  ['not ready', b => { b.ready = false; }],
  ['future arrival', b => { b.arriveAt = 10; }],
  ['not HBM', b => { b.tier = 'dram'; }],
]) {
  test(`U2 cache: ${name} page and later resident pages cannot yield hits`, () => {
    const h = contentHarness();
    seedContent(h, [['path', 192]]); change(h.pool.blocks[1]);
    const before = h.snapshot();
    assert.equal(h.cache.lookup(contentRequest([['path', 192]]), 3).hitL1Tokens, 64);
    assert.deepEqual(h.snapshot(), before);
  });
}

test('U2 cache: unpublished concurrent inputs deduplicate on publication and release exactly once', () => {
  const h = contentHarness();
  const a = contentRequest([['same', 129]]), b = contentRequest([['same', 129]]);
  assert.equal(h.cache.place(a).missTokens, 129); assert.equal(h.cache.place(b).missTokens, 129);
  assert.equal(h.pool.used, 384);
  h.cache.publish(a, 1); h.cache.publish(a, 1); h.cache.publish(b, 1);
  assert.equal(h.pool.used, 192); assert.equal(h.cache.snapshot().deduplicatedPages, 3);
  assert.ok(h.pool.blocks.every(b => b.refcount === 2 && b.ready));
  h.cache.release(a, 2); h.cache.release(a, 3); h.cache.release(b, 3);
  assert.ok(h.pool.blocks.every(b => b.refcount === 0));
  const before = h.snapshot(); h.cache.release(b, 4, 'abort'); assert.deepEqual(h.snapshot(), before);
  assert.equal(h.cache.lookup(contentRequest([['same', 129]]), 4).hitL1Tokens, 129);
});

test('U2 cache: wait is side-effect free and retry rechecks newly published shared pages', () => {
  const h = contentHarness(64), a = contentRequest([['shared', 64]]), b = contentRequest([['shared', 64]]);
  h.cache.place(a, 0);
  const before = h.snapshot(), reqBefore = structuredClone(b);
  for (let i = 0; i < 3; i++) {
    const { slots, ...lookup } = h.cache.lookup(b, i);
    assert.deepEqual(lookup, { status: 'wait', inputTokens: 64, hitL1Tokens: 0, hitL2Tokens: 0, hitL3Tokens: 0, missTokens: 64 });
    assert.deepEqual(slots.map(({ position, tokens, hit }) => [position, tokens, hit]), [[0, 64, false]]);
    assert.deepEqual(h.cache.place(b, i), { status: 'wait' });
    assert.deepEqual(h.snapshot(), before); assert.deepEqual(b, reqBefore);
  }
  h.cache.publish(a, 3); h.cache.release(a, 3);
  assert.equal(h.cache.place(b, 4).hitL1Tokens, 64);
  assert.equal(h.pool.used, 64); assert.equal(h.pool.blocks[0].refcount, 1);
});

test('U2 cache: wait lookup preserves resident prefix plan without locking or allocating', () => {
  const h = contentHarness(128);
  seedContent(h, [['shared', 64]]);
  const blocker = contentRequest([['busy', 64]]), req = contentRequest([['shared', 64], ['new', 64]]);
  h.cache.place(blocker, 2);
  const before = h.snapshot(), reqBefore = structuredClone(req);
  const { slots, ...lookup } = h.cache.lookup(req, 3);
  assert.deepEqual(lookup, { status: 'wait', inputTokens: 128, hitL1Tokens: 64, hitL2Tokens: 0, hitL3Tokens: 0, missTokens: 64 });
  assert.deepEqual(slots.map(({ position, tokens, hit }) => [position, tokens, hit]), [[0, 64, true], [64, 64, false]]);
  assert.equal(slots[0].key, h.pool.blocks[0].id);
  assert.deepEqual(h.cache.place(req, 3), { status: 'wait' });
  assert.deepEqual(h.snapshot(), before); assert.deepEqual(req, reqBefore);
  slots[0].key = 'caller mutation'; slots[0].hit = false;
  assert.equal(h.cache.lookup(req, 3).slots[0].hit, true);
  h.cache.release(blocker, 4, 'abort');
  assert.equal(h.cache.place(req, 5).hitL1Tokens, 64);
});

test('U2 cache: successful release cannot publish unfinished input and failure still cleans it', () => {
  const h = contentHarness(), req = contentRequest([['unfinished', 64]], 1);
  h.cache.place(req, 0); h.cache.output(req, 1, 1);
  const before = h.snapshot(), reqBefore = structuredClone(req);
  assert.throws(() => h.cache.release(req, 2), /successful release before input publication/);
  assert.deepEqual(h.snapshot(), before); assert.deepEqual(req, reqBefore);
  assert.equal(h.cache.lookup(contentRequest([['unfinished', 64]]), 3).hitL1Tokens, 0);
  h.cache.release(req, 3, 'abort');
  assert.equal(h.pool.used, 0);
  const completed = contentRequest([['finished', 64]], 1);
  h.cache.place(completed, 4); h.cache.publish(completed, 5); h.cache.output(completed, 1, 6);
  h.cache.release(completed, 7);
  assert.equal(h.pool.used, 128); assert.ok(h.pool.blocks.every(b => b.ready && b.refcount === 0));
});

test('U2 cache: infeasible input does not expand a very long lazy RLE', () => {
  const h = contentHarness(64);
  const req = createReplayRequest({ in: 128_000_000, out: 0, blockRuns: [[0, 2_000_000]] }, 0, 0, { sessionInstanceKey: 'large' });
  req.inputContent = { [Symbol.iterator]() { assert.fail('infeasible request expanded'); } };
  assert.deepEqual(h.cache.lookup(req), { status: 'infeasible' });
  assert.deepEqual(h.cache.place(req), { status: 'infeasible' });
  assert.equal(h.pool.used, 0); assert.deepEqual(req.ownBlkIds, []);
});

test('U2 cache: physical reference limits default to 200000 and fail without partial admission', () => {
  const h = contentHarness(Infinity);
  const req = { inputLen: 200001 * 64, inputContent: { [Symbol.iterator]() { assert.fail('limit exceeded before expansion'); } } };
  assert.throws(() => h.cache.place(req), ReplayValidationError);
  assert.equal(h.pool.used, 0);
  const limited = contentHarness(4096, { maxBlockReferences: 2 });
  seedContent(limited, [['old', 64]]);
  const before = limited.snapshot();
  assert.throws(() => limited.cache.place(contentRequest([['new', 128]])), ReplayValidationError);
  assert.deepEqual(limited.snapshot(), before);
});

test('U2 cache: failure deletes unpublished input/output but keeps published shared residency', () => {
  const h = contentHarness();
  const a = contentRequest([['aborted', 65]], 65);
  h.cache.place(a); h.cache.output(a, 65, 1);
  assert.equal(h.pool.used, 256);
  h.cache.release(a, 2, 'abort'); h.cache.release(a, 3, 'abort');
  assert.equal(h.pool.used, 0); assert.equal(h.cache.snapshot().inputPages, 0); assert.equal(h.cache.snapshot().outputPages, 0);
  const b = contentRequest([['published', 65]], 1);
  h.cache.place(b); h.cache.publish(b, 4); h.cache.output(b, 1, 5); h.cache.release(b, 6, 'abort');
  assert.equal(h.pool.used, 128); assert.ok(h.pool.blocks.every(b => b.refcount === 0 && b.ready));
  assert.equal(h.cache.lookup(contentRequest([['published', 65]]), 7).hitL1Tokens, 65);
});

test('U2 cache: output 1 to 65 repairs the former tail and input/output round independently', () => {
  const h = contentHarness();
  const req = contentRequest([['input', 65]], 129);
  h.cache.place(req); h.cache.publish(req, 1);
  assert.deepEqual(h.cache.output(req, 1, 2), { status: 'admitted' });
  assert.deepEqual(h.cache.output(req, 65, 3), { status: 'admitted' });
  assert.deepEqual(h.pool.blocks.filter(b => b.output).map(b => b.tokens), [64, 1]);
  assert.equal(h.pool.used, 256);
  h.cache.output(req, 129, 4);
  assert.deepEqual(h.pool.blocks.filter(b => b.output).map(b => b.tokens), [64, 64, 1]);
  assert.equal(h.pool.used, 320); assert.equal(req._outSeq, 3); assert.equal(req._outAllocTok, 129);
});

test('U2 cache: output wait and infeasible are atomic before tokens, IDs or allocation counters change', () => {
  const h = contentHarness(256);
  const req = contentRequest([['input', 64]], 65), blocker = contentRequest([['blocker', 128]]);
  h.cache.place(req); h.cache.publish(req, 1); h.cache.output(req, 1, 2); h.cache.place(blocker, 2);
  const before = h.snapshot(), reqBefore = structuredClone(req);
  assert.deepEqual(h.cache.output(req, 65, 3), { status: 'wait' });
  assert.deepEqual(h.snapshot(), before); assert.deepEqual(req, reqBefore);
  h.cache.release(blocker, 4, 'abort');
  assert.deepEqual(h.cache.output(req, 65, 5), { status: 'admitted' });
  assert.deepEqual(h.pool.blocks.filter(b => b.output).map(b => b.tokens), [64, 1]);
  const small = contentHarness(128), impossible = contentRequest([['tail-input', 65]], 1);
  small.cache.place(impossible);
  const state = small.snapshot(), original = structuredClone(impossible);
  assert.deepEqual(small.cache.output(impossible, 1, 1), { status: 'infeasible' });
  assert.deepEqual(small.snapshot(), state); assert.deepEqual(impossible, original);
});

test('U2 cache: composite page keys preserve path order, segment offsets, and conservative tail lengths', () => {
  const h = contentHarness();
  seedContent(h, [['A', 32], ['B', 32], ['C', 64]]);
  assert.equal(h.cache.lookup(contentRequest([['A', 32], ['B', 32], ['C', 64]])).hitL1Tokens, 128);
  for (const parts of [[['B', 32], ['A', 32], ['C', 64]], [['A', 16], ['B', 48], ['C', 64]], [['different-context', 32], ['B', 32], ['C', 64]]]) {
    assert.equal(h.cache.lookup(contentRequest(parts)).hitL1Tokens, 0);
  }
  seedContent(h, [['tail', 65]]);
  assert.equal(h.cache.lookup(contentRequest([['tail', 66]])).hitL1Tokens, 64);
  assert.equal(h.cache.lookup(contentRequest([['tail', 65]])).hitL1Tokens, 65);
});

test('U2 cache: output stays unmapped to trace input and only actual completed output identity hits', () => {
  const h = contentHarness();
  const a = createReplayRequest({ in: 64, out: 64, blockRuns: [[0, 1]] }, 0, 0, { sessionInstanceKey: 'trace' });
  h.cache.place(a); h.cache.publish(a, 1); h.cache.output(a, 64, 2); h.cache.release(a, 3);
  const traceNext = createReplayRequest({ in: 128, out: 0, blockRuns: [[0, 2]] }, 1, 0, { sessionInstanceKey: 'trace' });
  assert.equal(h.cache.lookup(traceNext, 4).hitL1Tokens, 64);
  const actual = contentRequest([[Array.from(a.inputContent)[0].pathId, 64], [a.outputIdentity.pathId, 64]]);
  assert.equal(h.cache.lookup(actual, 4).hitL1Tokens, 128);
  const anonymous = contentRequest([['anonymous-input', 64]], 64);
  delete anonymous.outputIdentity;
  h.cache.place(anonymous); h.cache.publish(anonymous, 4); h.cache.output(anonymous, 64, 5); h.cache.release(anonymous, 6);
  assert.equal(h.cache.lookup(contentRequest([['anonymous-input', 64], ['guessed-output', 64]]), 7).hitL1Tokens, 64);
});

test('U2 cache: public synthetic completion generates reusable content without legacy retained handles', () => {
  let draws = 0;
  const source = createSyntheticRuntime({ concurrency: 1, qps: 1, inputLen: 256, outputLen: 64,
    arrivalDist: 'uniform', lenDist: 'fixed', prefixHit: 0, multiTurn: 1, singleBatch: false }, {}, () => { draws++; return 0.5; });
  let parent, child;
  source.drainEvents(1, req => { parent = req; });
  const content = parent.inputContent;
  parent.inputContent = Object.freeze({ *[Symbol.iterator]() { yield* content; } });
  const h = contentHarness();
  h.cache.place(parent, 1); h.cache.publish(parent, 2); h.cache.output(parent, 64, 3);
  parent.tokensGen = 64; h.cache.release(parent, 4);
  assert.equal(source.complete(parent, 4), true); assert.equal(draws, 4);
  source.drainEvents(source.nextTime, req => { child = req; });
  assert.equal(child.inputLen, 320); assert.deepEqual(child.retainIds, []);
  assert.equal(h.cache.place(child, child.arrive).hitL1Tokens, 320);
  assert.equal(source.complete(child, child.arrive + 1), true); assert.equal(draws, 4); assert.equal(source.done, true);
});

test('U2 cache: warm admits only whole placement pages, charges full tail capacity and never invents tier moves', () => {
  const h = contentHarness(128, { dramCap: 32, ssdCap: 32, tierRatio: { hbm: 1, dram: 0.5, ssd: 0.5 } });
  const description = { content: [{ pathId: 'warm', position: 0, tokens: 193 }], placements: [
    { tier: 'dram', position: 0, tokens: 80 }, { tier: 'ssd', position: 80, tokens: 113 },
  ] };
  assert.deepEqual(h.cache.warm([description], 0), { status: 'admitted', pages: 2 });
  assert.equal(h.pools.dram.used, 32); assert.equal(h.pools.ssd.used, 32); assert.equal(h.pool.used, 0);
  assert.deepEqual(h.pools.ssd.blocks.map(b => b.tokens), [64]);
  const before = h.snapshot();
  assert.equal(h.cache.lookup(contentRequest([['warm', 128]]), 1).hitL1Tokens, 0);
  assert.deepEqual(h.snapshot(), before);
  assert.deepEqual(h.cache.warm(description, 2), { status: 'admitted', pages: 0 });
  const tail = { content: [{ pathId: 'tail-warm', position: 0, tokens: 65 }], placements: [{ tier: 'hbm', position: 0, tokens: 65 }] };
  h.cache.warm(tail, 3);
  assert.equal(h.pool.used, 128); assert.deepEqual(h.pool.blocks.map(b => b.tokens), [64, 1]);
  assert.equal(h.cache.lookup(contentRequest([['tail-warm', 65]]), 4).hitL1Tokens, 65);
  h.cache.warm({ content: [{ pathId: 'overflow', position: 0, tokens: 1 }], placements: [{ tier: 'hbm', position: 0, tokens: 1 }] }, 5);
  assert.equal(h.pool.used, 128); assert.equal(h.cache.snapshot().inputPages, 4);
});

test('U2 cache: resource identity and callback bindings isolate equal content and private request IDs', () => {
  const a = contentHarness(128, { resourceId: 'A' }), b = contentHarness(128, { resourceId: 'B' });
  seedContent(a, [['shared-content', 64]]);
  const aBefore = a.snapshot();
  assert.equal(b.cache.lookup(contentRequest([['shared-content', 64]]), 3).hitL1Tokens, 0);
  seedContent(b, [['shared-content', 64]]);
  assert.notEqual(a.pool.blocks[0].id, b.pool.blocks[0].id); assert.deepEqual(a.snapshot(), aBefore);
  const shared = createReplayCache({ pool: a.pool, blockBytes: 64, resourceId: 'other-on-same-pool', add: a.add, remove: a.remove });
  assert.equal(shared.lookup(contentRequest([['shared-content', 64]]), 4).hitL1Tokens, 0);
  assert.equal(shared.snapshot().inputPages, 0); assert.equal(a.cache.snapshot().inputPages, 1);
});
