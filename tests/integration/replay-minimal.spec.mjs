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
  if (await page.locator('#workloadSource').inputValue() === 'replay' && !('workload' in values)) {
    await page.evaluate(values => {
      if (values._strategyMode) window.switchMode(values._strategyMode);
      for (const [id, value] of Object.entries(values)) {
        const control = document.getElementById(id);
        if (!control || id === 'workloadSource' || control.closest('#replayPanel')) continue;
        if (control.type === 'checkbox') control.checked = !!value;
        else control.value = String(value);
        control.dispatchEvent(new Event('input', { bubbles: true }));
        control.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (values.sDsl) window.syncPrefetchSelect();
      window.toggleSingleBatchHints();
      window.recalcAll();
    }, values);
    return;
  }
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
  await expect(page.locator(allButton)).toBeEnabled();
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

async function u5Scan(page) {
  const pending = submitted(page);
  await page.locator('#btnRunSens').click();
  const response = await pending;
  expect(response.status(), await response.text()).toBe(202);
  const task = await response.json();
  await expect(page.locator('#sensitivityStatus')).toContainText('扫描完成', { timeout: 30_000 });
  await expect(page.locator('#btnRunSens')).toBeEnabled();
  const stored = await (await page.request.get(`/api/tasks/${task.id}/download`)).json();
  expect(stored.task.status).toBe('completed');
  return stored.points.map(point => point.result);
}

async function u5SavePair(page) {
  await page.locator('#sName').fill('U5-none');
  await page.locator('button[onclick="saveStrategy()"]').click();
  await page.locator('#sName').fill('U5-best-effort');
  await page.locator('#sDsl').fill(baseline.strategy.dsl.replace(/PREFETCH:[^\n]*/, 'PREFETCH: best_effort'));
  await page.locator('button[onclick="saveStrategy()"]').click();
}

test('U5: Replay multi-strategy freezes one workload and commits only complete snapshots', async ({ page }, info) => {
  const { errors, posts } = await start(page);
  await upload(page, oneRequest(2), 'frozen.json');
  await settings(page, { replaySeed: '0', replayQps: '2' });
  await u5SavePair(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/tasks', async route => {
    if (route.request().method() === 'POST') await gate;
    await route.continue();
  });
  const pending = submitted(page);
  await page.locator(allButton).click();
  await expect(page.locator('#simulationStatus')).toContainText('正在运行');
  for (const id of ['workloadSource', 'replayFile', ...ids]) await expect(page.locator('#' + id)).toBeDisabled();
  await page.evaluate(() => {
    document.getElementById('replayQps').value = '99';
    document.getElementById('replaySeed').value = '99';
    document.getElementById('sName').value = 'must-not-relabel';
    window.runAllStrategies();
  });
  release();
  const response = await pending;
  expect(response.status()).toBe(202);
  const task = await response.json();
  await expect(page.locator('#simulationStatus')).toHaveText('运行完成');
  const stored = await (await page.request.get(`/api/tasks/${task.id}/download`)).json();
  const results = stored.points.map(point => point.result);
  expect(posts).toHaveLength(1);
  expect(posts[0].kind).toBe('batch');
  expect(posts[0].jobs).toHaveLength(2);
  expect(results.map(result => result.name)).toEqual(['U5-none', 'U5-best-effort']);
  for (const job of posts[0].jobs) expect(job.overrides).toMatchObject({ qps: 2, seed: 0, replay: { bundle: oneRequest(2) } });
  for (const result of results) {
    expect(result.replay.configuration).toMatchObject({ targetQps: 2, seed: 0, durationSeconds: 0.2, warmupSeconds: 0 });
    expect(result.completed).toBe(1);
  }
  expect(await downloadResult(page)).toEqual(results);
  await expect(page.locator('#simulationSnapshot')).toContainText('QPS=2');
  await expect(page.locator('#simulationSnapshot')).not.toContainText('QPS=99');
  if (info.project.name === 'development') {
    const snapshot = await page.evaluate(async () => {
      const { state } = await import('/src/ui/state.js');
      return { input: state.simInput, results: state.simResults, cache: state.simCache };
    });
    expect(snapshot.input.replayConfigurations).toEqual(results.map(result => result.replay.configuration));
    expect(snapshot.results).toEqual(results);
    expect(snapshot.cache).toEqual({});
    expect(JSON.stringify(snapshot.input)).not.toContain('blockRuns');
  }
  expect(errors).toEqual([]);
});

