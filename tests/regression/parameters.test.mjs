import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadLegacy } from '../fixtures/legacy-loader.mjs';
import { paramsFromControls } from '../../src/adapters/node/params.js';
import { baseControls } from '../fixtures/scenarios.mjs';

const cases = [
  {},
  baseControls,
  { ...baseControls, pPrefillA: '0', pPrefillB: '0', pMfu: '', pPrefixWarmL2: '90', pPrefixHit: '40' },
  { pMaxBatch: '64', sDsl: 'ADMIT: always\nBATCH: continuous max(12)\nPREFETCH: race' },
  JSON.parse(readFileSync(new URL('../../data/params_332_report_pipeline.json', import.meta.url), 'utf8')),
];
for (const [index, values] of cases.entries()) {
  test(`CLI control conversion matches initialized page import ${index}`, () => {
    const legacy = loadLegacy();
    try {
      legacy.init();
      legacy.document.getElementById('paramsIo').value = JSON.stringify(values);
      legacy.importParamsFromBox();
      assert.deepEqual(paramsFromControls(values), legacy.getParams());
    } finally { legacy.close(); }
  });
}
