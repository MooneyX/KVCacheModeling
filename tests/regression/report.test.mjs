import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { renderSensHtml, reportPointKey, reportSnapshotContext, reportExportRestriction } from '../../src/reports/html.js';
import { buildSensHtml } from '../../src/ui/export.js';
import { state } from '../../src/ui/state.js';
import { TTFT_STACK_PARTS } from '../../src/application/labels.js';
import { reportState } from '../fixtures/scenarios.mjs';
import { loadLegacy } from '../fixtures/legacy-loader.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const jsonValue = value => JSON.parse(JSON.stringify(value));
const exportedValue = (html, name) => JSON.parse(html.match(new RegExp(`var ${name} = ([^\\n]+);`))[1]);

function replaySnapshot() {
  const workload = { source: 'replay', bundle: { version: 1, digest: 'a'.repeat(64) },
    configuration: { source: 'replay', seed: 7, workloadModelVersion: 'u5', execution: { qps: 2, gpuCount: 1 }, strategy: { dsl: 'ADMIT: always' } },
    windows: { full: { start: 0, end: 3, durationSeconds: 3 }, measurement: { start: 1, end: 2, durationSeconds: 1 } },
    state: { truncated: false, terminationReason: 'source_drained' }, counts: { failed: 0 },
    versions: { workloadModel: 'u5' }, eligibleForComparison: true };
  const recs = [12, 8].map(ttft => ({ ttft, throughput: 100, measurement_ttft: ttft / 2,
    measurement_completion_qps: 1, workload: structuredClone(workload) }));
  return { ...structuredClone(reportState), workloadSource: 'replay', engineVersion: 'engine-u5',
    workload: { source: 'replay', bundleSummary: { name: 'same-name.json', digest: 'a'.repeat(64) },
      options: { qps: 2, seed: 7, durationSeconds: 2, warmupSeconds: 1, simMaxTime: 1, arrivalModel: 'closed', superblocks: false } },
    configuration: { seed: 0, qps: 2 }, seed: 7, dsl: 'ADMIT: always',
    lineTpl: [{ name: 'WC', type: 'line' }], curveRecs: [recs],
    points: recs.map((rec, i) => ({ params: { ssd_bw: [10, 50][i] }, rec })) };
}

function openReport(snapshot, snapshots) {
  const html = renderSensHtml(snapshot, snapshots);
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const scripts = dom.window.document.querySelectorAll('script:not([src])');
  assert.equal(scripts.length, 1);
  dom.window.eval(scripts[0].textContent);
  return { html, dom, view: dom.window };
}

test('exported report HTML matches the frozen output byte for byte', () => {
  assert.equal(renderSensHtml(reportState), readFileSync(new URL('../fixtures/report-baseline.html', import.meta.url), 'utf8'));
});

test('U5: frozen legacy single and multi outputs remain pinned while new reports preserve scalar data and escaping', () => {
  const second = { ...reportState, strategyName: 'test </script> & "quotes"', _cacheKey: 'second', points: [{ params: { ssd_bw: 50 }, rec: { ttft: 8 } }] };
  const legacy = loadLegacy();
  try {
    legacy.setReportState(reportState);
    assert.equal(digest(legacy.buildSensHtml()), '6168736d5f6d9185a0fcd71c3b30184a40fd53a61216c8e488f1b146be480419');
    const oldHtml = legacy.buildSensHtml([reportState, second]);
    assert.equal(digest(oldHtml), 'b45062705dac26a961f910335d22ed0e5d9318371e5facf5479a208e59be4576');
    const html = renderSensHtml(reportState, [reportState, second]);
    for (const key of ['OPT', 'METRIC_DATA', 'METRIC_LABEL', 'LINE_LABELS', 'STACK_DATA', 'STACK_TOTALS']) {
      assert.deepEqual(exportedValue(html, key), exportedValue(oldHtml, key), key);
    }
    assert.equal(html.match(/<table id="tbl">[\s\S]*?<\/table>/)[0], oldHtml.match(/<table id="tbl">[\s\S]*?<\/table>/)[0]);
    const currentDom = new JSDOM(html), oldDom = new JSDOM(oldHtml);
    try {
      assert.equal(currentDom.window.document.querySelectorAll('script').length, 2);
      assert.equal(currentDom.window.document.querySelector('title').textContent, oldDom.window.document.querySelector('title').textContent);
      assert.equal(exportedValue(html, 'PIVOT_PTS')[0].r.ttft, 8);
      assert.deepEqual(exportedValue(html, 'SNAP_META'), exportedValue(oldHtml, 'SNAP_META'));
    } finally { currentDom.window.close(); oldDom.window.close(); }
  } finally { legacy.close(); }
});