for (const status of ['failed', 'cancelled']) {
  test(`U5: a ${status} Replay strategy batch preserves prior results and input despite a delivered partial point`, async ({ page }, info) => {
    const { errors, posts } = await start(page);
    await upload(page, oneRequest(2));
    const { result: previous } = await run(page);
    await refreshTabs(page);
    const visible = await capture(page);
    if (info.project.name === 'development') await page.evaluate(async () => {
      const { state } = await import('/src/ui/state.js');
      window.u5OldInput = state.simInput;
      window.u5OldResults = state.simResults;
    });
    await u5SavePair(page);
    const task = { id: `u5-batch-${status}`, status, total: 2, completed: 1, error: `U5 batch ${status}` };
    await page.route(`**/api/tasks/${task.id}/points?*`, route => route.fulfill({ json: {
      task, next: 1, points: [{ index: 0, result: { ...previous, name: 'partial-must-not-publish' } }],
    } }));
    await page.route('**/api/tasks', route => route.request().method() === 'POST'
      ? route.fulfill({ status: 202, json: { ...task, status: 'running', completed: 0 } }) : route.continue());
    await page.locator(allButton).click();
    await expect(page.locator('#simulationStatus')).toContainText(task.error);
    await expect(page.locator(allButton)).toBeEnabled();
    await refreshTabs(page);
    expect(await capture(page)).toEqual(visible);
    expect(await downloadResult(page)).toEqual(previous);
    expect(posts).toHaveLength(2);
    expect(posts[1].kind).toBe('batch');
    expect(posts[1].jobs).toHaveLength(2);
    if (info.project.name === 'development') expect(await page.evaluate(async () => {
      const { state } = await import('/src/ui/state.js');
      return state.simInput === window.u5OldInput && state.simResults === window.u5OldResults;
    })).toBe(true);
    expect(errors).toEqual([]);
  });
}

test('U5: Replay scan overrides QPS and batch size across all four prefetch policies without reusing results', async ({ page }) => {
  const { errors, posts } = await start(page);
  await upload(page, oneRequest(2));
  await settings(page, { replayDuration: '0.6', replaySeed: '0' });
  await page.locator('#sSweepParam').selectOption('qps');
  await page.locator('#sSweepRange').fill('2,8');
  await page.locator('#sSweepCompareParam').selectOption('max_batch_size');
  await page.locator('#sSweepCompare').fill('1,4');
  await page.locator('#sShapeDim').selectOption('prefetch');
  await page.locator('#sSweepMetric').selectOption('measurement_latency_p99');
  for (const id of ['sPfWait', 'sPfBest', 'sPfTimeout', 'sPfRace']) await page.locator('#' + id).check();
  const records = await u5Scan(page);
  expect(posts).toHaveLength(1);
  expect(posts[0].kind).toBe('scan');
  expect(posts[0].jobs).toHaveLength(16);
  const combinations = [];
  posts[0].jobs.forEach((job, index) => {
    const rec = records[index];
    combinations.push([job.overrides.qps, job.strategy.batching.max_batch_size, job.strategy.prefetch.type]);
    expect(job.overrides.replay.bundle).toEqual(oneRequest(2));
    expect(job.overrides.seed).toBe(0);
    expect(job.overrides.replay.options).toMatchObject({ durationSeconds: 0.6, warmupSeconds: 0 });
    for (const key of ['nreq', 'inputLen', 'prefixHit', 'singleBatch']) expect(job.overrides).not.toHaveProperty(key);
    expect(rec.workload.configuration).toMatchObject({ targetQps: job.overrides.qps, seed: 0,
      execution: { qps: job.overrides.qps, seed: 0 },
      strategy: { batching: { max_batch_size: job.strategy.batching.max_batch_size }, prefetch: { type: job.strategy.prefetch.type } },
    });
    expect(rec.measurement_latency_p99).toBe(rec.workload.windows.measurement.latency.endToEnd.p99);
    expect(rec.measurement_arrival_qps).toBe(rec.workload.windows.measurement.arrivalQps);
    expect(rec.measurement_completion_qps).toBe(rec.workload.windows.measurement.completionQps);
    expect(rec.workload.counts.failed).toBe(0);
  });
  expect(new Set(combinations.map(JSON.stringify)).size).toBe(16);
  expect(new Set(combinations.map(item => item[2]))).toEqual(new Set(['none', 'best_effort', 'timeout', 'race']));
  const low = records.filter((_record, index) => posts[0].jobs[index].overrides.qps === 2);
  const high = records.filter((_record, index) => posts[0].jobs[index].overrides.qps === 8);
  expect(Math.min(...high.map(rec => rec.workload.counts.arrived))).toBeGreaterThan(Math.max(...low.map(rec => rec.workload.counts.arrived)));
  const chart = await page.evaluate(() => window.echarts.getInstanceByDom(document.getElementById('chartSensitivity')).getOption());
  expect(chart.xAxis[0].name).toBe('目标 QPS');
  expect(chart.series.flatMap(series => series.data)).toEqual(records.map(rec => rec.measurement_latency_p99 == null ? null : +rec.measurement_latency_p99.toFixed(3)));
  expect(await u5Scan(page)).toEqual(records);
  expect(posts).toHaveLength(2);
  expect(posts[0].requestId).not.toBe(posts[1].requestId);
  expect(errors).toEqual([]);
});

