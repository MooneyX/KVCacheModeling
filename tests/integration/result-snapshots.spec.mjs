import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { baseControls } from '../fixtures/scenarios.mjs';

const fixtures = JSON.parse(readFileSync(new URL('../fixtures/simulation-baseline.json', import.meta.url), 'utf8'));
const values = { ...baseControls, sDsl: fixtures[0].strategy.dsl, sName: 'snapshot-A', pSsdBW: '50' };
const runButton = 'button[onclick="applyStrategies()"]';
const chartIds = ['chartStrategyGantt', 'chartStrategyPt', 'chartStrategyBwReq', 'chartStrategyResident', 'chartGantt', 'chartBatchOcc'];

async function start(page) {
  const errors = [], posts = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().endsWith('/api/tasks') && request.method() === 'POST') posts.push(request.postDataJSON());
  });
  await page.addInitScript(() => {
    window.Worker = class { constructor() { throw new Error('Unexpected client simulation'); } };
  });
  await page.route('https://**/*', route => route.abort());
  await page.goto('/');
  await expect(page.locator('#serverStatus')).toContainText('服务器计算');
  await page.locator('#paramsIo').fill(JSON.stringify(values));
  await page.locator('button[onclick="importParamsFromBox()"]').click();
  return { errors, posts };
}

async function tab(page, id) {
  await page.locator(`.nav-item[data-tab="tab-${id}"]`).click();
  await page.waitForTimeout(200);
}

async function capture(page) {
  return page.evaluate(ids => ({
    metrics: document.getElementById('strategyMetricsGrid').innerHTML,
    formulas: ['formulaStrategySim', 'formulaStrategyTier', 'formulaGantt'].map(id => document.getElementById(id).innerHTML),
    charts: ids.map(id => {
      const option = window.echarts.getInstanceByDom(document.getElementById(id))?.getOption();
      return option ? { series: option.series?.map(s => ({ name: s.name, data: s.data })), xAxis: option.xAxis, yAxis: option.yAxis } : null;
    }),
  }), chartIds);
}

async function run(page, selector = runButton) {
  const responseEvent = page.waitForResponse(response => response.url().endsWith('/api/tasks') && response.request().method() === 'POST');
  await page.locator(selector).click();
  const response = await responseEvent;
  expect(response.status()).toBe(202);
  const task = await response.json();
  await expect(page.locator(selector)).toBeEnabled();
  await expect(page.locator('#simulationStatus')).toHaveText('运行完成');
  const download = await page.request.get(`/api/tasks/${task.id}/download`);
  expect(download.ok()).toBe(true);
  return (await download.json()).points.map(point => point.result);
}

function expectTimeline(snapshot, result) {
  const [gantt, occupancy] = snapshot.charts.slice(-2);
  expect(gantt.series.find(s => s.name === 'Decode').data).toEqual([...result.timeline].sort((a, b) => a.arrive - b.arrive).map(t => [t.id, t.prefillEnd, t.completeTime]));
  expect(occupancy.series.map(s => s.data)).toEqual([1, 2, 3].map(index => result.concTimeline.map(point => [point[0], point[index]])));
  expect(snapshot.metrics).toContain(`${result.avgTtft.toFixed(0)} ms`);
  expect(snapshot.formulas[2]).toContain(`${result.completed}/${result.totalReqs}`);
}

test('V1: empty result views and repeated tab refreshes never submit tasks', async ({ page }) => {
  const { errors, posts } = await start(page);
  await tab(page, 'schedule');
  for (const id of ['chartGantt', 'chartBatchOcc', 'formulaGantt']) await expect(page.locator('#' + id)).toHaveText('请先运行');
  await page.evaluate(() => { document.getElementById('pQps').value = '19'; window.recalcAll(); });
  await tab(page, 'params');
  for (const id of ['strategyMetricsGrid', 'chartStrategyGantt', 'chartStrategyPt', 'chartStrategyBwReq', 'chartStrategyResident', 'formulaStrategySim', 'formulaStrategyTier']) {
    await expect(page.locator('#' + id)).toHaveText('请先运行');
  }
  await tab(page, 'schedule');
  expect(posts).toEqual([]);
  expect(errors).toEqual([]);
});