test('U5: report point identity includes bundle, source, full experiment, seed, strategy and versions with canonical key order', () => {
  const snapshot = replaySnapshot();
  const key = reportPointKey(snapshot, snapshot.points[0]);
  const changes = [
    s => { s.workload.bundleSummary.digest = 'b'.repeat(64); },
    s => { s.workload.source = 'synthetic'; s.points[0].rec.workload.source = 'synthetic'; },
    s => { s.paramsJson = JSON.stringify({ pGpuCount: '2' }); },
    s => { s.points[0].rec.workload.configuration.execution.gpuCount = 2; },
    s => { s.points[0].rec.workload.configuration.seed = 8; },
    s => { s.workload.options.warmupSeconds = 0; },
    s => { s.dsl = 'ADMIT: always\nEVICT: fifo'; },
    s => { s.points[0].rec.workload.configuration.strategy.dsl = 'ADMIT: false'; },
    s => { s.engineVersion = 'engine-u6'; },
    s => { s.points[0].rec.workload.versions.workloadModel = 'u6'; },
    s => { s.points[0].rec.workload.windows.measurement.start = 0; },
  ];
  for (const change of changes) {
    const different = structuredClone(snapshot); change(different);
    assert.notEqual(reportPointKey(different, different.points[0]), key, change.toString());
  }
  const ordered = structuredClone(snapshot);
  ordered.points[0].rec.workload.configuration.execution = { gpuCount: 1, qps: 2 };
  assert.equal(reportPointKey(ordered, ordered.points[0]), key);
  ordered.points[0].rec.workload.windows.measurement.latency = { ttft: { mean: 500 } };
  assert.equal(reportPointKey(ordered, ordered.points[0]), key, 'measured latency is not an experiment setting');
  const context = reportSnapshotContext(snapshot, snapshot.points[0]);
  assert.equal(context.configuration.seed, 7);
  assert.equal(context.baselineConfiguration.seed, 0);
});

test('U5: report deduplication retains different same-name bundles and isolates projections and batch selection', () => {
  const first = replaySnapshot(), second = replaySnapshot();
  second.workload.bundleSummary.digest = 'b'.repeat(64);
  second.points.forEach(point => { point.rec.workload.bundle.digest = 'b'.repeat(64); point.rec.measurement_ttft = 99; });
  const before = structuredClone([first, second]);
  const { dom, view } = openReport(first, [first, second, structuredClone(first)]);
  try {
    assert.equal(view.PIVOT_PTS.length, 4);
    assert.deepEqual(jsonValue(view.PIVOT_PTS[0].snapshots), [0, 2]);
    view.PV_ROLE = { x: 'ssd_bw', c: null, s: null };
    const all = view.pvProject();
    assert.equal(all.curves.length, 2); assert.equal(all.n, 4); assert.equal(all.avgN, 0);
    view.PV_SNAPSHOT = 1;
    const onlySecond = view.pvProject();
    assert.equal(onlySecond.n, 2); assert.equal(onlySecond.curves.length, 1);
    assert.equal(view.pvMetricVal(onlySecond.curves[0].recs[0], 'measurement_ttft'), 99);
    view.PV_SNAPSHOT = 2;
    assert.equal(view.pvProject().n, 2, 'deduplicated points remain in their later source batch');
    view.pvSwapParams(1);
    assert.ok(view.document.querySelector('#pWrap').textContent.includes('b'.repeat(64)));
    assert.deepEqual([first, second], before);
  } finally { dom.window.close(); }
});