test('U5: Replay hardware, SSD bandwidth and eviction scans survive base overrides in execution snapshots', async ({ page }) => {
  const { errors, posts } = await start(page);
  await upload(page, oneRequest(2));
  await page.locator('#sSweepParam').selectOption('ssd_bw');
  await page.locator('#sSweepRange').fill('10,30');
  await page.locator('#sSweepCompareParam').selectOption('evict_threshold');
  await page.locator('#sSweepCompare').fill('60,90');
  await page.locator('#sShapeDim').selectOption('gpu_preset');
  await page.locator('#sShapeVals').fill('h20x8,b300x8');
  const records = await u5Scan(page);
  expect(posts).toHaveLength(1);
  expect(posts[0].jobs).toHaveLength(8);
  const combinations = new Set();
  posts[0].jobs.forEach((job, index) => {
    const configuration = records[index].workload.configuration;
    combinations.add(JSON.stringify([job.overrides.ssdBW, job.overrides.hwPreset, job.strategy.eviction.hbm_evict_threshold]));
    expect(configuration.execution.ssdBW).toBe(job.overrides.ssdBW);
    expect(configuration.execution.hbmPerGpu).toBe(job.overrides.hwPreset === 'h20x8' ? 96 : 288);
    expect(configuration.strategy.eviction.hbm_evict_threshold).toBe(job.strategy.eviction.hbm_evict_threshold);
    expect(configuration.targetQps).toBe(2);
    expect(configuration.seed).toBe(42);
    expect(configuration.execution.blockSize).toBe(64);
  });
  expect(combinations.size).toBe(8);
  expect(errors).toEqual([]);
});

test('U5: Replay synthetic dimensions are disabled and direct handlers cannot inject them', async ({ page }) => {
  const { errors, posts } = await start(page);
  await upload(page);
  await smallScanSettings(page);
  for (const id of ['sSweepParam', 'sSweepCompareParam', 'sShapeDim']) {
    for (const dimension of ['input_len', 'prefix_hit', 'prefix_warm_l2', 'concurrency']) {
      const option = page.locator(`#${id} option[value="${dimension}"]`);
      if (await option.count()) await expect(option).toBeDisabled();
    }
    for (const dimension of ['input_len', 'prefix_hit', 'prefix_warm_l2', 'concurrency']) {
      await page.evaluate(({ id, dimension }) => {
        document.getElementById('sSweepParam').value = 'ssd_bw';
        document.getElementById('sSweepCompareParam').value = '';
        document.getElementById('sShapeDim').value = 'prefetch';
        const select = document.getElementById(id);
        if (![...select.options].some(option => option.value === dimension)) select.add(new Option(dimension, dimension));
        select.value = dimension;
        return window.runSensitivity();
      }, { id, dimension });
      await expect(page.locator('#sensitivityStatus')).toContainText(dimension);
      await expect(page.locator('#sensitivityStatus')).toContainText('不支持合成生成维度');
      expect(posts).toHaveLength(0);
    }
  }
  expect(errors).toEqual([]);
});