test('V1: charts and formulas retain the executed snapshot until the next successful run', async ({ page }) => {
  const { errors, posts } = await start(page);
  const [first] = await run(page);
  await tab(page, 'schedule');
  const before = await capture(page);
  expectTimeline(before, first);
  expect(before.charts[2].series.find(s => s.name === 'L3 配置').data).toEqual([50]);
  const theoryBefore = await page.locator('#formulaBatching').innerHTML();
  await page.evaluate(() => {
    for (const [id, value] of Object.entries({ pSsdBW: '200', pPrefillA: '17', pPrefillB: '0.2', pMfu: '25', pQps: '9', pSeed: '77', sName: 'editing-B', sDsl: 'not a valid strategy' })) document.getElementById(id).value = value;
    window.recalcAll();
  });
  expect(await capture(page)).toEqual(before);
  expect(await page.locator('#formulaBatching').innerHTML()).not.toBe(theoryBefore);
  for (let i = 0; i < 2; i++) { await tab(page, 'params'); await tab(page, 'schedule'); }
  expect(await capture(page)).toEqual(before);
  expect(posts).toHaveLength(1);
  await tab(page, 'params');
  await page.locator('#sDsl').fill(values.sDsl);
  await page.locator('#sName').fill('snapshot-B');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/tasks', async route => {
    if (route.request().method() === 'POST') await gate;
    await route.continue();
  });
  const next = run(page);
  await expect(page.locator('#simulationStatus')).toContainText('正在运行');
  expect(await capture(page)).toEqual(before);
  release();
  const [second] = await next;
  await tab(page, 'schedule');
  const after = await capture(page);
  expectTimeline(after, second);
  expect(after.metrics).toContain('snapshot-B');
  expect(after.charts[2].series.find(s => s.name === 'L3 配置').data).toEqual([200]);
  expect(after.formulas[0]).toContain('seed=77');
  expect(after.formulas[2]).toContain('a=17, b=0.2');
  expect(after).not.toEqual(before);
  expect(posts).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('V1: submission failure retains all previous result views and configuration', async ({ page }) => {
  const { errors } = await start(page);
  await run(page);
  await tab(page, 'schedule');
  const before = await capture(page);
  await tab(page, 'params');
  await page.locator('#pSeed').fill('43');
  await page.route('**/api/tasks', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 503, json: { error: '<b>server unavailable</b>' } }) : route.continue());
  await page.locator(runButton).click();
  await expect(page.locator('#simulationStatus')).toHaveText('仿真出错: <b>server unavailable</b>');
  expect(await page.locator('#simulationStatus b').count()).toBe(0);
  await expect(page.locator(runButton)).toBeEnabled();
  await tab(page, 'schedule');
  await tab(page, 'params');
  expect(await capture(page)).toEqual(before);
  expect(errors).toEqual([]);
});

for (const status of ['failed', 'cancelled']) {
  test(`V1: a ${status} batch cannot publish its partial results`, async ({ page }) => {
    const { errors } = await start(page);
    const [first] = await run(page);
    await tab(page, 'schedule');
    const before = await capture(page);
    await tab(page, 'params');
    await page.locator('#pSeed').fill('43');
    await page.locator('button[onclick="saveStrategy()"]').click();
    await page.locator('#sDsl').fill(fixtures[1].strategy.dsl);
    await page.locator('#sName').fill('partial-B');
    await page.locator('button[onclick="saveStrategy()"]').click();
    const task = { id: `v1-${status}`, status, total: 2, completed: 1, error: `test ${status}` };
    await page.route(`**/api/tasks/${task.id}/points?*`, route => route.fulfill({ json: { task, next: 1, points: [{ index: 0, result: { ...first, name: 'partial-result' } }] } }));
    await page.route('**/api/tasks', route => route.request().method() === 'POST'
      ? route.fulfill({ status: 202, json: { ...task, status: 'running', completed: 0 } }) : route.continue());
    await page.locator('button[onclick="runAllStrategies()"]').click();
    await expect(page.locator('#simulationStatus')).toContainText(`test ${status}`);
    await expect(page.locator(runButton)).toBeEnabled();
    await tab(page, 'schedule');
    await tab(page, 'params');
    expect(await capture(page)).toEqual(before);
    expect(errors).toEqual([]);
  });
}