test('U5: empty measurement records survive single-point export, metric switching and offline tables without zero filling', () => {
  const snapshot = replaySnapshot();
  snapshot.points = snapshot.points.slice(0, 1); snapshot.labels = ['10GB/s'];
  const rec = snapshot.points[0].rec;
  rec.measurement_ttft = null; rec.measurement_completion_qps = 0; rec.measurement_ttft_samples = 0;
  rec.workload.state.truncated = true; rec.workload.eligibleForComparison = false;
  snapshot.curveRecs = [[rec]]; snapshot.opt.series[0].data = [12];
  const { html, dom, view } = openReport(snapshot);
  try {
    assert.equal(view.HAS_PIVOT, false); assert.equal(view.PIVOT_PTS.length, 1);
    assert.equal(view.PIVOT_PTS[0].r.measurement_ttft, null);
    assert.equal(view.PIVOT_PTS[0].r.measurement_ttft_samples, 0);
    assert.equal(view.PIVOT_PTS[0].r.workload.eligibleForComparison, false);
    assert.deepEqual(jsonValue(view.METRIC_DATA.measurement_ttft), [[null]]);
    assert.deepEqual(jsonValue(view.METRIC_DATA.measurement_completion_qps), [[0]]);
    view.applyMetric('measurement_ttft');
    assert.deepEqual(Array.from(view.document.querySelectorAll('#tbl tbody td'), el => el.textContent), ['10GB/s', '—']);
    view.applyMetric('measurement_completion_qps');
    assert.deepEqual(Array.from(view.document.querySelectorAll('#tbl tbody td'), el => el.textContent), ['10GB/s', '0']);
    assert.match(html, /不是独立可复现包/); assert.match(html, /throughput 为全程输出 token\/s/);
    assert.match(html, /TTFT 分解为全程口径/); assert.match(html, /完成 QPS 按完成事件归窗/);
  } finally { dom.window.close(); }
});

test('U5: missing TTFT components never become zero totals in static or pivot reports', () => {
  const snapshot = replaySnapshot();
  snapshot.stackParts = structuredClone(TTFT_STACK_PARTS);
  snapshot.stackLabels = [...snapshot.labels]; snapshot.stackMode = true; snapshot.metric = 'ttft_stack';
  for (const [i, point] of snapshot.points.entries()) {
    for (const part of snapshot.stackParts) point.rec[part.key] = i === 0 ? null : 0;
  }
  const { dom, view } = openReport(snapshot);
  try {
    assert.deepEqual(jsonValue(view.STACK_TOTALS), [null, 0]);
    for (const part of snapshot.stackParts) assert.deepEqual(jsonValue(view.STACK_DATA[part.key]), [null, 0]);
    const rows = view.document.querySelectorAll('#tbl tbody tr');
    assert.equal(rows[0].lastElementChild.textContent, '—'); assert.equal(rows[1].lastElementChild.textContent, '0');
    view.PV_ROLE = { x: 'ssd_bw', c: null, s: null };
    assert.deepEqual(jsonValue(view.pvBuildStack(view.pvProject()).totals), [null, 0]);
  } finally { dom.window.close(); }
});

test('U5: export permission and metadata follow the exported snapshot, independent of current inputs and latest results', () => {
  const saved = { sensExportState: state.sensExportState, workloadSource: state.workloadSource, simResults: state.simResults };
  const snapshot = replaySnapshot();
  const expected = renderSensHtml(snapshot, [snapshot]);
  try {
    for (const source of ['synthetic', 'replay']) {
      state.workloadSource = source; state.simResults = source === 'replay' ? [{}] : [{ replay: {} }];
      state.sensExportState = { ...structuredClone(reportState), workload: { source: 'replay' } };
      assert.match(reportExportRestriction(state.sensExportState), /Replay/);
      assert.throws(() => buildSensHtml(), /Replay/);
      assert.equal(buildSensHtml([snapshot]), expected);
      state.sensExportState = structuredClone(reportState);
      assert.equal(reportExportRestriction(state.sensExportState), '');
      assert.doesNotThrow(() => buildSensHtml());
    }
    snapshot.points[0].rec.workload.state.truncated = true;
    assert.equal(reportExportRestriction(snapshot), '');
    assert.match(renderSensHtml(snapshot), /截断/);
    assert.equal(reportSnapshotContext(snapshot).state.truncated, true);
  } finally { Object.assign(state, saved); }
});