test('U5: Replay cross uses target QPS axes and actual measurement QPS tooltips', async ({ page }) => {
  const { errors, posts } = await start(page);
  await upload(page, oneRequest(2));
  await settings(page, { replaySeed: '0' });
  await page.locator('.nav-item[data-tab="tab-cross"]').click();
  const pending = submitted(page);
  await page.locator('#btnRunCross').click();
  const response = await pending;
  expect(response.status()).toBe(202);
  const task = await response.json();
  await expect(page.locator('#crossStatus')).toContainText('交叉分析完成', { timeout: 30_000 });
  const stored = await (await page.request.get(`/api/tasks/${task.id}/download`)).json();
  expect(stored.task.status).toBe('completed');
  expect(posts).toHaveLength(1);
  expect(posts[0].kind).toBe('batch');
  expect(posts[0].jobs).toHaveLength(28);
  const levels = [0.1, 0.3, 1, 3, 8, 16];
  posts[0].jobs.forEach((job, index) => {
    expect(job.overrides.qps).toBe(index < 24 ? levels[Math.floor(index / 4)] : 2);
    expect(job.overrides.seed).toBe(0);
    expect(job.overrides.replay.bundle).toEqual(oneRequest(2));
    expect(job.overrides).not.toHaveProperty('nreq');
    expect(job.overrides).not.toHaveProperty('concurrency');
  });
  const chart = await page.evaluate(() => {
    const option = window.echarts.getInstanceByDom(document.getElementById('chartHeatmap')).getOption();
    return { axis: option.xAxis[0], data: option.series[0].data,
      tooltips: option.series[0].data.map(value => option.tooltip[0].formatter({ value })) };
  });
  expect(chart.axis.name).toBe('目标 QPS');
  expect(chart.axis.data).toEqual(levels);
  expect(chart.data).toHaveLength(24);
  for (let index = 0; index < 24; index++) {
    const r = stored.points[index].result, measurement = r.replay.windows.measurement;
    const latency = measurement.latency.endToEnd.p99;
    const valid = !r.replay.state.truncated && !r.replay.counts.failed && !r.replay.counts.cancelled
      && !r.replay.counts.arrivedUnfinished && r.completed > 0 && Number.isFinite(latency);
    expect(chart.data[index]).toEqual([Math.floor(index / 4), index % 4, valid ? +latency.toFixed(3) : null]);
    expect(chart.tooltips[index]).toContain(`目标 QPS: ${levels[Math.floor(index / 4)]}`);
    expect(chart.tooltips[index]).toContain(`实际到达 QPS: ${measurement.arrivalQps.toFixed(3)}`);
    expect(chart.tooltips[index]).toContain(`实际完成 QPS: ${measurement.completionQps.toFixed(3)}`);
  }
  expect(errors).toEqual([]);
});