test('V1: multiple strategies preserve comparison, first-result timelines and cache reuse', async ({ page }) => {
  const { errors, posts } = await start(page);
  const [first] = await run(page);
  await page.locator('#sName').fill('renamed-A');
  await page.locator('button[onclick="saveStrategy()"]').click();
  await page.locator('#sDsl').fill(fixtures[1].strategy.dsl);
  await page.locator('#sName').fill('saved-B');
  await page.locator('button[onclick="saveStrategy()"]').click();
  const [second] = await run(page, 'button[onclick="runAllStrategies()"]');
  expect(posts).toHaveLength(2);
  expect(posts[1].jobs).toHaveLength(1);
  expect(posts[1].jobs[0].strategy.name).toBe('saved-B');
  await tab(page, 'schedule');
  const snapshot = await capture(page);
  expectTimeline(snapshot, first);
  expect(snapshot.metrics).toContain('renamed-A');
  expect(snapshot.metrics).toContain('saved-B');
  expect(snapshot.formulas[2]).toContain('renamed-A');
  expect(snapshot.charts[0].series.find(s => s.name === 'P50延迟(ms)').data).toEqual([first, second].map(r => +r.p50.toFixed(0)));
  await tab(page, 'params');
  await page.locator('button[onclick="runAllStrategies()"]').click();
  await expect(page.locator(runButton)).toBeEnabled();
  await tab(page, 'schedule');
  expect(posts).toHaveLength(2);
  expect(await capture(page)).toEqual(snapshot);
  expect(errors).toEqual([]);
});

test('V1: direct redraws require snapshots, replace empty occupancy and do not leak chart instances', async ({ page }, info) => {
  test.skip(info.project.name !== 'development', 'Direct module injection is development-only; lifecycle tests run in both builds.');
  const { errors, posts } = await start(page);
  await run(page);
  await tab(page, 'schedule');
  const check = await page.evaluate(async () => {
    const { state } = await import('/src/ui/state.js');
    const { drawGantt } = await import('/src/ui/charts.js');
    const { showStrategyResults } = await import('/src/ui/simulation.js');
    const result = state.simResults[0], input = state.simInput;
    const count = state.chartRegistry.length;
    for (let i = 0; i < 4; i++) { showStrategyResults(); drawGantt(result, input); }
    const stable = state.chartRegistry.length === count && state.chartRegistry.every(chart => !chart.isDisposed());
    const frozen = { mode: input.mode, name: input.strategies[0].name, dsl: input.controls.sDsl.value };
    drawGantt({ ...result, timeline: [], incomplete: [], concTimeline: [] }, input);
    const empty = window.echarts.getInstanceByDom(document.getElementById('chartBatchOcc')).getOption().series.every(s => s.data.length === 0);
    state.simInput = null;
    showStrategyResults();
    const missing = ['strategyMetricsGrid', 'chartStrategyGantt', 'chartStrategyPt', 'formulaStrategySim', 'formulaStrategyTier', 'chartGantt', 'chartBatchOcc', 'formulaGantt'].every(id => document.getElementById(id).textContent === '请先运行');
    state.simInput = input;
    showStrategyResults();
    return { stable, frozen, empty, missing };
  });
  expect(check).toEqual({ stable: true, frozen: { mode: 'dsl', name: 'snapshot-A', dsl: values.sDsl }, empty: true, missing: true });
  expect(posts).toHaveLength(1);
  expect(errors).toEqual([]);
});
