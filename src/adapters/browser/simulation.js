import { runSimulation as simulate } from '../../core/simulation.js';
import { getParams } from './params.js';
import { state } from '../../ui/state.js';

export function runSimulation(strategy, overrides) {
  return simulate(getParams(), strategy, overrides, state.strategyMode);
}
