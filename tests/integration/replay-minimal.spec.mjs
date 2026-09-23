import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { baseControls } from '../fixtures/scenarios.mjs';
import { visualizationCases } from '../fixtures/replay-visualization.mjs';
import { extractSensMetrics } from '../../src/application/metrics.js';

const fixture = name => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const baseline = fixture('simulation-baseline.json')[0];
const prefix = fixture('replay/runtime-prefix.json').bundle;
const invalid = fixture('replay/bundle-invalid.json');
const samplePath = fileURLToPath(new URL('../../data/replay/sample.json', import.meta.url));
const sampleConfig = JSON.parse(readFileSync(new URL('../../data/replay/sample-config.json', import.meta.url), 'utf8'));
const ids = ['replayQps', 'replaySeed', 'replayDuration', 'replayWarmup', 'replayDrain'];
const runButton = 'button[onclick="applyStrategies()"]';
const allButton = 'button[onclick="runAllStrategies()"]';
const chartIds = ['chartStrategyGantt', 'chartStrategyPt', 'chartStrategyBwReq', 'chartStrategyResident', 'chartGantt', 'chartBatchOcc'];
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
async function source(page, value) {
  await page.locator('#workloadSource').selectOption(value);
  await expect(page.locator('#syntheticPanel')).toHaveJSProperty('hidden', value !== 'synthetic');
  await expect(page.locator('#replayPanel')).toHaveJSProperty('hidden', value !== 'replay');
  await expect(page.locator(value === 'replay' ? '#replayPanel' : '#syntheticPanel')).toBeVisible();
  await expect(page.locator(value === 'replay' ? '#syntheticPanel' : '#replayPanel')).toBeHidden();
  for (const id of ['pParamsB', 'pHbm', 'pBlockSize', 'sDsl']) await expect(page.locator('#' + id)).toBeVisible();
}
async function start(page, workloadSource = 'replay') {
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
  await expect(page.locator('#workloadSource')).toHaveValue('synthetic');
  await expect(page.locator('#syntheticPanel')).toBeVisible();
  await expect(page.locator('#replayPanel')).toBeHidden();
  await expect(page.locator('#replayRun')).toHaveCount(0);
  await importControls(page, { ...baseControls, sDsl: baseline.strategy.dsl, sName: 'replay-browser', pBlockSize: '64', pInstances: '1', pPdSep: '0' });
  if (workloadSource === 'replay') {
    await source(page, 'replay');
    await settings(page);
  }
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
  await page.locator(runButton).click();
  const response = await responseEvent;
  expect(response.status(), await response.text()).toBe(202);
  const task = await response.json();
  await expect(page.locator(runButton)).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator('#simulationStatus')).toContainText('运行完成');
  await expect(page.locator('#replayDownload')).toBeEnabled();
  const result = await downloadResult(page);
  const stored = await (await page.request.get(`/api/tasks/${task.id}/download`)).json();
  expect(stored.task.status).toBe('completed');
  expect(stored.points).toHaveLength(1);
  expect(result).toEqual(stored.points[0].result);
  expect(Object.keys(result.replay.windows).sort()).toEqual(['drain', 'full', 'measurement', 'warmup']);
  expect(result.replay.samples).toHaveProperty('requestCoverage');
  return { result, task, stored };
}
async function recovered(page, previous = null) {
  await expect(page.locator(runButton)).toBeEnabled();
  await expect(page.locator('#workloadSource')).toBeEnabled();
  await expect(page.locator('#replayFile')).toBeEnabled();
  await expect(page.locator(allButton)).toBeDisabled();
  for (const id of ids) await expect(page.locator('#' + id)).toBeEnabled();
  if (previous) {
    await expect(page.locator('#replaySummary')).toBeVisible();
    await expect(page.locator('#replayDownload')).toBeEnabled();
    expect(await downloadResult(page)).toEqual(previous);
  } else {
    await expect(page.locator('#replayDownload')).toBeDisabled();
    await expect(page.locator('#replaySummary')).toBeHidden();
  }
  await expect(page.locator('#replayPanel')).toHaveAttribute('aria-busy', 'false');
}
async function capture(page) {
  return page.evaluate(ids => ({
    metrics: document.getElementById('strategyMetricsGrid').innerHTML,
    snapshot: document.getElementById('simulationSnapshot').textContent,
    formulas: ['formulaStrategySim', 'formulaStrategyTier', 'formulaGantt', 'formulaBatchOcc'].map(id => document.getElementById(id).textContent),
    charts: ids.map(id => {
      const option = window.echarts.getInstanceByDom(document.getElementById(id))?.getOption();
      return option ? { series: option.series.map(s => ({ name: s.name, data: s.data })), xAxis: option.xAxis, yAxis: option.yAxis } : null;
    }),
  }), chartIds);
}
async function refreshTabs(page) {
  for (const [tab, chart] of [['schedule', 'chartGantt'], ['params', 'chartStrategyGantt']]) {
    const previous = await page.evaluate(id => window.echarts.getInstanceByDom(document.getElementById(id))?.id, chart);
    await page.locator(`.nav-item[data-tab="tab-${tab}"]`).click();
    await expect.poll(() => page.evaluate(({ chart, previous }) => {
      const current = window.echarts.getInstanceByDom(document.getElementById(chart))?.id;
      return !!current && current !== previous;
    }, { chart, previous })).toBe(true);
  }
}
async function runSynthetic(page) {
  const responseEvent = submitted(page);
  await page.locator(runButton).click();
  const response = await responseEvent;
  expect(response.status()).toBe(202);
  const task = await response.json();
  await expect(page.locator(runButton)).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator('#simulationStatus')).toHaveText('运行完成');
  const stored = await (await page.request.get(`/api/tasks/${task.id}/download`)).json();
  expect(stored.task.status).toBe('completed');
  expect(stored.points).toHaveLength(1);
  expect(stored.points[0].result.replay).toBeUndefined();
  return stored.points[0].result;
}

