import type { readParams } from '../adapters/parameters.js';
import type { runSimulation } from '../core/simulation.js';
import type { parseDSL } from '../core/strategy.js';
import type { extractSensMetrics } from '../application/metrics.js';

export type SimulationParams = ReturnType<typeof readParams>;
export type SimulationStrategy = ReturnType<typeof parseDSL>;
export type SimulationResult = ReturnType<typeof runSimulation>;
export type SensitivityMetrics = ReturnType<typeof extractSensMetrics>;
export type MeasurementMetricKey = Extract<keyof SensitivityMetrics, `measurement_${string}`>;
export type SimulationConfiguration = SimulationResult['configuration'];
export type WorkloadSource = 'synthetic' | 'replay';
export type StrategyMode = 'dsl' | 'js';
export type SimulationOverrides = Partial<SimulationParams> & {
  seed?: number;
  nreq?: number;
  hwPreset?: string;
  replay?: import('./replay').ReplayOverride;
};

export interface SimulationJob {
  params: SimulationParams;
  strategy: SimulationStrategy;
  overrides?: SimulationOverrides;
  mode?: StrategyMode;
}

export interface ScanJob {
  key: string;
  ci: number;
  pi: number;
  idx: number;
  s: SimulationStrategy;
  overrides?: SimulationOverrides;
}

export type WorkerRequest =
  | ({ type: 'simulation'; id: number } & SimulationJob)
  | { type: 'scan'; params: SimulationParams; jobs: ScanJob[] };

export type WorkerResponse =
  | { type: 'result'; id: number; result: SimulationResult }
  | { type: 'error'; id: number; message: string }
  | { type: 'point'; key: string; ci: number; pi: number; idx: number; rec: SensitivityMetrics | null }
  | { type: 'done' };
