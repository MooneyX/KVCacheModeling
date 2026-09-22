import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseReplayBundle, validateReplayBundle, ReplayValidationError } from '../../src/core/replay.js';

const text = readFileSync(new URL('../fixtures/replay/bundle-valid.json', import.meta.url), 'utf8');
const fresh = () => JSON.parse(text);
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

test('S01: strict bundle validation derives exact statistics without mutating input', () => {
  const input = freeze(fresh());
  const before = JSON.stringify(input);
  const expected = { sessions: 2, requests: 4, inputTokens: 512, outputTokens: 13, runs: 5, blockReferences: 8, meanRequestsPerSession: 2, anchors: { origin: 2, arrival: 1, completion: 1 } };
  assert.deepEqual(validateReplayBundle(input), expected);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(parseReplayBundle(text).stats, expected);
  assert.deepEqual(parseReplayBundle(new TextEncoder().encode(text)).bundle, input);
  assert.throws(() => parseReplayBundle(readFileSync(new URL('../fixtures/replay/bundle-invalid.json', import.meta.url))), /anchorReq.*earlier/);
});

test('S01: exact fields and scalar/array constraints at every layer', () => {
  const mutations = [
    b => { b.version = 2; }, b => { b.blockSize = 32; }, b => { b.extra = 0; }, b => { delete b.version; },
    b => { b.sessions = []; }, b => { b.sessions = {}; }, b => { b.sessions[0] = null; },
    b => { b.sessions[0].req = []; }, b => { b.sessions[0].id = 'not allowed'; },
    b => { b.sessions[0].req[0].other = 1; }, b => { delete b.sessions[0].req[0].out; },
    b => { b.sessions[0].req[0].in = 0; }, b => { b.sessions[0].req[0].in = 1.5; },
    b => { b.sessions[0].req[0].in = '128'; }, b => { b.sessions[0].req[0].out = -1; },
    b => { b.sessions[0].req[0].out = Infinity; }, b => { b.sessions[0].req[0].out = Number.MAX_SAFE_INTEGER + 1; },
    b => { b.sessions[0].req[0].blockRuns = []; }, b => { b.sessions[0].req[0].blockRuns = [[0, 1]]; },
    b => { b.sessions[0].req[0].blockRuns = [[0, 0]]; }, b => { b.sessions[0].req[0].blockRuns = [[-1, 2]]; },
    b => { b.sessions[0].req[0].blockRuns = [[0, 2, 3]]; }, b => { b.sessions[0].req[0].blockRuns = [[Number.MAX_SAFE_INTEGER, 2]]; },
    b => { b.sessions[0].req[0].timing.extra = 0; }, b => { b.sessions[0].req[0].timing.kind = 'open'; },
    b => { b.sessions[0].req[0].timing.anchorReq = 0; }, b => { b.sessions[0].req[1].timing.anchorReq = null; },
    b => { b.sessions[0].req[1].timing.anchorReq = 2; }, b => { b.sessions[0].req[1].timing.anchorReq = 1; },
    b => { b.sessions[0].req[1].timing.offsetMs = -1; }, b => { b.sessions[0].req[1].timing.offsetMs = 0.2; },
  ];
  for (const mutate of mutations) {
    const bundle = fresh();
    mutate(bundle);
    assert.throws(() => validateReplayBundle(bundle), ReplayValidationError, mutate.toString());
  }
});

test('S01: interval ownership handles nested ranges, gaps, adjacency and huge IDs', () => {
  const bundle = fresh();
  bundle.sessions[1].req[0].blockRuns = [[1, 1]];
  assert.throws(() => validateReplayBundle(bundle), /overlap session/);
  bundle.sessions[1].req[0].blockRuns = [[4, 1]];
  validateReplayBundle(bundle);
  bundle.sessions[1].req[0].blockRuns = [[Number.MAX_SAFE_INTEGER, 1]];
  validateReplayBundle(bundle);
  bundle.sessions[0].req[0].blockRuns = [[0, 1], [0, 1]];
  validateReplayBundle(bundle);
  bundle.sessions[0].req[0].in = 65;
  validateReplayBundle(bundle);
  bundle.sessions[0].req[0].out = Number.MAX_SAFE_INTEGER;
  assert.throws(() => validateReplayBundle(bundle), /safe integer/);
});

test('S01: all resource budgets reject before expansion, including UTF-8 bytes', () => {
  for (const limits of [{ maxSessions: 1 }, { maxRequests: 3 }, { maxRuns: 4 }, { maxBlockReferences: 7 }]) {
    assert.throws(() => validateReplayBundle(fresh(), limits), /resource limit/);
  }
  assert.throws(() => parseReplayBundle(text, { maxDecompressedBytes: 10 }), /resource limit/);
  assert.throws(() => parseReplayBundle('"汉字"', { maxDecompressedBytes: 5 }), /resource limit/);
  assert.throws(() => parseReplayBundle(new Uint8Array([0xff])), /UTF-8/);
  assert.throws(() => parseReplayBundle('{'), /invalid JSON/);
  assert.throws(() => validateReplayBundle(fresh(), { maxRuns: 0 }), /limits.maxRuns/);
  assert.throws(() => validateReplayBundle(fresh(), { typo: 1 }), /unknown resource limit/);
  const huge = { version: 1, blockSize: 64, sessions: [{ req: [{ in: 64 * 1_000_000_000, out: 0, blockRuns: [[0, 1_000_000_000]], timing: { kind: 'origin', anchorReq: null, offsetMs: 0 } }] }] };
  assert.throws(() => validateReplayBundle(huge), /resource limit/);
  assert.equal(validateReplayBundle(huge, { maxBlockReferences: 1_000_000_000 }).blockReferences, 1_000_000_000);
});
