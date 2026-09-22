import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runSimulation } from '../../src/core/simulation.js';
import { createReplayCache, replayPageKey } from '../../src/core/replay-cache.js';
import { createReplayRequest } from '../../src/core/requests.js';

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
  h.cache.place(a, 0);
  assert.equal(h.cache.place(h.req(bundle.sessions[0].req[1], 1), 0), null);
  assert.throws(() => h.cache.place(h.req(bundle.sessions[0].req[0], 2), 0), /HBM pressure/);
  assert.equal(h.pool.used, 128);
});
