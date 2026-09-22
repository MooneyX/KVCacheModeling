import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { flattenReplaySession, compileReplaySession, validateReplayBundle, encodeReplayRuns, iterateReplayBlocks, verifyReplayTiming, orderReplaySessions } from '../../src/core/replay.js';
import { mulberry32 } from '../../src/core/math.js';

const fixture = name => JSON.parse(readFileSync(new URL(`../fixtures/replay/${name}.json`, import.meta.url), 'utf8'));
const rawSession = requests => ({ id: 'manual', models: ['test'], block_size: 64, hash_id_scope: 'local', requests: requests.map(r => ({ type: 'n', t: r.t, api_time: r.api, model: 'test', in: r.path.length * 64, out: 0, hash_ids: r.path })) });
const timingRows = session => session.req.map(r => [r.timing.kind, r.timing.anchorReq, r.timing.offsetMs]);

test('S03: trie identities encode parent + hash, and remain globally disjoint', () => {
  const flat = flattenReplaySession(fixture('session-interleaved'));
  const a = compileReplaySession(flat);
  assert.deepEqual(a.session.req.map(r => r.blockRuns), [[[0, 2]], [[0, 1]], [[2, 1]], [[0, 2], [3, 1]]]);
  assert.equal(a.nextBlockId, 4);
  const b = compileReplaySession(flat, { startBlockId: a.nextBlockId });
  assert.equal(b.nextBlockId, 8);
  const stats = validateReplayBundle({ version: 1, blockSize: 64, sessions: [a.session, b.session] });
  assert.equal(stats.inputTokens, 896);
  const branches = compileReplaySession(flattenReplaySession(rawSession([{ t: 0, api: 0, path: [1, 9] }, { t: 1, api: 0, path: [2, 9] }, { t: 2, api: 0, path: [1, 9] }])));
  assert.deepEqual(branches.session.req.map(r => [...iterateReplayBlocks(r.blockRuns)]), [[0, 1], [2, 3], [0, 1]]);
  assert.deepEqual(encodeReplayRuns([0, 1, 2, 8, 9, 0, 0]), [[0, 3], [8, 2], [0, 1], [0, 1]]);
  assert.deepEqual([...iterateReplayBlocks([[Number.MAX_SAFE_INTEGER, 1]])], [Number.MAX_SAFE_INTEGER]);
});

test('S03: manual main-request anchor precedence and backtracking', () => {
  const source = fixture('anchor-cases');
  const flat = flattenReplaySession(rawSession(source.requests));
  const compiled = compileReplaySession(flat, { evidenceLimit: 2 });
  assert.deepEqual(timingRows(compiled.session), source.expected);
  assert.equal(compiled.diagnostics.completion, 6);
  assert.equal(compiled.diagnostics.backtrackedCompletion, 4);
  assert.equal(compiled.evidence.length, 2);
  assert.deepEqual(verifyReplayTiming(flat, compiled.session), flat.requests.map(r => r.tMs));
  compiled.session.req[3].timing.offsetMs++;
  assert.throws(() => verifyReplayTiming(flat, compiled.session), /does not recover/);
});

test('S03: merged-stream predecessor, group-first anchors and first main origin', () => {
  const raw = fixture('session-interleaved');
  const compiled = compileReplaySession(flattenReplaySession(raw));
  assert.deepEqual(timingRows(compiled.session), [['origin', null, 0], ['arrival', 0, 1], ['arrival', 1, 1], ['arrival', 0, 2]]);
  raw.requests[1].requests[1].t = 9;
  const early = compileReplaySession(flattenReplaySession(raw));
  assert.equal(early.session.req[0].timing.kind, 'origin');
  assert.deepEqual(early.session.req[1].timing, { kind: 'origin', anchorReq: null, offsetMs: 1000 });
  const group = structuredClone(raw.requests[1]);
  group.agent_id = 'other';
  group.requests = [group.requests[0]];
  raw.requests.splice(2, 0, group);
  const cross = compileReplaySession(flattenReplaySession(raw));
  assert.equal(cross.session.req[3].timing.anchorReq, 2);
});

