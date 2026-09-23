import test from 'node:test';
import assert from 'node:assert/strict';
import { createLegacyHarness } from '../../src/adapters/node/legacy.js';
import { runWorkloadAcceptance, WORKLOAD_MODEL_VERSION } from '../../src/core/simulation.js';
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
    try {
      for (const seed of [42, 123]) {
        controls.pSeed.value = String(seed);
        const params = modern.getParams();
        assert.deepEqual(params, legacy.getParams());
        const historical = legacy.runSimulation(strategy);
        assert.deepEqual(legacy.runSimulation(strategy), historical);
        const actual = modern.runSimulation(strategy);
        assert.deepEqual(actual, runWorkloadAcceptance(params, strategy));
        assert.equal(actual.configuration.workloadModelVersion, WORKLOAD_MODEL_VERSION);
        assert.equal(actual.configuration.seed, seed);
        assert.equal(actual.configuration.execution.wcArrivalFetch, params.wcArrivalFetch);
        const requests = createTrace(params).requests;
        assert.equal(historical.completed, requests.length); assert.equal(historical.totalReqs, requests.length);
        assert.equal(actual.completed, requests.length); assert.equal(actual.totalReqs, requests.length);
        assert.equal(actual.hitTok.total, requests.reduce((sum, req) => sum + req.inputLen, 0));
        assert.equal(actual.decodeTokensTotal, requests.reduce((sum, req) => sum + req.outputLen, 0));
        assert.deepEqual([...actual.timeline].sort((a, b) => a.id - b.id).map(({ id, arrive }) => ({ id, arrive })),
          [...requests].sort((a, b) => a.id - b.id).map(({ id, arrive }) => ({ id, arrive })));
      }
    } finally { reference.close(); }
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
