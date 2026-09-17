import { runSimulation } from '../../core/simulation.js';
import type { SimulationJob } from '../../contracts/simulation';

export function executeJob(job: SimulationJob) {
  return runSimulation(job.params, job.strategy, job.overrides, job.mode);
}

export { runSimulation } from '../../core/simulation.js';
export * from '../../core/calculations.js';
export * from '../../core/math.js';
export * from '../../core/presets.js';
export * from '../../core/strategy.js';
export * from '../../application/metrics.js';
export * from '../../application/sweep.js';
export { readParams } from '../../adapters/parameters.js';
export { paramsFromControls, jobFromControls } from '../../adapters/node/params.js';
export { parseJob } from '../../adapters/node/input';
export { createLegacyHarness } from '../../adapters/node/legacy.js';
export { createTrace } from '../../application/trace.js';