test('S03: indexed candidates agree with an independent exhaustive reference', () => {
  const rng = mulberry32(123);
  for (let trial = 0; trial < 40; trial++) {
    let time = 0;
    const source = [];
    for (let i = 0; i < 50; i++) {
      time += Math.floor(rng() * 3) / 1000;
      source.push({ t: time, api: Math.floor(rng() * 8) / 1000, path: Array.from({ length: 1 + Math.floor(rng() * 4) }, () => Math.floor(rng() * 3)) });
    }
    const flat = flattenReplaySession(rawSession(source));
    const compiled = compileReplaySession(flat);
    const expected = flat.requests.map((r, i, all) => {
      if (i === 0) return ['origin', null, r.tMs];
      const prev = all[i - 1];
      if (prev.endMs > r.tMs && prev.hashIds[0] === r.hashIds[0]) return ['arrival', i - 1, r.tMs - prev.tMs];
      const candidates = all.slice(0, i).map((p, index) => ({ p, index })).filter(({ p }) => p.endMs <= r.tMs && p.hashIds.length <= r.hashIds.length && p.hashIds.every((id, k) => id === r.hashIds[k]));
      candidates.sort((a, b) => b.p.hashIds.length - a.p.hashIds.length || b.p.tMs - a.p.tMs || b.index - a.index);
      return candidates.length ? ['completion', candidates[0].index, r.tMs - candidates[0].p.endMs] : ['arrival', i - 1, r.tMs - prev.tMs];
    });
    assert.deepEqual(timingRows(compiled.session), expected);
  }
});

test('S03: completed inner requests are excluded and rounded milliseconds govern overlap', () => {
  const source = rawSession([{ t: 0, api: 0.0014, path: [1] }, { t: 0.00149, api: 0, path: [1, 2] }]);
  assert.deepEqual(timingRows(compileReplaySession(flattenReplaySession(source)).session), [['origin', null, 0], ['completion', 0, 0]]);
  source.requests[0].api_time = 0.0015;
  assert.deepEqual(timingRows(compileReplaySession(flattenReplaySession(source)).session), [['origin', null, 0], ['arrival', 0, 1]]);
  const main = rawSession([{ t: 0, api: 0, path: [1] }, { t: 2, api: 0, path: [1, 2, 3] }]);
  const inner = rawSession([{ t: 1, api: 0, path: [1, 2] }]).requests[0];
  main.requests.splice(1, 0, { type: 'subagent', t: 1, agent_id: 'longer-inner', requests: [inner] });
  assert.deepEqual(compileReplaySession(flattenReplaySession(main)).session.req[2].timing, { kind: 'completion', anchorReq: 0, offsetMs: 2000 });
});

test('S03: balanced alternating layers preserve identity and deterministic order', () => {
  const entries = Array.from({ length: 8 }, (_, i) => ({ sourceIndex: i, session: { req: Array(i + 1).fill({}) } }));
  assert.deepEqual(orderReplaySessions(entries).map(e => e.sourceIndex), [0, 7, 1, 6, 2, 5, 3, 4]);
  const many = Array.from({ length: 40 }, (_, i) => ({ sourceIndex: i, session: { req: Array(1 + i % 3).fill({}) } }));
  const before = JSON.stringify(many);
  assert.deepEqual(orderReplaySessions(many, 9), orderReplaySessions(many, 9));
  assert.notDeepEqual(orderReplaySessions(many, 9), orderReplaySessions(many, 10));
  assert.equal(new Set(orderReplaySessions(many, 9)).size, 40);
  assert.equal(JSON.stringify(many), before);
  assert.throws(() => orderReplaySessions([], 0), /empty/);
  assert.throws(() => orderReplaySessions(many, 2 ** 32), /uint32/);
});
