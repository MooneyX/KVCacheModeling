import { test, expect } from '@playwright/test';
import { runSimulation } from '../../src/core/simulation.js';
import { visualizationCases } from '../fixtures/replay-visualization.mjs';

const execute = job => runSimulation(job.params, job.strategy, job.overrides, job.mode);
const cached = new Map();
function result(name) {
  if (!cached.has(name)) cached.set(name, execute(visualizationCases[name]));
  return structuredClone(cached.get(name));
}
const valueText = (value, digits = 3, unit = '') => value == null ? '无样本' : value.toFixed(digits) + unit;
const chartIds = ['chartGantt', 'chartBatchOcc', 'chartStrategyGantt', 'chartStrategyPt', 'chartStrategyBwReq', 'chartStrategyResident'];

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
  return { errors, posts };
}

async function inject(page, r, job = visualizationCases.prefix) {
  await page.evaluate(async ({ r, job }) => {
    const { state } = await import('/src/ui/state.js');
    const { showStrategyResults } = await import('/src/ui/simulation.js');
    const controls = Object.fromEntries([...document.querySelectorAll('input[id], select[id], textarea[id]')]
      .map(el => [el.id, { value: el.value, checked: el.checked }]));
    state.simResults = [r];
    state.simInput = { params: job.params, controls, strategies: [{ ...job.strategy, name: r.name }], mode: 'dsl' };
    showStrategyResults();
  }, { r, job });
  await page.locator('.nav-item[data-tab="tab-schedule"]').click();
  await expect.poll(() => page.evaluate(() => !!window.echarts.getInstanceByDom(document.getElementById('chartGantt')))).toBe(true);
}

async function capture(page) {
  return page.evaluate(ids => {
    const charts = Object.fromEntries(ids.map(id => {
      const o = window.echarts.getInstanceByDom(document.getElementById(id))?.getOption();
      return [id, o ? { xAxis: o.xAxis, yAxis: o.yAxis, series: o.series.map(s => ({ name: s.name, type: s.type, data: s.data, step: s.step })) } : null];
    }));
    const g = window.echarts.getInstanceByDom(document.getElementById('chartGantt'))?.getOption();
    const tooltips = g?.series.flatMap(s => s.data.map(data => g.tooltip[0].formatter({ seriesName: s.name, data }))) || [];
    return {
      charts, tooltips,
      metrics: Object.fromEntries([...document.querySelectorAll('#strategyMetricsGrid .result-item')].map(el => [el.querySelector('.rl').textContent, el.querySelector('.rv').textContent])),
      formulas: Object.fromEntries(['formulaGantt', 'formulaBatchOcc', 'formulaStrategySim', 'formulaStrategyTier'].map(id => [id, document.getElementById(id).textContent])),
      page: document.getElementById('ganttPageStatus').textContent,
    };
  }, chartIds);
}

