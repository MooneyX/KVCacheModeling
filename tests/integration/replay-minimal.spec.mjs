import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { baseControls } from '../fixtures/scenarios.mjs';

const fixture = name => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const baseline = fixture('simulation-baseline.json')[0];
const prefix = fixture('replay/runtime-prefix.json').bundle;
const invalid = fixture('replay/bundle-invalid.json');
const samplePath = fileURLToPath(new URL('../../data/replay/sample.json', import.meta.url));
const sampleConfig = JSON.parse(readFileSync(new URL('../../data/replay/sample-config.json', import.meta.url), 'utf8'));
const ids = ['replayQps', 'replaySeed', 'replayDuration', 'replayWarmup', 'replayDrain'];
const oneRequest = (out = 0, offsetMs = 0) => ({ version: 1, blockSize: 64, sessions: [{ req: [
  { in: 64, out, blockRuns: [[0, 1]], timing: { kind: 'origin', anchorReq: null, offsetMs } },
] }] });
const upload = (page, bundle = oneRequest(), name = 'bundle.json') => page.locator('#replayFile').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)) });
const submitted = page => page.waitForResponse(response => response.url().endsWith('/api/tasks') && response.request().method() === 'POST');
const summaryValue = (page, label) => page.locator('#replaySummary dt').filter({ hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::dd[1]');

async function importControls(page, values) {
  await page.locator('#paramsIo').fill(JSON.stringify(values));
  await page.locator('button[onclick="importParamsFromBox()"]').click();
}
async function settings(page, values = {}) {
  const params = { replayQps: '2', replaySeed: '42', replayDuration: '0.2', replayWarmup: '0', replayDrain: '5', ...values };
  for (const [id, value] of Object.entries(params)) await page.locator('#' + id).fill(value);
}
async function start(page) {
  const errors = [];
  const posts = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().endsWith('/api/tasks') && request.method() === 'POST') posts.push(request.postDataJSON());
  });
  await page.addInitScript(() => {
    window.Worker = class { constructor() { throw new Error('Replay must not execute in a browser Worker'); } };
  });
  await page.route('https://**/*', route => route.abort());
  await page.goto('/');
  await expect(page.locator('#serverStatus')).toContainText('服务器计算');
  await importControls(page, { ...baseControls, sDsl: baseline.strategy.dsl, sName: 'replay-browser', pInstances: '1', pPdSep: '0' });
  await settings(page);
  return { errors, posts };
}
async function downloadResult(page) {
  const event = page.waitForEvent('download');
  await page.locator('#replayDownload').click();
  const download = await event;
  expect(download.suggestedFilename()).toMatch(/^replay-result-seed-\d+\.json$/);
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function run(page) {
  const responseEvent = submitted(page);
  await page.locator('#replayRun').click();
  const response = await responseEvent;
  expect(response.status(), await response.text()).toBe(202);
  const task = await response.json();
  await expect(page.locator('#replayDownload')).toBeEnabled({ timeout: 30_000 });
  const result = await downloadResult(page);
  const stored = await (await page.request.get(`/api/tasks/${task.id}/download`)).json();
  expect(stored.task.status).toBe('completed');
  expect(stored.points).toHaveLength(1);
  expect(result).toEqual(stored.points[0].result);
  expect(Object.keys(result.replay.windows).sort()).toEqual(['drain', 'full', 'measurement', 'warmup']);
  expect(result.replay.samples).toHaveProperty('requestCoverage');
  return { result, task, stored };
}
async function recovered(page) {
  await expect(page.locator('#replayRun')).toBeEnabled();
  await expect(page.locator('#replayFile')).toBeEnabled();
  for (const id of ids) await expect(page.locator('#' + id)).toBeEnabled();
  await expect(page.locator('#replayDownload')).toBeDisabled();
  await expect(page.locator('#replaySummary')).toBeHidden();
  await expect(page.locator('#replayPanel')).toHaveAttribute('aria-busy', 'false');
}

test('real sample uses frozen Hy4/B300 FP8 configuration and downloads the complete worker result', async ({ page }) => {
  const { errors, posts } = await start(page);
  const { overrides, ...controls } = sampleConfig;
  await importControls(page, { ...controls, pBlockSize: '16', sDsl: 'ADMIT: always\nEVICT: lru from hbm when 95% -> dram\nPREFETCH: none\nBATCH: continuous max(8)\nPLACE: hbm_first' });
  await page.locator('[data-hw="b300x8"]').click();
  await settings(page, { replayQps: '5', replayDuration: '2', replayDrain: '600' });
  await page.locator('#replayFile').setInputFiles(samplePath);
  await expect(page.locator('#replayFileInfo')).toContainText('sample.json');
  await expect(page.locator('#replayRun')).toBeEnabled();
  expect(posts).toHaveLength(0);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  await page.route('**/api/tasks', async route => {
    if (route.request().method() === 'POST') { entered(); await gate; }
    await route.continue();
  });
  const event = submitted(page);
  await page.locator('#replayRun').click();
  await waiting;
  for (const id of ['replayFile', ...ids, 'replayRun', 'replayDownload']) await expect(page.locator('#' + id)).toBeDisabled();
  await expect(page.locator('#replayPanel')).toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() => {
    document.getElementById('replayRun').click();
    document.getElementById('pHbm').value = '1';
    document.getElementById('pParamsB').value = '1';
    document.getElementById('sName').value = 'changed-after-submit';
  });
  release();
  const response = await event;
  expect(response.status()).toBe(202);
  const task = await response.json();
  await expect(page.locator('#replayDownload')).toBeEnabled({ timeout: 30_000 });
  const r = await downloadResult(page);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ kind: 'simulation', jobs: [{ mode: 'dsl', overrides: { blockSize: 64, replay: { options: { arrivalModel: 'closed', superblocks: false } } } }] });
  expect(posts[0].jobs).toHaveLength(1);
  expect(r).toMatchObject({ completed: 20, totalReqs: 20, truncated: false });
  expect(r.replay.source).toMatchObject({ sessions: 8, requests: 220 });
  expect(r.replay.counts).toMatchObject({ launchedSessions: 1, completedSessions: 1, completeCycles: 0, planned: 20, successful: 20, failed: 0, cancelled: 0, unfinished: 0 });
  expect(r.replay.configuration).toMatchObject({ targetQps: 5, seed: 42, durationSeconds: 2, warmupSeconds: 0, hardCutoff: 602,
    execution: { paramsB: 770, gpus: 8, instances: 1, hbmPerGpu: 288, dtypeBytes: 1, weightDtype: 1, mfu: 0.5, blockSize: 64, simMaxTime: 600 } });
  expect(r.replay.configuration.strategy.name).not.toBe('changed-after-submit');
  expect(r.replay.windows.measurement).toMatchObject({ start: 0, end: 2, durationSeconds: 2 });
  expect(r.replay.state.limits.maxRequests).toBeLessThanOrEqual(20000);
  const stored = await (await page.request.get(`/api/tasks/${task.id}/download`)).json();
  expect(r).toEqual(stored.points[0].result);
  await expect(summaryValue(page, '成功请求')).toHaveText('20');
  await expect(summaryValue(page, '完整圈数')).toHaveText('0');
  await expect(page.locator('#replaySummary')).not.toContainText('changed-after-submit');
  await expect(page.locator('#pBlockSize')).toHaveValue('16');
  await page.locator('#serverRefresh').click();
  await expect(page.locator(`[data-task-id="${task.id}"]`)).toContainText('完成');
  expect(errors).toEqual([]);
  await page.reload();
  await expect(page.locator('#replayRun')).toBeDisabled();
  await expect(page.locator('#replayDownload')).toBeDisabled();
  expect(await page.locator('#replayFile').evaluate(el => el.files.length)).toBe(0);
});

