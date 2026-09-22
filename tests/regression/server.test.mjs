import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { runSimulation } from '../../src/core/simulation.js';
import { extractSensMetrics } from '../../src/application/metrics.js';

const require = createRequire(import.meta.url);
const { createTaskServer } = require('../../dist/node/server-library.cjs');
const fixtures = JSON.parse(readFileSync(new URL('../fixtures/simulation-baseline.json', import.meta.url), 'utf8'));
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
    method, headers: { 'Content-Type': 'application/json', Cookie: overrideCookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { ...app, config, dataDir, base, cookie, request, async dispose(remove = true) { await app.close(); if (remove) rmSync(dataDir, { recursive: true, force: true }); } };
}
async function waitTask(app, id) {
  for (let i = 0; i < 300; i++) {
    const task = await (await app.request('/api/tasks/' + id)).json();
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status)) return task;
    await pause(20);
  }
  throw new Error('Task did not complete');
}
const submission = (jobs = [fixtures[0]], kind = 'simulation') => ({ kind, jobs, label: 'regression', requestId: crypto.randomUUID() });

test('server executes identical results, deduplicates submission and scopes task ownership', async () => {
  const app = await setup();
  try {
    const input = submission(fixtures.filter(f => f.mode !== 'js'), 'batch');
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
