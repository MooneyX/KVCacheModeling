import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { buildSync } from 'esbuild';
import { runSimulation } from '../../src/core/simulation.js';
import { calcAll } from '../../src/core/calculations.js';
import { DEFAULT_REPLAY_RUN_LIMITS, flattenReplaySession, compileReplaySession } from '../../src/core/replay.js';
import { extractSensMetrics } from '../../src/application/metrics.js';
import { visualizationCases } from '../fixtures/replay-visualization.mjs';

const require = createRequire(import.meta.url);
const { createTaskServer } = require('../../dist/node/server-library.cjs');
const library = require('../../dist/node/library.cjs');
const { outputFiles } = buildSync({ entryPoints: [resolve('src/execution/server/input.ts')], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22' });
const { validateSubmission } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const fixtures = JSON.parse(readFileSync(new URL('../fixtures/simulation-baseline.json', import.meta.url), 'utf8'));
const replayFixture = JSON.parse(readFileSync(new URL('../fixtures/replay/runtime-prefix.json', import.meta.url)));
const interleaved = JSON.parse(readFileSync(new URL('../fixtures/replay/session-interleaved.json', import.meta.url)));
const runner = resolve('dist/node/runner.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setup(options = {}, directory) {
  const dataDir = directory || mkdtempSync(resolve('test-results-server-'));
  const config = { host: '127.0.0.1', token: '', publicOrigin: '', secureCookie: false, port: 0, dataDir,
    webDir: resolve('dist/web'), concurrency: 1, timeoutMs: 20_000, memoryMb: 256,
    maxTasks: 100, maxJobs: 100, maxRequests: 100000, bodyBytes: 2 * 1024 * 1024, resultBytes: 16 * 1024 * 1024, retentionMs: 86400000, ...options };
  const app = createTaskServer(config, runner);
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const session = await fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: config.token }) });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const request = (path, method = 'GET', body, overrideCookie = cookie) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', Cookie: overrideCookie, Connection: 'close' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { ...app, config, dataDir, base, cookie, request, async dispose(remove = true) { await app.close(); if (remove) rmSync(dataDir, { recursive: true, force: true }); } };
}
async function waitTask(app, id) {
  const deadline = Date.now() + app.config.timeoutMs + 1000;
  while (Date.now() < deadline) {
    const task = await (await app.request('/api/tasks/' + id)).json();
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status)) return task;
    await pause(20);
  }
  throw new Error('Task did not complete');
}
const submission = (jobs = [fixtures[0]], kind = 'simulation') => ({ kind, jobs, label: 'regression', requestId: crypto.randomUUID() });
const replayJob = (bundle = replayFixture.bundle, overrides = {}, options = {}) => ({
  params: structuredClone(fixtures[0].params), strategy: structuredClone(fixtures[0].strategy), mode: 'dsl',
  overrides: { seed: 42, qps: bundle.sessions[0].req.length * 2, blockSize: 64, simMaxTime: 5, ...overrides,
    replay: { bundle: structuredClone(bundle), options: { durationSeconds: 0.2, warmupSeconds: 0, ...options } },
  },
});
const replayRequest = (input, id, kind = 'origin', anchorReq = null, offsetMs = 0) => ({
  in: input, out: 0, blockRuns: [[id, Math.ceil(input / 64)]], timing: { kind, anchorReq, offsetMs },
});
const replayBundle = req => ({ version: 1, blockSize: 64, sessions: [{ req }] });
const serverReplayLimits = config => ({
  ...DEFAULT_REPLAY_RUN_LIMITS,
  maxRequests: Math.min(DEFAULT_REPLAY_RUN_LIMITS.maxRequests, config.maxRequests),
  maxWallTimeMs: Math.min(DEFAULT_REPLAY_RUN_LIMITS.maxWallTimeMs, config.timeoutMs),
  maxResultBytes: Math.min(DEFAULT_REPLAY_RUN_LIMITS.maxResultBytes, config.resultBytes),
});
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
async function completedReplay(app, job) {
  const response = await app.request('/api/tasks', 'POST', submission([job]));
  assert.equal(response.status, 202, await response.clone().text());
  const task = await response.json();
  const finished = await waitTask(app, task.id);
  assert.equal(finished.status, 'completed', finished.error);
  assert.equal(finished.completed, 1);
  const downloaded = await (await app.request(`/api/tasks/${task.id}/download`)).json();
  const result = downloaded.points[0].result;
  assert.ok(result.replay);
  const points = await (await app.request(`/api/tasks/${task.id}/points`)).json();
  assert.deepEqual(points.points[0].result, result);
  assert.deepEqual(result, JSON.parse(JSON.stringify(library.executeJob(library.parseJob(downloaded.input.jobs[0])))));
  return { result, downloaded };
}