function assertMeasurement(snapshot, r) {
  const m = r.replay.windows.measurement;
  for (const [name, key, unit] of [['TTFT', 'ttft', ' ms'], ['TPOT', 'tpot', ' ms/token'], ['E2E', 'endToEnd', ' ms']]) {
    for (const [label, field] of [['均值', 'mean'], ['P50', 'p50'], ['P99', 'p99']]) {
      expect(snapshot.metrics[`${name}(${label})`]).toBe(valueText(m.latency[key][field], 3, unit));
    }
    expect(snapshot.metrics[`${name}(样本数)`]).toBe(String(m.latency[key].count));
  }
  expect(snapshot.metrics['到达 QPS']).toBe(valueText(m.arrivalQps, 3, ' 请求/秒'));
  expect(snapshot.metrics['完成 QPS']).toBe(valueText(m.completionQps, 3, ' 请求/秒'));
  expect(snapshot.metrics['Token 命中率']).toBe(valueText(m.cache.hitRate == null ? null : m.cache.hitRate * 100, 2, '%'));
  expect(snapshot.metrics['命中 token 数']).toBe(String(m.cache.hitL1Tokens + m.cache.hitL2Tokens + m.cache.hitL3Tokens));
  expect(snapshot.metrics['未命中 token 数']).toBe(String(m.cache.missTokens));
  expect(snapshot.metrics['输入 token 数']).toBe(String(m.cache.inputTokens));
  for (const [label, key] of [['计划请求', 'planned'], ['到达请求', 'arrived'], ['完成请求', 'successful'], ['失败请求', 'failed'], ['取消请求', 'cancelled'], ['未完成请求', 'unfinished'], ['已到达未完成', 'arrivedUnfinished'], ['待到达', 'pendingArrival'], ['等待前置触发', 'waitingAnchor']]) {
    expect(snapshot.metrics[`${label}(全程)`]).toBe(String(r.replay.counts[key]));
  }
  const compare = snapshot.charts.chartStrategyGantt.series;
  for (const [label, key] of [['P50', 'p50'], ['P99', 'p99']]) {
    const v = m.latency.endToEnd[key];
    expect(compare.find(s => s.name === `${label}延迟(ms)`).data).toEqual([v == null ? null : +v.toFixed(3)]);
  }
  const hit = m.cache.hitRate;
  expect(compare.find(s => s.name === 'Token命中率(measurement,%)').data).toEqual([hit == null ? null : +(hit * 100).toFixed(2)]);
  expect(snapshot.formulas.formulaStrategySim).toContain('measurement');
  expect(snapshot.formulas.formulaStrategyTier).toContain('全程');
  expect(Object.keys(snapshot.metrics)).not.toContain('命中率(实测/输入)');
  const bandwidth = snapshot.charts.chartStrategyBwReq;
  expect(bandwidth.xAxis[0].data).toEqual([r.name]);
  for (const [name, key] of [['L2 P99', 'l2BWp99'], ['L2 峰值', 'l2BWPeak'], ['L3 P99', 'l3BWp99'], ['L3 峰值', 'l3BWPeak']]) {
    expect(bandwidth.series.find(series => series.name === name).data).toEqual([r.ptSamples ? +(r[key] / 1e9).toFixed(2) : null]);
  }
  expect(bandwidth.series.find(series => series.name === 'L3 配置').data).toEqual([r.replay.configuration.execution.ssdBW]);
  const resident = snapshot.charts.chartStrategyResident;
  expect(resident.series.map(series => series.data)).toEqual([r.l2Series, r.l3Series]);
  expect(resident.series.map(series => series.data.at(-1)[0])).toEqual([r.simEnd, r.simEnd]);
  expect(r.seriesCoverage.resident).toMatchObject({ start: 0, end: r.simEnd, sampling: 'time-weighted-full-window-buckets' });
  expect(snapshot.formulas.formulaStrategyTier).toContain('不能视为全程所需带宽');
  expect(JSON.stringify(snapshot)).not.toMatch(/NaN|Infinity|undefined/);
}

function assertConcurrency(snapshot, r) {
  const chart = snapshot.charts.chartBatchOcc;
  expect(chart.xAxis[0].min).toBe(0);
  expect(chart.xAxis[0].max).toBe(r.simEnd);
  expect(chart.series.map(s => s.data)).toEqual([1, 2, 3].map(i => r.concTimeline.map(p => [p[0], p[i]])));
  expect(chart.series.every(s => s.step === 'end')).toBe(true);
  for (const key of ['formulaBatchOcc', 'formulaGantt']) {
    expect(snapshot.formulas[key]).toContain('来源：Replay');
    expect(snapshot.formulas[key]).toContain('全程');
    expect(snapshot.formulas[key]).toContain(`T=${r.replay.configuration.durationSeconds.toFixed(3)}s`);
    expect(snapshot.formulas[key]).toContain(`W=${r.replay.configuration.warmupSeconds.toFixed(3)}s`);
    expect(snapshot.formulas[key]).toContain(`D=${(r.replay.configuration.hardCutoff - r.replay.configuration.durationSeconds).toFixed(3)}s`);
  }
  expect(snapshot.formulas.formulaBatchOcc).toContain('10ms');
}

test.beforeEach(async ({}, info) => {
  test.skip(info.project.name !== 'development', 'V3 direct module injection; shared synthetic/Replay entry regressions cover both builds.');
});

