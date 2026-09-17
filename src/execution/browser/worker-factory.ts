export function createSimulationWorker(): Worker {
  return new Worker(new URL('./simulation.worker.ts', import.meta.url), { type: 'module' });
}
