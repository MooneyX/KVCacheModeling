import { createSimulationWorker } from './worker-factory';
import { runSimulation } from '../../core/simulation.js';
import type { SimulationJob, SimulationResult, WorkerRequest, WorkerResponse } from '../../contracts/simulation';

let nextId = 0;

export function executeSimulation(job: SimulationJob): Promise<SimulationResult> {
  const snapshot = structuredClone(job);
  if (snapshot.mode === 'js' || typeof Worker === 'undefined') {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try { resolve(runSimulation(snapshot.params, snapshot.strategy, snapshot.overrides, snapshot.mode)); }
        catch (error) { reject(error); }
      }, 0);
    });
  }
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try { worker = createSimulationWorker(); }
    catch (error) { reject(error); return; }
    const id = ++nextId;
    const fail = (message: string) => { worker.terminate(); reject(new Error(message)); };
    worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      if ((data.type === 'result' || data.type === 'error') && data.id === id) {
        worker.terminate();
        if (data.type === 'result') resolve(data.result);
        else reject(new Error(data.message));
      }
    };
    worker.onerror = event => { event.preventDefault(); fail(event.message || 'Simulation Worker failed to load.'); };
    worker.onmessageerror = () => fail('Simulation Worker returned an unreadable message.');
    try {
      worker.postMessage({ type: 'simulation', id, ...snapshot } satisfies WorkerRequest);
    } catch (error) {
      worker.terminate();
      reject(error);
    }
  });
}
