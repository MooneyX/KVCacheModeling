import { runSimulation } from '../../core/simulation.js';
import { extractSensMetrics } from '../../application/metrics.js';
import type { WorkerRequest, WorkerResponse } from '../../contracts/simulation';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
};

scope.onmessage = ({ data: message }) => {
  if (message.type === 'simulation') {
    try {
      if (message.mode === 'js') throw new Error('JavaScript strategies must use the browser compatibility path.');
      const result = runSimulation(message.params, message.strategy, message.overrides, 'dsl');
      scope.postMessage({ type: 'result', id: message.id, result });
    } catch (error) {
      scope.postMessage({ type: 'error', id: message.id, message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (message.type !== 'scan') return;
  for (const job of message.jobs) {
    let rec = null;
    try {
      rec = extractSensMetrics(runSimulation(message.params, job.s, job.overrides, 'dsl'));
    } catch {
      rec = null;
    }
    scope.postMessage({ type: 'point', key: job.key, ci: job.ci, pi: job.pi, idx: job.idx, rec });
  }
  scope.postMessage({ type: 'done' });
};
