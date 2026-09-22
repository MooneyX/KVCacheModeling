import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { flattenReplaySession } from '../../src/core/replay.js';

const fresh = () => JSON.parse(readFileSync(new URL('../fixtures/replay/session-interleaved.json', import.meta.url), 'utf8'));

test('S02: stable flattening, absolute rounding and original positions', () => {
  const source = fresh();
  const before = JSON.stringify(source);
  const flat = flattenReplaySession(source, { lineNumber: 7, sourceIndex: 3 });
  assert.deepEqual(flat.requests.map(r => [r.topIndex, r.innerIndex, r.tMs, r.apiMs, r.endMs]), [
    [0, null, 0, 3, 3], [1, 1, 1, 2, 3], [1, 0, 2, 0, 2], [2, null, 2, 0, 2],
  ]);
  assert.deepEqual(flat.mainRequests, [0, 3]);
  assert.deepEqual(flat.groups, [{ topIndex: 1, firstReq: 1, requests: [1, 2] }, { topIndex: 3, firstReq: null, requests: [] }]);
  assert.equal(flat.originMs, 10000);
  assert.equal(flat.sourceIndex, 3);
  assert.equal(flat.inputTokens, 448);
  assert.equal(flat.outputTokens, 6);
  assert.equal(flat.blockReferences, 7);
  assert.deepEqual(flat.thinkTime, { missing: 1, null: 1, zero: 1, positive: 1 });
  assert.ok(Math.abs(flat.spanSeconds - 0.0026) < 1e-12);
  assert.equal(JSON.stringify(source), before);
});

test('S02: equal timestamps sort by top then inner positions, not rounded time', () => {
  const source = fresh();
  source.requests[1].requests[0].t = 10.0004;
  source.requests[1].requests[1].t = 10.0004;
  source.requests[2].t = 10.0004;
  assert.deepEqual(flattenReplaySession(source).requests.map(r => [r.topIndex, r.innerIndex]), [[0, null], [1, 0], [1, 1], [2, null]]);
  source.requests[1].requests[0].t = 10.00039;
  assert.equal(flattenReplaySession(source).requests[0].innerIndex, 0);
});

test('S02: malformed records carry line/session/top/inner diagnostics', () => {
  const mutations = [
    r => { r.type = 'unknown'; }, r => { r.t = -1; }, r => { r.t = Infinity; },
    r => { r.api_time = NaN; }, r => { r.api_time = Number.MAX_VALUE; },
    r => { r.in = 0; }, r => { r.out = 1.5; }, r => { r.hash_ids = []; },
    r => { r.hash_ids = [-1]; }, r => { r.hash_ids = [Number.MAX_SAFE_INTEGER + 1]; },
    r => { r.think_time = -1; }, r => { r.think_time = ''; }, r => { delete r.model; },
  ];
  for (const mutate of mutations) {
    const source = fresh();
    mutate(source.requests[1].requests[0]);
    assert.throws(() => flattenReplaySession(source, { lineNumber: 9 }), /line 9, session "interleaved"\.requests\[1\]\.requests\[0\]/, mutate.toString());
  }
  for (const mutate of [s => { s.block_size = 32; }, s => { s.hash_id_scope = 'global'; }, s => { s.models = null; }, s => { s.requests = []; }, s => { s.requests = [s.requests[3]]; }, s => { s.requests[1].t = -1; }, s => { delete s.requests[1].agent_id; }, s => { s.requests[1].requests = null; }]) {
    const source = fresh(); mutate(source);
    assert.throws(() => flattenReplaySession(source), /line 1, session/);
  }
});

test('S02: per-session budgets and derived timestamp overflow are rejected', () => {
  assert.throws(() => flattenReplaySession(fresh(), { limits: { maxRequests: 3 } }), /resource limit/);
  assert.throws(() => flattenReplaySession(fresh(), { limits: { maxBlockReferences: 6 } }), /resource limit/);
  const source = fresh();
  source.requests[2].t = Number.MAX_SAFE_INTEGER / 1000;
  source.requests[2].api_time = Number.MAX_SAFE_INTEGER / 1000;
  assert.throws(() => flattenReplaySession(source), /safe integer/);
});
