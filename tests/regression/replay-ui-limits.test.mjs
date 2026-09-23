import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { state } from '../../src/ui/state.js';
import { allowSyntheticAnalysis, updateRunControls } from '../../src/ui/replay.js';
import { buildSensHtml, exportSensHtml, exportSensImage, refreshSensExportControls, setSensExportEnabled } from '../../src/ui/export.js';
import { renderSensHtml } from '../../src/reports/html.js';
import { reportState } from '../fixtures/scenarios.mjs';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const initialState = structuredClone(state);
const exportIds = ['btnSensExportPng', 'btnSensExportJpg', 'btnSensExportHtml'];
let dom;
const element = id => document.getElementById(id);
const runButton = handler => document.querySelector(`button[onclick="${handler}()"]`);

beforeEach(() => {
  dom = new JSDOM(html);
  globalThis.document = dom.window.document;
  Object.assign(state, structuredClone(initialState));
  setSensExportEnabled(false);
});
afterEach(() => {
  setSensExportEnabled(false);
  Object.assign(state, structuredClone(initialState));
  dom.window.close();
  delete globalThis.document;
});

test('U5: ready Replay enables analysis independently of old results and rejects only synthetic dimensions', async () => {
  const replay = await import('../../src/ui/replay.js?u5-ready-capabilities');
  const { buildSweepJob, REPLAY_SWEEP_PARAMETERS } = await import('../../src/application/sweep.js');
  state.workloadSource = 'replay';
  replay.updateRunControls();
  for (const handler of ['runAllStrategies', 'runSensitivity', 'runCrossAnalysis']) assert.equal(runButton(handler).disabled, true);
  for (const id of ['sensitivityStatus', 'crossStatus']) {
    assert.equal(replay.allowSyntheticAnalysis(id), false);
    assert.match(element(id).textContent, /请选择|请先选择/);
  }
  const bytes = readFileSync(new URL('../../data/replay/sample.json', import.meta.url));
  const ready = new Promise((resolve, reject) => replay.initReplay(() => {
    if (replay.replaySelection().digest) resolve();
    else if (element('replayStatus').textContent.startsWith('读取失败')) reject(new Error(element('replayStatus').textContent));
  }));
  Object.defineProperty(element('replayFile'), 'files', { configurable: true, value: [{ name: 'sample.json', size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }] });
  element('replayFile').dispatchEvent(new dom.window.Event('change'));
  await ready;
  for (const result of [null, { name: 'synthetic' }, { name: 'replay', replay: {} }]) {
    state.simResults = result ? [result] : [];
    state.simInput = result ? { workloadSource: result.replay ? 'replay' : 'synthetic' } : null;
    state.simCache = { retained: { value: 1 } };
    for (const source of ['replay', 'synthetic', 'replay']) {
      state.workloadSource = source;
      const before = structuredClone(state);
      replay.updateRunControls();
      for (const handler of ['runAllStrategies', 'runSensitivity', 'runCrossAnalysis']) {
        assert.equal(runButton(handler).disabled, false);
        if (source === 'replay') assert.match(runButton(handler).title, /支持目标 QPS/);
      }
      for (const id of ['sensitivityStatus', 'crossStatus']) {
        assert.equal(replay.allowSyntheticAnalysis(id), true);
        assert.equal(element(id).hidden, true);
        assert.equal(element(id).textContent, '');
      }
      for (const id of ['sSweepParam', 'sSweepCompareParam', 'sShapeDim']) {
        for (const option of element(id).options) assert.equal(option.disabled,
          source === 'replay' && !!option.value && !REPLAY_SWEEP_PARAMETERS.includes(option.value));
      }
      assert.deepEqual(state, before);
    }
  }
  state.strategyMode = 'js';
  replay.updateRunControls();
  for (const handler of ['runAllStrategies', 'runSensitivity', 'runCrossAnalysis']) assert.equal(runButton(handler).disabled, true);
  assert.equal(replay.allowSyntheticAnalysis('sensitivityStatus'), false);
  assert.match(element('sensitivityStatus').textContent, /DSL/);
  state.strategyMode = 'dsl';
  assert.equal(replay.allowSyntheticAnalysis('sensitivityStatus'), true);
  assert.equal(element('sensitivityStatus').hidden, true);
  const base = { params: { blockSize: 64 }, strategy: { prefetch: { type: 'none' }, batching: { max_batch_size: 8 }, eviction: { hbm_evict_threshold: .8 } }, mode: 'dsl',
    overrides: { qps: 1, seed: 0, simMaxTime: 1, replay: { bundle: JSON.parse(bytes.toString()), options: { durationSeconds: 1, warmupSeconds: 0, arrivalModel: 'closed', superblocks: false } } } };
  const before = structuredClone(base);
  const job = buildSweepJob(base, [['qps', 3], ['ssd_bw', 100], ['max_batch_size', 4], ['evict_threshold', 50], ['gpu_preset', 'h20x8'], ['prefetch', 'timeout']]);
  assert.equal(job.overrides.qps, 3);
  assert.equal(job.overrides.ssdBW, 100);
  assert.equal(job.overrides.hwPreset, 'h20x8');
  assert.equal(job.strategy.batching.max_batch_size, 4);
  assert.equal(job.strategy.eviction.hbm_evict_threshold, .5);
  assert.equal(job.strategy.prefetch.type, 'timeout');
  assert.notEqual(job.overrides.replay.bundle, base.overrides.replay.bundle);
  job.overrides.replay.options.durationSeconds = 2;
  assert.deepEqual(base, before);
  for (const key of ['input_len', 'prefix_hit', 'prefix_warm_l2', 'concurrency', 'nreq']) assert.throws(() => buildSweepJob(base, [[key, 8]]), /Replay.*合成生成维度/);
  assert.deepEqual(base, before);
});

