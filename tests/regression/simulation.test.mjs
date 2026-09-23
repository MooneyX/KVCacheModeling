import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runSimulation, runWorkloadAcceptance, WORKLOAD_MODEL_VERSION } from '../../src/core/simulation.js';
import { createSyntheticRuntime } from '../../src/core/requests.js';
import { mulberry32 } from '../../src/core/math.js';
import { readParams } from '../../src/adapters/parameters.js';
import { parseDSL } from '../../src/core/strategy.js';
import { extractSensMetrics } from '../../src/application/metrics.js';
import { loadLegacy } from '../fixtures/legacy-loader.mjs';
import { scenarios, baseControls } from '../fixtures/scenarios.mjs';

const fixtures = JSON.parse(readFileSync(new URL('../fixtures/simulation-baseline.json', import.meta.url), 'utf8'));

for (const fixture of fixtures) {
  test(`U5: legacy fingerprint and unified default full result: ${fixture.name}`, () => {
    const spec = scenarios.find(s => s.name === fixture.name);
    const legacy = loadLegacy({ ...baseControls, ...spec.controls });
    try {
      legacy.setMode(fixture.mode);
      assert.deepEqual(readParams(id => legacy.document.getElementById(id)), fixture.params);
      assert.deepEqual(parseDSL(fixture.strategy.dsl), legacy.parseDSL(fixture.strategy.dsl));
      const before = JSON.stringify(fixture);
      const historical = legacy.runSimulation(fixture.strategy, fixture.overrides);
      assert.equal(createHash('sha256').update(JSON.stringify(historical)).digest('hex'), fixture.hash);
      assert.deepEqual(Object.fromEntries(Object.keys(fixture.summary).map(key => [key, historical[key]])), fixture.summary);
      const historicalMetrics = legacy.extractSensMetrics(historical);
      const adaptedHistorical = extractSensMetrics(historical);
      const expectedHistoricalMetrics = { ...historicalMetrics };
      const breakdown = historical.ttftBreakdown;
      if (!breakdown) {
        for (const key of ['compute_net', 'compute_wait', 'ttft_queue', 'ttft_prefillq', 'ttft_fetch', 'ttft_xfer']) {
          assert.equal(historicalMetrics[key], 0);
          expectedHistoricalMetrics[key] = null;
        }
      }
      if (!(breakdown && breakdown.queue + breakdown.prefillQ + breakdown.fetch + breakdown.compute > 0)) {
        assert.equal(historicalMetrics.fetch_ratio, 0); expectedHistoricalMetrics.fetch_ratio = null;
      }
      if (!(breakdown && breakdown.compute > 0)) {
        assert.equal(historicalMetrics.compute_wait_ratio, 0); expectedHistoricalMetrics.compute_wait_ratio = null;
      }
      assert.deepEqual(Object.fromEntries(Object.keys(historicalMetrics).map(key => [key, adaptedHistorical[key]])), expectedHistoricalMetrics,
        'U5 changes only absent samples/undefined ratios from legacy zero to null');
      const actual = runSimulation(fixture.params, fixture.strategy, fixture.overrides, fixture.mode);
      if (fixture.mode === 'dsl') {
        const expected = runWorkloadAcceptance(fixture.params, fixture.strategy, fixture.overrides);
        assert.deepEqual(actual, expected, 'the production entry must use the accepted physical-page model');
        assert.deepEqual(extractSensMetrics(actual), extractSensMetrics(expected));
      } else {
        assert.deepEqual(runSimulation(fixture.params, fixture.strategy, fixture.overrides, fixture.mode), actual);
      }
      assert.equal(actual.configuration.workloadModelVersion, WORKLOAD_MODEL_VERSION);
      assert.notEqual(actual.configuration.workloadModelVersion, 'legacy-s09');
      assert.equal(actual.configuration.pageLayout.capacity, 'physical-page');
      assert.equal(actual.configuration.capabilities.finiteCapacity, true);
      const counts = actual.workloadCounts;
      assert.equal(counts.arrived, counts.successful + counts.failed + counts.arrivedUnfinished);
      assert.equal(actual.completed, counts.successful);
      assert.equal(actual.hitTok.total, actual.hitTok.l1 + actual.hitTok.l2 + actual.hitTok.l3 + actual.hitTok.miss);
      const p = { ...fixture.params, ...fixture.overrides };
      if (!p.multiTurn && !actual.truncated) {
        const source = createSyntheticRuntime(p, fixture.overrides, mulberry32((fixture.overrides.seed ?? p.seed) >>> 0));
        const requests = source.pendingRequests();
        assert.equal(actual.totalReqs, requests.length);
        assert.equal(actual.completed, requests.length);
        assert.equal(actual.hitTok.total, requests.reduce((sum, req) => sum + req.inputLen, 0));
        const expectedOutputTokens = p.singleBatch ? 0 : requests.reduce((sum, req) => sum + req.outputLen, 0);
        assert.equal(actual.decodeTokensTotal, expectedOutputTokens);
        assert.equal(actual.throughput, expectedOutputTokens / actual.simEnd);
      }
      assert.equal(JSON.stringify(fixture), before, 'inputs must not be mutated');
    } finally {
      legacy.close();
    }
  });
}

