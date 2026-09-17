import { readParams } from '../parameters.js';
import { runSimulation } from '../../core/simulation.js';
import * as calculations from '../../core/calculations.js';
import * as math from '../../core/math.js';
import * as presets from '../../core/presets.js';
import * as strategies from '../../core/strategy.js';
import * as metrics from '../../application/metrics.js';
import { createTrace } from '../../application/trace.js';

export function createLegacyHarness(readControl, getMode = () => 'dsl') {
  const getParams = () => readParams(readControl);
  return {
    ...calculations, ...math, ...presets, ...strategies, ...metrics,
    getParams,
    runSimulation: (strategy, overrides) => runSimulation(getParams(), strategy, overrides, getMode()),
    createTrace: overrides => createTrace(getParams(), overrides),
  };
}