test('V3: measurement values, units and counts do not come from top-level synthetic metrics', async ({ page }) => {
  const observed = await start(page);
  const job = structuredClone(visualizationCases.prefix);
  job.overrides.replay.options.durationSeconds = 1;
  job.overrides.replay.bundle.sessions[0].req.forEach(req => { req.out = 4; });
  const r = execute(job);
  expect(r.replay.windows.measurement.latency.tpot.count).toBeGreaterThan(0);
  r.avgTtft = r.avgTpot = r.p50 = r.p99 = 999999;
  r.hbmHitRate = 99.99;
  await inject(page, r, job);
  const snapshot = await capture(page);
  assertMeasurement(snapshot, r);
  assertConcurrency(snapshot, r);
  expect(snapshot.metrics['输出吞吐(全程)']).toBe(valueText(r.throughput, 3, ' tok/s'));
  expect(snapshot.metrics['显存利用率峰值(全程)']).toBe(valueText(r.memUtilPeak, 1, '%'));
  expect(snapshot.charts.chartStrategyPt.series.find(s => s.name === 'HBM读').data).toEqual([null, +r.ptBreakdown.hbm.toFixed(1)]);
  for (const id of ['chartStrategyBwReq', 'chartStrategyResident']) await expect(page.locator('#' + id)).not.toContainText('不适用');
  for (const id of ['chartBatching', 'chartPrefix', 'chartEviction']) await expect(page.locator('#' + id)).toContainText('不适用：此理论估算依赖合成负载假设');
  expect(observed).toEqual({ errors: [], posts: [] });
});