const serverFixtures = fixtures.filter(f => f.mode !== 'js' && f.name !== 'window-truncated');
for (let first = 0; first < serverFixtures.length; first += 2) {
  test(`server executes identical results, deduplicates submission and scopes task ownership: batch ${first / 2 + 1}`, async () => {
  const app = await setup();
  try {
    const input = submission(serverFixtures.slice(first, first + 2), 'batch');
    const response = await app.request('/api/tasks', 'POST', input);
    assert.equal(response.status, 202);
    const task = await response.json();
    const duplicate = await (await app.request('/api/tasks', 'POST', input)).json();
    assert.equal(duplicate.id, task.id);
    assert.equal((await app.request('/api/tasks', 'POST', { ...input, label: 'different' })).status, 409);
    assert.equal((await app.request('/api/tasks/' + task.id, 'GET', undefined, '')).status, 401);
    const otherSession = await fetch(app.base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const other = otherSession.headers.get('set-cookie').split(';')[0];
    assert.equal((await app.request('/api/tasks/' + task.id, 'GET', undefined, other)).status, 404);
    const finished = await waitTask(app, task.id);
    assert.equal(finished.status, 'completed', finished.error);
    const download = await (await app.request('/api/tasks/' + task.id + '/download')).json();
    assert.deepEqual(download.points.map(p => p.result), input.jobs.map(j => JSON.parse(JSON.stringify(runSimulation(j.params, j.strategy, j.overrides, j.mode)))));
    assert.equal((await app.request('/api/tasks/' + task.id + '/points?after=-1')).status, 400);
    await app.close();
    const reopened = await setup({}, app.dataDir);
    try {
      const list = await (await reopened.request('/api/tasks', 'GET', undefined, app.cookie)).json();
      assert.equal(list[0].id, task.id); assert.equal(list[0].status, 'completed');
    } finally { await reopened.dispose(); }
  } finally {
    if (app.server.listening) await app.dispose();
  }
  });
}

test('scan points, cancellation and timeout run independently from HTTP requests', async () => {
  const app = await setup();
  try {
    const scan = await (await app.request('/api/tasks', 'POST', submission(fixtures.slice(0, 3), 'scan'))).json();
    const state = await waitTask(app, scan.id); assert.equal(state.status, 'completed');
    const points = await (await app.request(`/api/tasks/${scan.id}/points?after=1`)).json();
    assert.equal(points.points[0].index, 1);
    assert.deepEqual(points.points[0].result, extractSensMetrics(runSimulation(fixtures[1].params, fixtures[1].strategy, {})));
    const owner = app.cookie.slice('sim_session='.length).split('.')[0];
    const release = app.queue.acquireDownload(scan.id, owner);
    assert.equal((await app.request(`/api/tasks/${scan.id}`, 'DELETE')).status, 409);
    release();
    assert.equal((await app.request(`/api/tasks/${scan.id}`, 'DELETE')).status, 200);
    const long = submission(Array(100).fill(fixtures[0]), 'batch');
    const task = await (await app.request('/api/tasks', 'POST', long)).json();
    const pending = await (await app.request('/api/tasks', 'POST', submission())).json();
    assert.equal(pending.status, 'queued');
    assert.equal((await app.request('/api/health')).status, 200);
    assert.equal((await (await app.request(`/api/tasks/${pending.id}/cancel`, 'POST')).json()).status, 'cancelled');
    await app.request(`/api/tasks/${task.id}/cancel`, 'POST');
    assert.equal((await waitTask(app, task.id)).status, 'cancelled');
    await pause(50);
    assert.equal((await app.request(`/api/tasks/${task.id}`, 'DELETE')).status, 200);
  } finally { await app.dispose(); }
  const short = await setup({ timeoutMs: 1 });
  try {
    const task = await (await short.request('/api/tasks', 'POST', submission())).json();
    assert.equal((await waitTask(short, task.id)).status, 'failed');
  } finally { await short.dispose(); }
});

test('server rejects JS, malformed workload, unauthenticated access and cross-origin writes', async () => {
  const app = await setup({ token: 'private-test-key-at-least-24-characters' });
  try {
    const bad = await fetch(app.base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"token":"wrong"}' });
    assert.equal(bad.status, 401);
    const foreign = await fetch(app.base + '/api/tasks', { method: 'POST', headers: { Origin: 'https://foreign.example', Cookie: app.cookie, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(foreign.status, 403);
    assert.equal((await app.request('/api/tasks', 'POST', submission([fixtures.find(f => f.mode === 'js')]))).status, 400);
    assert.equal((await app.request('/api/tasks', 'POST', submission([{ ...fixtures[0], overrides: { nreq: 'Infinity' } }]))).status, 400);
    assert.equal((await app.request('/api/tasks', 'POST', { ...submission(), jobs: [] })).status, 400);
    assert.equal((await app.request('/src/core/simulation.js')).status, 404);
    assert.equal((await app.request('/.runtime/tasks/session-secret')).status, 404);
  } finally { await app.dispose(); }
});

test('M1: replay budgets clamp every limit without mutating frozen submissions', () => {
  const generous = { maxJobs: 100, maxRequests: Number.MAX_SAFE_INTEGER, timeoutMs: Number.MAX_SAFE_INTEGER, resultBytes: Number.MAX_SAFE_INTEGER };
  const restricted = { ...generous, maxRequests: 100, timeoutMs: 5000, resultBytes: 1024 * 1024 };
  for (const config of [generous, restricted]) {
    const caps = serverReplayLimits(config);
    const smaller = Object.fromEntries(Object.entries(caps).map(([key, value]) => [key, Math.floor(value / 2)]));
    const oversized = Object.fromEntries(Object.keys(caps).map(key => [key, Number.MAX_SAFE_INTEGER]));
    const mixed = Object.fromEntries(Object.entries(caps).map(([key, value], i) => [key, i % 2 ? value * 2 : Math.floor(value / 2)]));
    for (const requested of [undefined, {}, caps, oversized, smaller, { maxRequests: 1 }, mixed]) {
      const job = replayJob(undefined, {}, requested === undefined ? {} : { limits: requested });
      const input = freeze(submission([job]));
      const before = structuredClone(input);
      const normalized = validateSubmission(input, freeze(config));
      const actual = normalized.jobs[0].overrides.replay.options.limits;
      for (const key of Object.keys(caps)) assert.equal(actual[key], Math.min(requested?.[key] ?? DEFAULT_REPLAY_RUN_LIMITS[key], caps[key]), key);
      assert.deepEqual(input, before);
      assert.notStrictEqual(normalized, input);
      assert.notStrictEqual(normalized.jobs[0], job);
      assert.notStrictEqual(normalized.jobs[0].overrides, job.overrides);
      assert.notStrictEqual(normalized.jobs[0].overrides.replay, job.overrides.replay);
      assert.notStrictEqual(normalized.jobs[0].overrides.replay.options, job.overrides.replay.options);
      assert.notStrictEqual(actual, requested);
    }
  }
});

test('M1: HTTP worker returns complete deterministic replay results for shared prefix and interleaved anchors', async () => {
  const app = await setup();
  try {
    const { result } = await completedReplay(app, replayJob());
    assert.equal(result.completed, replayFixture.expected.requests);
    assert.equal(result.replay.counts.launchedSessions, 1);
    assert.equal(result.replay.windows.measurement.cache.hitL1Tokens, replayFixture.expected.hitL1Tokens);
    assert.equal(result.replay.cache.inputPages, replayFixture.expected.residentInputPages);
    assert.deepEqual(result.replay.state.limits, serverReplayLimits(app.config));
    assert.ok(result.replay.configuration.bundleDigest);
    assert.ok(result.replay.samples.series.length > 0);
    assert.deepEqual(Object.keys(result.replay.windows).sort(), ['drain', 'full', 'measurement', 'warmup']);
    const compiled = { version: 1, blockSize: 64, sessions: [compileReplaySession(flattenReplaySession(interleaved)).session] };
    assert.ok(compiled.sessions[0].req.some(req => req.timing.kind === 'arrival'));
    const replay = await completedReplay(app, replayJob(compiled, {}, { warmupSeconds: 0.1 }));
    assert.equal(replay.result.completed, 4);
    assert.equal(replay.result.truncated, false);
    assert.equal(replay.result.replay.counts.planned, 4);
    const mixed = replayBundle([replayRequest(128, 0), replayRequest(64, 2, 'arrival', 0), replayRequest(64, 3, 'completion', 0)]);
    const timeline = (await completedReplay(app, replayJob(mixed))).result.timeline;
    const requests = new Map(timeline.map(req => [req.id, req]));
    assert.equal(requests.size, 3);
    assert.equal(requests.get(1).arrive, requests.get(0).arrive);
    assert.equal(requests.get(2).arrive, requests.get(0).completeTime);
  } finally { await app.dispose(); }
});

test('U5: Replay ignores synthetic base parameters, rejects generation overrides, and preserves synthetic scale limits', async () => {
  const app = await setup({ maxRequests: 3 });
  try {
    const ignored = { concurrency: Number.MAX_SAFE_INTEGER, inputLen: -100, outputLen: -100 };
    const inherited = replayJob(); Object.assign(inherited.params, ignored);
    const { result } = await completedReplay(app, inherited);
    assert.equal(result.completed, 3);
    assert.equal((await completedReplay(app, replayJob())).result.completed, 3);
    for (const key of ['nreq', 'concurrency', 'inputLen', 'outputLen', 'prefixHit', 'prefixWarmL2']) {
      const response = await app.request('/api/tasks', 'POST', submission([replayJob(undefined, { [key]: 1 })]));
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /synthetic generation override/);
    }
    for (const kind of ['simulation', 'batch', 'scan']) {
      for (const overrides of [{ nreq: 4 }, { concurrency: 4 }, { nreq: 1, inputLen: 0 }, { nreq: 1, outputLen: -1 }, { nreq: 1, simMaxTime: 0.5 }]) {
        const response = await app.request('/api/tasks', 'POST', submission([{ ...fixtures[0], overrides }], kind));
        assert.equal(response.status, 400, `${kind}: ${JSON.stringify(overrides)}`);
      }
      const response = await app.request('/api/tasks', 'POST', submission([{ ...fixtures[0], overrides: { nreq: 1 } }], kind));
      assert.equal(response.status, 202);
      const task = await response.json();
      assert.equal((await waitTask(app, task.id)).status, 'completed');
    }
    const pool = replayBundle([replayRequest(64, 0)]);
    pool.sessions.push({ req: [replayRequest(64, 1), replayRequest(64, 2), replayRequest(64, 3)] });
    const run = await completedReplay(app, replayJob(pool, { qps: 4 }));
    assert.equal(run.result.replay.source.requests, 4);
    assert.equal(run.result.replay.counts.planned, 1);
  } finally { await app.dispose(); }
});

test('M1: HTTP replay uses default, larger, partial, smaller and mixed budgets with server caps', async () => {
  const app = await setup({ maxRequests: 100, timeoutMs: 10_000, resultBytes: 2 * 1024 * 1024 });
  try {
    const caps = serverReplayLimits(app.config);
    const huge = Object.fromEntries(Object.keys(caps).map(key => [key, Number.MAX_SAFE_INTEGER]));
    const smaller = Object.fromEntries(Object.entries(caps).map(([key, value]) => [key, Math.floor(value / 2)]));
    for (const limits of [undefined, {}, huge, smaller, { maxRequests: 5 }, { ...huge, maxSessions: 2, maxEvents: 10 }]) {
      const job = replayJob(undefined, {}, limits === undefined ? {} : { limits });
      const before = structuredClone(job);
      const { result, downloaded } = await completedReplay(app, job);
      const expected = Object.fromEntries(Object.entries(caps).map(([key, value]) => [key, Math.min(limits?.[key] ?? DEFAULT_REPLAY_RUN_LIMITS[key], value)]));
      assert.deepEqual(result.replay.state.limits, expected);
      assert.deepEqual(downloaded.input.jobs[0].overrides.replay.options.limits, expected);
      assert.deepEqual(job, before);
    }
    for (const seed of [0, 0xffffffff]) {
      const job = replayJob(undefined, { seed, qps: 1e-12, simMaxTime: 0.7 }, { durationSeconds: 0.3, warmupSeconds: 0.1 });
      const { result } = await completedReplay(app, job);
      assert.equal(result.replay.configuration.seed, seed);
      assert.equal(result.replay.configuration.hardCutoff, 1);
      assert.equal(result.totalReqs, 0);
      assert.equal(result.truncated, false);
    }
    const inherited = replayJob(undefined, { qps: 1e-12 });
    Object.assign(inherited.params, { seed: 0, qps: 1e-12, blockSize: 64, simMaxTime: 0.25 });
    for (const key of ['seed', 'qps', 'blockSize', 'simMaxTime']) delete inherited.overrides[key];
    assert.equal((await completedReplay(app, inherited)).result.replay.configuration.seed, 0);
  } finally { await app.dispose(); }
});

test('U5: HTTP rejects malformed Replay inputs while supporting bounded batch and scan submissions', async () => {
  const app = await setup();
  try {
    const rejectJob = async (job, pattern) => {
      const response = await app.request('/api/tasks', 'POST', submission([job]));
      const body = await response.json();
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.match(body.error, pattern);
    };
    for (const [overrides, pattern] of [
      [{ instances: 0 }, /instances/], [{ blockSize: 48 }, /64/], [{ instances: 2, pdMode: 2 }, /P\/D/],
      [{ qps: 0 }, /QPS/], [{ qps: -1 }, /QPS/], [{ qps: '2' }, /qps/], [{ qps: null }, /qps/],
      [{ seed: -1 }, /uint32/], [{ seed: 0x100000000 }, /uint32/], [{ seed: 0.5 }, /uint32/], [{ seed: '0' }, /seed/],
      [{ simMaxTime: -0.1 }, /drain/], [{ simMaxTime: null }, /simMaxTime/],
      [{ gpus: 100001 }, /dimensions/], [{ gpus: 0 }, /gpus/], [{ gpus: 1.5 }, /gpus/],
      [{ layers: 0 }, /layers/], [{ concurrency: 0 }, /concurrency/], [{ nreq: 0 }, /nreq/],
      [{ nreq: '1000000' }, /nreq/], [{ inputLen: '64' }, /inputLen/], [{ outputLen: null }, /outputLen/], [{ hbmPerGpu: '96' }, /hbmPerGpu/],
    ]) await rejectJob(replayJob(undefined, overrides), pattern);
    for (const source of ['params', 'overrides']) {
      for (const [key, value, pattern] of [['instances', 0, /instances/], ['blockSize', 48, /64/], ['pdMode', 2, /P\/D/], ['qps', 0, /QPS/], ['seed', -1, /uint32/], ['simMaxTime', -1, /drain/]]) {
        const job = replayJob(); delete job.overrides[key]; job[source][key] = value;
        if (key === 'pdMode') job.overrides.instances = 2;
        await rejectJob(job, pattern);
      }
    }
    for (const size of [0, -1, 1.5, '8', null, Number.MAX_SAFE_INTEGER + 1]) {
      const job = replayJob(); job.strategy.batching.max_batch_size = size;
      await rejectJob(job, /batch size/);
    }
    const js = replayJob(); js.mode = 'js'; await rejectJob(js, /DSL only/);
    for (const options of [
      { durationSeconds: 0 }, { durationSeconds: -1 }, { durationSeconds: null }, { durationSeconds: '1' },
      { warmupSeconds: -1 }, { warmupSeconds: 0.2 }, { warmupSeconds: 1 }, { warmupSeconds: null },
      { arrivalModel: 'open' }, { superblocks: true }, { superblocks: 'false' }, { extra: 1 },
      { limits: null }, { limits: [] }, { limits: { unknown: 1 } },
    ]) await rejectJob(replayJob(undefined, {}, options), /replay\.options/);
    for (const key of Object.keys(DEFAULT_REPLAY_RUN_LIMITS)) {
      for (const value of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
        await rejectJob(replayJob(undefined, {}, { limits: { [key]: value } }), /replay\.options\.limits/);
      }
    }
    const invalidBundle = JSON.parse(readFileSync(new URL('../fixtures/replay/bundle-invalid.json', import.meta.url)));
    for (const bundle of [null, {}, { ...replayFixture.bundle, version: 2 }, { ...replayFixture.bundle, blockSize: 32 }, { ...replayFixture.bundle, sessions: [] }, invalidBundle,
      replayBundle([{ ...replayRequest(128, 0), blockRuns: [[0, 1]] }]), replayBundle([replayRequest(64, 0, 'origin', null, -1)]),
    ]) {
      const job = replayJob(); job.overrides.replay.bundle = bundle;
      await rejectJob(job, /bundle/);
    }
    for (const replay of [null, {}, { bundle: replayFixture.bundle }, { ...replayJob().overrides.replay, extra: 1 }]) {
      const job = replayJob(); job.overrides.replay = replay;
      await rejectJob(job, /replay/);
    }
    assert.equal((await app.request('/api/tasks', 'POST', submission([replayJob(), replayJob()]))).status, 400);
    assert.deepEqual(await (await app.request('/api/tasks')).json(), []);
    for (const kind of ['batch', 'scan']) {
      for (const jobs of [[replayJob()], [fixtures[0], replayJob()], [replayJob(), fixtures[0]], [{ pBlockSize: '64', overrides: replayJob().overrides }]]) {
        const response = await app.request('/api/tasks', 'POST', submission(jobs, kind));
        assert.equal(response.status, 202, await response.clone().text());
        const task = await response.json();
        const finished = await waitTask(app, task.id);
        assert.equal(finished.status, 'completed', finished.error);
        assert.equal(finished.completed, jobs.length);
        const download = await (await app.request(`/api/tasks/${task.id}/download`)).json();
        assert.equal(download.points.length, jobs.length);
        for (let i = 0; i < jobs.length; i++) {
          const full = library.executeJob(download.input.jobs[i]);
          assert.deepEqual(download.points[i].result, JSON.parse(JSON.stringify(kind === 'scan' ? extractSensMetrics(full) : full)));
        }
      }
    }
    for (const key of ['qps', 'seed', 'simMaxTime']) {
      for (const value of [NaN, Infinity, -Infinity]) {
        assert.throws(() => validateSubmission(submission([replayJob(undefined, { [key]: value })]), app.config), /finite/);
      }
    }
  } finally { await app.dispose(); }
});

test('U5: HTTP Replay enables validated pages and topologies without changing per-job budgets', async () => {
  const app = await setup();
  try {
    for (const blockSize of [16, 32, 64, 128]) {
      for (const topology of [{ instances: 2, pdMode: 0 }, { instances: 1, pdMode: 2 }]) {
        const { result } = await completedReplay(app, replayJob(undefined, { blockSize, ...topology }));
        assert.equal(result.completed, 3);
        assert.equal(result.replay.configuration.blockMapping.physical, blockSize);
        assert.equal(result.replay.configuration.execution.instances, topology.instances);
        assert.equal(result.replay.configuration.execution.pdMode, topology.pdMode);
        assert.deepEqual(result.replay.state.limits, serverReplayLimits(app.config));
      }
    }
    const jobs = [replayJob(), replayJob(undefined, { qps: 12, ssdBW: 20 })];
    const frozen = freeze(submission(jobs, 'scan'));
    const capped = validateSubmission(frozen, { ...app.config, maxRequests: 7 });
    for (const job of capped.jobs) assert.equal(job.overrides.replay.options.limits.maxRequests, 7);
    assert.throws(() => validateSubmission(frozen, { ...app.config, maxJobs: 1 }), /1\.\.1 jobs/);
    assert.deepEqual(frozen.jobs[0].overrides.replay.options, { durationSeconds: 0.2, warmupSeconds: 0 });
  } finally { await app.dispose(); }
});

test('M1: D=0 reaches the worker hard cutoff and failed anchors retain their existing semantics', async () => {
  const app = await setup();
  try {
    const bundle = replayBundle([replayRequest(128, 0), replayRequest(64, 2, 'arrival', 0, 10_000), replayRequest(64, 3, 'completion', 0)]);
    const { result } = await completedReplay(app, replayJob(bundle, { simMaxTime: 0 }, { durationSeconds: 0.13 }));
    assert.equal(result.simEnd, 0.13);
    assert.equal(result.truncated, true);
    assert.equal(result.replay.state.terminationReason, 'hard_cutoff');
    assert.equal(result.replay.counts.arrivedUnfinished, 1);
    assert.equal(result.replay.counts.pendingArrival, 1);
    assert.equal(result.replay.counts.waitingAnchor, 1);
    assert.equal(result.replay.counts.unfinished, 3);
    const capacity = calcAll({ ...fixtures[0].params, blockSize: 64 });
    const pages = Math.floor(capacity.availHbm / capacity.blockBytes) + 1;
    const failure = replayBundle([replayRequest(pages * 64, 0), replayRequest(64, pages, 'completion', 0), replayRequest(64, pages + 1, 'arrival', 0)]);
    const failed = (await completedReplay(app, replayJob(failure))).result;
    assert.equal(failed.replay.counts.infeasible, 1);
    assert.equal(failed.replay.counts.failed, 1);
    assert.equal(failed.replay.counts.cancelled, 1);
    assert.equal(failed.replay.counts.anchor_unavailable, 1);
    assert.equal(failed.completed, 1);
  } finally { await app.dispose(); }
});

test('V2: worker returns complete drawing arrays and rejects over-budget results without success points', async () => {
  const app = await setup();
  try {
    for (const name of ['manySuccessful', 'manyUnfinished', 'mixed', 'longActive']) {
      const { result } = await completedReplay(app, visualizationCases[name]);
      const counts = result.replay.counts;
      assert.equal(result.timeline.length, counts.successful);
      assert.equal(result.incomplete.length, counts.failed + counts.arrivedUnfinished);
      assert.equal(result.timeline.length + result.incomplete.length, counts.arrived);
      assert.equal(result.concTimeline.at(-1)[0], result.simEnd);
      if (name === 'manySuccessful') assert.equal(result.timeline.length, 400);
      if (name === 'manyUnfinished') assert.equal(result.incomplete.length, 400);
      if (name === 'longActive') assert.ok(result.concTimeline.length > 20_000);
    }
    for (const name of ['manySuccessful', 'longActive']) {
      const job = structuredClone(visualizationCases[name]);
      job.overrides.replay.options.limits = { maxResultBytes: 1024 };
      const response = await app.request('/api/tasks', 'POST', submission([job]));
      assert.equal(response.status, 202);
      const id = (await response.json()).id;
      const finished = await waitTask(app, id);
      assert.equal(finished.status, 'failed');
      assert.match(finished.error, /replay\.result.*resource limit/);
      assert.equal(finished.completed, 0);
      assert.deepEqual((await (await app.request(`/api/tasks/${id}/points`)).json()).points, []);
      assert.deepEqual((await (await app.request(`/api/tasks/${id}/download`)).json()).points, []);
    }
  } finally { await app.dispose(); }
});

test('U5: finite capacity recovers via eviction while runtime budget errors never publish success points', async () => {
  const app = await setup({ maxRequests: 3 });
  try {
    const hardware = calcAll({ ...fixtures[0].params, blockSize: 64 });
    const hbmPerGpu = (hardware.modelWeightBytes + hardware.overhead + 2.5 * hardware.blockBytes) / fixtures[0].params.gpus / 1e9;
    const pressure = replayBundle([replayRequest(128, 0), replayRequest(128, 2, 'completion', 0)]);
    const recovered = (await completedReplay(app, replayJob(pressure, { hbmPerGpu }))).result;
    assert.equal(recovered.completed, 2);
    assert.equal(recovered.replay.counts.failed, 0);
    assert.equal(recovered.replay.counts.arrivedUnfinished, 0);
    assert.equal(recovered.replay.windows.full.cache.inputTokens, 256);
    assert.ok(recovered.replay.samples.peak.hbmBytes <= 2.5 * hardware.blockBytes);
    const jobs = [
      [replayJob(undefined, { qps: 30 }), /replay\.plannedRequests.*limit/],
      [replayJob(undefined, { qps: 30 }, { limits: { maxSessions: 1 } }), /replay\.launchedSessions.*limit/],
      [replayJob(undefined, {}, { limits: { maxRequests: 2 } }), /replay\.plannedRequests.*limit/],
      [replayJob(replayBundle([replayRequest(64, 0), replayRequest(64, 1)]), {}, { limits: { maxEvents: 1 } }), /replay\.events.*limit/],
      [replayJob(undefined, {}, { limits: { maxBlockReferences: 1 } }), /replay\.blockReferences.*limit/],
      [replayJob(undefined, {}, { limits: { maxResultBytes: 1 } }), /replay\.result.*limit/],
    ];
    for (const [job, pattern] of jobs) {
      const response = await app.request('/api/tasks', 'POST', submission([job]));
      assert.equal(response.status, 202, await response.clone().text());
      const task = await response.json();
      const finished = await waitTask(app, task.id);
      assert.equal(finished.status, 'failed', String(pattern));
      assert.match(finished.error, pattern);
      assert.equal(finished.completed, 0);
      assert.deepEqual((await (await app.request(`/api/tasks/${task.id}/points`)).json()).points, []);
      assert.deepEqual((await (await app.request(`/api/tasks/${task.id}/download`)).json()).points, []);
    }
  } finally { await app.dispose(); }
  const smallBody = await setup({ bodyBytes: 256 });
  try {
    assert.equal((await smallBody.request('/api/tasks', 'POST', submission([replayJob()]))).status, 413);
    assert.deepEqual(await (await smallBody.request('/api/tasks')).json(), []);
  } finally { await smallBody.dispose(); }
  const short = await setup({ timeoutMs: 1 });
  try {
    for (const job of [replayJob(), fixtures.find(f => f.name === 'window-truncated')]) {
      const response = await short.request('/api/tasks', 'POST', submission([job]));
      assert.equal(response.status, 202);
      const task = await waitTask(short, (await response.json()).id);
      assert.equal(task.status, 'failed');
      assert.match(task.error, /time limit|wallTimeMs/);
      assert.equal(task.completed, 0);
      assert.deepEqual((await (await short.request(`/api/tasks/${task.id}/download`)).json()).points, []);
    }
  } finally { await short.dispose(); }
});
