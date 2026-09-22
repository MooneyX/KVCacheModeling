import type { SimulationJob, SimulationResult, SensitivityMetrics } from './simulation';

export type TaskKind = 'simulation' | 'scan' | 'batch';
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface TaskSubmission {
  kind: TaskKind;
  label?: string;
  jobs: SimulationJob[];
  requestId: string;
}
export interface TaskInfo {
  id: string;
  kind: TaskKind;
  label: string;
  status: TaskStatus;
  completed: number;
  total: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
  engineVersion: string;
}
export interface TaskPoint {
  index: number;
  result: SimulationResult | SensitivityMetrics;
}
export const terminalStatuses: TaskStatus[] = ['completed', 'failed', 'cancelled', 'interrupted'];
