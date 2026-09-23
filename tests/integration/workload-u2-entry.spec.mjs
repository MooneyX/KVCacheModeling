import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { runSimulation, WORKLOAD_MODEL_VERSION } from '../../src/core/simulation.js';

const base = JSON.parse(readFileSync(new URL('../fixtures/simulation-baseline.json', import.meta.url)))[0];
const { bundle } = JSON.parse(readFileSync(new URL('../fixtures/replay/runtime-prefix.json', import.meta.url)));

async function completedTask(page, kind, jobs) {
  const response = await page.request.post('/api/tasks', { data: { kind, jobs, requestId: randomUUID(), label: 'U5 entry consistency' } });
  expect(response.status(), await response.text()).toBe(202);
  const task = await response.json();
  await expect.poll(async () => (await (await page.request.get(`/api/tasks/${task.id}`)).json()).status,
    { timeout: 30_000 }).toBe('completed');
  const stored = await (await page.request.get(`/api/tasks/${task.id}/download`)).json();
  expect(stored.task.status).toBe('completed');
  expect(stored.points).toHaveLength(jobs.length);
  return stored.points.map(point => point.result);
}

for (const workloadSource of ['synthetic', 'replay']) {
  test(`U5: identical ${workloadSource} jobs produce equal complete results singly and in independent batch slots`, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#serverStatus')).toContainText('服务器计算');
    const job = { params: structuredClone(base.params), strategy: structuredClone(base.strategy), mode: 'dsl',
      overrides: workloadSource === 'replay'
        ? { seed: 0, blockSize: 32, qps: 6, simMaxTime: 1, replay: { bundle, options: { durationSeconds: 0.2, warmupSeconds: 0 } } }
        : { seed: 0, blockSize: 32, qps: 2, nreq: 2, inputLen: 64, outputLen: 2, lenDist: 'fixed', prefixHit: 0, prefixWarm: false } };
    const before = structuredClone(job);
    const [single] = await completedTask(page, 'simulation', [job]);
    const batch = await completedTask(page, 'batch', [job, structuredClone(job)]);
    expect(batch).toEqual([single, single]);
    expect(job).toEqual(before);
    expect(single.configuration.workloadModelVersion).toBe(WORKLOAD_MODEL_VERSION);
    if (workloadSource === 'replay') {
      expect(single.replay.configuration).toEqual(single.configuration);
      expect(single.replay.configuration.seed).toBe(0);
      expect(single.replay.configuration.execution.blockSize).toBe(32);
      expect(single.hitTok).toEqual({ l1: 192, l2: 0, l3: 0, miss: 256, total: 448 });
      expect(single.replay.counts.successful).toBe(3);
    } else expect(single.replay).toBeUndefined();
  });
}

test('U5: deployed task entry defaults to the unified engine and cannot inject acceptance overrides', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#serverStatus')).toContainText('服务器计算');
  const health = await (await page.request.get('/api/health')).json();
  const version = createHash('sha256').update(readFileSync(new URL('../../dist/node/runner.cjs', import.meta.url))).digest('hex').slice(0, 16);
  expect(health.engineVersion).toBe(version);
  const overrides = { seed: 42, blockSize: 64, nreq: 1, inputLen: 64, outputLen: 64,
    prefixHit: 0, prefixWarm: false, lenDist: 'fixed', qps: 2 };
  const jobs = [
    { params: base.params, strategy: base.strategy, mode: 'dsl', overrides },
    { params: base.params, strategy: base.strategy, mode: 'dsl', overrides: { ...overrides,
      unified: true, acceptance: { window: { hardCutoff: 0 } }, workloadModelVersion: WORKLOAD_MODEL_VERSION } },
    { params: base.params, strategy: base.strategy, mode: 'dsl', overrides: { seed: 42, blockSize: 64, qps: 6, simMaxTime: 5,
      replay: { bundle, options: { durationSeconds: 0.2, warmupSeconds: 0 } } } },
  ];
  const results = [];
  for (const job of jobs) {
    const response = await page.request.post('/api/tasks', { data: { kind: 'simulation', jobs: [job], label: 'U3 entry isolation', requestId: randomUUID() } });
    expect(response.status(), await response.text()).toBe(202);
    const task = await response.json();
    await expect.poll(async () => (await (await page.request.get(`/api/tasks/${task.id}`)).json()).status,
      { timeout: 30_000 }).toBe('completed');
    const download = await (await page.request.get(`/api/tasks/${task.id}/download`)).json();
    const result = download.points[0].result;
    expect(JSON.stringify(result)).not.toMatch(/"(?:inputContent|routingKey|sessionId|modelVersion)":/);
    results.push(result);
  }
  expect(results[0]).toEqual(JSON.parse(JSON.stringify(runSimulation(base.params, base.strategy, overrides))));
  expect(results[1]).toEqual(results[0]);
  expect(results[0].configuration.workloadModelVersion).toBe(WORKLOAD_MODEL_VERSION);
  expect(results[1].configuration.workloadModelVersion).toBe(WORKLOAD_MODEL_VERSION);
  for (const result of results) {
    expect(result.configuration.execution).not.toHaveProperty('acceptance');
    expect(result.configuration.execution).not.toHaveProperty('unified');
    expect(result.configuration.execution).not.toHaveProperty('workloadModelVersion');
  }
  expect(results[1].completed).toBe(1);
  expect(results[1].simEnd).toBeGreaterThan(0);
  expect(results[2].replay.configuration).toEqual(results[2].configuration);
  expect(results[2].replay.configuration.workloadModelVersion).toBe(WORKLOAD_MODEL_VERSION);
  expect(results[2].replay.state.supportedScope).toBe('single-instance/64-token/finite-capacity-tiered-four-configurations');
  expect(results[2].completed).toBe(3);
  expect(results[2].hitTok).toEqual({ l1: 192, l2: 0, l3: 0, miss: 256, total: 448 });
  expect(results[2].replay.cache.inputPages).toBe(4);
});

test('U4: deployed input rejects unsupported physical boundaries and conflicting topologies for both sources', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#serverStatus')).toContainText('服务器计算');
  for (const replay of [undefined, { bundle, options: { durationSeconds: 0.2, warmupSeconds: 0 } }]) {
    for (const [overrides, pattern] of [
      ...[1.5, 48, 96].map(blockSize => [{ blockSize }, /blockSize|64/]),
      [{ instances: 2, pdMode: 2 }, /Multiple instances.*P\/D/],
    ]) {
      const response = await page.request.post('/api/tasks', { data: {
        kind: 'simulation', requestId: randomUUID(), label: 'U4 invalid configuration', jobs: [{
          params: base.params, strategy: base.strategy, mode: 'dsl',
          overrides: { ...overrides, ...(replay ? { replay } : {}) },
        }],
      } });
      expect(response.status()).toBe(400);
      expect((await response.json()).error).toMatch(pattern);
    }
  }
});
