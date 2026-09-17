import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderSensHtml } from '../../src/reports/html.js';
import { reportState } from '../fixtures/scenarios.mjs';
import { loadLegacy } from '../fixtures/legacy-loader.mjs';

test('exported report HTML matches the frozen output byte for byte', () => {
  assert.equal(renderSensHtml(reportState), readFileSync(new URL('../fixtures/report-baseline.html', import.meta.url), 'utf8'));
});

test('multiple report snapshots preserve the existing output and escaping', () => {
  const second = { ...reportState, strategyName: 'test </script> & "quotes"', _cacheKey: 'second', points: [{ params: { ssd_bw: 50 }, rec: { ttft: 8 } }] };
  const legacy = loadLegacy();
  try {
    legacy.setReportState(reportState);
    assert.equal(renderSensHtml(reportState, [reportState, second]), legacy.buildSensHtml([reportState, second]));
  } finally { legacy.close(); }
});