test('Replay typography matches the legacy interface without changing existing fonts', async ({ page }) => {
  const { errors } = await start(page, 'synthetic');
  const typography = locator => locator.evaluate(el => {
    const style = getComputedStyle(el);
    return Object.fromEntries(['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color'].map(key => [key, style[key]]));
  });
  const legacy = await page.context().newPage();
  try {
    const markup = await page.evaluate(html => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc.querySelectorAll('script').forEach(script => script.remove());
      return doc.documentElement.outerHTML;
    }, readFileSync(new URL('../fixtures/legacy/index.html', import.meta.url), 'utf8'));
    await legacy.setContent(markup);
    for (const selector of ['body', '.brand', '.sidebar .nav-item', '.card h2', '#tab-params h3', '.card .subtitle', 'label', '#pQps', '#pArrivalDist', '#sDsl', '#paramsIo', '.formula-box']) {
      expect(await typography(page.locator(selector).first()), selector).toEqual(await typography(legacy.locator(selector).first()));
    }
    const inputHeading = await typography(legacy.locator('#tab-params h3').first());
    const resultHeading = await typography(legacy.locator('#strategyResults .row2 h3').first());
    const note = await typography(legacy.locator('.card .subtitle').first());
    const formula = await typography(legacy.locator('.formula-box').first());
    await source(page, 'replay');
    expect(await typography(page.locator('#replayTitle'))).toEqual(inputHeading);
    for (const selector of ['#replayFileInfo', '#replayStatus']) {
      expect(await typography(page.locator(selector)), selector).toEqual(note);
    }
    expect(await typography(page.locator('#replayQps'))).toEqual(await typography(legacy.locator('#pQps')));
    await upload(page);
    await run(page);
    await expect(page.locator('#replaySummary')).toBeVisible();
    for (const heading of await page.locator('#replaySummary h3').all()) {
      expect(await typography(heading)).toEqual(resultHeading);
    }
    for (const selector of ['#replayFileInfo', '#replayStatus', '#replaySummary dt', '#replaySummary > p', '#replaySummary summary']) {
      expect(await typography(page.locator(selector).first()), selector).toEqual(note);
    }
    const value = await typography(page.locator('#replaySummary dd').first());
    expect(value).toEqual({ ...note, color: (await typography(page.locator('body'))).color });
    await page.locator('#replaySummary summary').first().click();
    await expect(page.locator('#replaySummary pre').first()).toBeVisible();
    expect(await typography(page.locator('#replaySummary pre').first())).toEqual(formula);
    await page.locator('.nav-item[data-tab="tab-schedule"]').click();
    await expect(page.locator('#ganttPagination')).toBeVisible();
    expect(await typography(page.locator('#ganttPageStatus'))).toEqual(note);
    for (const selector of ['#ganttPrev', '#ganttNext']) {
      expect(await typography(page.locator(selector))).toEqual(await typography(page.locator('#replayDownload')));
    }
    await page.locator('.nav-item[data-tab="tab-params"]').click();
    await source(page, 'synthetic');
    expect(await typography(page.locator('#pQps'))).toEqual(await typography(legacy.locator('#pQps')));
    expect(await typography(page.locator('#replaySummary h3').first())).toEqual(resultHeading);
    expect(errors).toEqual([]);
  } finally {
    await legacy.close();
  }
});

