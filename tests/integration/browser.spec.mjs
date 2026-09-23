import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { baseControls } from '../fixtures/scenarios.mjs';

const fixtures = JSON.parse(readFileSync(new URL('../fixtures/simulation-baseline.json', import.meta.url), 'utf8'));
const uiValues = { ...baseControls, sDsl: fixtures[0].strategy.dsl, sName: 'browser-test' };
const submitted = page => page.waitForResponse(response => response.url().endsWith('/api/tasks') && response.request().method() === 'POST');

async function importControls(page, values = uiValues) {
  await page.locator('#paramsIo').fill(JSON.stringify(values));
  await page.locator('button[onclick="importParamsFromBox()"]').click();
}
async function start(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.Worker = class { constructor() { throw new Error('Client simulation must not create a Worker.'); } };
  });
  await page.route('https://**/*', route => route.abort());
  await page.goto('/');
  await expect(page.locator('#serverStatus')).toContainText('服务器计算');
  await importControls(page);
  return errors;
}

test('ordinary simulation executes on server with frozen parameters and no client Worker', async ({ page }) => {
  const errors = await start(page);
  const submission = submitted(page);
  await page.evaluate(() => {
    document.getElementById('pSsdBW').value = '50';
    document.querySelector('button[onclick="applyStrategies()"]').click();
    document.getElementById('pSsdBW').value = '200';
    document.getElementById('sName').value = 'next-input';
  });
  const response = await submission;
  expect(response.status()).toBe(202);
  const task = await response.json();
  await expect(page.locator('#strategyMetricsGrid')).toContainText('browser-test');
  const bandwidth = await page.evaluate(() => window.echarts.getInstanceByDom(document.getElementById('chartStrategyBwReq')).getOption().series.find(s => s.name === 'L3 配置').data);
  expect(bandwidth).toEqual([50]);
  await page.locator('#serverRefresh').click();
  await expect(page.locator(`[data-task-id="${task.id}"]`)).toContainText('完成');
  expect(errors).toEqual([]);
});

test('scan cache, export, Gantt and cross-analysis use server tasks', async ({ page }) => {
  const errors = await start(page);
  await page.locator('#sSweepParam').selectOption('ssd_bw');
  await page.locator('#sSweepRange').fill('10,50');
  await page.locator('#sSweepCompareParam').selectOption('');
  await page.locator('#sPfWait').check();
  await page.locator('#sPfBest').uncheck();
  await page.locator('#sPfRace').uncheck();
  const submission = submitted(page);
  await page.locator('#btnRunSens').click();
  expect((await submission).status()).toBe(202);
  await expect(page.locator('#btnSensExportHtml')).toBeEnabled();
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#btnSensExportHtml').click();
  const download = await downloadEvent;
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const html = Buffer.concat(chunks).toString('utf8');
  expect(html).toContain('echarts@5.5.0'); expect(html).toContain('10GB/s'); expect(html).toContain('50GB/s');
  const posts = [];
  const listener = request => { if (request.url().endsWith('/api/tasks') && request.method() === 'POST') posts.push(request.url()); };
  page.on('request', listener);
  await page.locator('#btnRunSens').click();
  await expect(page.locator('#btnRunSens')).toBeEnabled();
  expect(posts).toEqual([]);
  await page.locator('.nav-item[data-tab="tab-schedule"]').click();
  await expect(page.locator('#formulaGantt')).toContainText('请先运行');
  await page.waitForTimeout(200);
  expect(posts).toEqual([]);
  page.off('request', listener);
  await page.evaluate(() => {
    document.getElementById('pInputLen').value = '128';
    document.getElementById('pOutputLen').value = '64';
    document.getElementById('pPrefixHit').value = '0';
    document.getElementById('pQps').value = '10';
  });
  await page.locator('.nav-item[data-tab="tab-cross"]').click();
  const cross = submitted(page);
  await page.locator('button[onclick="runCrossAnalysis()"]').click();
  const crossTask = await (await cross).json();
  expect(crossTask.total).toBe(28);
  await expect(page.locator('#formulaRadar')).toContainText('计算方式', { timeout: 40_000 });
  const formula = await page.locator('#formulaRadar').innerHTML();
  page.on('request', listener);
  await page.locator('.nav-item[data-tab="tab-params"]').click();
  await page.locator('#pQps').fill('20');
  await page.locator('.nav-item[data-tab="tab-cross"]').click();
  await page.waitForTimeout(250);
  expect(posts).toEqual([]);
  expect(await page.locator('#formulaRadar').innerHTML()).toBe(formula);
  expect(errors).toEqual([]);
});

test('JS is explicitly rejected and scan cancellation reaches the server', async ({ page }) => {
  const errors = await start(page);
  await importControls(page, { ...uiValues, _strategyMode: 'js', sDsl: 'window.__unexpectedJs = true;', sName: 'js-browser' });
  await page.locator('button[onclick="applyStrategies()"]').click();
  await expect(page.locator('#simulationStatus')).toContainText('不支持 JavaScript');
  expect(await page.evaluate(() => window.__unexpectedJs)).toBeUndefined();
  await importControls(page, { ...uiValues, _strategyMode: 'dsl' });
  await page.locator('#sSweepRange').fill('1,200,1');
  const previousChart = await page.locator('#chartSensitivity').innerHTML();
  const submission = submitted(page);
  await page.locator('#btnRunSens').click();
  const task = await (await submission).json();
  await page.locator('#sensCancelBtn').click();
  await expect(page.locator('#sensitivityStatus')).toContainText('取消');
  await expect(page.locator('#sensitivityStatus')).toContainText('保留上次结果');
  expect(await page.locator('#chartSensitivity').innerHTML()).toBe(previousChart);
  const status = await page.evaluate(async id => (await (await fetch('/api/tasks/' + id)).json()).status, task.id);
  expect(status).toBe('cancelled');
  await expect(page.locator('#btnRunSens')).toBeEnabled();
  expect(errors).toEqual([]);
});

test('submitted batch continues after closing the page and results remain downloadable', async ({ page, context }) => {
  await start(page);
  const task = await page.evaluate(async fixture => {
    const response = await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'batch', jobs: Array(30).fill(fixture), requestId: crypto.randomUUID(), label: 'closed-page-batch' }) });
    return response.json();
  }, fixtures[0]);
  expect(task.status).toBe('running');
  await page.close();
  const next = await context.newPage(); await next.goto('/');
  const row = next.locator(`[data-task-id="${task.id}"]`);
  await expect(row).toContainText('完成', { timeout: 25_000 });
  const downloadEvent = next.waitForEvent('download');
  await row.getByText('下载输入与结果').click();
  const download = await downloadEvent;
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(data.points).toHaveLength(30); expect(data.task.status).toBe('completed');
});

test('server failure is visible and never falls back to local simulation', async ({ page }) => {
  const errors = await start(page);
  await page.route('**/api/tasks', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"server unavailable"}' }) : route.continue());
  await page.locator('button[onclick="applyStrategies()"]').click();
  await expect(page.locator('#simulationStatus')).toContainText('server unavailable');
  await expect(page.locator('button[onclick="applyStrategies()"]')).toBeEnabled();
  expect(errors).toEqual([]);
});