test('back-to-back runs do not share state or consume another run RNG', () => {
  const [a, b] = fixtures;
  const first = runSimulation(a.params, a.strategy, a.overrides, a.mode);
  runSimulation(b.params, b.strategy, { ...b.overrides, seed: 9182 }, b.mode);
  assert.deepEqual(runSimulation(a.params, a.strategy, a.overrides, a.mode), first);
});

for (const blockSize of [16, 32, 64, 128]) {
  test(`U5: default B=${blockSize} cold prefill obeys the independent 64ms oracle and physical-page capacity`, () => {
    const base = fixtures[0];
    const params = { ...base.params, inputLen: 64, outputLen: 64, concurrency: 1, qps: 1,
      lenDist: 'fixed', arrivalDist: 'uniform', prefixHit: 0, prefixWarm: false, multiTurn: 0,
      prefillA: 1000, prefillB: 0, prefillBIdx: 0, blockSize };
    const overrides = { seed: 42, simMaxTime: 5 };
    const before = structuredClone({ params, strategy: base.strategy, overrides });
    let summary;
    const accepted = runWorkloadAcceptance(params, base.strategy, overrides, { finish: value => { summary = value; } });
    const actual = runSimulation(params, base.strategy, overrides);
    assert.deepEqual(actual, accepted);
    assert.deepEqual({ params, strategy: base.strategy, overrides }, before);
    assert.equal(actual.completed, 1); assert.equal(actual.totalReqs, 1);
    assert.deepEqual(actual.hitTok, { l1: 0, l2: 0, l3: 0, miss: 64, total: 64 });
    assert.equal(actual.decodeTokensTotal, 64); assert.equal(actual.throughput, 64 / actual.simEnd);
    const row = actual.timeline[0];
    assert.equal(row.admitTime, row.arrive); assert.equal(row.prefillStart, row.arrive);
    assert.ok(Math.abs(row.prefillEnd - row.arrive - 0.064) < 1e-10);
    assert.ok(row.completeTime > row.prefillEnd);
    assert.ok(Math.abs(actual.avgTtft - 64) < 1e-10);
    assert.equal(actual.avgLatency, (row.completeTime - row.arrive) * 1000);
    assert.equal(summary.cache.inputPages, Math.ceil(64 / blockSize));
    assert.equal(summary.cache.outputPages, Math.ceil(64 / blockSize));
    assert.equal(summary.cache.hbmBytes, 2 * Math.ceil(64 / blockSize) * blockSize * 163840);
    assert.ok(summary.resources.flatMap(resource => resource.pages).every(page => page.references === 0 && page.ready));
    const extracted = extractSensMetrics(actual);
    assert.equal(extracted.throughput, 64 / actual.simEnd); assert.equal(extracted.measurement_ttft, null);
    assert.equal(extracted.workload.source, 'synthetic');
  });
}