test('real sample uses frozen Hy4/B300 FP8 configuration and downloads the complete worker result', async ({ page }) => {
  const { errors, posts } = await start(page);
  const { overrides, ...controls } = sampleConfig;
  await importControls(page, { ...controls, pBlockSize: '64', sDsl: 'ADMIT: always\nEVICT: lru from hbm when 95% -> dram\nPREFETCH: none\nBATCH: continuous max(8)\nPLACE: hbm_first' });
  await page.locator('[data-hw="b300x8"]').click();
  await settings(page, { replayQps: '5', replayDuration: '2', replayDrain: '600' });
  await page.locator('#replayFile').setInputFiles(samplePath);
  await expect(page.locator('#replayFileInfo')).toContainText('sample.json');
  await expect(page.locator(runButton)).toBeEnabled();
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
  await page.locator(runButton).click();
  await waiting;
  for (const id of ['workloadSource', 'replayFile', ...ids, 'replayDownload']) await expect(page.locator('#' + id)).toBeDisabled();
  await expect(page.locator(runButton)).toBeDisabled();
  await expect(page.locator(allButton)).toBeDisabled();
  await expect(page.locator('#replayPanel')).toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() => {
    window.applyStrategies();
    window.runAllStrategies();
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
  expect(posts[0]).toMatchObject({ kind: 'simulation', jobs: [{ mode: 'dsl', params: { blockSize: 64 }, overrides: { replay: { options: { arrivalModel: 'closed', superblocks: false } } } }] });
  expect(posts[0].jobs[0].overrides).not.toHaveProperty('blockSize');
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
  await expect(page.locator('#pBlockSize')).toHaveValue('64');
  await expect(page.locator('#simulationSnapshot')).toContainText('Replay');
  await expect(page.locator('#simulationSnapshot')).not.toContainText('changed-after-submit');
  await expect(page.locator('#simulationDirty')).toHaveText('输入已修改，尚未重新运行');
  await page.locator('#serverRefresh').click();
  await expect(page.locator(`[data-task-id="${task.id}"]`)).toContainText('完成');
  expect(errors).toEqual([]);
  await page.reload();
  await expect(page.locator('#workloadSource')).toHaveValue('synthetic');
  await source(page, 'replay');
  await expect(page.locator(runButton)).toBeDisabled();
  await expect(page.locator('#replayDownload')).toBeDisabled();
  expect(await page.locator('#replayFile').evaluate(el => el.files.length)).toBe(0);
});

test('same filename changes and identical reruns bypass cache while edits retain the published result', async ({ page }) => {
  const { errors, posts } = await start(page);
  await upload(page, oneRequest(0), 'same.json');
  const first = await run(page);
  const firstSnapshot = await page.locator('#simulationSnapshot').textContent();
  await upload(page, oneRequest(1), 'same.json');
  await recovered(page, first.result);
  expect(await page.locator('#simulationSnapshot').textContent()).toBe(firstSnapshot);
  await expect(page.locator('#simulationDirty')).toBeVisible();
  const second = await run(page);
  expect(second.result.replay.configuration.bundleDigest).not.toBe(first.result.replay.configuration.bundleDigest);
  expect(second.result.replay.source.outputTokens).toBe(1);
  await expect(page.locator('#simulationDirty')).toBeHidden();
  const third = await run(page);
  expect(third.result).toEqual(second.result);
  expect(new Set([first.task.id, second.task.id, third.task.id]).size).toBe(3);
  expect(new Set(posts.map(post => post.requestId)).size).toBe(3);
  expect(posts.map(post => post.jobs[0].overrides.replay.bundle.sessions[0].req[0].out)).toEqual([0, 1, 1]);
  await page.locator('#replaySeed').fill('0');
  await recovered(page, third.result);
  await expect(page.locator('#simulationDirty')).toHaveText('输入已修改，尚未重新运行');
  expect(posts).toHaveLength(3);
  expect(errors).toEqual([]);
});

test('upload validation rejects malformed, wrong-shape, invalid UTF-8 and oversized files before submission', async ({ page }) => {
  const { errors, posts } = await start(page);
  await upload(page);
  const { result: previous } = await run(page);
  const snapshot = await page.locator('#simulationSnapshot').textContent();
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
    await expect(page.locator(runButton)).toBeDisabled();
    await expect(page.locator('#replayDownload')).toBeEnabled();
    await expect(page.locator('#replaySummary')).toBeVisible();
    expect(await downloadResult(page)).toEqual(previous);
    expect(await page.locator('#simulationSnapshot').textContent()).toBe(snapshot);
    await expect(page.locator('#simulationStatus')).toHaveText('运行完成');
    if (name === 'large.json') expect(await page.evaluate(() => window.replayFileReads)).toBe(before);
  }
  await upload(page, oneRequest(), '<img onerror=alert(1)>.json');
  await expect(page.locator('#replayFileInfo')).toContainText('<img onerror=alert(1)>.json');
  await expect(page.locator('#replayFileInfo img')).toHaveCount(0);
  await expect(page.locator(runButton)).toBeEnabled();
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
  await expect(page.locator(runButton)).toBeDisabled();
  await upload(page, oneRequest(1), 'latest.json');
  await expect(page.locator(runButton)).toBeEnabled();
  await page.evaluate(() => window.releaseReplayRead());
  const { result } = await run(page);
  expect(result.replay.source.outputTokens).toBe(1);
  await upload(page, oneRequest(), 'slow.json');
  await page.locator('#replayFile').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{') });
  await expect(page.locator('#replayStatus')).toContainText('有效的 JSON');
  await page.evaluate(() => window.releaseReplayRead());
  await expect(page.locator(runButton)).toBeDisabled();
  await expect(page.locator('#replayStatus')).toContainText('有效的 JSON');
  expect(errors).toEqual([]);
});

test('numeric and unsupported configuration errors stay local and unlock the panel', async ({ page }) => {
  const { errors, posts } = await start(page);
  await upload(page);
  await expect(page.locator(runButton)).toBeEnabled();
  for (const [id, value, message] of [
    ['replayQps', '', /不能为空/], ['replayQps', '0', /QPS/], ['replayQps', '-1', /QPS/],
    ['replaySeed', '0.5', /uint32/], ['replaySeed', '-1', /uint32/], ['replaySeed', '4294967296', /uint32/],
    ['replayDuration', '0', /投放时长/], ['replayWarmup', '-1', /暖机时长/], ['replayWarmup', '0.2', /暖机时长/],
    ['replayDrain', '-0.1', /排空上限/],
  ]) {
    await settings(page);
    await page.locator('#' + id).fill(value);
    await page.locator(runButton).click();
    await expect(page.locator('#simulationStatus')).toContainText(message);
    await expect(page.locator('#simulationStatus')).toContainText('仿真出错:');
    await expect(page.locator('#replayStatus')).not.toContainText(message);
    await recovered(page);
  }
  await settings(page);
  await page.locator('#pBlockSize').fill('256');
  await page.locator(runButton).click();
  await expect(page.locator('#simulationStatus')).toContainText('64');
  await expect(page.locator('#pBlockSize')).toHaveValue('256');
  await recovered(page);
  await page.locator('#pBlockSize').fill('64');
  await page.locator('#pInstances').fill('2');
  await page.locator(runButton).click();
  await expect(page.locator('#simulationStatus')).toContainText('单计算实例');
  await expect(page.locator('#pInstances')).toHaveValue('2');
  await recovered(page);
  await page.locator('#pInstances').fill('1');
  await page.locator('#pPdSep').selectOption('2');
  await page.locator(runButton).click();
  await expect(page.locator('#simulationStatus')).toContainText('物理 P/D');
  await recovered(page);
  await page.locator('#pPdSep').selectOption('0');
  await importControls(page, { _strategyMode: 'js', sDsl: 'window.__replayJs = true;' });
  await page.locator(runButton).click();
  await expect(page.locator('#simulationStatus')).toContainText('仅支持 DSL');
  await recovered(page);
  expect(await page.evaluate(() => window.__replayJs)).toBeUndefined();
  expect(posts).toHaveLength(0);
  await importControls(page, { _strategyMode: 'dsl', sDsl: baseline.strategy.dsl });
  expect((await run(page)).result.completed).toBe(1);
  expect(posts).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('server validation, body-limit and service errors are visible and a real failed worker never yields a result', async ({ page }) => {
  const { errors } = await start(page);
  await upload(page);
  const { result: previous } = await run(page);
  await refreshTabs(page);
  const snapshot = await capture(page);
  await upload(page, invalid);
  await expect(page.locator(runButton)).toBeEnabled();
  let responseEvent = submitted(page);
  await page.locator(runButton).click();
  expect((await responseEvent).status()).toBe(400);
  await expect(page.locator('#simulationStatus')).toContainText('bundle');
  await recovered(page, previous);
  expect(await capture(page)).toEqual(snapshot);
  await upload(page);
  for (const status of [413, 503]) {
    const message = `${status}: <img onerror=alert(1)> service rejection`;
    await page.route('**/api/tasks', route => route.request().method() === 'POST'
      ? route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: message }) }) : route.continue());
    await page.locator(runButton).click();
    await expect(page.locator('#simulationStatus')).toHaveText(`仿真出错: ${message}`);
    await expect(page.locator('#simulationStatus img')).toHaveCount(0);
    await expect(page.locator('#replayStatus')).not.toContainText(message);
    await recovered(page, previous);
    expect(await capture(page)).toEqual(snapshot);
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
  await page.locator(runButton).click();
  const response = await responseEvent;
  expect(response.status()).toBe(202);
  const task = await response.json();
  await expect(page.locator('#simulationStatus')).toContainText('replay.events');
  await expect(page.locator('#replayStatus')).not.toContainText('replay.events');
  await recovered(page, previous);
  expect(await capture(page)).toEqual(snapshot);
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
  await expect(page.locator('#simulationStatus')).toContainText('截断');
  await expect(page.locator('#simulationSnapshot')).toContainText('截断');
  await expect(page.locator('#simulationDirty')).toBeHidden();
  await expect(page.locator('#replayStatus')).not.toContainText('截断');
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

test('V4: synthetic to Replay to synthetic replaces every result view without mixing inputs, cache or parameter files', async ({ page }) => {
  const { errors, posts } = await start(page, 'synthetic');
  await page.locator('#pSeed').fill('41');
  await expect(page.locator('#simulationDirty')).toBeHidden();
  await page.locator('button[onclick="exportParams()"]').click();
  const original = JSON.parse(await page.locator('#paramsIo').inputValue());
  const syntheticResult = await runSynthetic(page);
  expect(syntheticResult.completed).toBeGreaterThan(0);
  await refreshTabs(page);
  const synthetic = await capture(page);
  expect(synthetic.snapshot).toContain('最近一次运行');
  expect(synthetic.snapshot).toContain('合成');
  await page.evaluate(() => {
    window.v4InputElements = ['pQps', 'pInputLen', 'replayQps', 'replaySeed', 'replayFile'].map(id => document.getElementById(id));
  });
  await source(page, 'replay');
  await expect(page.locator('#simulationDirty')).toHaveText('输入已修改，尚未重新运行');
  await expect(page.locator(runButton)).toBeDisabled();
  await upload(page, prefix, 'preserved.json');
  await settings(page, { replayQps: '6', replaySeed: '42' });
  const fileInfo = await page.locator('#replayFileInfo').textContent();
  for (let i = 0; i < 2; i++) {
    await source(page, 'synthetic');
    for (const id of ['pQps', 'pInputLen', 'pOutputLen', 'pSeed', 'pSimMaxTime']) await expect(page.locator('#' + id)).toHaveValue(original[id]);
    await source(page, 'replay');
    await expect(page.locator('#replayQps')).toHaveValue('6');
    await expect(page.locator('#replaySeed')).toHaveValue('42');
    await expect(page.locator('#replayDuration')).toHaveValue('0.2');
    expect(await page.locator('#replayFileInfo').textContent()).toBe(fileInfo);
    expect(await page.locator('#replayFile').evaluate(el => el.files[0].name)).toBe('preserved.json');
    for (const id of ['pParamsB', 'pHbm', 'pBlockSize', 'pInstances', 'sDsl']) await expect(page.locator('#' + id)).toHaveValue(original[id]);
    await refreshTabs(page);
    expect(await capture(page)).toEqual(synthetic);
  }
  expect(await page.evaluate(() => window.v4InputElements.every(el => document.getElementById(el.id) === el))).toBe(true);
  expect(posts).toHaveLength(1);
  const { result } = await run(page);
  expect(posts).toHaveLength(2);
  expect(posts[1].kind).toBe('simulation');
  expect(posts[1].jobs).toHaveLength(1);
  expect(posts[1].jobs[0].overrides).toMatchObject({ qps: 6, seed: 42, replay: { bundle: prefix } });
  expect(posts[0].jobs[0].params.seed).toBe(41);
  expect(posts[1].jobs[0].overrides).not.toHaveProperty('blockSize');
  expect(result.completed).toBe(3);
  expect(result.replay.counts).toMatchObject({ planned: 3, arrived: 3, successful: 3, launchedSessions: 1, completedSessions: 1, completeCycles: 1 });
  expect(result.replay.windows.full.cache).toMatchObject({ inputTokens: 448, hitL1Tokens: 192, missTokens: 256 });
  await refreshTabs(page);
  const replay = await capture(page);
  expect(replay).not.toEqual(synthetic);
  expect(replay.snapshot).toContain('Replay');
  expect(replay.metrics).toContain('measurement');
  expect(replay.formulas[0]).toContain('measurement');
  expect(replay.formulas[1]).toContain('全程');
  expect(replay.formulas[2]).toContain('来源：Replay');
  expect(replay.formulas[3]).toContain('来源：Replay');
  const rows = [...result.timeline, ...result.incomplete].sort((a, b) => a.arrive - b.arrive || a.id - b.id);
  expect(replay.charts[4].yAxis[0].data).toHaveLength(rows.length);
  expect(replay.charts[4].series.find(s => s.name === 'Decode').data.map(d => d.value || d)).toEqual(rows.flatMap((r, i) => r.completeTime > r.prefillEnd ? [[i, r.prefillEnd, r.completeTime]] : []));
  expect(replay.charts[4].series.find(s => s.name === 'Prefill').data.map(d => d.value || d)).toEqual(rows.flatMap((r, i) => r.prefillEnd > r.prefillStart ? [[i, r.prefillStart, r.prefillEnd]] : []));
  expect(replay.charts[5].series.map(s => s.data)).toEqual([1, 2, 3].map(i => result.concTimeline.map(p => [p[0], p[i]])));
  const metric = page.locator('#strategyMetricsGrid .result-item').filter({ has: page.locator('.rl', { hasText: 'TTFT(均值)' }) }).locator('.rv');
  await expect(metric).toHaveText(`${result.replay.windows.measurement.latency.ttft.mean.toFixed(3)} ms`);
  await expect(page.locator('#simulationDirty')).toBeHidden();
  await page.locator('button[onclick="exportParams()"]').click();
  const exported = JSON.parse(await page.locator('#paramsIo').inputValue());
  expect(exported).toEqual(original);
  expect(Object.keys(exported).some(key => /replay|bundle|workloadSource/i.test(key))).toBe(false);
  await importControls(page, { ...original, workloadSource: 'synthetic', replaySeed: '999', replayDuration: '123', replayFile: 'not-a-bundle', bundle: oneRequest() });
  await expect(page.locator('#workloadSource')).toHaveValue('replay');
  await expect(page.locator('#replaySeed')).toHaveValue('42');
  await expect(page.locator('#replayDuration')).toHaveValue('0.2');
  expect(await page.locator('#replayFileInfo').textContent()).toBe(fileInfo);
  expect(await downloadResult(page)).toEqual(result);
  await source(page, 'synthetic');
  await expect(page.locator(allButton)).toBeEnabled();
  await expect(page.locator('#replaySummary')).toBeVisible();
  await expect(page.locator('#simulationDirty')).toBeVisible();
  expect(await downloadResult(page)).toEqual(result);
  await refreshTabs(page);
  expect(await capture(page)).toEqual(replay);
  const before = posts.length;
  await page.locator(runButton).click();
  await expect(page.locator(runButton)).toBeEnabled();
  await expect(page.locator('#simulationStatus')).toHaveText('运行完成');
  await expect(page.locator('#simulationDirty')).toBeHidden();
  await refreshTabs(page);
  expect(posts).toHaveLength(before);
  expect(await capture(page)).toEqual(synthetic);
  await expect(page.locator('#replayDownload')).toBeDisabled();
  await expect(page.locator('#replaySummary')).toBeHidden();
  await page.locator('#pSeed').fill('43');
  const nextSynthetic = await runSynthetic(page);
  expect(nextSynthetic.completed).toBeGreaterThan(0);
  expect(posts).toHaveLength(before + 1);
  expect(posts.at(-1).jobs[0].overrides?.replay).toBeUndefined();
  expect(posts[0].jobs[0].overrides?.replay).toBeUndefined();
  expect(posts.at(-1).jobs[0].params.seed).toBe(43);
  await expect(page.locator('#replayDownload')).toBeDisabled();
  await source(page, 'replay');
  await expect(page.locator('#replaySeed')).toHaveValue('42');
  await expect(page.locator('#replayFileInfo')).toHaveText(fileInfo);
  await expect(page.locator(runButton)).toBeEnabled();
  expect(errors).toEqual([]);
});

for (const workloadSource of ['synthetic', 'replay']) {
  for (const status of ['failed', 'cancelled']) {
    test(`V4: ${workloadSource} ${status} retains Replay downloads and all views under the shared submission lock`, async ({ page }) => {
      const { errors, posts } = await start(page);
      await upload(page);
      const { result: previous } = await run(page);
      await refreshTabs(page);
      const snapshot = await capture(page);
      if (workloadSource === 'synthetic') {
        await source(page, 'synthetic');
        await page.locator('#pSeed').fill('43');
      } else {
        await page.locator('#replaySeed').fill('43');
      }
      const inputStatus = await page.locator('#replayStatus').textContent();
      const task = { id: `v4-${workloadSource}-${status}`, status, total: 1, completed: 1, error: `test ${workloadSource} ${status}` };
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      await page.route(`**/api/tasks/${task.id}/points?*`, async route => {
        await gate;
        await route.fulfill({ json: { task, next: 1, points: [{ index: 0, result: { ...previous, name: 'must-not-publish' } }] } });
      });
      await page.route('**/api/tasks', route => route.request().method() === 'POST'
        ? route.fulfill({ status: 202, json: { ...task, status: 'running', completed: 0 } }) : route.continue());
      const responseEvent = submitted(page);
      await page.locator(runButton).click();
      expect((await responseEvent).status()).toBe(202);
      await expect(page.locator('#simulationStatus')).toContainText('正在运行');
      await expect(page.locator(runButton)).toBeDisabled();
      await expect(page.locator(allButton)).toBeDisabled();
      for (const id of ['workloadSource', 'replayFile', ...ids]) await expect(page.locator('#' + id)).toBeDisabled();
      await page.evaluate(() => { window.applyStrategies(); window.applyStrategies(); window.runAllStrategies(); });
      expect(posts).toHaveLength(2);
      expect(posts[1].kind).toBe('simulation');
      expect(posts[1].jobs).toHaveLength(1);
      expect(!!posts[1].jobs[0].overrides?.replay).toBe(workloadSource === 'replay');
      await expect(page.locator('#replayDownload')).toBeEnabled();
      await expect(page.locator('#replaySummary')).toBeVisible();
      expect(await downloadResult(page)).toEqual(previous);
      expect(await capture(page)).toEqual(snapshot);
      release();
      await expect(page.locator('#simulationStatus')).toHaveText(`仿真出错: ${task.error}`);
      await expect(page.locator(runButton)).toBeEnabled();
      await expect(page.locator('#workloadSource')).toBeEnabled();
      if (workloadSource === 'replay') await recovered(page, previous);
      else await expect(page.locator(allButton)).toBeEnabled();
      expect(await page.locator('#replayStatus').textContent()).toBe(inputStatus);
      await expect(page.locator('#simulationDirty')).toBeVisible();
      await refreshTabs(page);
      expect(await capture(page)).toEqual(snapshot);
      expect(await downloadResult(page)).toEqual(previous);
      expect(posts).toHaveLength(2);
      expect(errors).toEqual([]);
    });
  }
}

test('V4: Replay rejects the run-all handler while synthetic retains its existing batch entry', async ({ page }) => {
  const { errors, posts } = await start(page);
  await upload(page);
  await expect(page.locator(allButton)).toBeDisabled();
  await page.evaluate(() => window.runAllStrategies());
  await expect(page.locator('#simulationStatus')).toContainText('Replay');
  expect(posts).toHaveLength(0);
  await expect(page.locator(runButton)).toBeEnabled();
  await run(page);
  await expect(page.locator(allButton)).toBeDisabled();
  await page.evaluate(() => window.runAllStrategies());
  expect(posts).toHaveLength(1);
  await source(page, 'synthetic');
  await expect(page.locator(allButton)).toBeEnabled();
  const responseEvent = submitted(page);
  await page.locator(allButton).click();
  expect((await responseEvent).status()).toBe(202);
  await expect(page.locator(runButton)).toBeEnabled();
  await expect(page.locator('#simulationStatus')).toHaveText('运行完成');
  expect(posts).toHaveLength(2);
  expect(posts[1].jobs.every(job => !job.overrides?.replay)).toBe(true);
  await expect(page.locator('#replayDownload')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('V4: inactive synthetic request counts and single-batch settings cannot affect Replay', async ({ page }) => {
  const { errors, posts } = await start(page);
  await upload(page, oneRequest(2));
  const { result: baselineResult } = await run(page);
  const sharedIds = ['pMaxBatch', 'pMaxPrefillTok'];
  const shared = Object.fromEntries(await Promise.all(sharedIds.map(async id => [id, await page.locator('#' + id).inputValue()])));
  await source(page, 'synthetic');
  await page.locator('#pSingleBatch').check();
  for (const id of sharedIds) await expect(page.locator('#' + id)).toBeDisabled();
  for (const value of ['', '-4']) {
    await page.locator('#pConcurrency').fill(value);
    const before = posts.length;
    await source(page, 'replay');
    await expect(page.locator('#pSingleBatch')).toBeChecked();
    for (const id of sharedIds) {
      await expect(page.locator('#' + id)).toBeVisible();
      await expect(page.locator('#' + id)).toBeEnabled();
      await expect(page.locator('#' + id)).toHaveValue(shared[id]);
    }
    expect(posts).toHaveLength(before);
    const { result } = await run(page);
    expect(posts).toHaveLength(before + 1);
    expect(posts.at(-1).jobs[0].params.concurrency).toBeGreaterThan(0);
    expect(posts.at(-1).jobs[0].params.singleBatch).toBe(false);
    expect(result).toEqual(baselineResult);
    await source(page, 'synthetic');
    await expect(page.locator('#pConcurrency')).toHaveValue(value);
    await expect(page.locator('#pSingleBatch')).toBeChecked();
    for (const id of sharedIds) {
      await expect(page.locator('#' + id)).toBeDisabled();
      await expect(page.locator('#' + id)).toHaveValue(shared[id]);
    }
  }
  expect(posts).toHaveLength(3);
  expect(errors).toEqual([]);
});

test('V4: committed snapshots carry effective Replay configuration without bundle duplication or synthetic cache mutation', async ({ page }, info) => {
  test.skip(info.project.name !== 'development', 'State inspection is development-only; lifecycle and lock checks run in both builds.');
  const { errors, posts } = await start(page, 'synthetic');
  await runSynthetic(page);
  const syntheticCache = await page.evaluate(async () => {
    const { state } = await import('/src/ui/state.js');
    return state.simCache;
  });
  expect(Object.keys(syntheticCache)).toHaveLength(1);
  await source(page, 'replay');
  await upload(page, oneRequest(2), 'snapshot.json');
  await settings(page, { replaySeed: '0', replayDrain: '0.7' });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/tasks', async route => {
    if (route.request().method() === 'POST') await gate;
    await route.continue();
  });
  const pending = run(page);
  await expect(page.locator('#simulationStatus')).toContainText('正在运行');
  expect(await page.evaluate(async () => (await import('/src/ui/state.js')).state.simRunning)).toBe(true);
  release();
  const { result } = await pending;
  await page.unroute('**/api/tasks');
  const published = await page.evaluate(async () => {
    const { state } = await import('/src/ui/state.js');
    window.v4PublishedInput = state.simInput;
    window.v4PublishedResult = state.simResults[0];
    return { input: state.simInput, results: state.simResults, cache: state.simCache, running: state.simRunning };
  });
  expect(published.running).toBe(false);
  expect(published.results).toHaveLength(1);
  expect(published.results[0]).toEqual(result);
  expect(published.cache).toEqual(syntheticCache);
  expect(published.input).toMatchObject({
    workloadSource: 'replay', mode: 'dsl',
    params: posts[1].jobs[0].params,
    strategies: [posts[1].jobs[0].strategy],
    replayConfiguration: result.replay.configuration,
    controls: { replaySeed: { value: '0' }, replayDrain: { value: '0.7' }, pSeed: { value: '42' }, pSimMaxTime: { value: '120' } },
  });
  expect(published.input.bundleSummary).toBeTruthy();
  const containsBundle = value => value && typeof value === 'object' && Object.entries(value).some(([key, item]) => key === 'bundle' || key === 'blockRuns' || containsBundle(item));
  expect(containsBundle(published.input)).toBe(false);
  await page.locator('#replaySeed').fill('99');
  await page.locator('#pHbm').fill('1');
  await upload(page, oneRequest(9), 'snapshot.json');
  await source(page, 'synthetic');
  const after = await page.evaluate(async () => {
    const { state } = await import('/src/ui/state.js');
    return {
      input: state.simInput, results: state.simResults, cache: state.simCache,
      sameInput: state.simInput === window.v4PublishedInput,
      sameResult: state.simResults[0] === window.v4PublishedResult,
    };
  });
  expect(after.input).toEqual(published.input);
  expect(after.results).toEqual(published.results);
  expect(after.cache).toEqual(syntheticCache);
  expect(after.sameInput).toBe(true);
  expect(after.sameResult).toBe(true);
  expect(await downloadResult(page)).toEqual(result);
  expect(posts).toHaveLength(2);
  expect(errors).toEqual([]);
});

async function smallScanSettings(page) {
  await page.locator('#sSweepParam').selectOption('ssd_bw');
  await page.locator('#sSweepRange').fill('10');
  await page.locator('#sSweepCompareParam').selectOption('');
  await page.locator('#sPfWait').check();
  await page.locator('#sPfBest').uncheck();
  await page.locator('#sPfRace').uncheck();
}

async function downloadHtml(page) {
  const event = page.waitForEvent('download');
  await page.locator('#btnSensExportHtml').click();
  const download = await event, chunks = [];
  expect(download.suggestedFilename()).toMatch(/\.html$/);
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const legacyExportIds = ['btnSensExportPng', 'btnSensExportJpg', 'btnSensExportHtml'];
const consoleErrors = page => {
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
};

test('V5: analysis handlers cannot bypass Replay restrictions and legacy exports follow saved results across the round trip', async ({ page }) => {
  const { errors, posts } = await start(page, 'synthetic');
  const console = consoleErrors(page);
  await runSynthetic(page);
  await refreshTabs(page);
  const synthetic = await capture(page);
  await smallScanSettings(page);
  const scan = submitted(page);
  await page.locator('#btnRunSens').click();
  expect((await scan).status()).toBe(202);
  await expect(page.locator('#btnRunSens')).toBeEnabled();
  await expect(page.locator('#btnSensExportHtml')).toBeEnabled();
  const originalHtml = await downloadHtml(page);
  expect(originalHtml).toContain('10GB/s');
  const originalScan = await page.locator('#formulaSensitivity').innerHTML();
  const scanData = () => page.evaluate(() => window.echarts.getInstanceByDom(document.getElementById('chartSensitivity')).getOption().series.map(s => s.data));
  const originalScanData = await scanData();
  await source(page, 'replay');
  await expect(page.locator('#simulationModeNote')).toContainText('Replay');
  await expect(page.locator('#btnRunSens')).toBeDisabled();
  for (const id of legacyExportIds) await expect(page.locator('#' + id)).toBeEnabled();
  expect(await downloadHtml(page)).toBe(originalHtml);
  await page.locator('.nav-item[data-tab="tab-cross"]').click();
  await expect(page.locator('button[onclick="runCrossAnalysis()"]')).toBeDisabled();
  await expect(page.locator('#crossStatus')).toContainText('不支持');
  for (let i = 0; i < 2; i++) {
    await page.evaluate(async () => {
      window.runAllStrategies();
      await window.runSensitivity();
      await window.runCrossAnalysis();
    });
  }
  expect(await page.evaluate(() => !!window.__crossAnalyzed)).toBe(false);
  expect(posts).toHaveLength(2);
  await page.locator('.nav-item[data-tab="tab-params"]').click();
  expect(await capture(page)).toEqual(synthetic);
  expect(await page.locator('#formulaSensitivity').innerHTML()).toBe(originalScan);
  await upload(page);
  const { result } = await run(page);
  for (const id of legacyExportIds) await expect(page.locator('#' + id)).toBeDisabled();
  await expect(page.locator('#sensExportRestriction')).toContainText('下载完整结果 JSON');
  const unexpectedDownloads = [];
  const onDownload = download => unexpectedDownloads.push(download.suggestedFilename());
  page.on('download', onDownload);
  for (const editedSource of ['replay', 'synthetic']) {
    if (editedSource === 'synthetic') await source(page, 'synthetic');
    await page.evaluate(() => {
      window.exportSensHtml();
      window.exportSensImage('png');
      window.exportSensImage('jpeg');
    });
    await expect(page.locator('#sensExportNote')).toContainText('Replay');
    for (const id of legacyExportIds) await expect(page.locator('#' + id)).toBeDisabled();
  }
  page.off('download', onDownload);
  expect(unexpectedDownloads).toEqual([]);
  expect(await downloadResult(page)).toEqual(result);
  expect(posts).toHaveLength(3);
  await expect(page.locator('#btnRunSens')).toBeEnabled();
  await expect(page.locator(allButton)).toBeEnabled();
  await page.locator('.nav-item[data-tab="tab-cross"]').click();
  await expect(page.locator('button[onclick="runCrossAnalysis()"]')).toBeEnabled();
  await page.locator('.nav-item[data-tab="tab-params"]').click();
  await page.locator(runButton).click();
  await expect(page.locator('#simulationStatus')).toHaveText('运行完成');
  await expect(page.locator(runButton)).toBeEnabled();
  for (const id of legacyExportIds) await expect(page.locator('#' + id)).toBeEnabled();
  await expect(page.locator('#sensExportRestriction')).toBeHidden();
  expect(await downloadHtml(page)).toBe(originalHtml);
  await page.locator('#btnRunSens').click();
  await expect(page.locator('#btnRunSens')).toBeEnabled();
  expect(await page.locator('#formulaSensitivity').innerHTML()).toContain(originalScan);
  await expect(page.locator('#formulaSensitivity')).toContainText('缓存命中，未重跑仿真');
  expect(await scanData()).toEqual(originalScanData);
  expect(posts).toHaveLength(3);
  expect(posts.map(post => post.kind)).toEqual(['simulation', 'scan', 'simulation']);
  expect(errors).toEqual([]);
  expect(console).toEqual([]);
});

for (const status of ['completed', 'failed', 'cancelled']) {
  test(`V5: a ${status} synthetic scan cannot unlock Replay entries after an in-flight mode switch`, async ({ page }) => {
    const { errors, posts } = await start(page, 'synthetic');
    const result = await runSynthetic(page);
    await smallScanSettings(page);
    const task = { id: `v5-scan-${status}`, status, total: 1, completed: status === 'completed' ? 1 : 0, error: status === 'completed' ? undefined : `scan ${status}` };
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route(`**/api/tasks/${task.id}/points?*`, async route => {
      await gate;
      await route.fulfill({ json: { task, next: task.completed, points: status === 'completed' ? [{ index: 0, result: extractSensMetrics(result) }] : [] } });
    });
    await page.route('**/api/tasks', route => route.request().method() === 'POST'
      ? route.fulfill({ status: 202, json: { ...task, status: 'running', completed: 0 } }) : route.continue());
    const response = submitted(page);
    await page.locator('#btnRunSens').click();
    expect((await response).status()).toBe(202);
    for (const editedSource of ['replay', 'synthetic', 'replay']) {
      await source(page, editedSource);
      await expect(page.locator('#btnRunSens')).toBeDisabled();
    }
    await page.evaluate(() => window.runSensitivity());
    release();
    await expect(page.locator('#btnRunSens')).toHaveText('运行敏感性分析');
    await expect(page.locator('#btnRunSens')).toBeDisabled();
    await expect(page.locator(allButton)).toBeDisabled();
    await expect(page.locator('#sensitivityStatus')).toContainText('Replay');
    if (status === 'completed') await expect(page.locator('#btnSensExportHtml')).toBeEnabled();
    else {
      await expect(page.locator('#chartSensitivity')).toContainText(`scan ${status}`);
      await expect(page.locator('#btnSensExportHtml')).toBeDisabled();
    }
    await source(page, 'synthetic');
    await expect(page.locator('#btnRunSens')).toBeEnabled();
    expect(posts).toHaveLength(2);
    expect(posts[1].kind).toBe('scan');
    expect(posts[1].jobs.every(job => !job.overrides?.replay)).toBe(true);
    expect(errors).toEqual([]);
  });
}

for (const name of ['manySuccessful', 'manyUnfinished', 'mixed', 'cutoff', 'longActive', 'idle', 'zero']) {
  test(`V5: real ${name} UI execution preserves complete request pages, windows and concurrency in both builds`, async ({ page }) => {
    const { errors, posts } = await start(page);
    const console = consoleErrors(page);
    const job = visualizationCases[name];
    await upload(page, job.overrides.replay.bundle);
    await settings(page, {
      replayQps: String(job.overrides.qps), replaySeed: String(job.overrides.seed),
      replayDuration: String(job.overrides.replay.options.durationSeconds),
      replayWarmup: String(job.overrides.replay.options.warmupSeconds), replayDrain: String(job.overrides.simMaxTime),
    });
    const { result: r } = await run(page);
    const counts = r.replay.counts;
    const rows = [...r.timeline, ...r.incomplete].sort((a, b) => a.arrive - b.arrive || a.id - b.id);
    expect(r.timeline).toHaveLength(counts.successful);
    expect(r.incomplete.filter(row => row.state === 'failed')).toHaveLength(counts.failed);
    expect(r.incomplete.filter(row => row.state !== 'failed')).toHaveLength(counts.arrivedUnfinished);
    expect(rows).toHaveLength(counts.arrived);
    expect(new Set(rows.map(row => row.id)).size).toBe(counts.arrived);
    if (name === 'manySuccessful' || name === 'manyUnfinished') expect(counts.arrived).toBe(400);
    if (name === 'mixed') expect(counts).toMatchObject({ successful: 1, failed: 1, cancelled: 1 });
    if (name === 'cutoff') expect(counts).toMatchObject({ arrived: 1, pendingArrival: 1, waitingAnchor: 1 });
    await page.locator('.nav-item[data-tab="tab-schedule"]').click();
    await expect.poll(() => page.evaluate(() => !!window.echarts.getInstanceByDom(document.getElementById('chartGantt')))).toBe(true);
    const visibleIds = [];
    for (let index = 0; index < Math.max(1, Math.ceil(rows.length / 100)); index++) {
      const labels = await page.evaluate(() => window.echarts.getInstanceByDom(document.getElementById('chartGantt')).getOption().yAxis[0].data);
      expect(labels).toHaveLength(Math.min(100, rows.length - index * 100));
      visibleIds.push(...labels.map(label => Number(label.match(/^Req #(\d+)/)[1])));
      if (rows.length) await expect(page.locator('#ganttPageStatus')).toContainText(`${index * 100 + 1}–${Math.min(rows.length, (index + 1) * 100)} / ${rows.length}`);
      if ((index + 1) * 100 < rows.length) await page.locator('#ganttNext').click();
    }
    expect(visibleIds).toEqual(rows.map(row => row.id));
    await expect(page.locator('#ganttNext')).toBeDisabled();
    const snapshot = await capture(page), concurrency = snapshot.charts[5];
    expect(concurrency.xAxis[0]).toMatchObject({ min: 0, max: r.simEnd });
    expect(concurrency.series.map(s => s.data)).toEqual([1, 2, 3].map(i => r.concTimeline.map(point => [point[0], point[i]])));
    expect(r.concTimeline[0]).toEqual([0, 0, 0, 0]);
    expect(r.concTimeline.at(-1)[0]).toBe(r.simEnd);
    if (name === 'longActive') {
      expect(concurrency.series[0].data.length).toBeGreaterThan(20_000);
      expect(concurrency.series[0].data.some(point => point[0] > 201 && point[1] > 0)).toBe(true);
    }
    const metrics = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#strategyMetricsGrid .result-item')]
      .map(el => [el.querySelector('.rl').textContent, el.querySelector('.rv').textContent])));
    const measurement = r.replay.windows.measurement;
    for (const [label, key, unit] of [['TTFT', 'ttft', ' ms'], ['TPOT', 'tpot', ' ms/token'], ['E2E', 'endToEnd', ' ms']]) {
      for (const [title, field] of [['均值', 'mean'], ['P50', 'p50'], ['P99', 'p99']]) {
        const value = measurement.latency[key][field];
        expect(metrics[`${label}(${title})`]).toBe(value == null ? '无样本' : value.toFixed(3) + unit);
      }
      expect(metrics[`${label}(样本数)`]).toBe(String(measurement.latency[key].count));
    }
    expect(metrics['到达 QPS']).toBe(measurement.arrivalQps.toFixed(3) + ' 请求/秒');
    expect(metrics['完成 QPS']).toBe(measurement.completionQps.toFixed(3) + ' 请求/秒');
    expect(metrics['Token 命中率']).toBe(measurement.cache.hitRate == null ? '无样本' : (measurement.cache.hitRate * 100).toFixed(2) + '%');
    expect(snapshot.formulas[0]).toContain('measurement');
    expect(snapshot.formulas[1]).toContain('全程');
    for (const formula of snapshot.formulas.slice(2)) {
      expect(formula).toContain('来源：Replay');
      expect(formula).toContain(`T=${r.replay.configuration.durationSeconds.toFixed(3)}s`);
      expect(formula).toContain(`W=${r.replay.configuration.warmupSeconds.toFixed(3)}s`);
      expect(formula).toContain(`D=${r.replay.configuration.execution.simMaxTime.toFixed(3)}s`);
    }
    expect(snapshot.formulas[3]).toContain('10ms');
    expect(snapshot.metrics).not.toMatch(/NaN|Infinity|undefined/);
    if (r.truncated) expect(snapshot.formulas[2]).toContain('硬截止截断');
    const tooltips = await page.evaluate(() => {
      const option = window.echarts.getInstanceByDom(document.getElementById('chartGantt')).getOption();
      return option.series.flatMap(s => s.data.map(data => option.tooltip[0].formatter({ seriesName: s.name, data })));
    });
    if (name === 'mixed') expect(tooltips.some(text => text.includes('infeasible'))).toBe(true);
    if (name === 'cutoff') expect(tooltips.some(text => text.includes('截止未完成'))).toBe(true);
    await page.locator('.nav-item[data-tab="tab-params"]').click();
    await page.locator('#replaySeed').fill('43');
    await source(page, 'synthetic');
    await page.locator('.nav-item[data-tab="tab-schedule"]').click();
    await expect.poll(() => capture(page)).toEqual(snapshot);
    await page.locator('.nav-item[data-tab="tab-params"]').click();
    expect(await downloadResult(page)).toEqual(r);
    expect(posts).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(console).toEqual([]);
  });
}

for (const status of ['completed', 'failed', 'cancelled']) {
  test(`V5: ${status} cross analysis retains its entry and cannot be restarted while editing Replay`, async ({ page }) => {
    const { errors, posts } = await start(page, 'synthetic');
    const result = await runSynthetic(page);
    const task = { id: `v5-cross-${status}`, status, total: 28, completed: status === 'completed' ? 28 : 0, error: `cross ${status}` };
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route(`**/api/tasks/${task.id}/points?*`, async route => {
      await gate;
      await route.fulfill({ json: { task, next: task.completed, points: status === 'completed' ? Array.from({ length: 28 }, (_, index) => ({ index, result })) : [] } });
    });
    await page.route('**/api/tasks', route => route.request().method() === 'POST'
      ? route.fulfill({ status: 202, json: { ...task, status: 'running', completed: 0 } }) : route.continue());
    await page.locator('.nav-item[data-tab="tab-cross"]').click();
    const response = submitted(page);
    await page.locator('#btnRunCross').click();
    expect((await response).status()).toBe(202);
    await expect(page.locator('#btnRunCross')).toBeDisabled();
    await page.locator('.nav-item[data-tab="tab-params"]').click();
    await source(page, 'replay');
    await page.evaluate(() => window.runCrossAnalysis());
    release();
    await page.locator('.nav-item[data-tab="tab-cross"]').click();
    if (status === 'completed') await expect(page.locator('#formulaRadar')).toContainText('计算方式');
    else await expect(page.locator('#chartHeatmap')).toContainText(`cross ${status}`);
    await expect(page.locator('#btnRunCross')).toBeDisabled();
    await expect(page.locator('#crossStatus')).toContainText('Replay');
    expect(posts).toHaveLength(2);
    expect(posts[1].kind).toBe('batch');
    expect(posts[1].jobs).toHaveLength(28);
    expect(posts[1].jobs.every(job => !job.overrides?.replay)).toBe(true);
    await page.locator('.nav-item[data-tab="tab-params"]').click();
    await source(page, 'synthetic');
    await page.locator('.nav-item[data-tab="tab-cross"]').click();
    await expect(page.locator('#btnRunCross')).toBeEnabled();
    const retry = submitted(page);
    await page.locator('#btnRunCross').click();
    expect((await retry).status()).toBe(202);
    await expect(page.locator('#btnRunCross')).toBeEnabled();
    expect(posts).toHaveLength(3);
    expect(errors).toEqual([]);
  });
}

test('V5: a pre-submission scan rejection disables stale exports and a supported cached scan restores them', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-23T00:00:00Z'));
  const { errors, posts } = await start(page, 'synthetic');
  await smallScanSettings(page);
  await page.locator('#btnRunSens').click();
  await expect(page.locator('#btnSensExportHtml')).toBeEnabled();
  const original = await downloadHtml(page);
  await importControls(page, { _strategyMode: 'js', sDsl: 'window.__unexpectedScan = true;' });
  await page.locator('#btnRunSens').click();
  await expect(page.locator('#chartSensitivity')).toContainText('不支持 JavaScript');
  await expect(page.locator('#btnRunSens')).toBeEnabled();
  for (const id of legacyExportIds) await expect(page.locator('#' + id)).toBeDisabled();
  expect(await page.evaluate(() => window.__unexpectedScan)).toBeUndefined();
  expect(posts).toHaveLength(1);
  await importControls(page, { _strategyMode: 'dsl', sDsl: baseline.strategy.dsl });
  await page.locator('#btnRunSens').click();
  await expect(page.locator('#btnSensExportHtml')).toBeEnabled();
  await expect(page.locator('#formulaSensitivity')).toContainText('缓存命中，未重跑仿真');
  expect(await downloadHtml(page)).toBe(original);
  expect(posts).toHaveLength(1);
  expect(errors).toEqual([]);
});
