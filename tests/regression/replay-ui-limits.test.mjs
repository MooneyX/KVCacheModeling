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

test('V5: analysis capabilities follow edited mode, never the saved result source', () => {
  for (const result of [null, { name: 'synthetic' }, { name: 'replay', replay: {} }]) {
    state.simResults = result ? [result] : [];
    state.simInput = result ? { workloadSource: result.replay ? 'replay' : 'synthetic' } : null;
    state.simCache = { retained: { value: 1 } };
    for (const source of ['replay', 'synthetic', 'replay']) {
      state.workloadSource = source;
      const before = structuredClone(state);
      updateRunControls();
      for (const handler of ['runAllStrategies', 'runSensitivity', 'runCrossAnalysis']) {
        assert.equal(runButton(handler).disabled, source === 'replay');
        if (source === 'replay') assert.match(runButton(handler).title, /Replay.*不支持/);
      }
      for (const id of ['sensitivityStatus', 'crossStatus']) {
        assert.equal(allowSyntheticAnalysis(id), source === 'synthetic');
        assert.equal(element(id).hidden, source === 'synthetic');
        if (source === 'replay') assert.match(element(id).textContent, /运行当前策略/);
      }
      assert.deepEqual(state, before);
    }
  }
});

test('V5: run-control refresh preserves independent busy flags and never unlocks Replay analysis on settlement', () => {
  state.simRunning = state.sensitivityRunning = state.crossRunning = true;
  for (const source of ['synthetic', 'replay', 'synthetic']) {
    state.workloadSource = source;
    updateRunControls();
    for (const handler of ['applyStrategies', 'runAllStrategies', 'runSensitivity', 'runCrossAnalysis']) assert.equal(runButton(handler).disabled, true);
    assert.equal(element('workloadSource').disabled, true);
  }
  state.workloadSource = 'replay';
  state.simRunning = state.sensitivityRunning = state.crossRunning = false;
  updateRunControls();
  assert.equal(element('workloadSource').disabled, false);
  for (const handler of ['runAllStrategies', 'runSensitivity', 'runCrossAnalysis']) assert.equal(runButton(handler).disabled, true);
  state.workloadSource = 'synthetic';
  updateRunControls();
  for (const handler of ['applyStrategies', 'runAllStrategies', 'runSensitivity', 'runCrossAnalysis']) assert.equal(runButton(handler).disabled, false);
});

test('V5: legacy exports use saved Replay provenance and guard direct HTML/image handlers without touching snapshots', () => {
  state.sensExportState = structuredClone(reportState);
  state.sensSnapshots = [state.sensExportState];
  setSensExportEnabled(true);
  const titles = exportIds.map(id => element(id).title);
  state.simResults = [{ replay: {} }];
  for (const source of ['replay', 'synthetic']) {
    state.workloadSource = source;
    const before = structuredClone(state);
    refreshSensExportControls();
    for (const id of exportIds) assert.equal(element(id).disabled, true);
    assert.equal(element('sensExportRestriction').hidden, false);
    assert.match(element('sensExportRestriction').textContent, /下载完整结果 JSON/);
    assert.throws(() => buildSensHtml(), /Replay.*JSON/);
    exportSensHtml();
    exportSensImage('png');
    exportSensImage('jpeg');
    assert.match(element('sensExportNote').textContent, /Replay.*JSON/);
    assert.deepEqual(state, before);
  }
  state.simResults = [{ name: 'synthetic' }];
  state.workloadSource = 'replay';
  refreshSensExportControls();
  assert.equal(element('sensExportRestriction').hidden, true);
  assert.equal(element('sensExportNote').textContent, '');
  for (const id of exportIds) assert.equal(element(id).disabled, false);
  assert.deepEqual(exportIds.map(id => element(id).title), titles);
  assert.equal(buildSensHtml(), renderSensHtml(state.sensExportState));
});

test('V5: publishing a synthetic result does not re-enable exports from a failed or unfinished scan', () => {
  state.sensExportState = structuredClone(reportState);
  state.simResults = [{ replay: {} }];
  setSensExportEnabled(true);
  setSensExportEnabled(false);
  state.simResults = [{ name: 'synthetic' }];
  refreshSensExportControls();
  for (const id of exportIds) assert.equal(element(id).disabled, true);
  setSensExportEnabled(true);
  for (const id of exportIds) assert.equal(element(id).disabled, false);
});