test('same filename with changed bytes and identical reruns always submit new tasks without stale summaries', async ({ page }) => {
  const { errors, posts } = await start(page);
  await upload(page, oneRequest(0), 'same.json');
  const first = await run(page);
  await upload(page, oneRequest(1), 'same.json');
  await expect(page.locator('#replaySummary')).toBeHidden();
  await expect(page.locator('#replayDownload')).toBeDisabled();
  const second = await run(page);
  expect(second.result.replay.configuration.bundleDigest).not.toBe(first.result.replay.configuration.bundleDigest);
  expect(second.result.replay.source.outputTokens).toBe(1);
  const third = await run(page);
  expect(third.result).toEqual(second.result);
  expect(new Set([first.task.id, second.task.id, third.task.id]).size).toBe(3);
  expect(new Set(posts.map(post => post.requestId)).size).toBe(3);
  expect(posts.map(post => post.jobs[0].overrides.replay.bundle.sessions[0].req[0].out)).toEqual([0, 1, 1]);
  await page.locator('#replaySeed').fill('0');
  await expect(page.locator('#replaySummary')).toBeHidden();
  await expect(page.locator('#replayDownload')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('upload validation rejects malformed, wrong-shape, invalid UTF-8 and oversized files before submission', async ({ page }) => {
  const { errors, posts } = await start(page);
  await upload(page);
  await run(page);
  posts.length = 0;
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer;
    window.replayFileReads = 0;
    File.prototype.arrayBuffer = function () { window.replayFileReads++; return original.call(this); };
  });
  const cases = [
    ['broken.json', Buffer.from('{'), /有效的 JSON/],
    ['report.json', Buffer.from('{"stats":{}}'), /bundle v1/],
    ['trace.jsonl', Buffer.from('{}'), /一个 .json/],
    ['encoding.json', Buffer.from([0xff, 0xfe]), /读取失败/],
    ['large.json', Buffer.alloc(8 * 1024 * 1024 + 1, 32), /8 MiB/],
  ];
  for (const [name, buffer, error] of cases) {
    const before = await page.evaluate(() => window.replayFileReads);
    await page.locator('#replayFile').setInputFiles({ name, mimeType: 'application/json', buffer });
    await expect(page.locator('#replayStatus')).toContainText(error);
    await expect(page.locator('#replayRun')).toBeDisabled();
    await expect(page.locator('#replayDownload')).toBeDisabled();
    await expect(page.locator('#replaySummary')).toBeHidden();
    if (name === 'large.json') expect(await page.evaluate(() => window.replayFileReads)).toBe(before);
  }
  await upload(page, oneRequest(), '<img onerror=alert(1)>.json');
  await expect(page.locator('#replayFileInfo')).toContainText('<img onerror=alert(1)>.json');
  await expect(page.locator('#replayFileInfo img')).toHaveCount(0);
  await expect(page.locator('#replayRun')).toBeEnabled();
  expect(posts).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('out-of-order file reads cannot replace a newer selection or its error state', async ({ page }) => {
  const { errors } = await start(page);
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      if (this.name === 'slow.json') {
        return new Promise(resolve => { window.releaseReplayRead = () => original.call(this).then(resolve); });
      }
      return original.call(this);
    };
  });
  await upload(page, oneRequest(0), 'slow.json');
  await expect(page.locator('#replayRun')).toBeDisabled();
  await upload(page, oneRequest(1), 'latest.json');
  await expect(page.locator('#replayRun')).toBeEnabled();
  await page.evaluate(() => window.releaseReplayRead());
  const { result } = await run(page);
  expect(result.replay.source.outputTokens).toBe(1);
  await upload(page, oneRequest(), 'slow.json');
  await page.locator('#replayFile').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{') });
  await expect(page.locator('#replayStatus')).toContainText('有效的 JSON');
  await page.evaluate(() => window.releaseReplayRead());
  await expect(page.locator('#replayRun')).toBeDisabled();
  await expect(page.locator('#replayStatus')).toContainText('有效的 JSON');
  expect(errors).toEqual([]);
});

test('numeric and unsupported configuration errors stay local and unlock the panel', async ({ page }) => {
  const { errors, posts } = await start(page);
  await upload(page);
  await expect(page.locator('#replayRun')).toBeEnabled();
  for (const [id, value, message] of [
    ['replayQps', '', /不能为空/], ['replayQps', '0', /QPS/], ['replayQps', '-1', /QPS/],
    ['replaySeed', '0.5', /uint32/], ['replaySeed', '-1', /uint32/], ['replaySeed', '4294967296', /uint32/],
    ['replayDuration', '0', /投放时长/], ['replayWarmup', '-1', /暖机时长/], ['replayWarmup', '0.2', /暖机时长/],
    ['replayDrain', '-0.1', /排空上限/],
  ]) {
    await settings(page);
    await page.locator('#' + id).fill(value);
    await page.locator('#replayRun').click();
    await expect(page.locator('#replayStatus')).toContainText(message);
    await recovered(page);
  }
  await settings(page);
  await page.locator('#pInstances').fill('2');
  await page.locator('#replayRun').click();
  await expect(page.locator('#replayStatus')).toContainText('单计算实例');
  await recovered(page);
  await page.locator('#pInstances').fill('1');
  await page.locator('#pPdSep').selectOption('2');
  await page.locator('#replayRun').click();
  await expect(page.locator('#replayStatus')).toContainText('物理 P/D');
  await recovered(page);
  await page.locator('#pPdSep').selectOption('0');
  await importControls(page, { _strategyMode: 'js', sDsl: 'window.__replayJs = true;' });
  await page.locator('#replayRun').click();
  await expect(page.locator('#replayStatus')).toContainText('仅支持 DSL');
  await recovered(page);
  expect(await page.evaluate(() => window.__replayJs)).toBeUndefined();
  expect(posts).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('server validation, body-limit and service errors are visible and a real failed worker never yields a result', async ({ page }) => {
  const { errors } = await start(page);
  await upload(page);
  await run(page);
  await upload(page, invalid);
  await expect(page.locator('#replayRun')).toBeEnabled();
  let responseEvent = submitted(page);
  await page.locator('#replayRun').click();
  expect((await responseEvent).status()).toBe(400);
  await expect(page.locator('#replayStatus')).toContainText('bundle');
  await recovered(page);
  await upload(page);
  for (const status of [413, 503]) {
    const message = `${status}: <img onerror=alert(1)> service rejection`;
    await page.route('**/api/tasks', route => route.request().method() === 'POST'
      ? route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: message }) }) : route.continue());
    await page.locator('#replayRun').click();
    await expect(page.locator('#replayStatus')).toContainText(message);
    await expect(page.locator('#replayStatus img')).toHaveCount(0);
    await recovered(page);
    await page.unroute('**/api/tasks');
  }
  const twoOrigins = oneRequest();
  twoOrigins.sessions[0].req.push({ ...structuredClone(twoOrigins.sessions[0].req[0]), blockRuns: [[1, 1]] });
  await upload(page, twoOrigins);
  await settings(page, { replayQps: '4' });
  await page.route('**/api/tasks', route => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON();
    body.jobs[0].overrides.replay.options.limits = { maxEvents: 1 };
    return route.continue({ postData: JSON.stringify(body) });
  });
  responseEvent = submitted(page);
  await page.locator('#replayRun').click();
  const response = await responseEvent;
  expect(response.status()).toBe(202);
  const task = await response.json();
  await expect(page.locator('#replayStatus')).toContainText('replay.events');
  await recovered(page);
  const failed = await (await page.request.get(`/api/tasks/${task.id}/download`)).json();
  expect(failed.task.status).toBe('failed');
  expect(failed.points).toEqual([]);
  await page.unroute('**/api/tasks');
  expect((await run(page)).result.completed).toBe(2);
  expect(errors).toEqual([]);
});