test('U5: run-control refresh preserves independent busy flags and bundle readiness after settlement', () => {
  state.simRunning = state.sensitivityRunning = state.crossRunning = true;
  for (const source of ['synthetic', 'replay', 'synthetic']) {
    state.workloadSource = source;
    updateRunControls();
    for (const handler of ['applyStrategies', 'runAllStrategies', 'runSensitivity', 'runCrossAnalysis']) assert.equal(runButton(handler).disabled, true);
    for (const id of ['workloadSource', 'replayFile', 'replayQps', 'replaySeed', 'replayDuration', 'replayWarmup', 'replayDrain']) assert.equal(element(id).disabled, true);
  }
  state.workloadSource = 'replay';
  state.simRunning = state.sensitivityRunning = state.crossRunning = false;
  updateRunControls();
  assert.equal(element('workloadSource').disabled, false);
  for (const handler of ['runAllStrategies', 'runSensitivity', 'runCrossAnalysis']) assert.equal(runButton(handler).disabled, true);
  assert.equal(allowSyntheticAnalysis('crossStatus'), false);
  assert.match(element('crossStatus').textContent, /bundle/);
  state.workloadSource = 'synthetic';
  updateRunControls();
  assert.equal(allowSyntheticAnalysis('crossStatus'), true);
  assert.equal(element('crossStatus').hidden, true);
  for (const handler of ['applyStrategies', 'runAllStrategies', 'runSensitivity', 'runCrossAnalysis']) assert.equal(runButton(handler).disabled, false);
  for (const flag of ['simRunning', 'sensitivityRunning', 'crossRunning']) {
    state[flag] = true;
    const before = structuredClone(state);
    updateRunControls();
    assert.equal(element('workloadSource').disabled, true);
    assert.equal(runButton('applyStrategies').disabled, flag === 'simRunning');
    assert.equal(runButton('runAllStrategies').disabled, flag === 'simRunning');
    assert.equal(runButton('runSensitivity').disabled, flag === 'sensitivityRunning');
    assert.equal(runButton('runCrossAnalysis').disabled, flag === 'crossRunning');
    assert.deepEqual(state, before);
    state[flag] = false;
  }
});

test('U5: exports use the selected snapshot rather than edited inputs or the latest simulation source', () => {
  const synthetic = structuredClone(reportState);
  state.sensExportState = synthetic;
  state.sensSnapshots = [synthetic];
  setSensExportEnabled(true);
  const titles = exportIds.map(id => element(id).title);
  state.simResults = [{ replay: {} }];
  for (const source of ['replay', 'synthetic']) {
    state.workloadSource = source;
    const before = structuredClone(state);
    refreshSensExportControls();
    for (const id of exportIds) assert.equal(element(id).disabled, false);
    assert.equal(element('sensExportRestriction').hidden, true);
    assert.equal(buildSensHtml(), renderSensHtml(synthetic));
    assert.deepEqual(state, before);
  }
  state.sensExportState = { ...structuredClone(reportState), workload: { source: 'replay' } };
  state.simResults = [{ name: 'synthetic' }];
  for (const source of ['synthetic', 'replay']) {
    state.workloadSource = source;
    const before = structuredClone(state);
    refreshSensExportControls();
    for (const id of exportIds) assert.equal(element(id).disabled, true);
    assert.equal(element('sensExportRestriction').hidden, false);
    assert.match(element('sensExportRestriction').textContent, /完整结果 JSON/);
    assert.throws(() => buildSensHtml(), /Replay.*JSON/);
    assert.equal(buildSensHtml([synthetic]), renderSensHtml(synthetic, [synthetic]));
    exportSensHtml();
    exportSensImage('png');
    exportSensImage('jpeg');
    assert.match(element('sensExportNote').textContent, /Replay.*JSON/);
    assert.deepEqual(state, before);
  }
  state.sensExportState = synthetic;
  refreshSensExportControls();
  for (const id of exportIds) assert.equal(element(id).disabled, false);
  assert.deepEqual(exportIds.map(id => element(id).title), titles);
});

test('U5: complete Replay snapshots export without bypassing scan readiness or losing truncation state', () => {
  const workload = { source: 'replay', bundleSummary: { digest: 'a'.repeat(64) },
    configuration: { seed: 7 }, windows: { measurement: { start: 1, end: 2 } },
    state: { truncated: true, terminationReason: 'hard_cutoff' }, versions: { workloadModel: 'u5' } };
  state.sensExportState = { ...structuredClone(reportState), workload };
  setSensExportEnabled(true);
  for (const source of ['synthetic', 'replay']) {
    state.workloadSource = source;
    state.simResults = source === 'synthetic' ? [{ replay: {} }] : [{ name: 'synthetic' }];
    const before = structuredClone(state);
    refreshSensExportControls();
    for (const id of exportIds) assert.equal(element(id).disabled, false);
    assert.equal(element('sensExportRestriction').hidden, true);
    assert.match(buildSensHtml(), /hard_cutoff/);
    assert.match(buildSensHtml(), /截断/);
    assert.deepEqual(state, before);
  }
  setSensExportEnabled(false);
  state.simResults = [{ name: 'synthetic' }];
  refreshSensExportControls();
  for (const id of exportIds) assert.equal(element(id).disabled, true);
  setSensExportEnabled(true);
  for (const id of exportIds) assert.equal(element(id).disabled, false);
});
