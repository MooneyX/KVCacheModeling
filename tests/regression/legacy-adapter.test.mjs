import test from 'node:test';
import assert from 'node:assert/strict';
import { createLegacyHarness } from '../../src/adapters/node/legacy.js';
import { createTrace } from '../../src/application/trace.js';
import { mulberry32 } from '../../src/core/math.js';
import { legacyCode, loadLegacy } from '../fixtures/legacy-loader.mjs';
import { baseControls } from '../fixtures/scenarios.mjs';

for (const checked of [undefined, false]) {
  test(`legacy script parameter defaults and outputs preserve checked=${checked}`, () => {
    const reference = loadLegacy(baseControls);
    const controls = {};
    for (const el of reference.document.querySelectorAll('input[id],select[id],textarea[id]')) {
      controls[el.id] = { value: el.value };
      if (el.type === 'checkbox') controls[el.id].checked = el.checked;
    }
    delete controls.pFetchRepull;
    const readControl = id => controls[id] || (controls[id] = checked === undefined ? { value: '0' } : { value: '0', checked });
    const legacy = new Function('document', 'window', legacyCode + '\nreturn { getParams, runSimulation, parseDSL, strategyPresets };')({ getElementById: readControl, querySelectorAll: () => [], addEventListener() {} }, { addEventListener() {} });
    const modern = createLegacyHarness(readControl);
    assert.deepEqual(modern.getParams(), legacy.getParams());
    const strategy = legacy.parseDSL(legacy.strategyPresets['SGLang-Default']);
    assert.deepEqual(modern.runSimulation(strategy), legacy.runSimulation(strategy));
    controls.pSeed.value = '123';
    assert.deepEqual(modern.runSimulation(strategy), legacy.runSimulation(strategy));
    reference.close();
  });
}

test('trace projection matches the original request-generation block', () => {
  const start = legacyCode.indexOf('  let N = overrides.nreq');
  const end = legacyCode.indexOf('    // S4: 把前缀组表分发给各实例。');
  const generateLegacy = new Function('p', 'overrides', 'rng', 'prefixGroupMap', legacyCode.slice(start, end) + '}\nreturn requests;');
  for (const lenDist of ['uniform', 'fixed', 'lognormal']) {
    const legacy = loadLegacy({ ...baseControls, pLenDist: lenDist });
    try {
      const p = legacy.getParams();
      const expected = generateLegacy(p, {}, mulberry32(p.seed >>> 0), {}).map(r => ({
        id: r.id, arrive: r.arrive, inputLen: r.inputLen, outputLen: r.outputLen,
        groupId: r.groupId, prefixTokLen: r.prefixTokLen, isFounder: r.isFounder,
        followUp: r.followUp, multiTurn: p.multiTurn,
      }));
      assert.deepEqual(createTrace(p), { p, requests: expected });
    } finally { legacy.close(); }
  }
});