test('zero seed, fractional drain, empty measurement and hard-cutoff results retain their distinct semantics', async ({ page }) => {
  const { errors } = await start(page);
  await upload(page);
  await settings(page, { replayQps: '1e-12', replaySeed: '0', replayDuration: '0.3', replayWarmup: '0.1', replayDrain: '0' });
  const zero = (await run(page)).result;
  expect(zero).toMatchObject({ completed: 0, totalReqs: 0, truncated: false });
  expect(zero.replay.configuration).toMatchObject({ seed: 0, targetQps: 1e-12, hardCutoff: 0.3, execution: { simMaxTime: 0 } });
  expect(zero.replay.counts.launchedSessions).toBe(0);
  for (const latency of Object.values(zero.replay.windows.measurement.latency).filter(value => typeof value === 'object')) {
    expect(latency).toMatchObject({ count: 0, mean: null, p50: null, p99: null });
  }
  await expect(page.locator('#replaySummary')).toContainText('无样本');
  await settings(page, { replayQps: '1e-12', replaySeed: '4294967295', replayDuration: '0.3', replayWarmup: '0.1', replayDrain: '0.7' });
  const fractional = (await run(page)).result;
  expect(fractional.replay.configuration).toMatchObject({ seed: 4294967295, durationSeconds: 0.3, warmupSeconds: 0.1, hardCutoff: 1, execution: { simMaxTime: 0.7 } });
  await upload(page, oneRequest(0, 1000));
  await settings(page);
  const drain = (await run(page)).result;
  expect(drain.completed).toBe(1);
  expect(drain.replay.windows.full.arrivals).toBe(1);
  expect(drain.replay.windows.measurement).toMatchObject({ arrivals: 0, arrivalQps: 0, completionQps: 0, cache: { hitRate: null } });
  expect(drain.replay.windows.measurement.latency.ttft.mean).toBeNull();
  await expect(summaryValue(page, '到达 QPS')).toHaveText('0');
  await expect(summaryValue(page, '命中率')).toHaveText('无样本');
  await settings(page, { replayDrain: '0' });
  const truncated = (await run(page)).result;
  expect(truncated.truncated).toBe(true);
  expect(truncated.simEnd).toBeCloseTo(0.2);
  expect(truncated.replay.state.terminationReason).toBe('hard_cutoff');
  expect(truncated.replay.counts.unfinished).toBe(1);
  await expect(page.locator('#replayStatus')).toContainText('截断');
  expect(errors).toEqual([]);
});

