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
  assert.equal(result.replay.cache.hbmBytes, 4 * 64 * 163840);
});

test('U5: production completion dependencies reuse published pages with independent 128/64/64ms prefill times', () => {
  const result = run(bundle, { prefillA: 1000, prefillB: 0, prefillBIdx: 0 });
  assert.equal(result.completed, 3);
  assert.deepEqual(result.hitTok, { l1: 192, l2: 0, l3: 0, miss: 256, total: 448 });
  const rows = [...result.timeline].sort((a, b) => a.requestIndex - b.requestIndex);
  for (const [index, duration] of [0.128, 0.064, 0.064].entries()) {
    const row = rows[index];
    assert.equal(row.admitTime, row.arrive); assert.equal(row.prefillStart, row.arrive);
    assert.ok(Math.abs(row.prefillEnd - row.prefillStart - duration) < 1e-10);
    assert.equal(row.completeTime, row.prefillEnd);
    assert.equal(row.firstTokenTime, row.prefillEnd); assert.equal(row.decodeStart, null);
    if (index) assert.equal(row.arrive, rows[index - 1].completeTime);
  }
  assert.ok(Math.abs(result.avgTtft - 256 / 3) < 1e-10);
  assert.equal(result.replay.cache.hbmBytes, 4 * 64 * 163840);
  assert.equal(result.replay.cache.outputPages, 0);
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
  const cache = createReplayCache({ pools, blockBytes: options.blockSize ?? 64, add, remove, ...options, tierRatio: ratio });
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

function finiteHarness(cap = 512, options = {}) {
  const events = [], links = {};
  for (const [from, to] of [['hbm', 'dram'], ['dram', 'ssd']]) {
    const a = links[`${from}>${to}`] = { bw: 64, busyUntil: 0 };
    const b = links[`${to}>${from}`] = { bw: 64, busyUntil: 0 };
    a.shared = b; b.shared = a;
  }
  const h = contentHarness(cap, { finiteCapacity: true, links, onEvent: event => events.push(event), ...options });
  return { ...h, events, links };
}
function warmTier(h, req, tier) {
  h.cache.warm({ content: req.inputContent, placements: [{ position: 0, tokens: req.inputLen, tier }] });
}
function computeInput(h, req, now) {
  const ranges = h.cache.computeRanges(req, now);
  h.cache.claimCompute(req, ranges, now);
  h.cache.completeCompute(req, ranges, now);
  h.cache.publish(req, now);
}

test('U3 cache: lookup preserves mixed-tier positions and stops at an unpublished middle page', () => {
  const h = finiteHarness(), req = contentRequest([['mixed', 256]]);
  h.cache.warm({ content: req.inputContent, placements: ['ssd', 'dram', 'ssd', 'hbm']
    .map((tier, i) => ({ tier, position: i * 64, tokens: 64 })) });
  const before = h.snapshot();
  const plan = h.cache.lookup(req);
  assert.deepEqual(plan.slots.map(slot => [slot.position, slot.tier]), [[0, 'ssd'], [64, 'dram'], [128, 'ssd'], [192, 'hbm']]);
  assert.deepEqual(h.snapshot(), before);
  h.pools.dram.blocks[0].ready = false;
  const missing = h.cache.lookup(req);
  assert.equal(missing.hitL3Tokens, 64); assert.equal(missing.missTokens, 192);
  assert.deepEqual(missing.slots.map(slot => slot.hit), [true, false, false, false]);
});

test('U3 cache: running references, pinned pages and transfer locks are never victims', () => {
  for (const protection of ['refcount', 'pinned', 'transferLocked']) {
    const h = finiteHarness(64), first = contentRequest([['protected', 64]]);
    warmTier(h, first, 'hbm');
    h.pool.blocks[0][protection] = 1;
    const before = h.snapshot();
    assert.equal(h.cache.place(contentRequest([['new', 64]]), 0).status, 'wait');
    assert.deepEqual(h.snapshot(), before);
    assert.equal(h.events.length, 0);
  }
});

test('U3 cache: eviction reserves the destination but retains the locked source until completion', () => {
  const h = finiteHarness(64), req = contentRequest([['cached', 64]]);
  warmTier(h, req, 'hbm');
  assert.equal(h.cache.place(contentRequest([['new', 64]]), 0).status, 'wait');
  const record = h.cache.ledger[0];
  assert.equal(record.fromPool, h.pools.hbm); assert.equal(record.toPool, h.pools.dram);
  assert.equal(record.reservation, 64); assert.equal(record.end, 1);
  assert.equal(h.pool.used, 64); assert.equal(h.pools.dram.used, 64);
  assert.ok(record.source.transferLocked); assert.equal(record.target.ready, false);
  assert.equal(h.cache.snapshot().dramReservedBytes, 64);
  h.cache.advance(0.5);
  assert.equal(h.pool.used, 64); assert.equal(record.target.ready, false);
  h.cache.advance(1);
  assert.equal(h.pool.used, 0); assert.equal(h.pools.dram.used, 64);
  assert.equal(record.target.ready, true); assert.equal(record.source.transferLocked, false);
  assert.equal(h.cache.snapshot().dramReservedBytes, 0);
});

test('U3 cache: opposite directions and prefetch share one link ledger without double bandwidth', () => {
  const h = finiteHarness(), down = contentRequest([['down', 64]]), up = contentRequest([['up', 64]]);
  warmTier(h, down, 'hbm'); warmTier(h, up, 'dram');
  const move = h.cache.scheduleTransfer(h.pool.blocks[0], 'hbm', 'dram', 0, { move: true });
  h.cache.prefetch(up, 0, { type: 'none' });
  const read = h.cache.ledger.find(record => record.prefetch);
  assert.equal(move.start, 0); assert.equal(move.end, 1);
  assert.equal(read.start, 1); assert.equal(read.end, 2);
  h.cache.advance(1);
  assert.equal(read.target.ready, false);
  h.cache.advance(2);
  assert.equal(read.target.ready, true);
  assert.equal(h.events.filter(event => event.type === 'transfer-progress').reduce((n, event) => n + event.bytes, 0), 128);
});

test('U3 cache: cancellation retains completed pages, frees unfinished reservations and counts elapsed bytes', () => {
  const h = finiteHarness(), req = contentRequest([['cancel', 128]]);
  h.links['dram>hbm'].bw = h.links['hbm>dram'].bw = 640;
  warmTier(h, req, 'ssd');
  h.cache.prefetch(req, 0, { type: 'none' });
  assert.equal(h.cache.snapshot().hbmReservedBytes, 128);
  h.cache.advance(1.5);
  assert.equal(h.cache.lookup(req, 1.5).hitL1Tokens, 64);
  h.cache.cancel(req, 1.5);
  assert.equal(h.cache.pending, 0);
  assert.equal(h.pool.used, 64);
  assert.equal(h.cache.snapshot().hbmReservedBytes, 0);
  assert.ok(Object.values(h.pools).flatMap(pool => pool.blocks).every(page => !page.transferLocked));
  const bytes = h.events.filter(event => event.type === 'transfer-progress').reduce((n, event) => n + event.bytes, 0);
  assert.equal(bytes, 160);
  const completed = h.events.filter(event => event.type === 'transfer-complete').length;
  h.cache.advance(10);
  assert.equal(h.events.filter(event => event.type === 'transfer-complete').length, completed);
});

test('U3 cache: cancelling one group subscriber cannot cancel another request load-back', () => {
  const h = finiteHarness(), first = contentRequest([['shared-pull', 64]]), second = contentRequest([['shared-pull', 64]]);
  warmTier(h, first, 'ssd');
  h.cache.prefetch(first, 0, { type: 'none', coalesce: true });
  h.cache.prefetch(second, 0, { type: 'none', coalesce: true });
  h.cache.cancel(first, 0.5);
  assert.equal(h.cache.pending, 1);
  assert.equal(h.events.filter(event => event.type === 'transfer-cancel').length, 0);
  h.cache.place(second, 0.5);
  h.cache.advance(2);
  assert.equal(h.cache.prefillReady(second, 2), true);
  h.cache.publish(second, 2); h.cache.release(second, 2);
  assert.equal(h.pool.used, 64);
  assert.ok(Object.values(h.pools).flatMap(pool => pool.blocks).every(page => !page.transferLocked && !page.refcount));
});

test('U3 cache: waiting admission never allocates new computation KV into slow tiers', () => {
  const h = finiteHarness(64), first = contentRequest([['active', 64]], 65), second = contentRequest([['waiting', 64]]);
  assert.equal(h.cache.place(first, 0).status, 'admitted');
  const before = h.snapshot();
  assert.equal(h.cache.place(second, 0).status, 'wait');
  assert.deepEqual(h.snapshot(), before);
  computeInput(h, first, 1);
  assert.equal(h.cache.output(first, 1, 1).status, 'infeasible');
  assert.equal(h.pools.dram.used, 0); assert.equal(h.pools.ssd.used, 0);
  assert.equal(first._outAllocTok, 0);
});

test('U3 cache: retract restores only missing KV and never changes logical output progress', () => {
  const h = finiteHarness(256), req = contentRequest([['restore', 64]], 65);
  h.cache.place(req, 0); computeInput(h, req, 1);
  h.cache.output(req, 65, 1); req.tokensGen = 65;
  h.cache.release(req, 2, 'retract');
  assert.equal(h.pool.used, 64);
  assert.equal(req.tokensGen, 65);
  h.cache.place(req, 3);
  assert.equal(h.pool.used, 192);
  assert.deepEqual(h.cache.computeRanges(req, 3), [{ position: 64, tokens: 65 }]);
  computeInput(h, req, 4);
  assert.deepEqual(h.pool.blocks.filter(page => page.output).map(page => page.tokens), [64, 1]);
  assert.equal(req.tokensGen, 65);
  h.cache.release(req, 4);
  assert.ok(h.pool.blocks.every(page => !page.refcount));
});

test('U3 cache: publication never deduplicates into an in-flight eviction source', () => {
  const h = finiteHarness(), first = contentRequest([['moving', 64]]), second = contentRequest([['moving', 64]]);
  h.cache.place(first, 0); h.cache.place(second, 0);
  computeInput(h, first, 0); h.cache.release(first, 0);
  const source = h.pool.blocks.find(page => page._published);
  h.cache.scheduleTransfer(source, 'hbm', 'dram', 0, { move: true });
  computeInput(h, second, 0.5);
  const id = second.prefixBlkIds[0];
  assert.notEqual(id, source.id);
  h.cache.advance(1);
  assert.ok(h.pool.blockIndex[id]?.ready);
  assert.equal(h.pool.blockIndex[id].refcount, 1);
  h.cache.release(second, 1);
});

const physicalOracles = [
  { blockSize: 16, tokens: [16, 16, 16, 16, 16, 16, 16, 16, 1], capacity: 144, tailHit: 64 },
  { blockSize: 32, tokens: [32, 32, 32, 32, 1], capacity: 160, tailHit: 64 },
  { blockSize: 64, tokens: [64, 64, 1], capacity: 192, tailHit: 64 },
  { blockSize: 128, tokens: [128, 1], capacity: 256, tailHit: 0 },
];

for (const { blockSize, tokens, capacity, tailHit } of physicalOracles) {
  test(`U4.1 cache: B=${blockSize} maps logical 64-token RLE paths and charges complete physical tail pages`, () => {
    const h = contentHarness(4096, { blockSize });
    const template = { in: 129, out: 0, blockRuns: [[0, 1], [7, 2]] };
    const before = structuredClone(template);
    const req = createReplayRequest(template, 0, 0, { sessionInstanceKey: 'physical' });
    assert.deepEqual(Array.from(req.inputContent, part => [part.position, part.tokens]), [[0, 64], [64, 64], [128, 1]]);
    const plan = h.cache.lookup(req);
    assert.equal(plan.missTokens, 129);
    assert.deepEqual(plan.slots.map(slot => slot.tokens), tokens);
    assert.deepEqual(plan.slots.map(slot => slot.position), tokens.map((_, i) => i * blockSize));
    if (blockSize <= 64) {
      assert.equal(plan.slots[0].key, replayPageKey('physical', 0, blockSize, 'default', blockSize));
      if (blockSize < 64) assert.equal(plan.slots[1].key, replayPageKey('physical', 0, blockSize, 'default', blockSize, blockSize));
    } else {
      assert.deepEqual(JSON.parse(plan.slots[0].key).at(-1), [
        [JSON.stringify(['replay', 'physical', 'input', 0]), 0, 64],
        [JSON.stringify(['replay', 'physical', 'input', 7]), 0, 64],
      ]);
    }
    h.cache.place(req, 0); h.cache.publish(req, 1); h.cache.release(req, 2);
    assert.equal(h.pool.used, capacity); assert.equal(h.cache.snapshot().inputPages, tokens.length);
    assert.equal(h.cache.lookup(req, 3).hitL1Tokens, 129);
    assert.deepEqual(template, before);
    const tail = contentRequest([['physical-tail', 65]]);
    h.cache.place(tail, 3); h.cache.publish(tail, 4); h.cache.release(tail, 4);
    const extended = h.cache.lookup(contentRequest([['physical-tail', 66]]), 5);
    assert.equal(extended.hitL1Tokens, tailHit); assert.equal(extended.missTokens, 66 - tailHit);
  });

  test(`U4.1 cache: B=${blockSize} output growth and retract use independent physical input/output pages`, () => {
    const h = finiteHarness(8 * blockSize, { blockSize });
    const req = contentRequest([['physical-output-input', blockSize + 1]], blockSize + 1);
    h.cache.place(req, 0); computeInput(h, req, 1);
    assert.equal(h.pool.used, 2 * blockSize);
    assert.equal(h.cache.output(req, 1, 1).status, 'admitted');
    assert.equal(h.pool.used, 3 * blockSize);
    assert.equal(h.cache.output(req, blockSize + 1, 2).status, 'admitted');
    assert.equal(h.pool.used, 4 * blockSize);
    assert.deepEqual(h.pool.blocks.filter(page => page.output).map(page => page.tokens), [blockSize, 1]);
    req.tokensGen = blockSize + 1;
    h.cache.release(req, 3, 'retract');
    assert.equal(h.pool.used, 2 * blockSize); assert.equal(req.tokensGen, blockSize + 1);
    assert.equal(h.cache.place(req, 4).hitL1Tokens, blockSize + 1);
    assert.deepEqual(h.cache.computeRanges(req, 4), [{ position: blockSize + 1, tokens: blockSize + 1 }]);
    assert.equal(h.pool.used, 4 * blockSize);
    computeInput(h, req, 5); h.cache.release(req, 6);
    assert.deepEqual(h.pool.blocks.filter(page => page.output).map(page => page.tokens), [blockSize, 1]);
    assert.ok(h.pool.blocks.every(page => !page.refcount));
    const cramped = finiteHarness(3 * blockSize, { blockSize });
    const retry = contentRequest([['too-large-restore', blockSize + 1]], blockSize + 1);
    retry.tokensGen = blockSize + 1;
    assert.deepEqual(cramped.cache.place(retry, 0), { status: 'infeasible' });
    assert.deepEqual(cramped.cache.prefetch(retry, 0), { status: 'infeasible' });
    assert.equal(cramped.pool.used, 0);
  });

  test(`U4.1 cache: B=${blockSize} physical page budgets reject before allocation and output mutation`, () => {
    const limited = contentHarness(Infinity, { blockSize, maxBlockReferences: tokens.length - 1 });
    const req = contentRequest([['budget', 129]], 1);
    req.inputContent = { [Symbol.iterator]() { assert.fail('over-budget request expanded'); } };
    assert.throws(() => limited.cache.place(req), ReplayValidationError);
    assert.equal(limited.pool.used, 0);
    const h = contentHarness(4096, { blockSize, maxBlockReferences: tokens.length });
    const admitted = contentRequest([['budget', 129]], 1);
    assert.equal(h.cache.place(admitted).status, 'admitted');
    assert.equal(h.pool.used, capacity);
    const before = h.snapshot(), reqBefore = structuredClone(admitted);
    assert.throws(() => h.cache.output(admitted, 1, 1), ReplayValidationError);
    assert.deepEqual(h.snapshot(), before); assert.deepEqual(admitted, reqBefore);
    const cramped = contentHarness(capacity - 1, { blockSize });
    assert.deepEqual(cramped.cache.place(contentRequest([['budget', 129]])), { status: 'infeasible' });
    assert.equal(cramped.pool.used, 0);
  });

  test(`U4.1 cache: B=${blockSize} tail transfers reserve full pages but charge valid-token bytes`, () => {
    const h = finiteHarness(4 * blockSize, { blockSize });
    const req = contentRequest([['physical-transfer', blockSize + 1]]);
    warmTier(h, req, 'dram');
    assert.equal(h.pools.dram.used, 2 * blockSize);
    assert.equal(h.cache.prefetch(req, 0).status, 'admitted');
    assert.equal(req.fetchTime, (blockSize + 1) / 64);
    assert.deepEqual(h.cache.ledger.map(record => [record.bytes, record.reservation]), [[blockSize, blockSize], [1, blockSize]]);
    assert.deepEqual(h.cache.ledger.map(record => [record.start, record.end]), [[0, blockSize / 64], [blockSize / 64, (blockSize + 1) / 64]]);
    assert.equal(h.cache.snapshot().hbmReservedBytes, 2 * blockSize);
    h.cache.advance((blockSize + 1) / 64);
    assert.equal(h.cache.lookup(req, (blockSize + 1) / 64).hitL1Tokens, blockSize + 1);
    assert.equal(h.cache.snapshot().hbmReservedBytes, 0);
    assert.equal(h.events.filter(event => event.type === 'transfer-progress').reduce((sum, event) => sum + event.bytes, 0), blockSize + 1);
    h.cache.cancel(req, 3);
  });
}

for (const blockSize of [16, 32]) {
  test(`U4.1 cache: B=${blockSize} subpage eviction stops at the gap and cannot share a different logical path`, () => {
    const h = contentHarness(4096, { blockSize });
    const template = { in: 64, out: 0, blockRuns: [[0, 1]] };
    const req = createReplayRequest(template, 0, 0, { sessionInstanceKey: 'subpages' });
    h.cache.place(req); h.cache.publish(req, 1); h.cache.release(req, 2);
    assert.equal(h.pool.used, 64);
    h.remove('hbm', h.pool.blocks[1].id);
    const plan = h.cache.lookup(req, 3);
    assert.equal(plan.hitL1Tokens, blockSize); assert.equal(plan.missTokens, 64 - blockSize);
    assert.deepEqual(plan.slots.map(slot => slot.hit), blockSize === 16 ? [true, false, false, false] : [true, false]);
    const unrelated = createReplayRequest({ ...template, blockRuns: [[1, 1]] }, 1, 0, { sessionInstanceKey: 'subpages' });
    assert.equal(h.cache.lookup(unrelated, 3).hitL1Tokens, 0);
    h.cache.place(req, 3); h.cache.publish(req, 4); h.cache.release(req, 5);
    assert.equal(h.pool.used, 64); assert.equal(h.cache.lookup(req, 6).hitL1Tokens, 64);
  });
}

test('U4.1 cache: B=128 crosses RLE runs without changing ordered path or boundary identity', () => {
  const h = contentHarness(4096, { blockSize: 128 });
  const req = runs => createReplayRequest({ in: 256, out: 0, blockRuns: runs }, 0, 0, { sessionInstanceKey: 'cross-rle' });
  const first = req([[0, 1], [1, 1], [8, 1], [9, 1]]);
  h.cache.place(first); h.cache.publish(first, 1); h.cache.release(first, 2);
  assert.equal(h.pool.used, 256);
  assert.equal(h.cache.lookup(req([[0, 2], [8, 2]]), 3).hitL1Tokens, 256);
  assert.equal(h.cache.lookup(req([[1, 1], [0, 1], [8, 2]]), 3).hitL1Tokens, 0);
  assert.equal(h.cache.lookup(req([[0, 2], [9, 1], [8, 1]]), 3).hitL1Tokens, 128);
  seedContent(h, [['A', 32], ['B', 96]]);
  assert.equal(h.cache.lookup(contentRequest([['A', 32], ['B', 96]]), 3).hitL1Tokens, 128);
  for (const parts of [[['A', 64], ['B', 64]], [['B', 96], ['A', 32]], [['A', 32], ['other-B', 96]]]) {
    assert.equal(h.cache.lookup(contentRequest(parts), 3).hitL1Tokens, 0);
  }
});

test('U4.1 cache: physical layouts cannot alias equal short tails and unsupported sizes fail explicitly', () => {
  const h = contentHarness(4096, { blockSize: 16 });
  seedContent(h, [['same-tail', 1]]);
  const differentLayout = createReplayCache({ pool: h.pool, blockSize: 32, blockBytes: 32, add: h.add, remove: h.remove });
  assert.equal(differentLayout.lookup(contentRequest([['same-tail', 1]]), 3).hitL1Tokens, 0);
  for (const blockSize of [0, -16, 1.5, 3, 48, 96, 129, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '64', null]) {
    assert.throws(() => contentHarness(4096, { blockSize }), ReplayValidationError);
  }
  for (const blockSize of [1, 2, 4, 8, 16, 32, 64, 128, 192, 256]) {
    assert.doesNotThrow(() => contentHarness(4096, { blockSize }));
  }
});

test('U4 cache: global physical reference budget includes other resource domains and in-flight reservations', () => {
  const contexts = [];
  const resourceCount = () => contexts.reduce((sum, h) => sum + Object.values(h.pools)
    .reduce((count, pool) => count + pool.blocks.length, 0), 0);
  const options = { blockSize: 32, maxBlockReferences: 3, resourceCount };
  const a = finiteHarness(256, { ...options, resourceId: 'budget-A' });
  const b = finiteHarness(256, { ...options, resourceId: 'budget-B' });
  contexts.push(a, b);
  const first = contentRequest([['budget-A-input', 32]], 1);
  a.cache.place(first, 0); computeInput(a, first, 0);
  const second = contentRequest([['budget-B-input', 32]]);
  warmTier(b, second, 'dram');
  assert.equal(resourceCount(), 2);
  b.cache.prefetch(second, 0);
  assert.equal(resourceCount(), 3); assert.equal(b.cache.snapshot().hbmReservedBytes, 32);
  const beforeA = a.snapshot(), beforeB = b.snapshot(), reqBefore = structuredClone(first);
  assert.throws(() => a.cache.output(first, 1, 0), ReplayValidationError);
  assert.throws(() => a.cache.place(contentRequest([['extra-input', 32]]), 0), ReplayValidationError);
  assert.throws(() => a.cache.scheduleTransfer(a.pool.blocks[0], 'hbm', 'dram', 0), ReplayValidationError);
  assert.deepEqual(a.snapshot(), beforeA); assert.deepEqual(b.snapshot(), beforeB); assert.deepEqual(first, reqBefore);
  b.cache.cancel(second, 0);
  assert.equal(resourceCount(), 2);
  assert.equal(a.cache.output(first, 1, 0).status, 'admitted');
  assert.equal(resourceCount(), 3);
});

for (const blockSize of [16, 32, 64, 128]) {
  test(`U4.3 cache: B=${blockSize} handoff reserves D, protects P, and adopts input plus restored output without early visibility`, () => {
    const p = finiteHarness(8 * blockSize, { blockSize, resourceId: 'P' });
    const d = finiteHarness(16 * blockSize, { blockSize, blockBytes: 2 * blockSize, resourceId: 'D' });
    const req = contentRequest([['pd-input', blockSize + 1]], blockSize + 2);
    req.replayTemplate = { marker: 'retain-on-handoff' };
    req.arrive = 0.125; req.firstTokenTime = 0.25;
    p.cache.place(req, 0); computeInput(p, req, 1);
    p.cache.output(req, blockSize + 1, 1); req.tokensGen = blockSize + 1;
    const original = structuredClone(req);
    assert.equal(d.cache.lookup(req, 1).hitL1Tokens, 0);
    const response = p.cache.beginHandoff(req, d.cache, 2), handoff = response.handoff;
    assert.equal(response.status, 'admitted'); assert.equal(handoff.state, 'pending');
    assert.equal(handoff.inputTokens, blockSize + 1); assert.equal(handoff.outputTokens, blockSize + 1);
    assert.equal(handoff.bytesReserved, 8 * blockSize);
    assert.equal(p.pool.used, 4 * blockSize); assert.equal(d.pool.used, 8 * blockSize);
    assert.equal(d.cache.snapshot().hbmReservedBytes, 8 * blockSize);
    assert.equal(p.cache.pending, 1); assert.equal(d.cache.pending, 0);
    assert.ok(p.pool.blocks.every(page => page.refcount === 1 && page.transferLocked));
    assert.ok(d.pool.blocks.every(page => !page.ready && page.transferLocked));
    assert.deepEqual(req, original);
    assert.equal(p.cache.beginHandoff(req, d.cache, 2).handoff, handoff);
    assert.deepEqual(d.cache.place(req, 2), { status: 'wait' }); assert.equal(d.cache.prefillReady(req, 2), false);
    assert.deepEqual(d.cache.prefetch(req, 2), { status: 'wait' }); assert.equal(d.cache.startPrefill(req, 2), false);
    assert.deepEqual(p.cache.output(req, blockSize + 2, 2), { status: 'wait' });
    assert.equal(d.cache.lookup(req, 2).hitL1Tokens, 0);
    assert.equal(p.cache.ensureSpace('hbm', 8 * blockSize, 2), 'wait');
    assert.equal(handoff.complete(3), true); assert.equal(handoff.complete(3), false); assert.equal(handoff.cancel(3), false);
    assert.equal(handoff.state, 'completed'); assert.equal(p.cache.pending, 0);
    assert.equal(p.pool.used, 2 * blockSize); assert.equal(d.pool.used, 8 * blockSize);
    assert.ok(p.pool.blocks.every(page => page._published && !page.refcount && !page.transferLocked));
    assert.ok(d.pool.blocks.every(page => page.ready && page.refcount === 1 && !page.transferLocked));
    assert.equal(d.cache.snapshot().hbmReservedBytes, 0); assert.equal(d.cache.prefillReady(req, 3), true);
    assert.equal(req.tokensGen, blockSize + 1); assert.equal(req._outAllocTok, blockSize + 1);
    assert.equal(req.arrive, original.arrive); assert.equal(req.firstTokenTime, original.firstTokenTime);
    assert.deepEqual(req.replayTemplate, original.replayTemplate);
    assert.deepEqual(d.pool.blocks.filter(page => page.output).map(page => page.tokens), [blockSize, 1]);
    assert.equal(d.cache.output(req, blockSize + 2, 4).status, 'admitted');
    assert.equal(p.pool.used, 2 * blockSize); assert.equal(d.pool.used, 8 * blockSize);
    assert.deepEqual(d.pool.blocks.filter(page => page.output).map(page => page.tokens), [blockSize, 2]);
    const adopted = structuredClone(req); p.cache.release(req, 4); assert.deepEqual(req, adopted);
    d.cache.release(req, 5);
    assert.ok(d.pool.blocks.every(page => !page.refcount));
    assert.equal(d.cache.lookup(contentRequest([['pd-input', blockSize + 1], ['unmapped-trace-output', 1]]), 6).hitL1Tokens, blockSize);
  });
}

test('U4.3 cache: D capacity is independent, wait/infeasible leave source handles and target references untouched', () => {
  const p = finiteHarness(512, { resourceId: 'P' }), d = finiteHarness(64, { resourceId: 'D' });
  const large = contentRequest([['large-prompt', 65]]);
  p.cache.place(large, 0); computeInput(p, large, 1);
  const beforeP = p.snapshot(), beforeD = d.snapshot(), original = structuredClone(large);
  assert.deepEqual(p.cache.beginHandoff(large, d.cache, 2), { status: 'infeasible' });
  assert.deepEqual(p.snapshot(), beforeP); assert.deepEqual(d.snapshot(), beforeD); assert.deepEqual(large, original);
  const req = contentRequest([['small-prompt', 64]]), blocker = contentRequest([['D-running', 64]]);
  p.cache.place(req, 2); computeInput(p, req, 3); d.cache.place(blocker, 3);
  const waitP = p.snapshot(), waitD = d.snapshot(), waiting = structuredClone(req);
  assert.deepEqual(p.cache.beginHandoff(req, d.cache, 3), { status: 'wait' });
  assert.deepEqual(p.snapshot(), waitP); assert.deepEqual(d.snapshot(), waitD); assert.deepEqual(req, waiting);
  d.cache.release(blocker, 4, 'abort');
  const { handoff } = p.cache.beginHandoff(req, d.cache, 4);
  assert.equal(handoff.cancel(5), true); assert.equal(handoff.cancel(5), false); assert.equal(handoff.complete(5), false);
  assert.equal(d.pool.used, 0); assert.equal(p.cache.pending, 0);
  assert.ok(p.pool.blocks.every(page => !page.transferLocked)); assert.deepEqual(req, waiting);
});

test('U4.3 cache: concurrent handoffs reserve privately, cancel independently and deduplicate only on completion', () => {
  const p = finiteHarness(256, { resourceId: 'P' }), d = finiteHarness(128, { resourceId: 'D' });
  const a = contentRequest([['same-pd', 64]]), b = contentRequest([['same-pd', 64]]);
  p.cache.place(a, 0); computeInput(p, a, 1); p.cache.place(b, 1); computeInput(p, b, 1);
  const first = p.cache.beginHandoff(a, d.cache, 2).handoff;
  const second = p.cache.beginHandoff(b, d.cache, 2).handoff;
  assert.equal(d.pool.used, 128); assert.equal(p.pool.blocks[0].refcount, 2);
  assert.equal(first.cancel(3), true); assert.equal(d.pool.used, 64);
  assert.equal(p.pool.blocks[0].transferLocked, true);
  const retry = p.cache.beginHandoff(a, d.cache, 3).handoff;
  assert.equal(second.complete(4), true); assert.equal(d.pool.used, 128);
  assert.equal(d.pool.blocks.filter(page => page.ready).length, 1);
  assert.equal(retry.complete(4), true); assert.equal(d.pool.used, 64);
  assert.equal(d.pool.blocks[0].refcount, 2); assert.equal(d.cache.snapshot().deduplicatedPages, 1);
  assert.equal(p.pool.blocks[0].refcount, 0); assert.equal(p.pool.blocks[0].transferLocked, false);
  d.cache.release(a, 5); assert.equal(d.pool.blocks[0].refcount, 1); d.cache.release(b, 5);
  assert.equal(d.pool.blocks[0].refcount, 0);
  const third = contentRequest([['same-pd', 64]]);
  p.cache.place(third, 6); computeInput(p, third, 6);
  const reuse = p.cache.beginHandoff(third, d.cache, 6).handoff;
  assert.equal(reuse.bytesReserved, 0); assert.equal(d.pool.used, 64);
  assert.equal(reuse.complete(7), true); d.cache.release(third, 8);
  assert.equal(d.pool.blocks[0].refcount, 0);
});

test('U4.3 cache: retract cancels reserved D pages and stale handoff cannot complete a later attempt', () => {
  const p = finiteHarness(512, { resourceId: 'P' }), d = finiteHarness(512, { resourceId: 'D' });
  const req = contentRequest([['pd-retry', 65]], 65);
  p.cache.place(req, 0); computeInput(p, req, 1); p.cache.output(req, 65, 1); req.tokensGen = 65;
  const stale = p.cache.beginHandoff(req, d.cache, 2).handoff;
  p.cache.release(req, 3, 'retract');
  assert.equal(stale.state, 'cancelled'); assert.equal(p.cache.pending, 0); assert.equal(d.pool.used, 0);
  assert.equal(req.tokensGen, 65); assert.equal(p.pool.used, 128);
  p.cache.place(req, 4); computeInput(p, req, 5);
  const current = p.cache.beginHandoff(req, d.cache, 6).handoff;
  assert.equal(stale.complete(7), false); assert.equal(current.state, 'pending');
  assert.equal(current.complete(8), true); assert.equal(req.tokensGen, 65);
  assert.deepEqual(d.pool.blocks.filter(page => page.output).map(page => page.tokens), [64, 1]);
  d.cache.release(req, 9, 'abort');
  assert.equal(d.pool.used, 128); assert.ok(p.pool.blocks.every(page => !page.refcount && !page.transferLocked));
});

test('U4.3 cache: shared global page budget counts both sides and rejects handoff without leaks', () => {
  const contexts = [], resourceCount = () => contexts.reduce((n, h) => n + h.pool.blocks.length, 0);
  const p = finiteHarness(512, { resourceId: 'P', resourceCount, maxBlockReferences: 3 });
  const d = finiteHarness(512, { resourceId: 'D', resourceCount, maxBlockReferences: 3 });
  contexts.push(p, d);
  const req = contentRequest([['budget-handoff', 65]]);
  p.cache.place(req, 0); computeInput(p, req, 1);
  const beforeP = p.snapshot(), beforeD = d.snapshot(), original = structuredClone(req);
  assert.throws(() => p.cache.beginHandoff(req, d.cache, 2), ReplayValidationError);
  assert.deepEqual(p.snapshot(), beforeP); assert.deepEqual(d.snapshot(), beforeD); assert.deepEqual(req, original);
  assert.equal(p.cache.pending, 0); assert.equal(resourceCount(), 2);
});

test('U4.3 cache: unready sources cannot hand off and anonymous output retains no inferred identity', () => {
  const p = finiteHarness(256, { resourceId: 'P' }), d = finiteHarness(256, { resourceId: 'D' });
  const req = contentRequest([['anonymous-pd', 64]], 1); delete req.outputIdentity;
  p.cache.place(req, 0);
  assert.deepEqual(p.cache.beginHandoff(req, d.cache, 0), { status: 'wait' }); assert.equal(d.pool.used, 0);
  computeInput(p, req, 1); p.cache.output(req, 1, 1); req.tokensGen = 1;
  const handoff = p.cache.beginHandoff(req, d.cache, 2).handoff;
  assert.equal(handoff.complete(3), true);
  assert.equal(d.pool.blocks.find(page => page.output).canonicalKey, undefined);
  d.cache.release(req, 4);
  assert.equal(d.cache.lookup(contentRequest([['anonymous-pd', 64], ['guessed-output', 1]]), 5).hitL1Tokens, 64);
});

test('U4.3 cache: handoff rejects nonfinite and backwards event times without touching reservations or ownership', () => {
  const p = finiteHarness(256, { resourceId: 'P' }), d = finiteHarness(256, { resourceId: 'D' });
  const req = contentRequest([['timed-handoff', 64]]);
  p.cache.place(req, 0); computeInput(p, req, 1);
  for (const time of [NaN, Infinity, -Infinity, '2']) {
    assert.throws(() => p.cache.beginHandoff(req, d.cache, time), ReplayValidationError);
  }
  assert.equal(d.pool.used, 0); assert.equal(p.cache.pending, 0);
  const handoff = p.cache.beginHandoff(req, d.cache, 2).handoff;
  const beforeP = p.snapshot(), beforeD = d.snapshot(), original = structuredClone(req);
  for (const time of [1.999, NaN, Infinity, -Infinity, '3']) {
    assert.throws(() => handoff.complete(time), ReplayValidationError);
    assert.throws(() => handoff.cancel(time), ReplayValidationError);
    assert.deepEqual(p.snapshot(), beforeP); assert.deepEqual(d.snapshot(), beforeD); assert.deepEqual(req, original);
    assert.equal(handoff.state, 'pending');
  }
  assert.equal(handoff.cancel(2), true);
  const second = p.cache.beginHandoff(req, d.cache, 3).handoff;
  assert.equal(second.complete(3), true);
  assert.equal(d.pool.blocks[0].arriveAt, 3); d.cache.release(req, 4);
});
