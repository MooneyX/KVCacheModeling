import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runSimulation } from '../../src/core/simulation.js';
import { readParams } from '../../src/adapters/parameters.js';
import { parseDSL } from '../../src/core/strategy.js';
import { extractSensMetrics } from '../../src/application/metrics.js';
import { loadLegacy } from '../fixtures/legacy-loader.mjs';
import { scenarios, baseControls } from '../fixtures/scenarios.mjs';

const fixtures = JSON.parse(readFileSync(new URL('../fixtures/simulation-baseline.json', import.meta.url), 'utf8'));

for (const fixture of fixtures) {
  test(`same-runtime full result: ${fixture.name}`, () => {
    const spec = scenarios.find(s => s.name === fixture.name);
    const legacy = loadLegacy({ ...baseControls, ...spec.controls });
    try {
      legacy.setMode(fixture.mode);
      assert.deepEqual(readParams(id => legacy.document.getElementById(id)), fixture.params);
      assert.deepEqual(parseDSL(fixture.strategy.dsl), legacy.parseDSL(fixture.strategy.dsl));
      const before = JSON.stringify(fixture);
      const actual = runSimulation(fixture.params, fixture.strategy, fixture.overrides, fixture.mode);
      const expected = legacy.runSimulation(fixture.strategy, fixture.overrides);
      assert.deepEqual(actual, expected);
      assert.equal(createHash('sha256').update(JSON.stringify(actual)).digest('hex'), fixture.hash);
      assert.deepEqual(extractSensMetrics(actual), legacy.extractSensMetrics(expected));
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