for (const name of ['manySuccessful', 'manyUnfinished']) {
  test(`V3: ${name} exposes all 400 real arrivals through 100-row pages without changing metrics`, async ({ page }) => {
    const observed = await start(page), r = result(name);
    await inject(page, r, visualizationCases[name]);
    const before = await capture(page), ids = [];
    for (let index = 0; index < 4; index++) {
      const current = await capture(page), gantt = current.charts.chartGantt;
      expect(gantt.yAxis[0].data).toHaveLength(100);
      expect(current.page).toContain(`${index * 100 + 1}–${(index + 1) * 100} / 400`);
      expect(current.metrics).toEqual(before.metrics);
      const rowIds = gantt.yAxis[0].data.map(label => Number(label.match(/^Req #(\d+)/)[1]));
      ids.push(...rowIds);
      for (const s of gantt.series) for (const item of s.data) {
        const d = Array.isArray(item) ? item : item.value;
        expect(d[0]).toBeGreaterThanOrEqual(0);
        expect(d[0]).toBeLessThan(100);
        expect(d[2]).toBeGreaterThan(d[1]);
        expect(d[2]).toBeLessThanOrEqual(r.simEnd);
      }
      expect(gantt.series.some(s => s.data.length)).toBe(true);
      if (index < 3) await page.locator('#ganttNext').click();
    }
    expect(ids).toEqual(Array.from({ length: 400 }, (_, i) => i));
    await expect(page.locator('#ganttNext')).toBeDisabled();
    await page.locator('#ganttPrev').click();
    await expect(page.locator('#ganttPageStatus')).toContainText('201–300 / 400');
    expect(await page.evaluate(async () => (await import('/src/ui/state.js')).state.simResults[0])).toEqual(r);
    assertMeasurement(before, r);
    assertConcurrency(before, r);
    expect(observed).toEqual({ errors: [], posts: [] });
  });
}

test('V3: failed and cutoff records retain sparse IDs and never invent cancelled or future rows', async ({ page }) => {
  const observed = await start(page), mixed = result('mixed');
  await inject(page, mixed, visualizationCases.mixed);
  let snapshot = await capture(page);
  expect(snapshot.charts.chartGantt.yAxis[0].data).toEqual(['Req #0 · 失败', 'Req #2 · 成功']);
  const failed = mixed.incomplete[0];
  expect(snapshot.charts.chartGantt.series.find(s => s.name === '失败').data).toEqual([[0, failed.failedAt, failed.failedAt]]);
  expect(failed.reason).toBe('infeasible');
  expect(failed.failedAt).toBe(failed.arrive);
  expect(snapshot.charts.chartGantt.series.find(s => s.name === 'Queue(等槽位/显存)').data.filter(d => (d.value || d)[0] === 0))
    .toEqual([]);
  expect(snapshot.charts.chartGantt.series.filter(s => ['Wait(等算力)', 'Prefill', 'Decode'].includes(s.name))
    .flatMap(s => s.data).every(d => (d.value || d)[0] !== 0)).toBe(true);
  expect(snapshot.tooltips.some(text => text.includes('infeasible'))).toBe(true);
  assertMeasurement(snapshot, mixed);
  const cutoff = result('cutoff');
  await inject(page, cutoff, visualizationCases.cutoff);
  snapshot = await capture(page);
  expect(snapshot.charts.chartGantt.yAxis[0].data).toHaveLength(1);
  expect(snapshot.charts.chartGantt.yAxis[0].data[0]).toContain('Req #0');
  expect(snapshot.tooltips.some(text => text.includes('截止未完成'))).toBe(true);
  expect(snapshot.formulas.formulaGantt).toContain('硬截止截断');
  expect(snapshot.formulas.formulaGantt).not.toContain('排水估计');
  expect(snapshot.charts.chartGantt.series.flatMap(s => s.data).some(d => !Array.isArray(d) && d.value[2] === cutoff.simEnd)).toBe(true);
  assertMeasurement(snapshot, cutoff);
  expect(observed).toEqual({ errors: [], posts: [] });
});

test('V3: empty and warmup-only windows leave latency and cache gaps instead of zero samples', async ({ page }) => {
  const observed = await start(page);
  const warmup = structuredClone(visualizationCases.prefix);
  warmup.overrides.replay.options.warmupSeconds = 0.19;
  const warmupResult = execute(warmup);
  expect(warmupResult.replay.counts.successful).toBeGreaterThan(0);
  for (const r of [result('zero'), result('futureOnly'), warmupResult]) {
    await inject(page, r);
    const snapshot = await capture(page);
    assertMeasurement(snapshot, r);
    assertConcurrency(snapshot, r);
    expect(snapshot.metrics['TTFT(均值)']).toBe('无样本');
    expect(snapshot.metrics['TPOT(均值)']).toBe('无样本');
    expect(snapshot.charts.chartStrategyGantt.series.find(s => s.name === 'P50延迟(ms)').data).toEqual([null]);
    if (!r.replay.counts.arrived) {
      expect(snapshot.charts.chartGantt.series.every(s => !s.data.length)).toBe(true);
      expect(snapshot.charts.chartStrategyPt.series.every(s => s.data.every(v => v === null))).toBe(true);
      await expect(page.locator('#ganttPrev')).toBeDisabled();
      await expect(page.locator('#ganttNext')).toBeDisabled();
    }
  }
  expect(observed).toEqual({ errors: [], posts: [] });
});

test('V3: full concurrency retains the second half beyond 20000 points and idle boundaries', async ({ page }) => {
  const observed = await start(page);
  for (const name of ['longActive', 'idle']) {
    const r = result(name);
    await inject(page, r, visualizationCases[name]);
    const snapshot = await capture(page);
    assertConcurrency(snapshot, r);
    if (name === 'longActive') {
      const decode = snapshot.charts.chartBatchOcc.series[0].data;
      expect(decode.length).toBeGreaterThan(20000);
      expect(decode.some(p => p[0] > 201 && p[1] > 0)).toBe(true);
      expect(decode.at(-1)[0]).toBe(r.simEnd);
    }
  }
  expect(observed).toEqual({ errors: [], posts: [] });
});

test('V3: explicit stage records clip failures, handle object tooltips and escape external labels', async ({ page }) => {
  const observed = await start(page), r = result('mixed');
  r.name = '<img src=x onerror=alert(1)>';
  r.simEnd = 10;
  r.timeline = [{ id: 900, arrive: 1, admitTime: 2, prefillStart: 3, prefillEnd: 4, completeTime: 5, state: 'done' }];
  r.incomplete = [
    { id: 20, arrive: 1, admitTime: 2, prefillStart: 3, prefillEnd: 4, completeTime: null, state: 'failed', failedAt: 6, reason: '<img src=x onerror=alert(2)>' },
    { id: 1000, arrive: 7, admitTime: 8, prefillStart: null, prefillEnd: null, completeTime: null, state: 'prefillQ' },
    { id: 2000, arrive: 9, admitTime: null, prefillStart: null, prefillEnd: null, completeTime: null, state: 'failed', failedAt: 9, reason: 'instant' },
  ];
  r.replay.counts = { ...r.replay.counts, arrived: 4, successful: 1, failed: 2, arrivedUnfinished: 1 };
  await inject(page, r);
  const snapshot = await capture(page), gantt = snapshot.charts.chartGantt;
  expect(gantt.yAxis[0].data).toEqual(['Req #20 · 失败', 'Req #900 · 成功', 'Req #1000 · 截止未完成 (prefillQ)', 'Req #2000 · 失败']);
  expect(gantt.series.find(s => s.name === '失败').data).toEqual([[0, 6, 6], [3, 9, 9]]);
  expect(gantt.series.filter(s => s.type === 'custom').flatMap(s => s.data).every(d => (d.value || d)[0] !== 3)).toBe(true);
  const decode = gantt.series.find(s => s.name === 'Decode').data;
  expect(decode).toEqual([{ value: [0, 4, 6], itemStyle: { opacity: 0.35 } }, [1, 4, 5]]);
  const wait = gantt.series.find(s => s.name === 'Wait(等算力)').data;
  expect(wait.at(-1)).toEqual({ value: [2, 8, 10], itemStyle: { opacity: 0.35 } });
  expect(gantt.series.find(s => s.name === 'Prefill').data.every(d => (d.value || d)[0] !== 2)).toBe(true);
  expect(snapshot.tooltips.some(t => t.includes('&lt;img'))).toBe(true);
  expect(snapshot.tooltips.every(t => !t.includes('<img'))).toBe(true);
  expect(await page.locator('#strategyMetricsGrid img, #formulaGantt img').count()).toBe(0);
  expect(observed).toEqual({ errors: [], posts: [] });
});

test('V3: redraws, hidden tabs, page changes and returning to synthetic replace instances without running', async ({ page }) => {
  const observed = await start(page), r = result('manySuccessful');
  await inject(page, r, visualizationCases.manySuccessful);
  await page.locator('#ganttNext').click();
  const before = await capture(page);
  const check = await page.evaluate(async () => {
    const { state } = await import('/src/ui/state.js');
    const { drawGantt } = await import('/src/ui/charts.js');
    const { showStrategyResults } = await import('/src/ui/simulation.js');
    const count = state.chartRegistry.length;
    const old = ['chartGantt', 'chartBatchOcc', 'chartStrategyGantt', 'chartStrategyPt']
      .map(id => window.echarts.getInstanceByDom(document.getElementById(id)));
    for (let i = 0; i < 3; i++) { showStrategyResults(); drawGantt(); }
    document.getElementById('pQps').value = '9999';
    document.getElementById('sName').value = 'edited-not-run';
    return { stable: state.chartRegistry.length === count, live: state.chartRegistry.every(c => !c.isDisposed()), oldDisposed: old.every(c => c.isDisposed()) };
  });
  expect(check).toEqual({ stable: true, live: true, oldDisposed: true });
  await page.locator('.nav-item[data-tab="tab-params"]').click();
  await page.locator('.nav-item[data-tab="tab-schedule"]').click();
  expect(await capture(page)).toEqual(before);
  const job = visualizationCases.prefix;
  const synthetic = runSimulation(job.params, job.strategy, undefined, job.mode);
  await inject(page, synthetic, job);
  const after = await capture(page);
  expect(after.metrics['TTFT(均值)']).toBe(`${synthetic.avgTtft.toFixed(0)} ms`);
  expect(after.charts.chartStrategyGantt.series.find(s => s.name === 'P50延迟(ms)').data).toEqual([+synthetic.p50.toFixed(0)]);
  expect(after.charts.chartStrategyBwReq).not.toBeNull();
  expect(after.charts.chartStrategyResident).not.toBeNull();
  await expect(page.locator('#ganttPagination')).toBeHidden();
  expect(await page.evaluate(() => document.getElementById('ganttNext').onclick)).toBeNull();
  expect(observed).toEqual({ errors: [], posts: [] });
});