test('existing network retry reuses the exact submission and requestId', async ({ page }) => {
  const { errors, posts } = await start(page);
  await upload(page);
  let attempts = 0;
  await page.route('**/api/tasks', route => {
    if (route.request().method() === 'POST' && ++attempts === 1) return route.abort('connectionfailed');
    return route.continue();
  });
  const { result } = await run(page);
  expect(result.completed).toBe(1);
  expect(attempts).toBe(2);
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
  expect(errors).toEqual([]);
});

test('Replay preserves synthetic results, cache and legacy parameter import/export in both builds', async ({ page }) => {
  const { errors, posts } = await start(page);
  await page.locator('#pBlockSize').fill('256');
  await page.locator('button[onclick="exportParams()"]').click();
  const original = JSON.parse(await page.locator('#paramsIo').inputValue());
  let responseEvent = submitted(page);
  await page.locator('button[onclick="applyStrategies()"]').click();
  expect((await responseEvent).status()).toBe(202);
  await expect(page.locator('#strategyMetricsGrid')).toContainText('replay-browser');
  const syntheticHtml = await page.locator('#strategyMetricsGrid').innerHTML();
  await upload(page, prefix);
  await settings(page, { replayQps: '6' });
  const { result } = await run(page);
  expect(result.completed).toBe(3);
  expect(result.replay.windows.full.cache).toMatchObject({ inputTokens: 448, hitL1Tokens: 192, missTokens: 256 });
  expect(result.replay.configuration.execution.blockSize).toBe(64);
  await expect(page.locator('#pBlockSize')).toHaveValue('256');
  expect(await page.locator('#strategyMetricsGrid').innerHTML()).toBe(syntheticHtml);
  await page.locator('button[onclick="exportParams()"]').click();
  const exported = JSON.parse(await page.locator('#paramsIo').inputValue());
  expect(exported).toEqual(original);
  expect(Object.keys(exported).some(key => key.startsWith('replay'))).toBe(false);
  await importControls(page, { ...original, replaySeed: '999', replayDuration: '123', replayFile: 'not-a-bundle' });
  await expect(page.locator('#replaySeed')).toHaveValue('42');
  await expect(page.locator('#replayDuration')).toHaveValue('0.2');
  await expect(page.locator('#replayDownload')).toBeEnabled();
  const before = posts.length;
  await page.locator('button[onclick="applyStrategies()"]').click();
  await expect(page.locator('button[onclick="applyStrategies()"]')).toBeEnabled();
  expect(posts).toHaveLength(before);
  expect(await page.locator('#strategyMetricsGrid').innerHTML()).toBe(syntheticHtml);
  await page.locator('#pSeed').fill('43');
  responseEvent = submitted(page);
  await page.locator('button[onclick="applyStrategies()"]').click();
  const syntheticResponse = await responseEvent;
  expect(syntheticResponse.status()).toBe(202);
  const syntheticTask = await syntheticResponse.json();
  await expect(page.locator('button[onclick="applyStrategies()"]')).toBeEnabled();
  const syntheticResult = await (await page.request.get(`/api/tasks/${syntheticTask.id}/download`)).json();
  expect(syntheticResult.task.status).toBe('completed');
  expect(syntheticResult.points).toHaveLength(1);
  expect(syntheticResult.points[0].result.completed).toBeGreaterThan(0);
  expect(syntheticResult.points[0].result.replay).toBeUndefined();
  await expect(page.locator('#strategyMetricsGrid')).toContainText('replay-browser');
  expect(posts.at(-1).jobs[0].overrides?.replay).toBeUndefined();
  expect(posts[0].jobs[0].overrides?.replay).toBeUndefined();
  await expect(page.locator('#replayDownload')).toBeEnabled();
  expect(await downloadResult(page)).toEqual(result);
  expect(errors).toEqual([]);
});
