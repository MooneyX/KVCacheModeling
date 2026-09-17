import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { legacyCode } from '../fixtures/legacy-loader.mjs';
import { baseControls } from '../fixtures/scenarios.mjs';

const fixtures = JSON.parse(readFileSync(new URL('../fixtures/simulation-baseline.json', import.meta.url), 'utf8'));
const uiValues = { ...baseControls, sDsl: fixtures[0].strategy.dsl, sName: 'browser-test' };

async function importControls(page, values = uiValues) {
  await page.locator('#paramsIo').fill(JSON.stringify(values));
  await page.locator('button[onclick="importParamsFromBox()"]').click();
}

async function start(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://**/*', route => route.abort());
  await page.goto('/');
  await expect(page.locator('#modelPresets .preset-tag')).not.toHaveCount(0);
  await importControls(page);
  const workerEvent = page.waitForEvent('worker');
  await page.locator('button[onclick="applyStrategies()"]').click();
  const worker = await workerEvent;
  const url = worker.url();
  await expect(page.locator('#strategyMetricsGrid')).toContainText('browser-test');
  await expect(page.locator('button[onclick="applyStrategies()"]')).toBeEnabled();
  expect(errors).toEqual([]);
  return { url, errors };
}

test('real Worker full results equal the frozen engine in the same browser runtime', async ({ page }) => {
  const { url, errors } = await start(page);
  const results = await page.evaluate(async ({ url, fixtures, legacyCode }) => {
    const documentStub = { getElementById() { throw new Error('Unexpected DOM read'); }, querySelectorAll() { return []; }, addEventListener() {} };
    const worker = new Worker(url, { type: 'module' });
    const differences = [];
    try {
      for (const [id, fixture] of fixtures.entries()) {
        if (fixture.mode === 'js') continue;
        const legacy = new Function('document', 'window', 'globalThis', legacyCode + '\nreturn {runSimulation};')(documentStub, { addEventListener() {} }, { __PARAMS_OVERRIDE: fixture.params });
        const expected = JSON.stringify(legacy.runSimulation(fixture.strategy, fixture.overrides));
        const actual = await new Promise((resolve, reject) => {
          worker.onmessage = ({ data }) => data.type === 'error' ? reject(new Error(data.message)) : resolve(data.result);
          worker.onerror = event => reject(new Error(event.message));
          worker.postMessage({ type: 'simulation', id, ...fixture });
        });
        if (JSON.stringify(actual) !== expected) differences.push(fixture.name);
      }
    } finally { worker.terminate(); }
    return differences;
  }, { url, fixtures, legacyCode });
  expect(results).toEqual([]);
  expect(errors).toEqual([]);
});

test('parameter snapshot, scan cache, reports and tab navigation work without CDN', async ({ page }) => {
  const { errors } = await start(page);
  await page.locator('#sName').fill('frozen-input');
  await page.locator('#pSeed').fill('917');
  const newWorker = page.waitForEvent('worker');
  await page.evaluate(() => {
    document.getElementById('pSsdBW').value = '50';
    document.querySelector('button[onclick="applyStrategies()"]').click();
    document.getElementById('pSsdBW').value = '200';
    document.getElementById('sName').value = 'next-input';
  });
  await newWorker;
  await expect(page.locator('#strategyMetricsGrid')).toContainText('frozen-input');
  const bandwidth = await page.evaluate(() => window.echarts.getInstanceByDom(document.getElementById('chartStrategyBwReq')).getOption().series.find(series => series.name === 'L3 配置').data);
  expect(bandwidth).toEqual([50]);
  await page.locator('#sSweepParam').selectOption('ssd_bw');
  await page.locator('#sSweepRange').fill('10,50');
  await page.locator('#sSweepCompareParam').selectOption('');
  await page.locator('#sPfWait').check();
  await page.locator('#sPfBest').uncheck();
  await page.locator('#sPfRace').uncheck();
  await page.locator('#btnRunSens').click();
  await expect(page.locator('#btnSensExportHtml')).toBeEnabled();
  await expect(page.locator('#sensSnapList')).toContainText('已收集');
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#btnSensExportHtml').click();
  const download = await downloadEvent;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const html = Buffer.concat(chunks).toString('utf8');
  expect(html).toContain('echarts@5.5.0');
  expect(html).toContain('10GB/s');
  expect(html).toContain('50GB/s');
  const newWorkers = [];
  page.on('worker', worker => newWorkers.push(worker.url()));
  await page.locator('#btnRunSens').click();
  await expect(page.locator('#btnRunSens')).toBeEnabled();
  expect(newWorkers).toEqual([]);
  for (const tab of ['tab-storage', 'tab-schedule', 'tab-cross', 'tab-params']) {
    await page.locator(`.nav-item[data-tab="${tab}"]`).click();
    await expect(page.locator(`#${tab}`)).toHaveClass(/active/);
    await page.waitForTimeout(150);
  }
  expect(errors).toEqual([]);
});

test('JS strategy remains in browser compatibility execution and scan can be cancelled', async ({ page }) => {
  const { errors } = await start(page);
  const workers = [];
  page.on('worker', worker => workers.push(worker.url()));
  const js = 'function admit() { document.body.dataset.hookCalls = String(1 + Number(document.body.dataset.hookCalls || 0)); return "hbm"; }\nfunction evict() { return null; }\nfunction shouldPrefetch() { return false; }\nfunction place() { return "hbm"; }';
  await importControls(page, { ...uiValues, _strategyMode: 'js', sDsl: js, sName: 'js-browser' });
  await page.locator('button[onclick="applyStrategies()"]').click();
  await expect(page.locator('#strategyMetricsGrid')).toContainText('js-browser');
  expect(await page.evaluate(() => Number(document.body.dataset.hookCalls))).toBeGreaterThan(0);
  expect(workers).toEqual([]);
  await importControls(page, { ...uiValues, _strategyMode: 'dsl' });
  await page.locator('#sSweepRange').fill('1,200,1');
  await page.evaluate(() => {
    document.getElementById('btnRunSens').click();
    document.getElementById('sensCancelBtn').click();
  });
  await expect(page.locator('#chartSensitivity')).toContainText('已取消');
  await expect(page.locator('#btnRunSens')).toBeEnabled();
  expect(errors).toEqual([]);
});