test('U5: empty measurement samples remain null in Replay scan charts and offline report records', async ({ page }) => {
  const { errors, posts } = await start(page);
  await upload(page, oneRequest(2, 1000));
  await settings(page, { replayDrain: '0', replayQps: '2' });
  await smallScanSettings(page);
  await page.locator('#sPfTimeout').uncheck();
  await page.locator('#sSweepMetric').selectOption('measurement_latency_p99');
  const records = await u5Scan(page);
  expect(records).toHaveLength(1);
  expect(records[0].measurement_latency_p99).toBeNull();
  expect(records[0].measurement_latency_samples).toBe(0);
  expect(records[0].workload.eligibleForComparison).toBe(false);
  const data = await page.evaluate(() => window.echarts.getInstanceByDom(document.getElementById('chartSensitivity')).getOption().series.map(series => series.data));
  expect(data).toEqual([[null]]);
  const html = await downloadHtml(page);
  const points = JSON.parse(html.match(/var PIVOT_PTS = ([^\n]+);/)[1]);
  expect(points).toHaveLength(1);
  expect(points[0].r.measurement_latency_p99).toBeNull();
  expect(points[0].r.measurement_latency_samples).toBe(0);
  expect(html).toContain('无样本');
  expect(posts).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('U5: Replay config requires bundle reselection and report points never merge across same-name bundles', async ({ page }) => {
  const { errors, posts } = await start(page);
  await upload(page, oneRequest(2), 'same-name.json');
  await settings(page, { replaySeed: '0' });
  await smallScanSettings(page);
  await page.locator('#sPfTimeout').uncheck();
  await page.locator('#sSweepMetric').selectOption('measurement_latency_p99');
  const first = await u5Scan(page);
  const firstHtml = await downloadHtml(page);
  await page.locator('button[onclick="exportParams()"]').click();
  const exported = JSON.parse(await page.locator('#paramsIo').inputValue());
  expect(exported.workload).toMatchObject({ source: 'replay', options: { qps: 2, seed: 0, durationSeconds: 0.2, warmupSeconds: 0, simMaxTime: 5 } });
  expect(exported.workload.bundleSummary.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(exported.workload)).not.toContain('blockRuns');
  await page.locator('#replayQps').fill('19');
  expect(await downloadHtml(page)).toBe(firstHtml);
  await page.locator('#paramsIo').fill(JSON.stringify(exported));
  await page.locator('button[onclick="importParamsFromBox()"]').click();
  await expect(page.locator('#workloadSource')).toHaveValue('replay');
  await expect(page.locator('#paramsIoNote')).toContainText('不是独立可复现包');
  await expect(page.locator('#replayQps')).toHaveValue('2');
  await expect(page.locator('#replaySeed')).toHaveValue('0');
  await expect(page.locator(runButton)).toBeDisabled();
  expect(await page.locator('#replayFile').evaluate(el => el.files.length)).toBe(0);
  expect(await downloadHtml(page)).toBe(firstHtml);
  await upload(page, oneRequest(8), 'same-name.json');
  await expect(page.locator('#replayStatus')).toContainText('摘要');
  await expect(page.locator(runButton)).toBeDisabled();
  await upload(page, oneRequest(2), 'renamed.json');
  await expect(page.locator(runButton)).toBeEnabled();
  const invalid = structuredClone(exported);
  invalid.workload.options.warmupSeconds = invalid.workload.options.durationSeconds;
  await page.locator('#paramsIo').fill(JSON.stringify(invalid));
  await page.locator('button[onclick="importParamsFromBox()"]').click();
  await expect(page.locator('#paramsIoNote')).toContainText('导入失败');
  await expect(page.locator('#replayWarmup')).toHaveValue('0');
  await expect(page.locator(runButton)).toBeEnabled();
  const { workload: _workload, ...legacy } = exported;
  await page.locator('#paramsIo').fill(JSON.stringify(legacy));
  await page.locator('button[onclick="importParamsFromBox()"]').click();
  await expect(page.locator('#workloadSource')).toHaveValue('synthetic');
  await source(page, 'replay');
  await expect(page.locator(runButton)).toBeDisabled();
  await upload(page, oneRequest(8), 'same-name.json');
  await settings(page, { replaySeed: '0' });
  await page.locator('#sSweepMetric').selectOption('measurement_latency_p99');
  const second = await u5Scan(page);
  expect(posts).toHaveLength(2);
  expect(first[0].workload.configuration.bundleDigest).not.toBe(second[0].workload.configuration.bundleDigest);
  const html = await downloadHtml(page);
  const points = JSON.parse(html.match(/var PIVOT_PTS = ([^\n]+);/)[1]);
  expect(points).toHaveLength(2);
  expect(new Set(points.map(point => point.r.workload.configuration.bundleDigest))).toEqual(new Set([
    first[0].workload.configuration.bundleDigest, second[0].workload.configuration.bundleDigest,
  ]));
  expect(points.map(point => point.r.measurement_latency_p99).sort()).toEqual([first[0].measurement_latency_p99, second[0].measurement_latency_p99].sort());
  expect(html).toContain('measurement');
  expect(html).toContain('workloadModel');
  expect(html).not.toBe(firstHtml);
  await source(page, 'synthetic');
  expect(await downloadHtml(page)).toBe(html);
  expect(errors).toEqual([]);
});

test('U1: shared entry preserves synthetic follow-ups, Replay zero-offset dependencies and result isolation', async ({ page }) => {
  const { errors, posts } = await start(page, 'synthetic');
  await importControls(page, { ...baseControls, pMultiTurn: '100', pInstances: '2', pRoutePolicy: 'random',
    sDsl: baseline.strategy.dsl, sName: 'u1-follow-up', pBlockSize: '64', pPdSep: '0' });
  const synthetic = await runSynthetic(page);
  expect(synthetic.totalReqs).toBe(16);
  expect(synthetic.completed).toBe(synthetic.totalReqs);
  expect(synthetic.truncated).toBe(false);
  await importControls(page, { pInstances: '1' });
  await source(page, 'replay');
  await upload(page, prefix);
  await settings(page, { replayQps: '6' });
  const { result } = await run(page);
  expect(result.replay.counts).toMatchObject({ planned: 3, arrived: 3, successful: 3, waitingAnchor: 0, unfinished: 0 });
  const timeline = new Map(result.timeline.map(req => [req.id, req]));
  expect(timeline.get(1).arrive).toBe(timeline.get(0).completeTime);
  expect(timeline.get(2).arrive).toBe(timeline.get(1).completeTime);
  expect(result.replay.windows.full.cache).toMatchObject({ inputTokens: 448, hitL1Tokens: 192, missTokens: 256 });
  expect((await run(page)).result).toEqual(result);
  for (const snapshot of [synthetic, result]) {
    const json = JSON.stringify(snapshot);
    for (const key of ['sessionId', 'routingKey', 'inputContent', 'sessionInstanceKey']) {
      expect(json).not.toContain(`"${key}":`);
    }
    const identityPaths = [];
    const collectIdentityPaths = (value, path = '') => {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        const next = path ? `${path}.${key}` : key;
        if (key === 'outputIdentity') identityPaths.push(next);
        collectIdentityPaths(item, next);
      }
    };
    collectIdentityPaths(snapshot);
    expect(identityPaths.sort()).toEqual((snapshot.replay
      ? ['configuration.pageLayout.outputIdentity', 'configuration.outputIdentity', 'replay.configuration.pageLayout.outputIdentity', 'replay.configuration.outputIdentity']
      : ['configuration.pageLayout.outputIdentity']).sort());
    expect(snapshot.configuration.pageLayout.outputIdentity).toBe(snapshot.replay ? 'unmapped' : 'session-history');
    if (snapshot.replay) {
      expect(snapshot.replay.configuration.outputIdentity).toBe('unmapped');
      expect(snapshot.replay.configuration).toEqual(snapshot.configuration);
    }
  }
  expect(posts[0].jobs[0].overrides?.replay).toBeUndefined();
  expect(posts[1].jobs[0].overrides.replay.bundle).toEqual(prefix);
  expect(errors).toEqual([]);
});

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
    for (const selector of ['#replayFileInfo', '#replayStatus', '#replaySummary dt', '#replaySummary > details > p', '#replaySummary summary']) {
      expect(await typography(page.locator(selector).first()), selector).toEqual(note);
    }
    const value = await typography(page.locator('#replaySummary dd').first());
    expect(value).toEqual({ ...note, color: (await typography(page.locator('body'))).color });
    await page.locator('#replaySummary > details > details > summary').first().click();
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
    await expect.poll(() => typography(page.locator('#replaySummary h3').first())).toEqual(resultHeading);
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
  for (const size of ['48', '96']) {
    await page.locator('#pBlockSize').fill(size);
    await page.locator(runButton).click();
    await expect(page.locator('#simulationStatus')).toContainText('64');
    await expect(page.locator('#pBlockSize')).toHaveValue(size);
    await recovered(page);
  }
  await page.locator('#pBlockSize').fill('64');
  await page.locator('#pInstances').fill('2');
  await page.locator('#pPdSep').selectOption('2');
  await page.locator(runButton).click();
  await expect(page.locator('#simulationStatus')).toContainText('P/D');
  await expect(page.locator('#pInstances')).toHaveValue('2');
  await expect(page.locator('#pPdSep')).toHaveValue('2');
  await recovered(page);
  await page.locator('#pInstances').fill('1');
  await page.locator('#pPdSep').selectOption('0');
  await page.locator('#modeJs').click();
  await page.locator('#sDsl').fill('window.__replayJs = true;');
  await expect(page.locator('#workloadSource')).toHaveValue('replay');
  expect(await page.locator('#replayFile').evaluate(el => el.files.length)).toBe(1);
  await expect(page.locator(runButton)).toBeDisabled();
  await page.evaluate(() => window.applyStrategies());
  await expect(page.locator('#simulationStatus')).toContainText('仅支持 DSL');
  expect(await page.evaluate(() => window.__replayJs)).toBeUndefined();
  expect(posts).toHaveLength(0);
  await page.locator('#modeDsl').click();
  await page.locator('#sDsl').fill(baseline.strategy.dsl);
  await expect(page.locator('#workloadSource')).toHaveValue('replay');
  for (const size of ['16', '32', '64', '128', '256']) {
    await page.locator('#pBlockSize').fill(size);
    const { result } = await run(page);
    expect(result.completed).toBe(1);
    expect(result.replay.configuration.execution.blockSize).toBe(Number(size));
    expect(result.replay.windows.full.cache.inputTokens).toBe(64);
  }
  await page.locator('#pInstances').fill('2');
  const multi = (await run(page)).result;
  expect(multi.replay.configuration.execution.instances).toBe(2);
  expect(multi.replay.state.supportedScope).toContain('instance-private');
  await page.locator('#pInstances').fill('1');
  await page.locator('#pPdSep').selectOption('2');
  const pd = (await run(page)).result;
  expect(pd.replay.configuration.execution.pdMode).toBe(2);
  expect(pd.replay.state.supportedScope).toContain('physical-pd');
  expect(posts).toHaveLength(7);
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
  const { workload: originalWorkload, ...originalControls } = original;
  const { workload: exportedWorkload, ...exportedControls } = exported;
  expect(originalWorkload).toEqual({ source: 'synthetic' });
  expect(exportedControls).toEqual(originalControls);
  expect(exportedWorkload).toMatchObject({ source: 'replay', options: { qps: 6, seed: 42, durationSeconds: 0.2, warmupSeconds: 0, simMaxTime: 5 } });
  expect(exportedWorkload.bundleSummary.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(exportedWorkload)).not.toContain('blockRuns');
  await page.locator('#paramsIo').fill(JSON.stringify({ ...originalControls, workloadSource: 'replay', replaySeed: '999', replayDuration: '123', replayFile: 'not-a-bundle', bundle: oneRequest() }));
  await page.locator('button[onclick="importParamsFromBox()"]').click();
  await expect(page.locator('#workloadSource')).toHaveValue('synthetic');
  await expect(page.locator('#replaySeed')).toHaveValue('42');
  await expect(page.locator('#replayDuration')).toHaveValue('0.2');
  expect(await page.locator('#replayFile').evaluate(el => el.files.length)).toBe(0);
  expect(await downloadResult(page)).toEqual(result);
  await source(page, 'replay');
  await expect(page.locator(runButton)).toBeDisabled();
  await upload(page, prefix, 'preserved.json');
  expect(await page.locator('#replayFileInfo').textContent()).toBe(fileInfo);
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

test('U5: Replay and synthetic share the run-all entry without sharing result caches or workload inputs', async ({ page }) => {
  const { errors, posts } = await start(page);
  await upload(page);
  await page.locator('button[onclick="saveStrategy()"]').click();
  await page.locator('#sName').fill('replay-second');
  await page.locator('#sDsl').fill(baseline.strategy.dsl.replace(/PREFETCH:[^\n]*/, 'PREFETCH: best_effort'));
  await page.locator('button[onclick="saveStrategy()"]').click();
  for (let iteration = 0; iteration < 2; iteration++) {
    await expect(page.locator(allButton)).toBeEnabled();
    const responseEvent = submitted(page);
    await page.locator(allButton).click();
    const response = await responseEvent;
    expect(response.status()).toBe(202);
    const task = await response.json();
    await expect(page.locator(runButton)).toBeEnabled();
    await expect(page.locator('#simulationStatus')).toContainText('运行完成');
    const stored = await (await page.request.get(`/api/tasks/${task.id}/download`)).json();
    expect(stored.task.status).toBe('completed');
    expect(stored.points).toHaveLength(2);
    expect(posts[iteration].jobs).toHaveLength(2);
    for (const job of posts[iteration].jobs) expect(job.overrides.replay.bundle).toEqual(oneRequest());
    expect(stored.points.map(point => point.result.completed)).toEqual([1, 1]);
  }
  expect(posts[0].requestId).not.toBe(posts[1].requestId);
  await source(page, 'synthetic');
  await expect(page.locator(allButton)).toBeEnabled();
  const responseEvent = submitted(page);
  await page.locator(allButton).click();
  expect((await responseEvent).status()).toBe(202);
  await expect(page.locator(runButton)).toBeEnabled();
  await expect(page.locator('#simulationStatus')).toHaveText('运行完成');
  expect(posts).toHaveLength(3);
  expect(posts[2].jobs).toHaveLength(2);
  expect(posts[2].jobs.every(job => !job.overrides?.replay)).toBe(true);
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

test('U5: missing bundles block analysis while report permissions follow saved scan snapshots across source changes', async ({ page }) => {
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
  await expect(page.locator('#crossStatus')).toContainText('bundle');
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
  for (const id of legacyExportIds) await expect(page.locator('#' + id)).toBeEnabled();
  await expect(page.locator('#sensExportRestriction')).toBeHidden();
  expect(await downloadHtml(page)).toBe(originalHtml);
  await expect(page.locator('#btnRunSens')).toBeEnabled();
  const replayScan = submitted(page);
  await page.locator('#btnRunSens').click();
  expect((await replayScan).status()).toBe(202);
  await expect(page.locator('#btnRunSens')).toBeEnabled();
  for (const id of legacyExportIds) await expect(page.locator('#' + id)).toBeEnabled();
  const replayHtml = await downloadHtml(page);
  expect(replayHtml).toContain('Replay');
  expect(replayHtml).toContain('measurement');
  expect(replayHtml).not.toEqual(originalHtml);
  await page.locator('#replayQps').fill('19');
  await source(page, 'synthetic');
  expect(await downloadHtml(page)).toEqual(replayHtml);
  expect(await downloadResult(page)).toEqual(result);
  expect(posts).toHaveLength(4);
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
  expect(await downloadHtml(page)).toBe(replayHtml);
  await page.locator('#btnRunSens').click();
  await expect(page.locator('#btnRunSens')).toBeEnabled();
  expect(await page.locator('#formulaSensitivity').innerHTML()).toContain(originalScan);
  await expect(page.locator('#formulaSensitivity')).toContainText('缓存命中，未重跑仿真');
  expect(await scanData()).toEqual(originalScanData);
  expect(posts).toHaveLength(4);
  expect(posts.map(post => post.kind)).toEqual(['simulation', 'scan', 'simulation', 'scan']);
  expect(errors).toEqual([]);
  expect(console).toEqual([]);
});

for (const status of ['completed', 'failed', 'cancelled']) {
  test(`U5: a ${status} synthetic scan locks source changes and never enables Replay without a bundle`, async ({ page }) => {
    const { errors, posts } = await start(page, 'synthetic');
    const result = await runSynthetic(page);
    await smallScanSettings(page);
    const chartBefore = await page.locator('#chartSensitivity').innerHTML();
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
    await expect(page.locator('#workloadSource')).toBeDisabled();
    await expect(page.locator('#replayFile')).toBeDisabled();
    await expect(page.locator('#btnRunSens')).toBeDisabled();
    await page.evaluate(() => {
      const source = document.getElementById('workloadSource');
      source.value = 'replay';
      source.dispatchEvent(new Event('change', { bubbles: true }));
      window.runSensitivity();
    });
    await expect(page.locator('#workloadSource')).toHaveValue('synthetic');
    expect(posts).toHaveLength(2);
    release();
    await expect(page.locator('#btnRunSens')).toHaveText('运行敏感性分析');
    await expect(page.locator('#workloadSource')).toBeEnabled();
    if (status !== 'completed') {
      await expect(page.locator('#sensitivityStatus')).toContainText(`scan ${status}`);
      expect(await page.locator('#chartSensitivity').innerHTML()).toBe(chartBefore);
    }
    await source(page, 'replay');
    await expect(page.locator('#btnRunSens')).toBeDisabled();
    await expect(page.locator(allButton)).toBeDisabled();
    await page.evaluate(() => window.runSensitivity());
    await expect(page.locator('#sensitivityStatus')).toContainText('bundle');
    if (status === 'completed') await expect(page.locator('#btnSensExportHtml')).toBeEnabled();
    else {
      expect(await page.locator('#chartSensitivity').innerHTML()).toBe(chartBefore);
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
    await expect(page.locator('#chartHeatmap .progress-note')).toBeVisible();
    await expect(page.locator('#chartHeatmap')).toContainText('交叉分析需运行');
    const chartBefore = await page.locator('#chartHeatmap').innerHTML();
    const response = submitted(page);
    await page.locator('#btnRunCross').click();
    expect((await response).status()).toBe(202);
    await expect(page.locator('#btnRunCross')).toBeDisabled();
    await page.locator('.nav-item[data-tab="tab-params"]').click();
    await expect(page.locator('#workloadSource')).toBeDisabled();
    await page.evaluate(() => {
      const source = document.getElementById('workloadSource');
      source.value = 'replay';
      source.dispatchEvent(new Event('change', { bubbles: true }));
      window.runCrossAnalysis();
    });
    await expect(page.locator('#workloadSource')).toHaveValue('synthetic');
    release();
    await page.locator('.nav-item[data-tab="tab-cross"]').click();
    if (status === 'completed') await expect(page.locator('#formulaRadar')).toContainText('计算方式');
    else {
      await expect(page.locator('#crossStatus')).toContainText(`cross ${status}`);
      expect(await page.locator('#chartHeatmap').innerHTML()).toBe(chartBefore);
    }
    await expect(page.locator('#btnRunCross')).toBeEnabled();
    await page.locator('.nav-item[data-tab="tab-params"]').click();
    await source(page, 'replay');
    await page.locator('.nav-item[data-tab="tab-cross"]').click();
    await expect(page.locator('#btnRunCross')).toBeDisabled();
    await page.evaluate(() => window.runCrossAnalysis());
    await expect(page.locator('#crossStatus')).toContainText('bundle');
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

test('U5: a pre-submission scan rejection retains the previous valid export and a cached scan restores its chart', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-23T00:00:00Z'));
  const { errors, posts } = await start(page, 'synthetic');
  await smallScanSettings(page);
  await page.locator('#btnRunSens').click();
  await expect(page.locator('#btnSensExportHtml')).toBeEnabled();
  const original = await downloadHtml(page);
  await importControls(page, { _strategyMode: 'js', sDsl: 'window.__unexpectedScan = true;' });
  await page.locator('#btnRunSens').click();
  await expect(page.locator('#sensitivityStatus')).toContainText('不支持 JavaScript');
  await expect(page.locator('#sensitivityStatus')).toContainText('保留上次结果');
  await expect(page.locator('#btnRunSens')).toBeEnabled();
  for (const id of legacyExportIds) await expect(page.locator('#' + id)).toBeEnabled();
  expect(await downloadHtml(page)).toBe(original);
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
